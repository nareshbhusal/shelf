import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { DATA_DIR, HOST, HOST_LIBRARY, IN_DOCKER, LIBRARY_DIR, OPENER_SOCKET, PDFJS_DIR, PORT, READONLY, ROOT, SESSIONS_CMD, SHELF_NAME } from './config.js';
import { AUTH_ON, authGate } from './auth.js';
import { PeekError, peekPage, peekPages, peekText } from './peek.js';
import { ensureThumb, forgetAllThumbs, forgetThumb, setThumb, spineColour } from './covers.js';
import { db, type BookRow } from './db.js';
import { checkpoint, storageStats } from './hygiene.js';
import { buildArgv, helperAlive, launch, launchViaHelper, parseTemplate } from './launch.js';
import { moveToTrash } from './trash.js';
import { ds, listSessions, one, pathsFor, SessionError, type SessionOut } from './sessions.js';
import { EPUB_MIME, epubStructure, pagesFromChars } from './epub.js';
import { pdfDetails, toolsAvailable } from './meta.js';
import { applyRename, planRename, renameFolder, RenameError } from './rename.js';
import { mergeMissing, purgeMissing, scanState, startScan } from './scanner.js';
import {
  addAnnotation as addNote,
  capabilities as notesCapabilities,
  cleanHex,
  deleteAnnotation as deleteNote,
  listAll as listNotes,
  NotesError,
  updateAnnotation as updateNote,
} from './pdfnotes.js';
import { fingerprint, natCompare, pdfFileId } from './util.js';
import { comicPages, imageExt, openEntryStream } from './zip.js';
import { IMAGE_MIME } from './config.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const app = express();
app.disable('x-powered-by');

// DNS-rebinding defence. A hostile web page can point its own domain at 127.0.0.1 and then talk to
// this server as if it were same-origin. Browsers always send the name they used in the Host header,
// so only accept localhost, raw IP addresses (which can't be rebound), and names you list yourself.
const extraHosts = (process.env.SHELF_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
app.use((req, res, next) => {
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const ok =
    host === 'localhost' || host === '[::1]' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || extraHosts.includes(host);
  if (ok) return next();
  res.status(403).type('text/plain').send(
    `Blocked: this server doesn't answer to the name "${host}". If that's really you, set SHELF_ALLOWED_HOSTS=${host}`,
  );
});
app.use(express.json({ limit: '2mb' }));

// Any website you visit could poke localhost. Refuse cross-origin writes.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host;
    } catch {
      /* fallthrough */
    }
    if (!ok) return res.status(403).json({ error: 'cross-origin request blocked' });
  }
  next();
});

authGate(app); // no-op unless a pass key is set; everything below needs the login

// ---------- helpers ----------

const qstr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const toInt = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'expected an integer');
  return n;
};
const intArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [];
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
/** "1,2,3" -> [1,2,3]; empty or junk entries are dropped (Number('') would otherwise become 0). */
const idList = (v: unknown): number[] =>
  (typeof v === 'string' ? v : '')
    .split(',')
    .filter((s) => /^\d+$/.test(s))
    .map(Number);

function getBook(idParam: unknown): BookRow {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(toInt(idParam)) as BookRow | undefined;
  if (!row) throw new HttpError(404, 'book not found');
  return row;
}

function absPath(book: BookRow): string {
  const abs = path.resolve(LIBRARY_DIR, book.path);
  if (!abs.startsWith(LIBRARY_DIR + path.sep)) throw new HttpError(400, 'bad path');
  return abs;
}

/** Content-addressed URLs (?v=<fingerprint>) can be cached forever. */
function cacheHeaders(req: Request, res: Response, book: BookRow) {
  const v = qstr(req.query.v);
  res.setHeader('Cache-Control', v && v === book.fingerprint ? 'public, max-age=31536000, immutable' : 'no-cache');
}

function tagMap(): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const r of db.prepare('SELECT book_id, tag_id FROM book_tags').all() as Array<{ book_id: number; tag_id: number }>) {
    const list = m.get(r.book_id);
    if (list) list.push(r.tag_id);
    else m.set(r.book_id, [r.tag_id]);
  }
  return m;
}

type BookX = BookRow & { position?: number };

/**
 * Folders whose only content is one comic (see "comic folders"): folder path -> folder name.
 * That folder is the series, so its one comic is called by the folder's name, not by its file name.
 */
function singleWrappers(): Map<string, string> {
  const rows = db.prepare(`SELECT dir, format FROM books WHERE missing = 0 AND dir != ''`).all() as Array<{ dir: string; format: string }>;
  const inside = new Map<string, number>(); // books in the folder or below
  const comics = new Map<string, number>(); // comics directly in it
  for (const r of rows) {
    const parts = r.dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      inside.set(d, (inside.get(d) ?? 0) + 1);
    }
    if (r.format === 'cbz') comics.set(r.dir, (comics.get(r.dir) ?? 0) + 1);
  }
  const out = new Map<string, string>();
  for (const [d, n] of inside) if (n === 1 && comics.get(d) === 1) out.set(d, path.posix.basename(d));
  return out;
}

function bookDTO(b: BookX, tags: Map<number, number[]>, singles: Map<string, string> = singleWrappers()) {
  const group = b.format === 'cbz' ? singles.get(b.dir) : undefined;
  return {
    id: b.id,
    path: b.path,
    dir: b.dir,
    filename: b.filename,
    format: b.format,
    isFolder: !!b.is_folder,
    group,
    size: b.size,
    title: group ?? b.title,
    author: b.author,
    series: b.series,
    number: b.number,
    pages: b.pages,
    fingerprint: b.fingerprint,
    spine: spineColour(b.fingerprint),
    addedAt: b.added_at,
    progress: { page: b.progress_page, at: b.progress_at, pos: b.progress_pos, frac: b.progress_frac },
    tagIds: tags.get(b.id) ?? [],
    position: b.position,
  };
}

// ---------- comic folders ----------
//
// Folders are never stored as anything: this is derived from the index each time.
//   group:  a folder with two or more comic files (.cbz / .zip) directly inside it. It is shown as one
//           card named after the folder, with the cover of its first comic. Series and collections of
//           one-shots are treated alike; opening it lists its comics alphabetically.
//   single: a folder whose only content is one comic file (the layout Kavita requires). The wrapper folder
//           disappears from the listing and the comic itself is shown.
//   plain:  anything else, shown as an ordinary folder.

interface DirInfo {
  path: string;
  name: string;
  total: number;
  kind: 'plain' | 'group' | 'single';
  units: number;
  done: number;
  fraction: number; // 0..1 of the whole series, counted in pages (a finished part counts in full)
  pages: number; // pages in all its comics together (0 when none is known)
  cover: { id: number; fingerprint: string } | null;
  bookId: number | null;
}

type ComicRow = { id: number; dir: string; format: string; filename: string; fingerprint: string; pages: number | null; progress_page: number };

/** How far through a set of comics you are: pages read over pages in total (parts without a known length count by part). */
function seriesFraction(comics: Array<{ pages: number | null; progress_page: number }>): number {
  let read = 0;
  let all = 0;
  for (const c of comics) {
    const n = c.pages && c.pages > 0 ? c.pages : 1;
    all += n;
    read += c.pages ? Math.min(c.progress_page, n) : c.progress_page > 0 ? 1 : 0;
  }
  return all ? read / all : 0;
}

function childDirs(parent: string): DirInfo[] {
  const rows = (
    parent === ''
      ? db.prepare(`SELECT id, dir, format, filename, fingerprint, pages, progress_page FROM books WHERE missing = 0 AND dir != ''`).all()
      : db
          .prepare(`SELECT id, dir, format, filename, fingerprint, pages, progress_page FROM books WHERE missing = 0 AND dir LIKE ? ESCAPE '\\'`)
          .all(likeEsc(parent) + '/%')
  ) as ComicRow[];
  const prefix = parent === '' ? '' : parent + '/';
  const byChild = new Map<string, ComicRow[]>();
  for (const r of rows) {
    const first = r.dir.slice(prefix.length).split('/')[0];
    const key = prefix + first;
    let list = byChild.get(key);
    if (!list) byChild.set(key, (list = []));
    list.push(r);
  }
  const out: DirInfo[] = [];
  for (const [p, list] of byChild) {
    const direct = list.filter((r) => r.dir === p);
    const comics = direct.filter((r) => r.format === 'cbz').sort((a, b) => natCompare(a.filename, b.filename));
    let kind: DirInfo['kind'] = 'plain';
    if (comics.length >= 2) kind = 'group';
    else if (comics.length === 1 && list.length === 1) kind = 'single';
    out.push({
      path: p,
      name: path.posix.basename(p),
      total: list.length,
      kind,
      units: comics.length,
      done: kind === 'group' ? comics.filter((c) => c.pages && c.progress_page >= c.pages).length : 0,
      fraction: kind === 'group' ? seriesFraction(comics) : 0,
      pages: kind === 'group' ? comics.reduce((n, c) => n + (c.pages ?? 0), 0) : 0,
      cover: kind === 'group' ? { id: comics[0].id, fingerprint: comics[0].fingerprint } : null,
      bookId: kind === 'single' ? comics[0].id : null,
    });
  }
  return out.sort((a, b) => natCompare(a.name, b.name));
}

app.get('/api/dirs', (req, res) => {
  const parent = typeof req.query.parent === 'string' ? req.query.parent : '';
  res.json(childDirs(parent));
});

