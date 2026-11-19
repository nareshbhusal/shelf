import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, EXT_FORMAT, IGNORE, LIBRARY_DIR, type Format } from './config.js';
import { db, type BookRow } from './db.js';
import { cbzInfo, epubInfo, pdfMeta, type Meta } from './meta.js';
import { checkpoint, gcThumbs } from './hygiene.js';
import { fingerprint, mapPool, pdfFileId, titleFromFilename } from './util.js';
import { imageExt } from './zip.js';
import crypto from 'node:crypto';

export interface ScanState {
  running: boolean;
  phase: 'idle' | 'walking' | 'fingerprinting' | 'reading' | 'saving' | 'cleaning' | 'done';
  total: number;
  processed: number;
  added: number;
  moved: number;
  updated: number;
  missing: number;
  skipped: number;
  errors: number;
  thumbsRemoved: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
}

const blank = (): ScanState => ({
  running: false, phase: 'idle', total: 0, processed: 0, added: 0, moved: 0, updated: 0,
  missing: 0, skipped: 0, errors: 0, thumbsRemoved: 0, startedAt: null, finishedAt: null, error: null,
});

export let scanState: ScanState = blank();

interface Found {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
  format: Format;
  /** Set for a comic that is a folder of loose images: the images (name and size). rel/abs are the folder. */
  images?: Array<{ name: string; size: number }>;
}

/** A folder with at least this many loose images (and no book files beside them) is one comic. */
const MIN_FOLDER_PAGES = 3;

const toRel = (abs: string) => path.relative(LIBRARY_DIR, abs).split(path.sep).join('/');
const dirOf = (rel: string) => {
  const d = path.posix.dirname(rel);
  return d === '.' ? '' : d;
};

// Folders named in the shelf file's "ignore" list are not entered at all.
const IGNORE_NAMES = new Set(IGNORE.filter((e) => !e.includes('/')));
const IGNORE_PATHS = new Set(IGNORE.filter((e) => e.includes('/')));
// The data folder is never part of the library, even when it sits inside it (nothing to put in "ignore").
const ignored = (name: string, abs: string) => abs === DATA_DIR || IGNORE_NAMES.has(name) || (IGNORE_PATHS.size > 0 && IGNORE_PATHS.has(toRel(abs)));

async function walk(): Promise<Found[]> {
  const out: Found[] = [];
  const visited = new Set<string>(); // realpaths, so symlink loops can't hang the scan
  const stack = [LIBRARY_DIR];
  while (stack.length) {
    const dir = stack.pop()!;
    try {
      const real = await fs.realpath(dir);
      if (visited.has(real)) continue;
      visited.add(real);
    } catch {
      continue;
    }
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      scanState.errors++;
      continue;
    }
    const pictures: string[] = [];
    let hasBook = false;
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      let isDir = ent.isDirectory();
      let isFile = ent.isFile();
      if (ent.isSymbolicLink()) {
        try {
          const st = await fs.stat(abs);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue; // dangling link
        }
      }
      if (isDir) {
        if (ignored(ent.name, abs)) continue;
        stack.push(abs);
        continue;
      }
      if (!isFile) continue;
      const format = EXT_FORMAT[path.extname(ent.name).toLowerCase()];
      if (!format) {
        if (imageExt(ent.name)) pictures.push(ent.name);
        continue;
      }
      hasBook = true;
      try {
        const st = await fs.stat(abs);
        out.push({ rel: toRel(abs), abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), format });
      } catch {
        scanState.errors++;
      }
    }
    // Loose pages: manga ripped as plain image files. The folder is the comic (named after itself).
    if (dir !== LIBRARY_DIR && !hasBook && pictures.length >= MIN_FOLDER_PAGES) {
      const images: Array<{ name: string; size: number }> = [];
      let mtimeMs = 0;
      for (const name of pictures) {
        try {
          const st = await fs.stat(path.join(dir, name));
          if (!st.isFile()) continue;
          images.push({ name, size: st.size });
          mtimeMs = Math.max(mtimeMs, Math.floor(st.mtimeMs));
        } catch {
          scanState.errors++;
        }
      }
      if (images.length >= MIN_FOLDER_PAGES) {
        images.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        out.push({ rel: toRel(dir), abs: dir, size: images.reduce((n, i) => n + i.size, 0), mtimeMs, format: 'cbz', images });
      }
    }
  }
  return out;
}

