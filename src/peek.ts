import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as mupdf from 'mupdf';
import { LIBRARY_DIR } from './config.js';
import type { BookRow } from './db.js';
import { semaphore } from './util.js';
import { mendedEpub } from './epubmend.js';
import { comicPages, readEntry } from './zip.js';

/**
 * One page of a PDF, an EPUB or a comic archive, drawn small, for flipping through a book on its card without opening the reader.
 * Nothing is written to disk: pages are made on request, a few recent ones are kept in memory, and the browser keeps the rest.
 */

const limit = semaphore(2);
const MUPDF_MAX_BYTES = 120 * 1024 * 1024; // the same limit as covers: bigger files are not held in memory

// An EPUB has no pages of its own: mupdf lays the book out into pages of this size (points) and this type size, which is what is flipped through. The count is
// therefore the flip-through's own, not the reader's estimate. Shaped like a paperback page.
const EPUB_PAGE = { w: 420, h: 620, em: 12 };

// A PDF or EPUB that is being flipped through stays open for a short while, so each turn doesn't read the whole file again.
interface Opened { doc: mupdf.Document; pages: number; timer: NodeJS.Timeout }
const opened = new Map<string, Opened>();
const IDLE_MS = 30_000;
const MAX_OPEN = 3;

function close(key: string) {
  const o = opened.get(key);
  if (!o) return;
  clearTimeout(o.timer);
  opened.delete(key);
  try { o.doc.destroy(); } catch { /* already gone */ }
}

async function openPdf(book: BookRow, abs: string): Promise<Opened | null> {
  const key = book.fingerprint;
  const have = opened.get(key);
  if (have) {
    clearTimeout(have.timer);
    have.timer = setTimeout(() => close(key), IDLE_MS);
    opened.delete(key); // move to the end: most recently used
    opened.set(key, have);
    return have;
  }
  if ((await fs.stat(abs)).size > MUPDF_MAX_BYTES) return null;
  const epub = book.format === 'epub';
  // an EPUB goes through a mended copy when its pictures are of a kind mupdf can't show (see epubmend.ts)
  const bytes = (epub ? await mendedEpub(abs).catch(() => null) : null) ?? (await fs.readFile(abs));
  const doc = mupdf.Document.openDocument(bytes, epub ? 'application/epub+zip' : 'application/pdf');
  if (epub) doc.layout(EPUB_PAGE.w, EPUB_PAGE.h, EPUB_PAGE.em);
  const o: Opened = { doc, pages: doc.countPages(), timer: setTimeout(() => close(key), IDLE_MS) };
  opened.set(key, o);
  while (opened.size > MAX_OPEN) close(opened.keys().next().value as string);
  return o;
}

// The last pages made, newest last.
const recent = new Map<string, Buffer>();
const KEEP = 60;

export class PeekError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function peekPage(book: BookRow, n: number, width: number): Promise<Buffer> {
  const w = Math.min(1400, Math.max(160, Math.round(width / 40) * 40 || 480));
  const key = `${book.fingerprint}:${n}:${w}`;
  const hit = recent.get(key);
  if (hit) return Promise.resolve(hit);
  return limit(async () => {
    const abs = path.join(LIBRARY_DIR, book.path);
    let img: Buffer;
    if (book.format === 'pdf' || book.format === 'epub') {
      const o = await openPdf(book, abs);
      if (!o) throw new PeekError(413, 'this file is too large to preview here');
      if (n < 1 || n > o.pages) throw new PeekError(404, 'page out of range');
      const page = o.doc.loadPage(n - 1);
      const [x0, , x1] = page.getBounds();
      const scale = w / Math.max(1, x1 - x0);
      const pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false); // no annotations in the picture: the viewer draws them itself, so a change shows at once
      img = Buffer.from(pix.asJPEG(78, false));
      try { pix.destroy(); } catch { /* not needed */ }
      try { page.destroy(); } catch { /* not needed */ }
    } else if (book.format === 'cbz') {
      const pages = await comicPages(`${book.id}:${book.fingerprint}`, abs, !!book.is_folder);
      if (n < 1 || n > pages.length) throw new PeekError(404, 'page out of range');
      const raw = book.is_folder ? await fs.readFile(path.join(abs, pages[n - 1])) : await readEntry(abs, pages[n - 1]);
      img = await sharp(raw, { failOn: 'none' }).rotate().resize({ width: w, withoutEnlargement: true }).jpeg({ quality: 76 }).toBuffer();
    } else {
      throw new PeekError(400, 'only PDF, EPUB and comic files can be flipped through');
    }
    recent.set(key, img);
    while (recent.size > KEEP) recent.delete(recent.keys().next().value as string);
    return img;
  });
}