// The parts of a series (a "group" folder): its comics in reading order, and where to carry on from.
// The reader uses the same list to read from one part straight into the next.
app.get('/api/series', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const rows = (dir === '' ? [] : db.prepare(`SELECT * FROM books WHERE missing = 0 AND dir = ? AND format = 'cbz'`).all(dir)) as BookX[];
  if (rows.length < 1) throw new HttpError(404, 'not a series');
  rows.sort((a, b) => natCompare(a.filename, b.filename));
  const isDone = (r: BookX) => !!r.pages && r.progress_page >= r.pages;
  const started = rows.filter((r) => r.progress_at !== null);
  let next = rows[0];
  let state: 'new' | 'reading' | 'done' = 'new';
  if (started.length) {
    const last = started.reduce((a, b) => ((b.progress_at ?? 0) > (a.progress_at ?? 0) ? b : a));
    if (!isDone(last)) {
      next = last;
      state = 'reading';
    } else {
      const after = rows.slice(rows.indexOf(last) + 1).find((r) => !isDone(r)) ?? rows.find((r) => !isDone(r));
      if (after) {
        next = after;
        state = 'reading';
      } else {
        state = 'done'; // everything read: "read again" starts at the first part
      }
    }
  }
  const tags = tagMap();
  const singles = singleWrappers();
  res.json({
    dir,
    name: path.posix.basename(dir),
    parts: rows.map((r) => bookDTO(r, tags, singles)),
    next: next.id,
    state,
    done: rows.filter(isDone).length,
    fraction: seriesFraction(rows),
  });
});

/** Every folder holding 2+ comics directly (a series), wherever it is: folder path -> what its card shows. */
interface SeriesInfo { name: string; units: number; pages: number; done: number; fraction: number; cover: { id: number; fingerprint: string } }

function seriesFolders(): Map<string, SeriesInfo> {
  const rows = db
    .prepare(`SELECT id, dir, format, filename, fingerprint, pages, progress_page FROM books WHERE missing = 0 AND format = 'cbz' AND dir != ''`)
    .all() as ComicRow[];
  const byDir = new Map<string, ComicRow[]>();
  for (const r of rows) (byDir.get(r.dir) ?? byDir.set(r.dir, []).get(r.dir)!).push(r);
  const out = new Map<string, SeriesInfo>();
  for (const [dir, list] of byDir) {
    if (list.length < 2) continue;
    list.sort((a, b) => natCompare(a.filename, b.filename));
    out.set(dir, {
      name: path.posix.basename(dir),
      units: list.length,
      pages: list.reduce((n, c) => n + (c.pages ?? 0), 0),
      done: list.filter((c) => c.pages && c.progress_page >= c.pages).length,
      fraction: seriesFraction(list),
      cover: { id: list[0].id, fingerprint: list[0].fingerprint },
    });
  }
  return out;
}