/** Identity of a comic: sampled content for a file; the list of page names and sizes for a folder. */
async function identify(f: Found): Promise<string> {
  if (!f.images) return fingerprint(f.abs, f.size);
  const h = crypto.createHash('sha1');
  for (const i of f.images) h.update(`${i.name}:${i.size}\n`);
  return h.digest('hex');
}

/** A PDF's own document ID (see pdfFileId); '' for everything else. Only ever used to suggest matches. */
const fileIdOf = (f: Found) => (f.format === 'pdf' && !f.images ? pdfFileId(f.abs, f.size) : Promise.resolve(''));

/** Returns null when the file shouldn't be indexed (e.g. a .zip with no images, or an unreadable archive). */
async function extract(f: Found): Promise<Meta | null> {
  if (f.images) return { pages: f.images.length };
  try {
    switch (f.format) {
      case 'pdf':
        return await pdfMeta(f.abs);
      case 'epub':
        return (await epubInfo(f.abs, true)).meta;
      case 'cbz':
        return (await cbzInfo(f.abs))?.meta ?? null;
    }
  } catch {
    // Unreadable metadata shouldn't hide the file; unreadable comic archives can't be read at all.
    return f.format === 'epub' ? {} : null;
  }
}

const insertBook = db.prepare(`
  INSERT INTO books (path, dir, filename, format, size, mtime_ms, fingerprint, meta_title, title,
                     author, series, number, pages, added_at, missing, is_folder, file_id)
  VALUES (@path, @dir, @filename, @format, @size, @mtime_ms, @fingerprint, @meta_title, @title,
          @author, @series, @number, @pages, @added_at, 0, @is_folder, @file_id)`);
const moveBook = db.prepare(
  `UPDATE books SET path=@path, dir=@dir, filename=@filename, mtime_ms=@mtime_ms, title=@title, missing=0 WHERE id=@id`,
);
const updateBook = db.prepare(`
  UPDATE books SET size=@size, mtime_ms=@mtime_ms, fingerprint=@fingerprint, meta_title=@meta_title,
         title=@title, author=@author, series=@series, number=@number, pages=@pages, is_folder=@is_folder, missing=0,
         file_id=COALESCE(NULLIF(@file_id, ''), file_id, ''), progress_frac=COALESCE(progress_frac, @frac)
  WHERE id=@id`);
const setFileId = db.prepare(`UPDATE books SET file_id=? WHERE id=?`);
const setMissing = db.prepare(`UPDATE books SET missing=1, missing_at=? WHERE id=?`);
const clearMissing = db.prepare(`UPDATE books SET missing=0, missing_at=NULL WHERE id=?`);

/** An EPUB read before page estimates existed has (section, spot in section); express that as a fraction of the book. */
function savedFraction(row: BookRow, chars?: number[]): number | null {
  if (row.format !== 'epub' || !chars?.length || row.progress_page < 1) return null;
  const i = Math.min(row.progress_page, chars.length) - 1;
  const before = chars.slice(0, i).reduce((a, b) => a + b, 0);
  const all = chars.reduce((a, b) => a + b, 0);
  return all ? Math.min(1, (before + (row.progress_pos ?? 0) * chars[i]) / all) : null;
}

/** A folder's name has no extension to strip ("Vol 1.5" is not a ".5" file). */
const nameTitle = (filename: string, folder: boolean) => (folder ? filename.normalize('NFC') : titleFromFilename(filename));

function bookFields(f: Found, fp: string, meta: Meta, fileId = '') {
  const filename = path.posix.basename(f.rel);
  return {
    path: f.rel,
    dir: dirOf(f.rel),
    filename,
    format: f.format,
    size: f.size,
    mtime_ms: f.mtimeMs,
    fingerprint: fp,
    meta_title: meta.metaTitle ?? null,
    title: meta.metaTitle ?? nameTitle(filename, !!f.images),
    author: meta.author ?? null,
    series: meta.series ?? null,
    number: meta.number ?? null,
    pages: meta.pages ?? null,
    is_folder: f.images ? 1 : 0,
    file_id: fileId,
  };
}

/**
 * `full` re-reads metadata for every file, not just new/modified ones. Use it after installing
 * poppler-utils late, or after metadata extraction has improved. Tags, lists and progress are kept.
 */
