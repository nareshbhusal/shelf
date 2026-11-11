import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EXT_FORMAT, IGNORE, LIBRARY_DIR, type Format } from './config.js';
import { db, type BookRow } from './db.js';
import { cbzInfo, epubInfo, pdfMeta, type Meta } from './meta.js';
import { checkpoint, gcThumbs } from './hygiene.js';
import { fingerprint, mapPool, titleFromFilename } from './util.js';

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
}

const toRel = (abs: string) => path.relative(LIBRARY_DIR, abs).split(path.sep).join('/');
const dirOf = (rel: string) => {
  const d = path.posix.dirname(rel);
  return d === '.' ? '' : d;
};

// Folders named in the shelf file's "ignore" list are not entered at all.
const IGNORE_NAMES = new Set(IGNORE.filter((e) => !e.includes('/')));
const IGNORE_PATHS = new Set(IGNORE.filter((e) => e.includes('/')));
const ignored = (name: string, abs: string) => IGNORE_NAMES.has(name) || (IGNORE_PATHS.size > 0 && IGNORE_PATHS.has(toRel(abs)));

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
      if (!format) continue;
      try {
        const st = await fs.stat(abs);
        out.push({ rel: toRel(abs), abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), format });
      } catch {
        scanState.errors++;
      }
    }
  }
  return out;
}

/** Returns null when the file shouldn't be indexed (e.g. a .zip with no images, or an unreadable archive). */
async function extract(f: Found): Promise<Meta | null> {
  try {
    switch (f.format) {
      case 'pdf':
        return await pdfMeta(f.abs);
      case 'epub':
        return (await epubInfo(f.abs)).meta;
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
                     author, series, number, pages, added_at, missing)
  VALUES (@path, @dir, @filename, @format, @size, @mtime_ms, @fingerprint, @meta_title, @title,
          @author, @series, @number, @pages, @added_at, 0)`);
const moveBook = db.prepare(
  `UPDATE books SET path=@path, dir=@dir, filename=@filename, mtime_ms=@mtime_ms, title=@title, missing=0 WHERE id=@id`,
);
const updateBook = db.prepare(`
  UPDATE books SET size=@size, mtime_ms=@mtime_ms, fingerprint=@fingerprint, meta_title=@meta_title,
         title=@title, author=@author, series=@series, number=@number, pages=@pages, missing=0
  WHERE id=@id`);
const setMissing = db.prepare(`UPDATE books SET missing=1 WHERE id=?`);
const clearMissing = db.prepare(`UPDATE books SET missing=0 WHERE id=?`);

function bookFields(f: Found, fp: string, meta: Meta) {
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
    title: meta.metaTitle ?? titleFromFilename(filename),
    author: meta.author ?? null,
    series: meta.series ?? null,
    number: meta.number ?? null,
    pages: meta.pages ?? null,
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
      const fp = await fingerprint(f.abs, f.size);
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
  const updates: Array<ReturnType<typeof bookFields> & { id: number }> = [];

  await mapPool(brandNew, 4, async ({ f, fp }) => {
    const meta = await extract(f);
    if (meta) inserts.push(bookFields(f, fp, meta));
    else scanState.skipped++;
    scanState.processed++;
  });
  await mapPool(changed, 4, async ({ f, row }) => {
    try {
      const fp = await fingerprint(f.abs, f.size);
      const meta = await extract(f);
      if (meta) updates.push({ ...bookFields(f, fp, meta), id: row.id });
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
        title: row.meta_title ?? titleFromFilename(filename),
      });
    }
    for (const u of updates) updateBook.run(u);
    for (const b of inserts) insertBook.run({ ...b, added_at: now });
    for (const r of gone) {
      if (!claimed.has(r.id) && !r.missing) {
        setMissing.run(r.id);
        scanState.missing++;
      }
    }
  })();

  scanState.added = inserts.length;
  scanState.moved = moves.length;
  scanState.updated = updates.length;
}

export async function purgeMissing(): Promise<number> {
  const removed = db.prepare('DELETE FROM books WHERE missing = 1').run().changes;
  if (removed) await gcThumbs(); // their covers are now orphaned
  return removed;
}
