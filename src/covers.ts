import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { LIBRARY_DIR, THUMB_DIR } from './config.js';
import type { BookRow } from './db.js';
import { epubInfo } from './meta.js';
import { semaphore } from './util.js';
import { comicPages, readEntry } from './zip.js';

const execFileP = promisify(execFile);
const THUMB_WIDTH = 400;

sharp.concurrency(2);
const limit = semaphore(3); // thumbnails are CPU-heavy; don't spawn 100 pdftoppm at once
const inflight = new Map<string, Promise<string | null>>();

const exists = (p: string) => fs.access(p).then(() => true, () => false);

/**
 * Thumbnails are generated lazily on first request and cached by content fingerprint,
 * so they survive file moves. Returns null if the book has no usable cover.
 */
export function ensureThumb(book: BookRow): Promise<string | null> {
  const key = book.fingerprint;
  let p = inflight.get(key);
  if (!p) {
    p = limit(() => build(book)).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

async function build(book: BookRow): Promise<string | null> {
  const out = path.join(THUMB_DIR, `${book.fingerprint}.jpg`);
  const none = `${out}.none`; // "tried and failed" marker, so broken files aren't retried on every page load
  if (await exists(out)) return out;
  if (await exists(none)) return null;

  const abs = path.join(LIBRARY_DIR, book.path);
  const tmp = `${out}.${process.pid}.tmp`;
  try {
    if (book.format === 'pdf') {
      await pdfCover(abs, tmp);
    } else {
      const image = await archiveCover(book, abs);
      if (!image) throw new Error('no cover image');
      await sharp(image, { failOn: 'none' })
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toFile(tmp);
    }
    await fs.rename(tmp, out);
    return out;
  } catch (e) {
    await fs.rm(tmp, { force: true });
    // A missing poppler is fixable by the user, so don't remember that as a permanent failure.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') await fs.writeFile(none, '').catch(() => {});
    return null;
  }
}

async function pdfCover(abs: string, tmpOut: string): Promise<void> {
  // pdftoppm appends ".jpg" itself; render to a prefix, then move into place.
  const prefix = tmpOut.replace(/\.jpg\.[^/]*\.tmp$/, '') + `.${process.pid}.render`;
  await execFileP(
    'pdftoppm',
    ['-jpeg', '-jpegopt', 'quality=82', '-f', '1', '-l', '1', '-scale-to-x', String(THUMB_WIDTH), '-scale-to-y', '-1', '-singlefile', abs, prefix],
    { timeout: 30_000 },
  );
  await fs.rename(`${prefix}.jpg`, tmpOut);
}

async function archiveCover(book: BookRow, abs: string): Promise<Buffer | null> {
  if (book.format === 'cbz') {
    const pages = await comicPages(`${book.id}:${book.fingerprint}`, abs, !!book.is_folder);
    if (!pages.length) return null;
    return book.is_folder ? fs.readFile(path.join(abs, pages[0])) : readEntry(abs, pages[0]);
  }
  if (book.format === 'epub') {
    const { coverEntry } = await epubInfo(abs);
    return coverEntry ? readEntry(abs, coverEntry) : null;
  }
  return null;
}