/** How many pages the flip-through has: the file's own for a PDF, as laid out here for an EPUB. */
export function peekPages(book: BookRow): Promise<number> {
  if (book.format === 'cbz') return comicPages(`${book.id}:${book.fingerprint}`, path.join(LIBRARY_DIR, book.path), !!book.is_folder).then((p) => p.length);
  if (book.format !== 'pdf' && book.format !== 'epub') return Promise.reject(new PeekError(400, 'only PDF, EPUB and comic files can be flipped through'));
  return limit(async () => {
    const o = await openPdf(book, path.join(LIBRARY_DIR, book.path));
    if (!o) throw new PeekError(413, 'this file is too large to preview here');
    return o.pages;
  });
}

/** Where the words of a page are, as fractions (0..1) of the page: [x, y, width, height, word]. Lets the viewer lay selectable text over the picture. */
const recentText = new Map<string, TextWord[]>();
export type TextWord = [number, number, number, number, string];

export function peekText(book: BookRow, n: number): Promise<TextWord[]> {
  if (book.format !== 'pdf') return Promise.resolve([]);
  const key = `${book.fingerprint}:${n}`;
  const hit = recentText.get(key);
  if (hit) return Promise.resolve(hit);
  return limit(async () => {
    const o = await openPdf(book, path.join(LIBRARY_DIR, book.path));
    if (!o) throw new PeekError(413, 'this PDF is too large to preview here');
    if (n < 1 || n > o.pages) throw new PeekError(404, 'page out of range');
    const page = o.doc.loadPage(n - 1);
    const words: TextWord[] = [];
    try {
      const [x0, y0, x1, y1] = page.getBounds();
      const pw = Math.max(1, x1 - x0);
      const ph = Math.max(1, y1 - y0);
      const st = page.toStructuredText('preserve-whitespace');
      let cur: { l: number; t: number; r: number; b: number; s: string } | null = null;
      const flush = () => {
        if (cur && cur.s && words.length < 6000) {
          const f = (v: number) => Math.round(v * 10000) / 10000;
          words.push([f((cur.l - x0) / pw), f((cur.t - y0) / ph), f((cur.r - cur.l) / pw), f((cur.b - cur.t) / ph), cur.s]);
        }
        cur = null;
      };
      st.walk({
        beginLine: flush,
        endLine: flush,
        onChar(c, _origin, _font, _size, q) {
          if (/\s/.test(c)) return flush();
          const xs = [q[0], q[2], q[4], q[6]];
          const ys = [q[1], q[3], q[5], q[7]];
          const l = Math.min(...xs), r = Math.max(...xs), t = Math.min(...ys), b = Math.max(...ys);
          if (!cur) cur = { l, t, r, b, s: c };
          else { cur.l = Math.min(cur.l, l); cur.r = Math.max(cur.r, r); cur.t = Math.min(cur.t, t); cur.b = Math.max(cur.b, b); cur.s += c; }
        },
      });
      flush();
      try { st.destroy(); } catch { /* not needed */ }
    } finally {
      try { page.destroy(); } catch { /* not needed */ }
    }
    recentText.set(key, words);
    while (recentText.size > KEEP) recentText.delete(recentText.keys().next().value as string);
    return words;
  });
}
