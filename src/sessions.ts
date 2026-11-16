import { execFile } from 'node:child_process';
import path from 'node:path';
import { LIBRARY_DIR, SESSIONS_CMD } from './config.js';
import { db } from './db.js';

// Reading sessions kept by docsessions (a separate program that remembers which documents a PDF viewer
// has open). Shelf never touches the session files: it reads them, and changes them, only through the
// docsessions command line (JSON on stdout; see its CLI.md), which owns the locking and the edit rules.

export class SessionError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = 'error',
    public currentRev?: number,
  ) {
    super(message);
  }
}

export interface SessionDTO {
  uuid: string;
  name: string;
  display_name: string;
  viewer: string;
  position: number;
  state: 'stopped' | 'starting' | 'running';
  opening: boolean;
  rev: number;
  files: string[];
  pending_files: string[];
  lost_files: string[];
  pid: number | null;
  created: string;
  last_update: string;
}

const STATUS: Record<string, number> = {
  not_found: 404, ambiguous: 404, file_not_in_session: 404,
  conflict: 409, session_running: 409, already_running: 409, already_starting: 409, not_running: 409, close_timeout: 409, permission: 403,
  file_not_found: 400, is_folder: 400, unsupported_file: 400, unknown_viewer: 400, single_document: 400, viewer_not_installed: 400, viewer_error: 502, no_files: 400, confirmation_required: 400, usage: 400,
  busy: 503, unsupported_schema: 503, io_error: 503,
};

/** Runs one docsessions command and returns its `data`. Every command gets --json (it is not a global switch). */
export function ds(args: string[], timeoutMs = 20_000): Promise<any> {
  if (!SESSIONS_CMD.length) return Promise.reject(new SessionError(404, 'The sessions feature is not set up (see "sessions" in the shelf file).', 'disabled'));
  const [prog, ...lead] = SESSIONS_CMD;
  return new Promise((resolve, reject) => {
    execFile(prog, [...lead, ...args, '--json'], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      let out: any = null;
      try {
        out = JSON.parse(String(stdout));
      } catch {
        /* handled below */
      }
      if (out && out.ok === true) return resolve(out.data ?? {});
      if (out && out.ok === false && out.error) {
        const e = out.error as { code?: string; message?: string; current_rev?: number };
        return reject(new SessionError(STATUS[e.code ?? ''] ?? 500, e.message ?? 'docsessions failed', e.code ?? 'error', e.current_rev));
      }
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return reject(new SessionError(503, `Can't run “${prog}”. Check "sessions" in the shelf file.`, 'not_installed'));
      if ((err as { killed?: boolean } | null)?.killed) return reject(new SessionError(504, 'docsessions took too long to answer.', 'timeout'));
      reject(new SessionError(502, 'docsessions gave an answer Shelf could not read.', 'bad_output'));
    });
  });
}

// ------------------------------------------------------------------ matching paths to books

export interface Match {
  path: string; // as the session has it
  name: string; // its file name
  bookId: number | null;
  how: 'exact' | 'folders' | 'name' | null;
  title?: string; // the book's title in Shelf, when matched
  dir?: string; // and its folder in the library
}

interface Row {
  id: number;
  path: string;
  title: string;
}

/**
 * Session paths are absolute and may point at the same files through another route (the library may be
 * mounted elsewhere on this computer). A path matches a book when it is exactly the book's path; otherwise
 * when the tail of the path (file name plus as many folders as possible, at least one folder) is shared by
 * exactly one book; otherwise by file name alone if only one book has that name.
 */
export function matcher() {
  const rows = db.prepare('SELECT id, path, title FROM books WHERE missing = 0').all() as Row[];
  const exact = new Map<string, Row>();
  const byName = new Map<string, Row[]>();
  for (const r of rows) {
    exact.set(path.join(LIBRARY_DIR, r.path), r);
    const base = path.posix.basename(r.path).toLowerCase();
    (byName.get(base) ?? byName.set(base, []).get(base)!).push(r);
  }
  const found = (p: string, name: string, r: Row, how: Match['how']): Match => ({ path: p, name, bookId: r.id, how, title: r.title, dir: path.posix.dirname(r.path) === '.' ? '' : path.posix.dirname(r.path) });
  return (p: string): Match => {
    const name = path.basename(p);
    const hit = exact.get(path.normalize(p));
    if (hit !== undefined) return found(p, name, hit, 'exact');
    const cands = byName.get(name.toLowerCase()) ?? [];
    if (!cands.length) return { path: p, name, bookId: null, how: null };
    const want = p.split(/[\\/]/).filter(Boolean).map((s) => s.toLowerCase());
    let best = 0;
    let winners: Row[] = [];
    for (const c of cands) {
      const have = c.path.split('/').map((s) => s.toLowerCase());
      let n = 0;
      while (n < have.length && n < want.length && have[have.length - 1 - n] === want[want.length - 1 - n]) n++;
      if (n > best) [best, winners] = [n, [c]];
      else if (n === best) winners.push(c);
    }
    if (winners.length === 1) return found(p, name, winners[0], best >= 2 ? 'folders' : 'name');
    return { path: p, name, bookId: null, how: null };
  };
}

export interface SessionOut extends Omit<SessionDTO, 'files' | 'pending_files' | 'lost_files'> {
  files: Match[];
  pending: Match[];
  lost: Match[];
  matched: number;
  total: number;
  /** The Shelf reading list that was imported from this session, if any. */
  listId: number | null;
}

export function enrich(sessions: SessionDTO[]): SessionOut[] {
  const match = matcher();
  const links = new Map<string, number>();
  for (const r of db.prepare('SELECT id, session_uuid FROM lists WHERE session_uuid IS NOT NULL').all() as Array<{ id: number; session_uuid: string }>) links.set(r.session_uuid, r.id);
  return sessions.map((s) => {
    const { files, pending_files, lost_files, ...rest } = s;
    const f = (files ?? []).map(match);
    const p = (pending_files ?? []).map(match);
    const l = (lost_files ?? []).map(match);
    const all = [...f, ...p, ...l];
    return { ...rest, files: f, pending: p, lost: l, matched: all.filter((m) => m.bookId !== null).length, total: all.length, listId: links.get(s.uuid) ?? null };
  });
}

/** Viewers open these kinds; anything else a book list may hold (loose-image comics, .zip comics) is left out. */
const OPENABLE = new Set(['.pdf', '.epub', '.cbz']);

/** Absolute paths for books, in the order given, plus what had to be left out. */
export function pathsFor(bookIds: number[]): { paths: string[]; skipped: number } {
  const get = db.prepare('SELECT path, is_folder FROM books WHERE id = ? AND missing = 0');
  const paths: string[] = [];
  let skipped = 0;
  for (const id of bookIds) {
    const r = get.get(id) as { path: string; is_folder: number } | undefined;
    if (!r || r.is_folder || !OPENABLE.has(path.posix.extname(r.path).toLowerCase())) {
      skipped++;
      continue;
    }
    const abs = path.join(LIBRARY_DIR, r.path);
    if (!paths.includes(abs)) paths.push(abs);
  }
  return { paths, skipped };
}

export const listSessions = async () => {
  const d = await ds(['list'], 15_000);
  return { ...d, sessions: enrich(d.sessions ?? []) as SessionOut[] };
};

/** The one session as Shelf shows it, from a mutating command's answer. */
export const one = (d: { session: SessionDTO }) => enrich([d.session])[0];
