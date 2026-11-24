import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIBRARY_DIR } from './config.js';
import { db } from './db.js';

// Deleting never removes anything: books and folders are moved into a trash folder inside the library
// (so it is on the same drive, and an encrypted library keeps its trash inside the encryption). The
// scan skips it because its name starts with a dot. To undo, move the item back out; Shelf recognises it
// by its content and its tags, lists and reading progress come back with it. Emptying the trash is up to you (Shelf never does it).
// Settings > Trash lists what is in there and puts items back where they were. Each item is also noted in the database (which
// folder it went into and its original path), so a folder that was trashed shows as one item and not as all its books.

export const TRASH_DIR = '.shelf-trash';

export interface TrashResult {
  trashed: number;
  failed: Array<{ path: string; error: string }>;
  /** Library-relative folder the items went into. */
  into: string;
}

const stampNow = () => new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

/** Moves library-relative paths (files or folders) into the trash, keeping their folder structure inside it. */
export async function moveToTrash(rels: string[]): Promise<TrashResult> {
  const clean = [...new Set(rels.map((r) => path.posix.normalize(r.replace(/\\/g, '/')).replace(/\/+$/, '')))].filter((r) => r && r !== '.');
  // An item inside another item of the batch goes along with it.
  const top = clean.filter((r) => !clean.some((o) => o !== r && r.startsWith(o + '/')));
  const into = path.posix.join(TRASH_DIR, `${stampNow()}-${crypto.randomBytes(2).toString('hex')}`);
  const failed: TrashResult['failed'] = [];
  let trashed = 0;
  for (const rel of top) {
    try {
      if (rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) throw new Error('not inside the library');
      if (rel === TRASH_DIR || rel.startsWith(TRASH_DIR + '/')) throw new Error('already in the trash');
      const abs = path.resolve(LIBRARY_DIR, rel);
      if (!abs.startsWith(LIBRARY_DIR + path.sep)) throw new Error('not inside the library');
      const st = await fs.lstat(abs); // it must exist
      const dest = path.resolve(LIBRARY_DIR, into, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(abs, dest);
      db.prepare('INSERT OR REPLACE INTO trash_items (batch, rel, is_dir, trashed_at) VALUES (?, ?, ?, ?)').run(path.posix.basename(into), rel, st.isDirectory() ? 1 : 0, Date.now());
      db.prepare(`UPDATE books SET missing = 1 WHERE path = ? OR substr(path, 1, ?) = ?`).run(rel, rel.length + 1, rel + '/');
      trashed++;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      failed.push({ path: rel, error: err.code === 'ENOENT' ? 'it is no longer there' : err.code === 'EACCES' || err.code === 'EPERM' ? "not allowed (the drive may be read-only)" : err.message });
    }
  }
  return { trashed, failed, into };
}

// ---------- what is in the trash, and putting it back ----------

export interface TrashItem {
  /** The dated folder inside the trash it is in. Together with `rel` this names the item. */
  batch: string;
  /** Where it was in the library. */
  rel: string;
  name: string;
  /** The library folder it was in. */
  dir: string;
  isDir: boolean;
  /** Bytes in it (all the files of a folder). */
  size: number;
  /** How many files (a folder) – 1 for a single book. */
  files: number;
  trashedAt: number;
  title: string | null;
  format: string | null;
  /** Something is already at the original place, so it can't be put back until that is moved. */
  blocked: boolean;
}

const BATCH = /^[A-Za-z0-9._-]+$/;
const trashRoot = () => path.resolve(LIBRARY_DIR, TRASH_DIR);

function batchTime(batch: string): number | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(batch);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/** Bytes and number of files under a path (capped, so a huge folder doesn't hold the listing up). */
async function measure(abs: string): Promise<{ size: number; files: number }> {
  let size = 0;
  let files = 0;
  let seen = 0;
  const stack = [abs];
  while (stack.length && seen < 20000) {
    const d = stack.pop()!;
    let ents: import('node:fs').Dirent[];
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      seen++;
      const f = path.join(d, e.name);
      if (e.isDirectory()) stack.push(f);
      else if (e.isFile()) {
        files++;
        try { size += (await fs.stat(f)).size; } catch { /* gone */ }
      }
    }
  }
  return { size, files };
}