/** A well-spread number from a seed and a key, so "random" order is the same each time for one seed. */
function shuffleKey(seed: number, key: string | number): number {
  let x = (seed ^ 0x9e3779b9) | 0;
  for (const ch of String(key)) x = Math.imul(x ^ ch.charCodeAt(0), 0x85ebca6b) ^ (x >>> 13);
  x = Math.imul(x ^ (x >>> 16), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

// ---------- books: listing & search ----------

app.get('/api/books', (req, res) => {
  const where: string[] = ['b.missing = 0'];
  const params: unknown[] = [];
  let join = '';
  let select = `b.*`;

  const dir = typeof req.query.dir === 'string' ? req.query.dir : undefined;
  if (dir !== undefined) {
    if (req.query.recursive === '1') {
      if (dir !== '') {
        where.push(`(b.dir = ? OR b.dir LIKE ? ESCAPE '\\')`);
        params.push(dir, likeEsc(dir) + '/%');
      }
    } else if (req.query.collapse === '1') {
      // Also the lone comic inside each single-comic wrapper folder (see "comic folders").
      const lone = childDirs(dir).filter((d) => d.kind === 'single').map((d) => d.path);
      where.push(`(b.dir = ?${lone.length ? ` OR b.dir IN (${lone.map(() => '?').join(',')})` : ''})`);
      params.push(dir, ...lone);
    } else {
      where.push('b.dir = ?');
      params.push(dir);
    }
  }

  const format = qstr(req.query.format);
  if (format) {
    where.push('b.format = ?');
    params.push(format);
  }

  // Every search word must match title/author/series/path, or one of the book's tag names.
  const q = qstr(req.query.q);
  if (q) {
    for (const term of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${likeEsc(term)}%`;
      where.push(`(
        (b.title || ' ' || COALESCE(b.author,'') || ' ' || COALESCE(b.series,'') || ' ' || b.path) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
                   WHERE bt.book_id = b.id AND t.name LIKE ? ESCAPE '\\'))`);
      params.push(like, like);
    }
  }

  // Selected tags combine with AND.
  for (const tid of idList(req.query.tags)) {
    where.push('EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = ?)');
    params.push(tid);
  }
  if (req.query.untagged === '1') where.push('NOT EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id)');
  if (req.query.recent === '1') where.push('b.progress_at IS NOT NULL');
  // "Recently added": first indexed within the last N days, not counting the library's very first scan
  // (everything found then would otherwise look new). A moved or renamed file keeps its original date.
  const addedDays = qstr(req.query.added) ? toInt(qstr(req.query.added)) : 0;
  if (addedDays > 0) {
    where.push('b.added_at >= ? AND b.added_at > (SELECT MIN(added_at) FROM books)');
    params.push(Date.now() - Math.min(addedDays, 3650) * 86_400_000);
  }

  const list = qstr(req.query.list);
  if (list) {
    join = 'JOIN list_items li ON li.book_id = b.id AND li.list_id = ?';
    select = `b.*, li.position AS position`;
  }

  const sql = `SELECT ${select} FROM books b ${join} WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(sql).all(...(list ? [toInt(list)] : []), ...params) as BookX[];

  const sort = qstr(req.query.sort) ?? (list ? 'manual' : 'title');
  const dirSign = req.query.order === 'desc' ? -1 : 1;
  const singles = singleWrappers();
  // series=1: the parts of a multi-part series stand in as one entry (never inside a list, which orders single files).
  const folders = req.query.series === '1' && !list ? seriesFolders() : new Map<string, SeriesInfo>();
  if (dir !== undefined) folders.delete(dir); // the series' own page lists its parts
  const inSeries = (r: BookX) => (r.format === 'cbz' && folders.has(r.dir) ? r.dir : undefined);
  const sortName = (r: BookX) => (inSeries(r) ? folders.get(r.dir)!.name : (r.format === 'cbz' && singles.get(r.dir)) || r.filename);
  const seed = Math.floor(Number(qstr(req.query.seed))) || 1;
  const cmp: Record<string, (a: BookX, b: BookX) => number> = {
    title: (a, b) => natCompare(a.title, b.title),
    filename: (a, b) => natCompare(sortName(a), sortName(b)),
    author: (a, b) => natCompare(a.author ?? '￿', b.author ?? '￿') || natCompare(a.title, b.title),
    path: (a, b) => natCompare(a.path, b.path),
    added: (a, b) => a.added_at - b.added_at || natCompare(a.title, b.title),
    size: (a, b) => a.size - b.size,
    pages: (a, b) => (a.pages ?? 0) - (b.pages ?? 0),
    read: (a, b) => (a.progress_at ?? 0) - (b.progress_at ?? 0),
    manual: (a, b) => (a.position ?? 0) - (b.position ?? 0),
    // A series is shuffled as one, by its folder, so its parts stay together.
    random: (a, b) => shuffleKey(seed, inSeries(a) ?? a.id) - shuffleKey(seed, inSeries(b) ?? b.id) || a.id - b.id,
  };
  for (const r of rows) {
    const g = r.format === 'cbz' ? singles.get(r.dir) : undefined;
    if (g) r.title = g; // sorted and shown by the folder's name
    const sd = inSeries(r);
    if (sd) r.title = folders.get(sd)!.name; // a series is sorted by its folder's name
  }
  const fn = cmp[sort] ?? cmp.title;
  rows.sort((a, b) => fn(a, b) * (sort === 'random' ? 1 : dirSign));

  const tags = tagMap();
  const seen = new Map<string, number>(); // series folder -> index in `out`
  const out: Array<ReturnType<typeof bookDTO> & { seriesCard?: unknown }> = [];
  for (const r of rows) {
    const sd = inSeries(r);
    if (!sd) {
      out.push(bookDTO(r, tags, singles));
      continue;
    }
    const at = seen.get(sd);
    if (at !== undefined) {
      (out[at].seriesCard as { matched: number }).matched++;
      continue;
    }
    seen.set(sd, out.length);
    out.push({ ...bookDTO(r, tags, singles), seriesCard: { dir: sd, ...folders.get(sd)!, matched: 1 } });
  }
  const limit = Math.floor(Number(qstr(req.query.limit)) || 0);
  res.json(limit > 0 ? out.slice(0, Math.min(limit, 500)) : out);
});

app.get('/api/books/:id', (req, res) => {
  const book = getBook(req.params.id);
  res.json(bookDTO(book, tagMap()));
});

// Everything Shelf knows about one file, for the reader's info panel.
app.get('/api/books/:id/info', async (req, res) => {
  const b = getBook(req.params.id);
  const file = absPath(b);
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(file);
  } catch { /* missing: reported below */ }
  const tags = (db.prepare('SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id = ? ORDER BY t.name').all(b.id) as Array<{ name: string }>).map((t) => t.name);
  const lists = (db.prepare('SELECT l.id, l.name FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.book_id = ? ORDER BY l.name').all(b.id) as Array<{ id: number; name: string }>);
  res.json({
    ...bookDTO(b, tagMap()),
    metaTitle: b.meta_title,
    fileId: b.file_id || null,
    location: path.join(HOST_LIBRARY || LIBRARY_DIR, b.path),
    exists: !!st,
    modifiedAt: st?.mtimeMs ?? null,
    tags,
    lists,
    pdf: b.format === 'pdf' && st ? await pdfDetails(file) : [],
  });
});

// Directory tree with recursive counts, for the sidebar and folder browsing.
app.get('/api/tree', (_req, res) => {
  const rows = db.prepare('SELECT dir, COUNT(*) AS n, MAX(progress_at) AS last_read FROM books WHERE missing = 0 GROUP BY dir').all() as Array<{ dir: string; n: number; last_read: number | null }>;
  // lastRead = the most recent time any book in that folder (or below it) was read; the sidebar can sort by it.
  const nodes = new Map<string, { path: string; name: string; parent: string; direct: number; total: number; lastRead: number | null }>();
  const ensure = (p: string) => {
    let node = nodes.get(p);
    if (!node) {
      const parent = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
      node = { path: p, name: path.posix.basename(p), parent, direct: 0, total: 0, lastRead: null };
      nodes.set(p, node);
    }
    return node;
  };
  for (const { dir, n, last_read } of rows) {
    if (dir === '') continue;
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const node = ensure(parts.slice(0, i).join('/'));
      node.total += n;
      if (last_read && (node.lastRead ?? 0) < last_read) node.lastRead = last_read;
    }
    ensure(dir).direct = n;
  }
  const rootDirect = rows.find((r) => r.dir === '')?.n ?? 0;
  const total = rows.reduce((s, r) => s + r.n, 0);
  res.json({
    root: { direct: rootDirect, total },
    dirs: [...nodes.values()].sort((a, b) => natCompare(a.path, b.path)),
  });
});

// ---------- books: file, cover, pages ----------

app.get('/api/books/:id/file', (req, res) => {
  const book = getBook(req.params.id);
  if (book.is_folder) throw new HttpError(400, 'this comic is a folder of images; there is no single file to download');
  const abs = absPath(book);
  cacheHeaders(req, res, book);
  if (req.query.download === '1') res.attachment(book.filename);
  else res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(book.filename)}`);
  // sendFile handles Range requests, which is what lets pdf.js load huge PDFs page by page.
  res.sendFile(abs, { dotfiles: 'allow', acceptRanges: true, cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file not found on disk; try rescanning' });
  });
});

app.get('/api/books/:id/cover', async (req, res) => {
  const book = getBook(req.params.id);
  const thumb = await ensureThumb(book);
  if (!thumb) return res.status(404).json({ error: 'no cover' });
  // A cover can be redrawn or replaced at any time, so the browser asks (cheap: the answer is "unchanged") instead of keeping it for good.
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(thumb, { dotfiles: 'allow', cacheControl: false });
});

// "Use this page as the cover": the reader sends a picture of a page it drew; it replaces the saved cover (nothing in the library changes).
app.put('/api/books/:id/cover', express.raw({ type: 'image/*', limit: '12mb' }), async (req, res) => {
  const book = getBook(req.params.id);
  if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'send the image as the request body' });
  try {
    await setThumb(book, req.body);
  } catch {
    return res.status(400).json({ error: 'that is not an image I can read' });
  }
  res.json({ ok: true });
});

// Cover images are only a cache of what the file shows, so making one again is always safe (and works in read-only libraries).
// Every saved cover goes; each one is drawn again the next time a card asks for it.
app.post('/api/covers/rebuild-all', async (_req, res) => res.json({ removed: await forgetAllThumbs() }));

app.post('/api/books/:id/cover/rebuild', async (req, res) => {
  const book = getBook(req.params.id);
  await forgetThumb(book);
  res.json({ ok: true, cover: !!(await ensureThumb(book)) });
});

// How many pages the flip-through of this book has (for an EPUB: as laid out for it, which is not the reader's estimate).
app.get('/api/books/:id/peek', async (req, res) => {
  const book = getBook(req.params.id);
  try {
    res.json({ pages: await peekPages(book) });
  } catch (e) {
    if (e instanceof PeekError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

// One page, small, for flipping through a book on its card. The URL carries the file's fingerprint, so browsers may keep it.
app.get('/api/books/:id/peek/:n', async (req, res) => {
  const book = getBook(req.params.id);
  try {
    const img = await peekPage(book, toInt(req.params.n), Number(req.query.w) || 480);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    res.send(img);
  } catch (e) {
    if (e instanceof PeekError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

// Where the words of one page are (fractions of the page), so the viewer can make the text selectable.
app.get('/api/books/:id/peek/:n/text', async (req, res) => {
  const book = getBook(req.params.id);
  try {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.json({ words: await peekText(book, toInt(req.params.n)) });
  } catch (e) {
    if (e instanceof PeekError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

app.get('/api/books/:id/pages', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'cbz') throw new HttpError(400, 'not a comic archive');
  const pages = await comicPages(`${book.id}:${book.fingerprint}`, absPath(book), !!book.is_folder);
  res.json({ count: pages.length });
});

app.get('/api/books/:id/pages/:n', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'cbz') throw new HttpError(400, 'not a comic archive');
  const abs = absPath(book);
  const pages = await comicPages(`${book.id}:${book.fingerprint}`, abs, !!book.is_folder);
  const n = toInt(req.params.n);
  if (n < 1 || n > pages.length) throw new HttpError(404, 'page out of range');
  const name = pages[n - 1];
  if (book.is_folder) {
    cacheHeaders(req, res, book);
    res.sendFile(path.join(abs, name), { dotfiles: 'allow', acceptRanges: true, cacheControl: false }, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'page not found on disk; try rescanning' });
    });
    return;
  }
  const { stream, size } = await openEntryStream(abs, name);
  const ext = imageExt(name) ?? '.jpg';
  res.setHeader('Content-Type', IMAGE_MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  cacheHeaders(req, res, book);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// ---------- EPUB reading ----------
// The reader shows each section (spine item) in a sandboxed iframe that points straight at these URLs,
// so images, styles and fonts load by their own relative paths. Scripts inside books never run:
// the iframe is sandboxed without allow-scripts and the CSP below forbids everything but passive content.

const EPUB_CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

app.get('/api/books/:id/epub', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'epub') throw new HttpError(400, 'not an EPUB');
  let st;
  try {
    st = await epubStructure(`${book.id}:${book.fingerprint}`, absPath(book));
  } catch (e) {
    throw new HttpError(422, `can't read this EPUB: ${(e as Error).message}`);
  }
  // Pages are estimated from the text (see epub.ts); keep the index in step with what the reader will show.
  const chars = st.chars ?? st.spine.map(() => 1);
  const pages = pagesFromChars(chars);
  if (book.pages !== pages) db.prepare('UPDATE books SET pages = ? WHERE id = ?').run(pages, book.id);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    title: st.title,
    rtl: st.rtl,
    pages,
    spine: st.spine.map((s, i) => ({ path: s.path, size: s.size, kind: s.kind, chars: chars[i] })),
    toc: st.toc,
  });
});

