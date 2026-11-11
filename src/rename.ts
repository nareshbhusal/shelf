import fs from 'node:fs/promises';
import path from 'node:path';
import { LIBRARY_DIR } from './config.js';
import { db, type BookRow } from './db.js';
import { titleFromFilename } from './util.js';

// Renaming is the one thing Shelf does to your library besides saving PDF notes. It is deliberately narrow:
//   - books only (never folders), and only the name: same folder, same extension;
//   - never overwrites, never replaces a file that is not part of the batch;
//   - the book keeps its id, so tags, lists, reading progress and covers carry over.

export interface RenameItem {
  id: number;
  /** New name without the extension (the extension is kept as it is). */
  name: string;
}

export interface RenamePlan {
  id: number;
  from: string; // library-relative path now
  to: string; // library-relative path after
  error?: string;
  unchanged?: boolean;
}

export class RenameError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const MAX_BYTES = 255; // what common file systems allow for one name
// Characters that are illegal on Windows-style drives (NTFS, exFAT, FAT): a library on a mounted
// drive can't take them, and they'd make the file unreadable elsewhere.
const BAD_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

/** Why `base` can't be a file name, or null when it can. */
export function nameProblem(base: string, ext: string): string | null {
  if (!base.trim()) return 'The name is empty.';
  if (base !== base.trim()) return 'The name starts or ends with a space.';
  if (/[. ]$/.test(base)) return 'The name ends with a dot or space (not allowed on Windows-style drives).';
  if (base === '.' || base === '..') return 'That is not a usable name.';
  const bad = base.match(BAD_CHARS);
  if (bad) return `The character ${JSON.stringify(bad[0]).slice(1, -1)} can't be used in a file name.`;
  if (Buffer.byteLength(base + ext) > MAX_BYTES) return 'The name is too long.';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return 'That name is reserved on Windows.';
  return null;
}

const key = (p: string) => p.normalize('NFC').toLowerCase(); // collide case-insensitively: the drive may be

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([fs.stat(a), fs.stat(b)]);
    return x.ino !== 0 && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

const rowsFor = (ids: number[]) => {
  const out = new Map<number, BookRow>();
  for (const id of ids) {
    const r = db.prepare('SELECT * FROM books WHERE id = ?').get(id) as BookRow | undefined;
    if (r) out.set(id, r);
  }
  return out;
};

/** Checks every requested rename without touching anything. */
export async function planRename(items: RenameItem[]): Promise<RenamePlan[]> {
  const rows = rowsFor(items.map((i) => i.id));
  const plans: RenamePlan[] = [];
  const seenIds = new Set<number>();
  for (const it of items) {
    const row = rows.get(it.id);
    if (!row) {
      plans.push({ id: it.id, from: '', to: '', error: 'This book is no longer in the library.' });
      continue;
    }
    const ext = path.posix.extname(row.filename);
    const base = String(it.name ?? '').normalize('NFC');
    const to = path.posix.join(row.dir, base + ext);
    const plan: RenamePlan = { id: it.id, from: row.path, to };
    if (seenIds.has(it.id)) plan.error = 'The same book is listed twice.';
    else if (row.missing) plan.error = 'The file is missing from the library right now.';
    else plan.error = nameProblem(base, ext) ?? undefined;
    seenIds.add(it.id);
    if (!plan.error && to === row.path) plan.unchanged = true;
    plans.push(plan);
  }

  // Two files of the batch may not end up with the same name; and a name must be free, unless the
  // file now holding it is itself part of the batch and moving away (swaps and shifts are fine).
  const movingFrom = new Set(plans.filter((p) => !p.error && !p.unchanged).map((p) => key(p.from)));
  const targets = new Map<string, number>();
  for (const p of plans) {
    if (p.error || p.unchanged) continue;
    const k = key(p.to);
    targets.set(k, (targets.get(k) ?? 0) + 1);
  }
  const indexed = new Map<string, number>(); // lowercased path -> book id, for everything Shelf knows
  for (const r of db.prepare('SELECT id, path FROM books WHERE missing = 0').all() as Array<{ id: number; path: string }>) indexed.set(key(r.path), r.id);

  for (const p of plans) {
    if (p.error || p.unchanged) continue;
    if ((targets.get(key(p.to)) ?? 0) > 1) {
      p.error = 'Another book in this batch gets the same name.';
      continue;
    }
    const abs = path.resolve(LIBRARY_DIR, p.to);
    if (!abs.startsWith(LIBRARY_DIR + path.sep)) {
      p.error = 'Bad path.';
      continue;
    }
    const owner = indexed.get(key(p.to));
    const freed = movingFrom.has(key(p.to));
    if (owner !== undefined && owner !== p.id && !freed) {
      p.error = 'A book with this name already exists in the folder.';
      continue;
    }
    if (!freed && key(p.to) !== key(p.from) && (await exists(abs))) {
      p.error = 'A file with this name already exists in the folder.';
      continue;
    }
    if (key(p.to) === key(p.from) && p.to !== p.from) continue; // only the capitalisation changes
    try {
      await fs.access(path.dirname(abs), fs.constants.W_OK);
    } catch {
      p.error = "The folder isn't writable.";
    }
  }
  return plans;
}

