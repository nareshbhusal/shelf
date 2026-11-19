import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import * as mupdf from 'mupdf';
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

/**
 * Page 1 drawn by mupdf, which is also what writes the annotations. It composes pages built from several layered images
 * (as some publishers' scans are) the way the reader's PDF.js does, where poppler's pdftoppm has shown a mixture of two
 * pages. Files too big to hold in memory for a thumbnail, or anything mupdf refuses, fall back to poppler.
 */
const MUPDF_MAX_BYTES = 120 * 1024 * 1024;
async function mupdfCover(abs: string, tmpOut: string): Promise<boolean> {
  try {
    if ((await fs.stat(abs)).size > MUPDF_MAX_BYTES) return false;
    const doc = mupdf.Document.openDocument(await fs.readFile(abs), 'application/pdf');
    try {
      if (!doc.countPages()) return false;
      const page = doc.loadPage(0);
      const [x0, , x1] = page.getBounds();
      const scale = THUMB_WIDTH / Math.max(1, x1 - x0);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, true);
      await fs.writeFile(tmpOut, pix.asJPEG(82, false));
      return true;
    } finally {
      doc.destroy();
    }
  } catch {
    return false;
  }
}

async function pdfCover(abs: string, tmpOut: string): Promise<void> {
  if (await mupdfCover(abs, tmpOut)) return;
  // pdftoppm appends ".jpg" itself; render to a prefix, then move into place.
  const prefix = tmpOut.replace(/\.jpg\.[^/]*\.tmp$/, '') + `.${process.pid}.render`;
  await execFileP(
    'pdftoppm',
    ['-jpeg', '-jpegopt', 'quality=82', '-f', '1', '-l', '1', '-scale-to-x', String(THUMB_WIDTH), '-scale-to-y', '-1', '-singlefile', abs, prefix],
    { timeout: 30_000 },
  );
  await fs.rename(`${prefix}.jpg`, tmpOut);
}

/** Keep a picture the reader chose (a page it showed correctly) as the book's cover. Only the cover cache changes. */
export async function setThumb(book: BookRow, image: Buffer): Promise<void> {
  const out = path.join(THUMB_DIR, `${book.fingerprint}.jpg`);
  const tmp = `${out}.${process.pid}.tmp`;
  await sharp(image).resize({ width: THUMB_WIDTH * 2, withoutEnlargement: true }).jpeg({ quality: 85 }).toFile(tmp);
  await fs.rename(tmp, out);
  await fs.rm(`${out}.none`, { force: true });
}

/** Throw away a book's saved cover (and the notes about it) so the next request makes it again from the file. */
export async function forgetThumb(book: BookRow): Promise<void> {
  const out = path.join(THUMB_DIR, `${book.fingerprint}.jpg`);
  await Promise.all([out, `${out}.none`].map((f) => fs.rm(f, { force: true })));
}

/** Throw away every saved cover (they are only a cache); each is made again on demand. Returns how many there were. */
export async function forgetAllThumbs(): Promise<number> {
  let n = 0;
  for (const name of await fs.readdir(THUMB_DIR)) {
    if (!/^[0-9a-f]{40}\.jpg(\.none)?$/.test(name)) continue;
    await fs.rm(path.join(THUMB_DIR, name), { force: true });
    if (name.endsWith('.jpg')) n++;
  }
  return n;
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