let rescanQueued: false | 'quick' | 'full' = false;

export function startScan(full = false, carry?: ScanState): ScanState {
  if (scanState.running) {
    // Something may have changed on disk after the running scan looked at it, so run once more when it ends.
    rescanQueued = full || rescanQueued === 'full' ? 'full' : 'quick';
    return scanState;
  }
  scanState = { ...blank(), running: true, phase: 'walking', startedAt: carry?.startedAt ?? Date.now() };
  if (carry) {
    for (const k of ['added', 'moved', 'updated', 'missing', 'skipped', 'errors', 'thumbsRemoved'] as const) scanState[k] = carry[k];
  }
  runScan(full)
    .then(async () => {
      // Housekeeping after a *successful* scan only. A refused scan (e.g. unmounted drive) must not
      // trigger cleanup, because the index may look emptier than it really is.
      if (scanState.error) return;
      scanState.phase = 'cleaning';
      scanState.thumbsRemoved += await gcThumbs();
      checkpoint();
    })
    .catch((e) => {
      scanState.error = e instanceof Error ? e.message : String(e);
      console.error('scan failed:', e);
    })
    .finally(() => {
      scanState.running = false;
      scanState.phase = 'done';
      scanState.finishedAt = Date.now();
      if (rescanQueued) {
        const again = rescanQueued === 'full';
        rescanQueued = false;
        startScan(again, scanState);
      }
    });
  return scanState;
}

async function runScan(full: boolean): Promise<void> {
  try {
    await fs.access(LIBRARY_DIR);
  } catch {
    scanState.error = `Library folder not found or not readable: ${LIBRARY_DIR}`;
    return;
  }

  const found = await walk();
  const rows = db.prepare('SELECT * FROM books').all() as BookRow[];

  // An empty result with a populated DB usually means an unmounted drive. Don't wipe the index over that.
  if (found.length === 0 && rows.some((r) => !r.missing)) {
    scanState.error = 'No files found, but the index has books. Is the drive mounted? Leaving the index untouched.';
    return;
  }

  const byPath = new Map(rows.map((r) => [r.path, r]));
  const foundPaths = new Set(found.map((f) => f.rel));

  const fresh: Found[] = []; // path we have never seen
  const changed: Array<{ f: Found; row: BookRow }> = []; // same path, different size/mtime
  const revived: number[] = [];
  for (const f of found) {
    const row = byPath.get(f.rel);
    if (!row) fresh.push(f);
    else if (full || row.size !== f.size || row.mtime_ms !== f.mtimeMs) changed.push({ f, row });
    else if (row.missing) revived.push(row.id);
  }
  // Rows whose path no longer exists: candidates for "this file was moved/renamed".
  const gone = rows.filter((r) => !foundPaths.has(r.path));

  scanState.total = fresh.length + changed.length;
  scanState.phase = 'fingerprinting';

  // Fingerprint new paths and try to match them to a vanished row with the same content.
  const goneByFp = new Map<string, BookRow[]>();
  for (const r of gone) {
    const list = goneByFp.get(r.fingerprint) ?? [];
    list.push(r);
    goneByFp.set(r.fingerprint, list);
  }
  const moves: Array<{ f: Found; row: BookRow }> = [];
  const brandNew: Array<{ f: Found; fp: string }> = [];
  const claimed = new Set<number>();

  await mapPool(fresh, 8, async (f) => {
    try {
      const fp = await identify(f);
      const cand = goneByFp.get(fp)?.find((r) => r.size === f.size && !claimed.has(r.id));
      if (cand) {
        claimed.add(cand.id);
        moves.push({ f, row: cand });
        scanState.processed++;
      } else {
        brandNew.push({ f, fp });
      }
    } catch {
      scanState.errors++;
      scanState.processed++;
    }
  });

  // Read metadata for genuinely new and modified files.
  scanState.phase = 'reading';
  const inserts: ReturnType<typeof bookFields>[] = [];
  const updates: Array<ReturnType<typeof bookFields> & { id: number; frac: number | null }> = [];

  await mapPool(brandNew, 4, async ({ f, fp }) => {
    const meta = await extract(f);
    if (meta) inserts.push(bookFields(f, fp, meta, await fileIdOf(f)));
    else scanState.skipped++;
    scanState.processed++;
  });
  await mapPool(changed, 4, async ({ f, row }) => {
    try {
      const fp = await identify(f);
      const meta = await extract(f);
      if (meta) updates.push({ ...bookFields(f, fp, meta, await fileIdOf(f)), id: row.id, frac: savedFraction(row, meta.epubChars) });
      else scanState.skipped++;
    } catch {
      scanState.errors++;
    }
    scanState.processed++;
  });

  // Apply everything atomically.
  scanState.phase = 'saving';
  const now = Date.now();
  db.transaction(() => {
    for (const id of revived) clearMissing.run(id);
    for (const { f, row } of moves) {
      const filename = path.posix.basename(f.rel);
      moveBook.run({
        id: row.id,
        path: f.rel,
        dir: dirOf(f.rel),
        filename,
        mtime_ms: f.mtimeMs,
        title: row.meta_title ?? nameTitle(filename, !!row.is_folder),
      });
    }
    for (const u of updates) updateBook.run(u);
    for (const b of inserts) insertBook.run({ ...b, added_at: now });
    for (const r of gone) {
      if (!claimed.has(r.id) && !r.missing) {
        setMissing.run(now, r.id);
        scanState.missing++;
      }
    }
  })();

  // PDFs indexed before document IDs were read: look once ('' = looked, it has none).
  const unread = db.prepare(`SELECT id, path, size FROM books WHERE missing = 0 AND format = 'pdf' AND file_id IS NULL`).all() as Array<{ id: number; path: string; size: number }>;
  if (unread.length) {
    const ids: Array<[string, number]> = [];
    await mapPool(unread, 8, async (r) => {
      ids.push([await pdfFileId(path.join(LIBRARY_DIR, r.path), r.size), r.id]);
    });
    db.transaction(() => ids.forEach(([fid, id]) => setFileId.run(fid, id)))();
  }

  scanState.added = inserts.length;
  scanState.moved = moves.length;
  scanState.updated = updates.length;
}