app.get('/api/books/:id/epub/f/*rest', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'epub') throw new HttpError(400, 'not an EPUB');
  const parts = (req.params as unknown as { rest: string[] }).rest;
  const name = parts.join('/');
  const st = await epubStructure(`${book.id}:${book.fingerprint}`, absPath(book)).catch(() => null);
  if (!st || !st.entries.has(name) || name.startsWith('META-INF/')) return res.status(404).type('text/plain').send('not in this book');
  const ext = path.posix.extname(name).toLowerCase();
  let type = EPUB_MIME[ext] ?? 'application/octet-stream';
  if (req.query.html === '1' && type.startsWith('application/xhtml')) type = 'text/html; charset=utf-8'; // lenient fallback for sloppy XHTML
  if (ext === '.js') type = 'text/plain; charset=utf-8'; // never executable
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Security-Policy', EPUB_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  cacheHeaders(req, res, book);
  const { stream, size } = await openEntryStream(absPath(book), name);
  res.setHeader('Content-Length', String(size));
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// ---------- renaming files ----------
//
// The only change Shelf makes to the library besides saving PDF notes (see rename.ts for the rules).
// Send {items: [{id, name}]}; `name` has no extension. With dryRun the answer says what would happen.
app.post('/api/rename', async (req, res) => {
  if (READONLY) throw new HttpError(403, 'Shelf is in read-only mode, so it will not rename files.');
  const raw = req.body?.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5000) throw new HttpError(400, 'items: 1 to 5000 books expected');
  const items = raw.map((r) => {
    if (!r || typeof r.name !== 'string') throw new HttpError(400, 'each item needs an id and a name');
    return { id: toInt(r.id), name: r.name };
  });
  const dry = req.body?.dryRun === true;
  if (!dry && scanState.running) throw new HttpError(409, 'Shelf is scanning the library right now. Try again in a moment.');
  const plans = await planRename(items);
  if (dry) return void res.json({ plans });
  const bad = plans.filter((p) => p.error);
  if (bad.length) return void res.status(409).json({ error: `${bad.length} name(s) can't be used; nothing was renamed.`, plans });
  try {
    const renamed = await applyRename(plans);
    res.json({ renamed, plans });
  } catch (e) {
    if (e instanceof RenameError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

// ---------- renaming folders, and the trash ----------

app.post('/api/rename-folder', async (req, res) => {
  if (READONLY) throw new HttpError(403, 'Shelf is in read-only mode, so it will not rename folders.');
  if (scanState.running) throw new HttpError(409, 'Shelf is scanning the library right now. Try again in a moment.');
  try {
    res.json(await renameFolder(String(req.body?.dir ?? ''), String(req.body?.name ?? '')));
  } catch (e) {
    if (e instanceof RenameError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

// Moves books (by id) and folders (by library path) into the trash folder inside the library. See trash.ts.
app.post('/api/trash', async (req, res) => {
  if (READONLY) throw new HttpError(403, 'Shelf is in read-only mode, so it will not delete anything.');
  if (scanState.running) throw new HttpError(409, 'Shelf is scanning the library right now. Try again in a moment.');
  const ids: unknown[] = Array.isArray(req.body?.books) ? req.body.books : [];
  const dirs: unknown[] = Array.isArray(req.body?.dirs) ? req.body.dirs : [];
  if (!ids.length && !dirs.length) throw new HttpError(400, 'books and/or dirs expected');
  if (ids.length + dirs.length > 5000) throw new HttpError(400, 'too many items');
  const rels = [...dirs.filter((d): d is string => typeof d === 'string' && d !== '')];
  for (const id of ids) {
    const row = db.prepare('SELECT path FROM books WHERE id = ?').get(toInt(id)) as { path: string } | undefined;
    if (row) rels.push(row.path);
  }
  res.json(await moveToTrash(rels));
});

// ---------- sessions (docsessions); everything goes through its command line, see sessions.ts ----------

// docsessions is an external app: it needs its command configured, and can be switched off in Settings.
const sessionsOn = () => SESSIONS_CMD.length > 0 && readSettings().sessionsEnabled !== false;
const needSessions = () => {
  if (!SESSIONS_CMD.length) throw new HttpError(404, 'Sessions are not set up. Add "sessions" to the shelf file.');
  if (!sessionsOn()) throw new HttpError(404, 'docsessions is turned off (Settings → Apps).');
};
const sessionId = (v: unknown) => {
  const id = String(v ?? '');
  if (!/^[0-9a-f-]{8,40}$/i.test(id)) throw new HttpError(400, 'bad session id');
  return id;
};
const revArgs = (rev: unknown) => (Number.isInteger(rev) ? [`--expect-rev=${rev}`] : []);
const absArgs = (v: unknown): string[] => {
  const arr = Array.isArray(v) ? v : [];
  if (!arr.length || arr.length > 5000 || arr.some((x) => typeof x !== 'string' || !path.isAbsolute(x))) throw new HttpError(400, 'file paths must be absolute');
  return arr as string[];
};
const sessionName = (v: unknown) => {
  const n = cleanName(v, 120);
  if (n.startsWith('-')) throw new HttpError(400, 'A session name can not start with a dash.');
  return n;
};

app.get('/api/sessions', async (_req, res) => {
  if (!sessionsOn()) return res.json({ enabled: false });
  res.json({ enabled: true, ...(await listSessions()) });
});

// Create a session from books (in the order given) or from a reading list.
app.post('/api/sessions', async (req, res) => {
  needSessions();
  let ids = intArray(req.body?.bookIds ?? []);
  const listId = req.body?.listId;
  let name = typeof req.body?.name === 'string' && req.body.name.trim() ? sessionName(req.body.name) : '';
  if (listId !== undefined) {
    const list = db.prepare('SELECT name FROM lists WHERE id = ?').get(toInt(listId)) as { name: string } | undefined;
    if (!list) throw new HttpError(404, 'list not found');
    ids = (db.prepare('SELECT book_id FROM list_items WHERE list_id = ? ORDER BY position').all(toInt(listId)) as Array<{ book_id: number }>).map((r) => r.book_id);
    name ||= sessionName(list.name);
  }
  const { paths, skipped } = pathsFor(ids);
  if (!paths.length) throw new HttpError(400, 'None of these books can be opened by a PDF viewer (it needs PDF, EPUB or CBZ files).');
  const viewer = viewerArgs(req.body?.viewer);
  const d = await ds(['create', ...(name ? [`--name=${name}`] : []), ...viewer, ...(req.body?.open ? ['--open'] : []), ...paths], req.body?.open ? 40_000 : 15_000);
  const session = one(d);
  if (listId !== undefined && !db.prepare('SELECT 1 FROM lists WHERE session_uuid = ?').get(session.uuid)) {
    // A list sent over stays tied to its session (a list is tied to one session only).
    db.prepare('UPDATE lists SET session_uuid = ?, session_rev = ? WHERE id = ? AND session_uuid IS NULL').run(session.uuid, session.rev ?? null, toInt(listId));
  }
  res.json({ session, skipped });
});

app.post('/api/sessions/:uuid/files', async (req, res) => {
  needSessions();
  const { paths, skipped } = pathsFor(intArray(req.body?.bookIds ?? []));
  if (!paths.length) throw new HttpError(400, 'None of these books can be opened by a PDF viewer (it needs PDF, EPUB or CBZ files).');
  const d = await ds(['add', sessionId(req.params.uuid), ...paths, ...revArgs(req.body?.rev), ...(req.body?.noQueue ? ['--no-queue'] : [])]);
  res.json({ session: one(d), changes: d.changes, skipped });
});

app.post('/api/sessions/:uuid/remove', async (req, res) => {
  needSessions();
  const d = await ds(['remove', sessionId(req.params.uuid), ...absArgs(req.body?.paths), ...revArgs(req.body?.rev)]);
  res.json({ session: one(d), changes: d.changes });
});

app.post('/api/sessions/:uuid/move', async (req, res) => {
  needSessions();
  const pos = toInt(req.body?.position);
  if (pos < 1) throw new HttpError(400, 'position starts at 1');
  const file = absArgs([req.body?.path])[0];
  const d = await ds(['move-file', sessionId(req.params.uuid), file, String(pos), ...revArgs(req.body?.rev)]);
  res.json({ session: one(d), changes: d.changes });
});

const viewerArgs = (v: unknown): string[] => {
  if (v === undefined || v === null || v === '') return [];
  if (typeof v !== 'string' || !/^[\w.-]{1,60}$/.test(v)) throw new HttpError(400, 'bad viewer');
  return [`--viewer=${v}`];
};

const ACTION_TIMEOUT: Record<string, number> = { open: 35_000, restart: 45_000, close: 20_000, rename: 15_000, delete: 15_000 };
app.post('/api/sessions/:uuid/:action', async (req, res, next) => {
  const action = req.params.action;
  if (action === 'import') return next();
  if (!(action in ACTION_TIMEOUT)) throw new HttpError(404, 'unknown action');
  needSessions();
  const id = sessionId(req.params.uuid);
  const args: string[] = [action, id];
  if (action === 'rename') args.push(sessionName(req.body?.name));
  if (action === 'delete') args.push('--yes');
  if (action === 'close' && req.body?.force) args.push('--force');
  if (action === 'open' || action === 'restart') args.push(...viewerArgs(req.body?.viewer));
  if (action === 'rename' || action === 'delete') args.push(...revArgs(req.body?.rev));
  const d = await ds(args, ACTION_TIMEOUT[action]);
  if (action === 'delete') db.prepare('UPDATE lists SET session_uuid = NULL WHERE session_uuid = ?').run(id);
  res.json(d.session ? { ...d, session: one(d) } : d);
});

// Make (or refresh) a Shelf reading list from a session: its documents in order, those Shelf knows.
app.post('/api/sessions/:uuid/import', async (req, res) => {
  needSessions();
  const id = sessionId(req.params.uuid);
  const found = (await listSessions()).sessions.find((s: SessionOut) => s.uuid === id);
  if (!found) throw new HttpError(404, 'session not found');
  const mode = req.body?.mode === 'update' ? 'update' : req.body?.mode === 'copy' ? 'copy' : 'new';
  const books = [...found.files, ...found.pending].map((m) => m.bookId).filter((b): b is number => b !== null);
  const unique = [...new Set(books)];
  const unmatched = found.total - found.lost.length - books.length;
  let listId = (db.prepare('SELECT id FROM lists WHERE session_uuid = ?').get(id) as { id: number } | undefined)?.id;
  if (mode === 'new' && listId) throw new HttpError(409, 'This session is already linked to a reading list. Use "Update list" to refresh it, or import a copy.');
  if (mode === 'update' && !listId) throw new HttpError(404, 'No list is linked to this session yet.');
  const link = mode !== 'copy';
  const nm = (found.display_name || 'Session').slice(0, 80);
  db.transaction(() => {
    if (mode === 'copy' || !listId) listId = Number(db.prepare('INSERT INTO lists (name, created_at, session_uuid, session_rev) VALUES (?, ?, ?, ?)').run(mode === 'copy' ? `${nm} (copy)` : nm, Date.now(), link ? id : null, link ? found.rev ?? null : null).lastInsertRowid);
    else {
      db.prepare('DELETE FROM list_items WHERE list_id = ?').run(listId);
      db.prepare('UPDATE lists SET session_rev = ? WHERE id = ?').run(found.rev ?? null, listId);
    }
    const ins = db.prepare('INSERT INTO list_items (list_id, book_id, position) VALUES (?, ?, ?)');
    unique.forEach((b, i) => ins.run(listId!, b, i));
  })();
  res.json({ listId, imported: unique.length, unmatched });
});

// Open a reading list in a viewer. A list that isn't tied to a session yet gets a new one (and stays tied
// to it). A tied list brings its session up to date first: books the list has that the session lacks are added,
// and (when the session isn't open) books the session has that the list dropped are removed. Documents Shelf
// doesn't know are never touched. The order is not forced onto the session.
app.post('/api/lists/:id/session', async (req, res) => {
  needSessions();
  const lid = toInt(req.params.id);
  const list = db.prepare('SELECT name, session_uuid FROM lists WHERE id = ?').get(lid) as { name: string; session_uuid: string | null } | undefined;
  if (!list) throw new HttpError(404, 'list not found');
  const ids = (db.prepare('SELECT li.book_id FROM list_items li JOIN books b ON b.id = li.book_id WHERE li.list_id = ? AND b.missing = 0 ORDER BY li.position').all(lid) as Array<{ book_id: number }>).map((r) => r.book_id);
  const viewer = viewerArgs(req.body?.viewer);
  const wantOpen = !!req.body?.open;
  const found = list.session_uuid ? (await listSessions()).sessions.find((x: SessionOut) => x.uuid === list.session_uuid) : undefined;
  if (list.session_uuid && !found) db.prepare('UPDATE lists SET session_uuid = NULL, session_rev = NULL WHERE id = ?').run(lid);

  if (!found) {
    const { paths, skipped } = pathsFor(ids);
    if (!paths.length) throw new HttpError(400, 'None of the books in this list can be opened by a PDF viewer (it needs PDF, EPUB or CBZ files).');
    const d = await ds(['create', `--name=${sessionName(list.name)}`, ...viewer, ...(wantOpen ? ['--open'] : []), ...paths], wantOpen ? 40_000 : 15_000);
    const session = one(d);
    db.prepare('UPDATE lists SET session_uuid = ?, session_rev = ? WHERE id = ?').run(session.uuid, session.rev ?? null, lid);
    return res.json({ session, created: true, added: paths.length, removed: 0, skipped });
  }

  const wanted = new Set(ids);
  const have = new Set<number>();
  for (const m of [...found.files, ...found.pending, ...found.lost]) if (m.bookId !== null) have.add(m.bookId);
  const addIds = ids.filter((b) => !have.has(b));
  const drop = found.state === 'stopped' ? [...found.files, ...found.pending, ...found.lost].filter((m) => m.bookId !== null && !wanted.has(m.bookId)) : [];
  let rev = found.rev;
  let current: SessionOut = found;
  let skipped = 0;
  let added = 0;
  if (addIds.length) {
    const { paths, skipped: sk } = pathsFor(addIds);
    skipped = sk;
    if (paths.length) {
      const d = await ds(['add', found.uuid, ...paths, `--expect-rev=${rev}`]);
      current = one(d);
      rev = current.rev;
      added = paths.length;
    }
  }
  if (drop.length) {
    const d = await ds(['remove', found.uuid, ...drop.map((m) => m.path), `--expect-rev=${rev}`]);
    current = one(d);
    rev = current.rev;
  }
  let opened = false;
  if (wantOpen) {
    if (current.state === 'stopped') {
      const d = await ds(['open', found.uuid, ...viewer], 35_000);
      current = d.session ? one(d) : current;
      opened = true;
    } else if (req.body?.restart) {
      const d = await ds(['restart', found.uuid, ...viewer], 45_000);
      current = d.session ? one(d) : current;
      opened = true;
    }
  }
  db.prepare('UPDATE lists SET session_rev = ? WHERE id = ?').run(current.rev ?? null, lid);
  res.json({ session: current, created: false, added, removed: drop.length, skipped, opened });
});

// What a drop, a paste or a link means: Shelf book links (#/read/12), file:// links, paths inside the library,
// a folder (all its books), and file names of files dragged in from the desktop (matched by name and size).
app.post('/api/resolve', (req, res) => {
  const texts = (Array.isArray(req.body?.texts) ? req.body.texts : []).filter((t: unknown): t is string => typeof t === 'string').slice(0, 500);
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).filter((f: any) => f && typeof f.name === 'string').slice(0, 500) as Array<{ name: string; size?: number }>;
  const ids = new Set<number>();
  const unknown: string[] = [];
  const byId = db.prepare('SELECT id FROM books WHERE id = ? AND missing = 0');
  const byPath = db.prepare('SELECT id FROM books WHERE path = ? AND missing = 0');
  const inDir = db.prepare("SELECT id FROM books WHERE missing = 0 AND (dir = ? OR dir LIKE ? ESCAPE '\\') ORDER BY path");
  const byName = db.prepare('SELECT id, size FROM books WHERE missing = 0 AND lower(filename) = lower(?)');
  for (let raw of texts) {
    raw = raw.trim();
    if (!raw) continue;
    let hit = false;
    const idm = /#\/read\/(\d+)|\/api\/books\/(\d+)(?:\/|$|\?)/.exec(raw);
    if (idm && /^(https?:\/\/|\/|#)/.test(raw)) {
      try {
        const u = raw.startsWith('http') ? new URL(raw) : null;
        if (u && req.headers.host && u.host !== req.headers.host) throw new Error('another server');
      } catch {
        unknown.push(raw);
        continue;
      }
      const id = Number(idm[1] ?? idm[2]);
      if (byId.get(id)) ids.add(id);
      else unknown.push(raw);
      continue;
    }
    let p = raw;
    if (/^file:\/\//i.test(raw)) {
      try { p = decodeURIComponent(new URL(raw).pathname); } catch { unknown.push(raw); continue; }
    }
    p = p.replace(/^["']|["']$/g, '');
    let rel = path.isAbsolute(p) ? path.relative(LIBRARY_DIR, path.normalize(p)) : p.replace(/^\.\//, '');
    if (HOST_LIBRARY && path.isAbsolute(p) && rel.startsWith('..')) rel = path.relative(HOST_LIBRARY, path.normalize(p));
    rel = rel.split(path.sep).join('/').replace(/\/+$/, '');
    if (rel && !rel.startsWith('..')) {
      const b = byPath.get(rel) as { id: number } | undefined;
      if (b) { ids.add(b.id); hit = true; }
      else for (const r of inDir.all(rel, likeEsc(rel) + '/%') as Array<{ id: number }>) { ids.add(r.id); hit = true; }
    }
    if (!hit) unknown.push(raw);
  }
  for (const f of files) {
    const rows = byName.all(f.name) as Array<{ id: number; size: number }>;
    const exact = rows.filter((r) => r.size === f.size);
    const pick = exact.length === 1 ? exact : rows.length === 1 ? rows : [];
    if (pick.length) ids.add(pick[0].id);
    else unknown.push(f.name);
  }
  res.json({ bookIds: [...ids], unknown });
});

// ---------- reading progress ----------

app.put('/api/books/:id/progress', async (req, res) => {
  const book = getBook(req.params.id);
  const byFrac = book.format === 'epub' && req.body?.page === undefined && typeof req.body?.frac === 'number' && Number.isFinite(req.body.frac);
  let page = byFrac ? 1 : toInt(req.body?.page);
  let at: number | null = null; // EPUB, told only how far through the book: which section and where in it
  if (byFrac) {
    const st = await epubStructure(`${book.id}:${book.fingerprint}`, absPath(book)).catch(() => null);
    const chars = st?.chars ?? [];
    const all = chars.reduce((x, y) => x + y, 0);
    if (all > 0) {
      const target = Math.min(1, Math.max(0, req.body.frac)) * all;
      let acc = 0;
      for (let k = 0; k < chars.length; k++) {
        if (target < acc + chars[k] || k === chars.length - 1) { page = k + 1; at = chars[k] ? Math.min(1, Math.max(0, (target - acc) / chars[k])) : 0; break; }
        acc += chars[k];
      }
    }
  }
  if (page < 1) page = 1;
  if (book.format !== 'epub' && book.pages && page > book.pages) page = book.pages; // (an EPUB's page is a section number)
  // EPUB: where inside the section (0..1), and how far through the whole book. Other formats don't send them.
  const unit = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  const pos = at ?? unit(req.body?.pos);
  let frac = unit(req.body?.frac);
  if (frac === null && book.format === 'epub' && pos !== null) {
    // A client that only knows (section, spot): work out how far through the book that is.
    const st = await epubStructure(`${book.id}:${book.fingerprint}`, absPath(book)).catch(() => null);
    if (st?.chars) {
      const i = Math.min(page, st.chars.length) - 1;
      const all = st.chars.reduce((x, y) => x + y, 0);
      frac = Math.min(1, (st.chars.slice(0, i).reduce((x, y) => x + y, 0) + pos * st.chars[i]) / all);
    }
  }
  db.prepare('UPDATE books SET progress_page = ?, progress_pos = ?, progress_frac = ?, progress_at = ? WHERE id = ?').run(page, pos, frac, Date.now(), book.id);
  res.json({ page, pos, frac });
});

app.delete('/api/books/:id/progress', (req, res) => {
  const book = getBook(req.params.id);
  db.prepare('UPDATE books SET progress_page = 0, progress_pos = NULL, progress_frac = NULL, progress_at = NULL WHERE id = ?').run(book.id);
  res.json({ ok: true });
});

// ---------- tags ----------

const TAG_SQL = `
  SELECT t.id, t.name, t.color,
         (SELECT COUNT(*) FROM book_tags bt JOIN books b ON b.id = bt.book_id
          WHERE bt.tag_id = t.id AND b.missing = 0) AS count
  FROM tags t`;

function cleanName(v: unknown, max = 80): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new HttpError(400, 'name is required');
  return s.slice(0, max);
}
const cleanColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);

app.get('/api/tags', (_req, res) => {
  const tags = db.prepare(TAG_SQL).all() as Array<{ name: string }>;
  tags.sort((a, b) => natCompare(a.name, b.name));
  res.json(tags);
});

app.post('/api/tags', (req, res) => {
  const name = cleanName(req.body?.name);
  db.prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)').run(name, cleanColor(req.body?.color));
  res.json(db.prepare(`${TAG_SQL} WHERE t.name = ?`).get(name));
});

app.patch('/api/tags/:id', (req, res) => {
  const id = toInt(req.params.id);
  const cur = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as { name: string; color: string | null } | undefined;
  if (!cur) throw new HttpError(404, 'tag not found');
  const name = req.body?.name !== undefined ? cleanName(req.body.name) : cur.name;
  const color = req.body?.color !== undefined ? cleanColor(req.body.color) : cur.color;
  try {
    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
  } catch {
    throw new HttpError(409, 'a tag with that name already exists');
  }
  res.json(db.prepare(`${TAG_SQL} WHERE t.id = ?`).get(id));
});

app.delete('/api/tags/:id', (req, res) => {
  db.prepare('DELETE FROM tags WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

// One endpoint for tagging one or many books: add existing tags, add-or-create by name, remove.
app.post('/api/bulk/tags', (req, res) => {
  const bookIds = intArray(req.body?.bookIds);
  const add = intArray(req.body?.add);
  const remove = intArray(req.body?.remove);
  const addNames: string[] = Array.isArray(req.body?.addNames) ? req.body.addNames.map((n: unknown) => cleanName(n)) : [];
  const created: unknown[] = [];

  db.transaction(() => {
    for (const name of addNames) {
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
      const t = db.prepare(`${TAG_SQL} WHERE t.name = ?`).get(name) as { id: number };
      add.push(t.id);
      created.push(t);
    }
    const ins = db.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM book_tags WHERE book_id = ? AND tag_id = ?');
    const exists = db.prepare('SELECT 1 FROM books WHERE id = ?');
    for (const b of bookIds) {
      if (!exists.get(b)) continue;
      for (const t of add) ins.run(b, t);
      for (const t of remove) del.run(b, t);
    }
  })();
  res.json({ ok: true, created });
});

// ---------- reading lists ----------

const LIST_SQL = `
  SELECT l.id, l.name, l.created_at AS createdAt, l.session_uuid AS sessionUuid, l.session_rev AS sessionRev,
         (SELECT COUNT(*) FROM list_items li JOIN books b ON b.id = li.book_id
          WHERE li.list_id = l.id AND b.missing = 0) AS count
  FROM lists l`;

app.get('/api/lists', (_req, res) => {
  const lists = db.prepare(LIST_SQL).all() as Array<{ name: string }>;
  lists.sort((a, b) => natCompare(a.name, b.name));
  res.json(lists);
});

app.post('/api/lists', (req, res) => {
  const name = cleanName(req.body?.name);
  const info = db.prepare('INSERT INTO lists (name, created_at) VALUES (?, ?)').run(name, Date.now());
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/lists/:id', (req, res) => {
  const id = toInt(req.params.id);
  db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(cleanName(req.body?.name), id);
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id));
});

app.delete('/api/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/lists/:id/items', (req, res) => {
  const id = toInt(req.params.id);
  if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(id)) throw new HttpError(404, 'list not found');
  const bookIds = intArray(req.body?.bookIds);
  db.transaction(() => {
    let pos = (db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM list_items WHERE list_id = ?').get(id) as { p: number }).p + 1;
    const ins = db.prepare('INSERT OR IGNORE INTO list_items (list_id, book_id, position) VALUES (?, ?, ?)');
    const exists = db.prepare('SELECT 1 FROM books WHERE id = ?');
    const fresh: number[] = [];
    for (const b of bookIds) {
      if (exists.get(b) && ins.run(id, b, pos).changes) {
        pos++;
        fresh.push(b);
      }
    }
    // Dropped between two cards: put the new ones there instead of at the end.
    if (Number.isInteger(req.body?.at) && fresh.length) {
      const order = (db.prepare('SELECT book_id FROM list_items WHERE list_id = ? ORDER BY position').all(id) as Array<{ book_id: number }>).map((r) => r.book_id).filter((b) => !fresh.includes(b));
      order.splice(Math.max(0, Math.min(order.length, req.body.at)), 0, ...fresh);
      const upd = db.prepare('UPDATE list_items SET position = ? WHERE list_id = ? AND book_id = ?');
      order.forEach((b, i) => upd.run(i, id, b));
    }
  })();
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id));
});

app.post('/api/lists/:id/copy', (req, res) => {
  const id = toInt(req.params.id);
  const l = db.prepare('SELECT name FROM lists WHERE id = ?').get(id) as { name: string } | undefined;
  if (!l) throw new HttpError(404, 'list not found');
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? cleanName(req.body.name) : `${l.name} (copy)`.slice(0, 80);
  let nid = 0;
  db.transaction(() => {
    nid = Number(db.prepare('INSERT INTO lists (name, created_at) VALUES (?, ?)').run(name, Date.now()).lastInsertRowid);
    db.prepare('INSERT INTO list_items (list_id, book_id, position) SELECT ?, book_id, position FROM list_items WHERE list_id = ?').run(nid, id);
  })();
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(nid));
});

app.post('/api/lists/:id/unlink', (req, res) => {
  const id = toInt(req.params.id);
  db.prepare('UPDATE lists SET session_uuid = NULL, session_rev = NULL WHERE id = ?').run(id);
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id));
});

app.post('/api/lists/:id/items/remove', (req, res) => {
  const id = toInt(req.params.id);
  const del = db.prepare('DELETE FROM list_items WHERE list_id = ? AND book_id = ?');
  db.transaction(() => intArray(req.body?.bookIds).forEach((b) => del.run(id, b)))();
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id));
});

app.delete('/api/lists/:id/items/:bookId', (req, res) => {
  db.prepare('DELETE FROM list_items WHERE list_id = ? AND book_id = ?').run(toInt(req.params.id), toInt(req.params.bookId));
  res.json({ ok: true });
});

// Which lists contain these books? (for the "add to list" picker)
app.get('/api/lists-for-books', (req, res) => {
  const ids = idList(req.query.ids);
  const rows = ids.length
    ? (db
        .prepare(`SELECT list_id, book_id FROM list_items WHERE book_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as Array<{ list_id: number; book_id: number }>)
    : [];
  res.json(rows);
});

app.put('/api/lists/:id/order', (req, res) => {
  const id = toInt(req.params.id);
  const order = intArray(req.body?.bookIds);
  db.transaction(() => {
    const upd = db.prepare('UPDATE list_items SET position = ? WHERE list_id = ? AND book_id = ?');
    order.forEach((bookId, i) => upd.run(i, id, bookId));
  })();
  res.json({ ok: true });
});

// ---------- annotations: highlights + notes, stored inside the PDF itself ----------

const cleanText = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

function pdfOf(idParam: unknown): { book: BookRow; abs: string } {
  const book = getBook(idParam);
  if (book.format !== 'pdf') throw new HttpError(400, 'highlights and notes are only available for PDF files (comics and EPUBs have no standard way to store them)');
  return { book, abs: absPath(book) };
}

/** Our own write changed the file; tell the index so the next scan doesn't see a stranger. */
async function afterWrite(book: BookRow, abs: string, w: { size: number; mtimeMs: number }) {
  const fp = await fingerprint(abs, w.size);
  const fid = await pdfFileId(abs, w.size);
  db.prepare("UPDATE books SET size = ?, mtime_ms = ?, fingerprint = ?, file_id = COALESCE(NULLIF(?, ''), file_id, '') WHERE id = ?").run(w.size, w.mtimeMs, fp, fid, book.id);
  return { size: w.size, fingerprint: fp };
}

function notesGuard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof NotesError) throw new HttpError(e.status, e.message);
    throw e;
  });
}

app.get('/api/books/:id/annotations', (req, res) => {
  const { abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  try {
    res.json({ ...caps, supported: true, items: listNotes(abs) });
  } catch (e) {
    if (e instanceof NotesError) return void res.json({ canWrite: false, reason: e.message, supported: false, items: [] });
    throw e;
  }
});

app.post('/api/books/:id/annotations', async (req, res) => {
  const { book, abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  if (!caps.canWrite) throw new HttpError(403, `can't save into this file: ${caps.reason}`);
  const kind = req.body?.kind;
  if (kind !== 'highlight' && kind !== 'note' && kind !== 'ink') throw new HttpError(400, 'kind must be "highlight", "note" or "ink"');
  const page = toInt(req.body?.page);
  if (page < 1 || (book.pages && page > book.pages)) throw new HttpError(400, 'page out of range');
  const note = cleanText(req.body?.note, 20000);
  let rects: number[][] | undefined;
  let point: [number, number] | undefined;
  let strokes: number[][][] | undefined;
  let width: number | undefined;
  if (kind === 'ink') {
    strokes = normStrokes(req.body?.strokes);
    if (!strokes.length) throw new HttpError(400, 'a drawing needs at least one stroke with two points');
    width = Math.min(0.03, Math.max(0.0005, Number(req.body?.width) || 0.004));
  } else if (kind === 'highlight') {
    rects = normRects(req.body?.rects);
    if (!rects.length) throw new HttpError(400, 'a highlight needs at least one rectangle');
  } else {
    if (!note) throw new HttpError(400, 'a note needs text');
    const p = Array.isArray(req.body?.point) ? req.body.point.map(Number) : [0.05, 0.05];
    point = [Math.min(0.97, Math.max(0, p[0] || 0)), Math.min(0.97, Math.max(0, p[1] || 0))];
  }
  const w = await notesGuard(() => addNote(abs, { page, kind, color: cleanHex(req.body?.color), rects, point, strokes, width, note }));
  res.json({ page: w.page, ...(await afterWrite(book, abs, w)) });
});

app.patch('/api/books/:id/annotations/:ref', async (req, res) => {
  const { book, abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  if (!caps.canWrite) throw new HttpError(403, `can't save into this file: ${caps.reason}`);
  const patch: { note?: string | null; color?: string } = {};
  if (req.body?.note !== undefined) patch.note = cleanText(req.body.note, 20000);
  if (req.body?.color !== undefined) patch.color = cleanHex(req.body.color);
  const w = await notesGuard(() => updateNote(abs, toInt(req.body?.page), toInt(req.params.ref), patch));
  res.json({ page: w.page, ...(await afterWrite(book, abs, w)) });
});

app.delete('/api/books/:id/annotations/:ref', async (req, res) => {
  const { book, abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  if (!caps.canWrite) throw new HttpError(403, `can't save into this file: ${caps.reason}`);
  const w = await notesGuard(() => deleteNote(abs, toInt(req.query.page), toInt(req.params.ref)));
  res.json({ page: w.page, ...(await afterWrite(book, abs, w)) });
});

const normStrokes = (v: unknown): number[][][] => {
  if (!Array.isArray(v)) return [];
  const out: number[][][] = [];
  for (const st of v.slice(0, 200)) {
    if (!Array.isArray(st)) continue;
    const pts: number[][] = [];
    for (const p of st.slice(0, 3000)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]), y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out;
};

const normRects = (v: unknown): number[][] => {
  if (!Array.isArray(v)) return [];
  const out: number[][] = [];
  for (const r of v.slice(0, 300)) {
    if (!Array.isArray(r) || r.length !== 4) continue;
    const [x, y, w, h] = r.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const cx = Math.min(1, Math.max(0, x)), cy = Math.min(1, Math.max(0, y));
    const cw = Math.min(1 - cx, Math.max(0, w)), ch = Math.min(1 - cy, Math.max(0, h));
    if (cw > 0.0005 && ch > 0.0005) out.push([cx, cy, cw, ch]);
  }
  return out;
};

// ---------- external readers ("Open with ...") ----------

type Scope = 'books' | 'lists';
interface ReaderRow { id: number; name: string; command: string; scope: Scope }
const READERS_SQL = 'SELECT id, name, command, scope FROM readers ORDER BY position, id';
const READER_ONE = 'SELECT id, name, command, scope FROM readers WHERE id = ?';
const cleanScope = (v: unknown): Scope => {
  if (v === undefined || v === 'books') return 'books';
  if (v === 'lists') return 'lists';
  throw new HttpError(400, 'scope must be "books" or "lists"');
};

function cleanCommand(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, 'command is required');
  if (s.length > 1000) throw new HttpError(400, 'command is too long');
  try {
    parseTemplate(s);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return s;
}
const readerDTO = (r: ReaderRow) => ({ ...r, takesMany: parseTemplate(r.command).takesMany });

app.get('/api/readers', (_req, res) => {
  res.json((db.prepare(READERS_SQL).all() as ReaderRow[]).map(readerDTO));
});

app.post('/api/readers', (req, res) => {
  const name = cleanName(req.body?.name, 60);
  const command = cleanCommand(req.body?.command);
  const scope = cleanScope(req.body?.scope);
  const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM readers').get() as { p: number }).p;
  const info = db.prepare('INSERT INTO readers (name, command, position, scope) VALUES (?, ?, ?, ?)').run(name, command, pos, scope);
  res.json(readerDTO(db.prepare(READER_ONE).get(info.lastInsertRowid) as ReaderRow));
});

app.patch('/api/readers/:id', (req, res) => {
  const id = toInt(req.params.id);
  const cur = db.prepare(READER_ONE).get(id) as ReaderRow | undefined;
  if (!cur) throw new HttpError(404, 'reader not found');
  const name = req.body?.name !== undefined ? cleanName(req.body.name, 60) : cur.name;
  const command = req.body?.command !== undefined ? cleanCommand(req.body.command) : cur.command;
  db.prepare('UPDATE readers SET name = ?, command = ? WHERE id = ?').run(name, command, id);
  res.json(readerDTO({ id, name, command, scope: cur.scope }));
});

app.delete('/api/readers/:id', (req, res) => {
  db.prepare('DELETE FROM readers WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

// Only ever runs a command YOU saved above. The request just says which saved reader and which books.
app.post('/api/readers/:id/open', async (req, res) => {
  const viaHelper = IN_DOCKER;
  if (viaHelper && (!OPENER_SOCKET || !HOST_LIBRARY)) {
    throw new HttpError(409, "Shelf is running in Docker without the desktop helper, so it can't start programs on your computer. Start it with ./shelf.sh start (that also starts the helper).");
  }
  const reader = db.prepare(READER_ONE).get(toInt(req.params.id)) as ReaderRow | undefined;
  if (!reader) throw new HttpError(404, 'reader not found');
  // Programs for books and for reading lists are separate sets.
  const wanted: Scope = req.body?.listId !== undefined ? 'lists' : 'books';
  if (reader.scope !== wanted) throw new HttpError(400, `“${reader.name}” is set up for ${reader.scope === 'lists' ? 'reading lists' : 'books'}, not for ${wanted === 'lists' ? 'reading lists' : 'books'}`);

  let books: BookRow[];
  if (req.body?.listId !== undefined) {
    books = db
      .prepare('SELECT b.* FROM list_items li JOIN books b ON b.id = li.book_id WHERE li.list_id = ? AND b.missing = 0 ORDER BY li.position')
      .all(toInt(req.body.listId)) as BookRow[];
  } else {
    const ids = intArray(req.body?.bookIds);
    const get = db.prepare('SELECT * FROM books WHERE id = ? AND missing = 0');
    books = ids.map((id) => get.get(id) as BookRow | undefined).filter((b): b is BookRow => !!b);
  }
  if (!books.length) throw new HttpError(400, 'nothing to open');
  if (books.length > 500) throw new HttpError(400, 'too many files (limit 500)');
  const existing = books.filter((b) => fs.existsSync(absPath(b)));
  const files = existing.map(absPath);
  if (!files.length) throw new HttpError(404, 'the files are not on disk; try rescanning');

  // From Docker the program runs on the host, so it needs the host's idea of where the files are.
  const toHost = (f: string) => (viaHelper ? path.join(HOST_LIBRARY, path.relative(LIBRARY_DIR, f)) : f);
  const targets = files.map(toHost);
  // {page}: where each book was left off, as the library stores it. An EPUB has no fixed pages, so its page is
  // the estimate the reader shows (how far through the book, over about 1800 characters a page). A single book
  // opened from the reader can bring the page you are looking at right now.
  const live = books.length === 1 && Number.isInteger(req.body?.page) && req.body.page > 0 ? (req.body.page as number) : 0;
  const leftAt = (b: BookRow) => (b.format === 'epub' ? Math.ceil((b.progress_frac ?? 0) * (b.pages ?? 0)) : b.progress_page);
  const pages = existing.map((b, i) => (i === 0 && live ? live : Math.max(1, leftAt(b))));
  let argv: string[];
  try {
    argv = buildArgv(reader.command, targets, { expandHome: !viaHelper, pages }); // the helper expands ~ for the host
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  try {
    if (viaHelper) await launchViaHelper(OPENER_SOCKET, argv, path.dirname(targets[0]));
    else await launch(argv, path.dirname(files[0]));
  } catch (e) {
    const m = (e as Error).message;
    if (m === 'OPENER_DOWN') {
      throw new HttpError(409, "The desktop helper isn't running (it stops when the computer restarts). Run ./shelf.sh start again on your computer and retry.");
    }
    throw new HttpError(502, `${reader.name}: ${m}`);
  }
  res.json({ launched: files.length, skipped: books.length - files.length });
});

// ---------- storage & backup ----------

app.get('/api/storage', async (_req, res) => res.json(await storageStats()));

// A consistent copy of the whole database (tags, lists, progress, programs), safe to take while running.
// Readable export of the things you made in Shelf (tags, lists, progress, programs) plus the book index.
// Books are identified by path AND content fingerprint, so it can be matched to files that were moved.
// Highlights/notes/drawings are inside the PDFs and display settings are in the browser (the page
// adds those to the file it downloads), so neither is in here.
// ---------- display settings (kept in the shelf's own data so every browser agrees) ----------

const SETTINGS_KEY = 'settings';
type Settings = Record<string, string | number | boolean>;
function readSettings(): Settings {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
  try {
    const o = row ? JSON.parse(row.value) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
const writeSettings = (o: Settings) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTINGS_KEY, JSON.stringify(o));

/** Only plain, small values under sane names; the server doesn't need to know which settings exist. */
function cleanSettings(body: unknown): Record<string, string | number | boolean | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected an object of settings');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) throw new HttpError(400, `bad setting name "${k}"`);
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 100)) out[k] = v;
    else throw new HttpError(400, `bad value for "${k}"`);
  }
  if (Object.keys(out).length > 80) throw new HttpError(400, 'too many settings');
  return out;
}

app.get('/api/settings', (_req, res) => res.json(readSettings()));
// Merge: a null value removes that key (back to its default).
app.patch('/api/settings', (req, res) => {
  const cur: Record<string, unknown> = readSettings();
  for (const [k, v] of Object.entries(cleanSettings(req.body))) {
    if (v === null) delete cur[k];
    else cur[k] = v;
  }
  if (Object.keys(cur).length > 80) throw new HttpError(400, 'too many settings');
  writeSettings(cur as Settings);
  res.json(cur);
});
// Replace everything ({} resets all display settings).
app.put('/api/settings', (req, res) => {
  const next = Object.fromEntries(Object.entries(cleanSettings(req.body)).filter(([, v]) => v !== null)) as Settings;
  writeSettings(next);
  res.json(next);
});

app.get('/api/export', (_req, res) => {
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
  const all = db.prepare('SELECT * FROM books ORDER BY path').all() as BookRow[];
  const tagRows = db.prepare('SELECT id, name, color FROM tags ORDER BY name').all() as Array<{ id: number; name: string; color: string | null }>;
  const tagName = new Map(tagRows.map((t) => [t.id, t.name]));
  const tagsOf = new Map<number, string[]>();
  for (const r of db.prepare('SELECT book_id, tag_id FROM book_tags').all() as Array<{ book_id: number; tag_id: number }>) {
    const n = tagName.get(r.tag_id);
    if (n) (tagsOf.get(r.book_id) ?? tagsOf.set(r.book_id, []).get(r.book_id)!).push(n);
  }
  const listRows = db.prepare('SELECT id, name, created_at FROM lists ORDER BY id').all() as Array<{ id: number; name: string; created_at: number }>;
  const listName = new Map(listRows.map((l) => [l.id, l.name]));
  const byId = new Map(all.map((b) => [b.id, b]));
  const items = db.prepare('SELECT list_id, book_id FROM list_items ORDER BY list_id, position').all() as Array<{ list_id: number; book_id: number }>;
  const inLists = new Map<number, string[]>();
  const listBooks = new Map<number, unknown[]>();
  for (const it of items) {
    const b = byId.get(it.book_id);
    if (!b) continue;
    (listBooks.get(it.list_id) ?? listBooks.set(it.list_id, []).get(it.list_id)!).push({ path: b.path, title: b.title, fingerprint: b.fingerprint, ...(b.missing ? { missing: true } : {}) });
    (inLists.get(b.id) ?? inLists.set(b.id, []).get(b.id)!).push(listName.get(it.list_id) ?? '?');
  }
  res.json({
    format: 'shelf-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    name: SHELF_NAME || undefined,
    tags: tagRows.map((t) => ({ name: t.name, color: t.color, books: all.filter((b) => tagsOf.get(b.id)?.includes(t.name)).length })),
    lists: listRows.map((l) => ({ name: l.name, createdAt: iso(l.created_at), books: listBooks.get(l.id) ?? [] })),
    settings: readSettings(),
    programs: (db.prepare(READERS_SQL).all() as ReaderRow[]).map((r) => ({ name: r.name, command: r.command, scope: r.scope })),
    books: all.map((b) => ({
      path: b.path,
      fingerprint: b.fingerprint,
      title: b.title,
      author: b.author,
      series: b.series,
      number: b.number,
      format: b.format,
      pages: b.pages,
      size: b.size,
      ...(b.missing ? { missing: true } : {}),
      tags: tagsOf.get(b.id) ?? [],
      lists: inLists.get(b.id) ?? [],
      progress: b.progress_page || b.progress_at ? { page: b.progress_page, ...(b.progress_pos != null ? { pos: b.progress_pos } : {}), at: iso(b.progress_at) } : null,
    })),
  });
});

// To restore: stop Shelf, replace shelf.db in the data folder with this file (and delete shelf.db-wal / -shm).
app.get('/api/backup', async (_req, res, next) => {
  const tmp = path.join(DATA_DIR, `backup-${Date.now()}.tmp`);
  try {
    await db.backup(tmp);
  } catch (e) {
    return next(e);
  }
  const day = new Date().toISOString().slice(0, 10);
  res.download(tmp, `shelf-backup-${day}.db`, { dotfiles: 'allow' }, () => fs.rm(tmp, { force: true }, () => {}));
});

// ---------- scan, stats, info ----------

app.post('/api/scan', (req, res) => res.status(202).json(startScan(req.query.full === '1')));
app.get('/api/scan', (_req, res) => res.json(scanState));

// Books whose files are gone: what Shelf still remembers about each, and any present book that might be it.
app.get('/api/missing', (_req, res) => {
  const rows = db.prepare('SELECT * FROM books WHERE missing = 1 ORDER BY COALESCE(missing_at, 0) DESC, path').all() as BookRow[];
  const tagsOf = db.prepare('SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id = ? ORDER BY t.name');
  const listsOf = db.prepare('SELECT l.id, l.name FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.book_id = ? ORDER BY l.name');
  const like = db.prepare(`SELECT id, path, title, filename, size, format, pages, meta_title, file_id FROM books
    WHERE missing = 0 AND format = @format AND (
      (@fid != '' AND file_id = @fid) OR lower(filename) = lower(@filename) OR size = @size
      OR (@pages IS NOT NULL AND pages = @pages AND lower(title) = lower(@title)))
    LIMIT 40`);
  // Present books that could be this one, with the reasons, strongest first.
  const candidates = (b: BookRow) => {
    const out = (like.all({ format: b.format, fid: b.file_id ?? '', filename: b.filename, size: b.size, pages: b.pages, title: b.title }) as Array<BookRow>).map((c) => {
      const reasons: string[] = [];
      let score = 0;
      if (b.file_id && c.file_id === b.file_id) { reasons.push('same PDF ID'); score += 8; }
      if (b.pages != null && c.pages === b.pages && c.title.toLowerCase() === b.title.toLowerCase()) { reasons.push('same title and page count'); score += 4; }
      if (c.filename.toLowerCase() === b.filename.toLowerCase()) { reasons.push('same file name'); score += 2; }
      if (c.size === b.size) { reasons.push('same size'); score += 1; }
      return { id: c.id, path: c.path, reasons, score };
    });
    return out.filter((c) => c.reasons.length).sort((a, b2) => b2.score - a.score).slice(0, 4).map(({ score: _s, ...c }) => c);
  };
  res.json(
    rows.map((b) => ({
      id: b.id,
      path: b.path,
      filename: b.filename,
      title: b.title,
      format: b.format,
      size: b.size,
      fingerprint: b.fingerprint,
      addedAt: b.added_at,
      missingAt: b.missing_at ?? null,
      tags: (tagsOf.all(b.id) as Array<{ name: string }>).map((t) => t.name),
      lists: listsOf.all(b.id) as Array<{ id: number; name: string }>,
      progress: b.progress_page ? { page: b.progress_page, pages: b.pages, at: b.progress_at } : null,
      maybe: candidates(b),
    })),
  );
});
// "These are the same book": carry the missing one's tags, lists and progress over to a present one.
app.post('/api/missing/:id/merge', async (req, res) => {
  const into = toInt(req.body?.into);
  try {
    await mergeMissing(toInt(req.params.id), into);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
  res.json({ ok: true, into });
});
app.post('/api/purge-missing', async (req, res) => res.json({ removed: await purgeMissing(Array.isArray(req.body?.ids) ? intArray(req.body.ids) : undefined) }));

app.get('/api/info', async (_req, res) => {
  const counts = db
    .prepare(`SELECT format, COUNT(*) AS n FROM books WHERE missing = 0 GROUP BY format`)
    .all() as Array<{ format: string; n: number }>;
  res.json({
    name: SHELF_NAME,
    auth: AUTH_ON,
    libraryDir: LIBRARY_DIR,
    docker: IN_DOCKER,
    opener: IN_DOCKER ? !!OPENER_SOCKET && (await helperAlive(OPENER_SOCKET)) : true,
    readOnly: READONLY,
    sessions: sessionsOn(),
    sessionsConfigured: SESSIONS_CMD.length > 0,
    sessionsCommand: SESSIONS_CMD.join(' '),
    display: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    tools: await toolsAvailable(),
    missing: (db.prepare('SELECT COUNT(*) AS n FROM books WHERE missing = 1').get() as { n: number }).n,
    byFormat: Object.fromEntries(counts.map((c) => [c.format, c.n])),
  });
});

// ---------- static ----------

const vendor = (name: string) =>
  app.use(`/vendor/pdfjs/${name}`, express.static(path.join(PDFJS_DIR, name), { maxAge: '7d' }));
['build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'].forEach(vendor);
app.use(express.static(path.join(ROOT, 'public')));

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not found')));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError || err instanceof SessionError ? err.status : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err instanceof Error ? err.message : 'server error', ...(err instanceof SessionError ? { code: err.code, currentRev: err.currentRev } : {}) });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`shelf: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`library: ${LIBRARY_DIR}`);
  if (AUTH_ON) console.log('pass key: required to open Shelf');
  else if (!/^(127\.|localhost$|::1$)/.test(HOST)) console.warn(`WARNING: listening on ${HOST} with no pass key: anyone who can reach this port can read your books. Set SHELF_PASSKEY (or "passkey" in the shelf file).`);
  startScan();
});

// `docker stop` sends SIGTERM; without a handler a container's main process ignores it and gets
// killed after 10 seconds. Close cleanly so the database is flushed.
function shutdown() {
  server.close();
  server.closeAllConnections();
  try {
    checkpoint();
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