export async function listTrash(): Promise<TrashItem[]> {
  const root = trashRoot();
  let batches: string[];
  try {
    batches = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory() && BATCH.test(e.name)).map((e) => e.name);
  } catch {
    return [];
  }
  const out: TrashItem[] = [];
  const known = new Map<string, Array<{ rel: string; is_dir: number; trashed_at: number }>>();
  for (const r of db.prepare('SELECT batch, rel, is_dir, trashed_at FROM trash_items').all() as Array<{ batch: string; rel: string; is_dir: number; trashed_at: number }>) {
    (known.get(r.batch) ?? known.set(r.batch, []).get(r.batch)!).push(r);
  }
  const bookOf = db.prepare('SELECT title, format, is_folder FROM books WHERE path = ?');
  const add = async (batch: string, rel: string, isDir: boolean, at: number) => {
    const abs = path.join(root, batch, rel);
    const m = isDir ? await measure(abs) : { size: (await fs.stat(abs).catch(() => null))?.size ?? 0, files: 1 };
    const b = bookOf.get(rel) as { title: string; format: string; is_folder: number } | undefined;
    const original = path.resolve(LIBRARY_DIR, rel);
    out.push({
      batch, rel, name: path.posix.basename(rel), dir: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), isDir, ...m, trashedAt: at,
      title: b?.title ?? null, format: b?.format ?? null,
      blocked: !!(await fs.lstat(original).catch(() => null)),
    });
  };
  for (const batch of batches) {
    const at = batchTime(batch) ?? (await fs.stat(path.join(root, batch)).catch(() => null))?.mtimeMs ?? 0;
    const covered: string[] = [];
    for (const r of known.get(batch) ?? []) {
      if (!(await fs.lstat(path.join(root, batch, r.rel)).catch(() => null))) {
        db.prepare('DELETE FROM trash_items WHERE batch = ? AND rel = ?').run(batch, r.rel); // moved out by hand since
        continue;
      }
      covered.push(r.rel);
      await add(batch, r.rel, !!r.is_dir, r.trashed_at || at);
    }
    // Anything in there that wasn't noted (trashed by an earlier version): each file on its own.
    const stack = ['']; 
    while (stack.length && out.length < 5000) {
      const d = stack.pop()!;
      let ents: import('node:fs').Dirent[];
      try { ents = await fs.readdir(path.join(root, batch, d), { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (covered.some((c) => rel === c || rel.startsWith(c + '/') || c.startsWith(rel + '/'))) {
          if (e.isDirectory() && covered.some((c) => c.startsWith(rel + '/'))) stack.push(rel); // a folder on the way to a noted item
          continue;
        }
        if (e.isDirectory()) stack.push(rel);
        else if (e.isFile()) await add(batch, rel, false, at);
      }
    }
  }
  return out.sort((a, b) => b.trashedAt - a.trashedAt || a.rel.localeCompare(b.rel));
}

export interface RestoreResult {
  restored: number;
  failed: Array<{ path: string; error: string }>;
}

/** Moves items back to where they were. Nothing is overwritten: if something is in the way, that item stays in the trash. */
export async function restoreFromTrash(items: Array<{ batch: string; rel: string }>): Promise<RestoreResult> {
  const root = trashRoot();
  const failed: RestoreResult['failed'] = [];
  let restored = 0;
  for (const it of items) {
    const rel = path.posix.normalize(String(it.rel ?? '').replace(/\\/g, '/')).replace(/\/+$/, '');
    try {
      if (!BATCH.test(String(it.batch ?? '')) || !rel || rel === '.' || rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) throw new Error('not an item of the trash');
      const src = path.resolve(root, it.batch, rel);
      const dest = path.resolve(LIBRARY_DIR, rel);
      if (!src.startsWith(root + path.sep) || !dest.startsWith(LIBRARY_DIR + path.sep) || dest === root || dest.startsWith(root + path.sep)) throw new Error('not an item of the trash');
      await fs.lstat(src);
      if (await fs.lstat(dest).catch(() => null)) throw new Error('something is already at its old place: move or rename that first');
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      db.prepare('DELETE FROM trash_items WHERE batch = ? AND rel = ?').run(it.batch, rel);
      restored++;
      // The folders it leaves empty behind it in the trash go too (they hold nothing).
      for (let d = path.dirname(src); d.startsWith(root + path.sep); d = path.dirname(d)) {
        try { await fs.rmdir(d); } catch { break; }
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      failed.push({ path: rel, error: err.code === 'ENOENT' ? 'it is no longer in the trash' : err.code === 'EACCES' || err.code === 'EPERM' ? 'not allowed (the drive may be read-only)' : err.message });
    }
  }
  return { restored, failed };
}