/** Forget missing books: all of them, or just these ids (a present book is never touched). */
export async function purgeMissing(ids?: number[]): Promise<number> {
  let removed = 0;
  if (ids) {
    const del = db.prepare('DELETE FROM books WHERE id = ? AND missing = 1');
    db.transaction(() => ids.forEach((id) => (removed += Number(del.run(id).changes))))();
  } else removed = Number(db.prepare('DELETE FROM books WHERE missing = 1').run().changes);
  if (removed) await gcThumbs(); // their covers are now orphaned
  return removed;
}

/**
 * You say a missing book and a present one are the same book: its tags, list places and reading progress move
 * to the present one, and the missing entry is dropped. Nothing is overwritten: tags are added, a list that
 * already has the present book keeps its own place, and progress is only copied when the present book has none.
 */
export async function mergeMissing(fromId: number, intoId: number): Promise<void> {
  const from = db.prepare('SELECT * FROM books WHERE id = ?').get(fromId) as BookRow | undefined;
  const into = db.prepare('SELECT * FROM books WHERE id = ?').get(intoId) as BookRow | undefined;
  if (!from || !into) throw new Error('book not found');
  if (!from.missing) throw new Error('that book is not missing');
  if (into.missing || from.id === into.id) throw new Error('pick a book that is present');
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) SELECT ?, tag_id FROM book_tags WHERE book_id = ?').run(into.id, from.id);
    db.prepare('UPDATE list_items SET book_id = ? WHERE book_id = ? AND list_id NOT IN (SELECT list_id FROM list_items WHERE book_id = ?)').run(into.id, from.id, into.id);
    if (into.progress_at === null && from.progress_at !== null) {
      db.prepare('UPDATE books SET progress_page = ?, progress_at = ?, progress_pos = ?, progress_frac = ? WHERE id = ?').run(
        from.progress_page, from.progress_at, from.progress_pos, from.progress_frac, into.id,
      );
    }
    // The book was added when it first appeared, not when it was moved: keep the earlier date.
    if (from.added_at < into.added_at) db.prepare('UPDATE books SET added_at = ? WHERE id = ?').run(from.added_at, into.id);
    db.prepare('DELETE FROM books WHERE id = ?').run(from.id); // remaining list rows and tags go with it
  })();
  await gcThumbs();
}