/**
 * Renames the files, then the index. All or nothing as far as the file system allows: if one rename
 * fails, the ones already done are put back and the error is reported.
 */
export async function applyRename(plans: RenamePlan[]): Promise<number> {
  const todo = plans.filter((p) => !p.error && !p.unchanged);
  if (!todo.length) return 0;
  const abs = (rel: string) => path.resolve(LIBRARY_DIR, rel);

  // A swap or a shift (a -> b while b -> c) needs the files to step aside first.
  const sources = new Set(todo.map((p) => key(p.from)));
  const chained = todo.some((p) => sources.has(key(p.to)) && key(p.to) !== key(p.from));
  const stamp = `.shelf-rename-${process.pid}-${Date.now().toString(36)}`;
  const done: Array<{ from: string; to: string }> = []; // undo log, in the order performed
  const move = async (from: string, to: string) => {
    await fs.rename(abs(from), abs(to));
    done.push({ from, to });
  };
  try {
    if (chained) {
      const temps = new Map<number, string>();
      for (const p of todo) {
        const tmp = path.posix.join(path.posix.dirname(p.from), `${stamp}-${p.id}`);
        await move(p.from, tmp);
        temps.set(p.id, tmp);
      }
      for (const p of todo) {
        if (await exists(abs(p.to))) throw new Error(`${p.to} appeared while renaming`);
        await move(temps.get(p.id)!, p.to);
      }
    } else {
      for (const p of todo) {
        // On a case-insensitive drive a capitalisation-only change finds "itself": that is fine.
        if (key(p.to) !== key(p.from) && (await exists(abs(p.to)))) throw new Error(`${p.to} appeared while renaming`);
        if (key(p.to) === key(p.from) && !(await sameFile(abs(p.from), abs(p.to))) && (await exists(abs(p.to)))) throw new Error(`${p.to} already exists`);
        await move(p.from, p.to);
      }
    }
  } catch (e) {
    for (const d of done.reverse()) await fs.rename(abs(d.to), abs(d.from)).catch(() => {});
    throw new RenameError(500, `Nothing was renamed: ${(e as NodeJS.ErrnoException).code ?? ''} ${(e as Error).message}`.replace('  ', ' '));
  }

  const upd = db.prepare(`UPDATE books SET path = ?, filename = ?, title = ? WHERE id = ?`);
  const park = db.prepare(`UPDATE books SET path = ? WHERE id = ?`);
  const getMeta = db.prepare(`SELECT meta_title FROM books WHERE id = ?`);
  db.transaction(() => {
    // Paths are unique in the index, so for a swap the rows step aside first, as the files did.
    if (chained) for (const p of todo) park.run(`${stamp}/${p.id}`, p.id);
    for (const p of todo) {
      const filename = path.posix.basename(p.to);
      const meta = (getMeta.get(p.id) as { meta_title: string | null } | undefined)?.meta_title;
      upd.run(p.to, filename, meta ?? titleFromFilename(filename), p.id);
    }
  })();
  return todo.length;
}
