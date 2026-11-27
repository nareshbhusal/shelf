import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import * as mupdf from 'mupdf';
import { LIBRARY_DIR } from './config.js';
import type { BookRow } from './db.js';
import { semaphore } from './util.js';
import { mendedEpub } from './epubmend.js';
import { fallbackFontFile, loadFallbackFonts } from './fallbackfont.js';
import { comicPages, readEntry } from './zip.js';

/**
 * One page of a PDF, an EPUB or a comic archive, drawn small, for flipping through a book on its card without opening the reader.
 * Nothing is written to disk: pages are made on request, a few recent ones are kept in memory, and the browser keeps the rest.
 */

const limit = semaphore(2);
const MUPDF_MAX_BYTES = 120 * 1024 * 1024; // the same limit as covers: bigger files are not held in memory

// An EPUB has no pages of its own: mupdf lays the book out into pages of this size (points) and this type size, which is what is flipped through. The count is
// therefore the flip-through's own, not the reader's estimate. Shaped like a paperback page.
export const EPUB_PAGE = { w: 420, h: 620, em: 12 };

// A PDF or EPUB that is being flipped through stays open for a short while, so each turn doesn't read the whole file again.
interface Opened { doc: mupdf.Document; pages: number; timer: NodeJS.Timeout; needsFont: boolean; epub: boolean }
const opened = new Map<string, Opened>();
// mupdf can count a few pages more at the end of a very big EPUB than it will then hand out (the count is made before the last chapters are laid out for good).
// When reading every page runs into that, the real last page is noted here and is the count from then on, for the page table and the viewer alike.
const reach = new Map<string, number>();
const told = new Set<string>();
const IDLE_MS = 30_000;
const MAX_OPEN = 3;

function close(key: string) {
  const o = opened.get(key);
  if (!o) return;
  clearTimeout(o.timer);
  opened.delete(key);
  try { o.doc.destroy(); } catch { /* already gone */ }
}

// mupdf asks for a font in two cases while it lays out or draws an EPUB: by family, when the book's own isn't there (answered only for a book that has
// letters its built-in font lacks, so that the whole text is set in the stand-in), and by script, for a single letter its font has no glyph for (answered
// always, for the scripts the stand-in covers: that is what a browser does on its own, and it is why the reader never showed boxes). Only while an EPUB is being
// worked on (the lookups happen inside the calls below, which have no await in them, so nothing else can slip in).
let epubWork = false;
let standIn = false;
const standInFonts = new Map<string, mupdf.Font>();
const STAND_IN_SCRIPTS = new Set(['Latin', 'Greek', 'Cyrillic', 'Common', 'Inherited']);
// mupdf reports everything it dislikes in a book (a stylesheet it can't parse, a font or picture that isn't in the file, a rule it doesn't know) on the console,
// again for every page it lays out. None of it stops anything: leave it out, except what is new and not of that kind, once. SHELF_DEBUG_MUPDF=1 shows it all.
const NOISE = /css syntax error|cannot load font-face|cannot locate font|FT_New_Memory_Face|cannot load image|ignoring stylesheet|cannot find entry|may be locked by DRM|unknown epub version|stale accelerator|repeated \d+ times|cannot find font|no glyph|not inside (?:table|table-row|table-group) element|expected name after \w+ in cmap|jbig2dec warning|unsupported (?:css|font|image)/i;
const seenLog = new Set<string>();
mupdf.setLog((message: string) => {
  const m = String(message).trim();
  if (!m || (!process.env.SHELF_DEBUG_MUPDF && NOISE.test(m)) || seenLog.has(m)) return;
  if (seenLog.size < 300) seenLog.add(m);
  console.warn(`[mupdf] ${m}`);
});

mupdf.installLoadFontFunction((name, script, bold, italic) => {
  if (!epubWork) return null;
  const byScript = !!script && script !== 'undefined';
  if (byScript ? !STAND_IN_SCRIPTS.has(script) : !standIn) return null;
  const f = fallbackFontFile(byScript ? 'serif' : name, !!bold, !!italic);
  if (!f) return null;
  let font = standInFonts.get(f.key);
  if (!font) standInFonts.set(f.key, (font = new mupdf.Font(f.key, f.data)));
  return font;
});

async function openPdf(book: BookRow, abs: string): Promise<Opened | null> {
  const key = book.fingerprint;
  const have = opened.get(key);
  if (have) {
    clearTimeout(have.timer);
    have.timer = setTimeout(() => close(key), IDLE_MS);
    const r = reach.get(key);
    if (r !== undefined && r < have.pages) have.pages = r;
    opened.delete(key); // move to the end: most recently used
    opened.set(key, have);
    return have;
  }
  if ((await fs.stat(abs)).size > MUPDF_MAX_BYTES) return null;
  const epub = book.format === 'epub';
  // An EPUB goes through a mended copy when mupdf would otherwise show it badly: pictures it can't draw, scrambled fonts (see epubmend.ts). A book with letters
  // its built-in font lacks gets a font from this computer to stand in for it, for the layout only.
  const mended = epub ? await mendedEpub(abs).catch((e) => { console.warn(`[shelf] could not make the corrected copy of "${book.title}" the viewer draws from, so it is drawn as it is: ${(e as Error).message}`); return null; }) : null;
  if (mended && !told.has(key)) { // once per book: what the viewer is drawing from, for finding out why a letter is wrong
    told.add(key);
    if (mended.needsFont) console.log(`[shelf] "${book.title}": ${mended.bytes ? 'corrected copy in use' : 'drawn as it is'}; transliterated letters ${mended.standIn === null ? 'NOT set in the stand-in font (it did not load)' : mended.standIn ? 'set in the stand-in font' : 'found, but none to wrap'}`);
  }
  const bytes = mended?.bytes ?? (await fs.readFile(abs));
  if (epub) await loadFallbackFonts(); // the four font files, read once
  epubWork = epub;
  standIn = !!mended?.needsFont; // from opening to laying out, the letters are measured with the same font they are drawn with, or they would overlap
  let doc: mupdf.Document;
  let pages: number;
  try {
    doc = mupdf.Document.openDocument(bytes, epub ? 'application/epub+zip' : 'application/pdf');
    if (epub) doc.layout(EPUB_PAGE.w, EPUB_PAGE.h, EPUB_PAGE.em);
    pages = doc.countPages(); // (this is what does the laying out, so it belongs in here)
  } finally {
    epubWork = false;
    standIn = false;
  }
  const r = reach.get(key);
  if (r !== undefined && r < pages) pages = r;
  const o: Opened = { doc, pages, needsFont: !!mended?.needsFont, epub, timer: setTimeout(() => close(key), IDLE_MS) };
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
      epubWork = o.epub;
      standIn = o.needsFont;
      let page: mupdf.Page;
      let pix: mupdf.Pixmap;
      try {
        try { page = o.doc.loadPage(n - 1); } catch (e) {
          if (/invalid page number/i.test((e as Error).message) && n > o.pages - 24) { reach.set(book.fingerprint, n - 1); o.pages = Math.min(o.pages, n - 1); throw new PeekError(404, 'page out of range'); }
          throw e;
        }
        const [x0, , x1] = page.getBounds();
        const scale = w / Math.max(1, x1 - x0);
        pix = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false, false); // no annotations in the picture: the viewer draws them itself, so a change shows at once
      } finally {
        epubWork = false;
        standIn = false;
      }
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

/**
 * The text of every page of an EPUB as laid out here (for epubpages.ts). Taken a few pages at a time, and the server is let breathe between them: the pages are
 * worked at in one run of calls that never wait for anything, so without that a big book (3000+ pages) would hold up every other request, the library list
 * included, until it was done. If the book turns out to have a different number of pages from one moment to the next (it was closed and opened again), it is
 * started over once on a fresh copy, rather than reading pages that are not there.
 */
export async function peekAllText(book: BookRow): Promise<string[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const total = await peekPages(book);
    const out: string[] = [];
    let drift = '';
    let tail = -1;
    for (let a = 0; a < total && !drift; a += 24) {
      await new Promise((r) => setImmediate(r)); // other requests get their turn
      await limit(async () => {
        const o = await openPdf(book, path.join(LIBRARY_DIR, book.path));
        if (!o) throw new PeekError(413, 'this file is too large to preview here');
        if (o.pages !== total) { drift = `the book now has ${o.pages} pages, not ${total}`; return; }
        epubWork = o.epub; // (a page can be laid out again while it is read, and must be with the same fonts as the first time)
        standIn = o.needsFont;
        let n = a;
        try {
          for (; n < Math.min(total, a + 24); n++) {
            const page = o.doc.loadPage(n);
            try {
              const st = page.toStructuredText('preserve-whitespace');
              try { out.push(st.asText()); } finally { try { st.destroy(); } catch { /* not needed */ } }
            } finally {
              try { page.destroy(); } catch { /* not needed */ }
            }
          }
        } catch (e) {
          const msg = (e as Error).message;
          if (/invalid page number/i.test(msg) && n >= total - 24 && n === out.length) tail = n; // only the very end is missing: that is the real page count
          else drift = msg;
        } finally {
          epubWork = false;
          standIn = false;
        }
      });
      if (tail >= 0) break;
    }
    if (tail >= 0 && !drift) {
      console.warn(`[shelf] "${book.title}" has ${tail} pages that can be shown, not the ${total} mupdf counted; using ${tail}`);
      reach.set(book.fingerprint, tail);
      const o = opened.get(book.fingerprint);
      if (o) o.pages = Math.min(o.pages, tail);
      return out;
    }
    if (!drift) return out;
    console.warn(`[shelf] reading all the pages of "${book.title}" went wrong (${drift}); ${attempt ? 'giving up on exact page numbers for it' : 'starting again on a fresh copy'}`);
    close(book.fingerprint);
  }
  throw new PeekError(503, 'the pages changed while they were being read');
}

/** Where the words of a page are, as fractions (0..1) of the page: [x, y, width, height, word]. Lets the viewer lay selectable text over the picture. */
const recentText = new Map<string, TextWord[]>();
export type TextWord = [number, number, number, number, string];

export function peekText(book: BookRow, n: number): Promise<TextWord[]> {
  if (book.format !== 'pdf' && book.format !== 'epub') return Promise.resolve([]);
  const key = `${book.fingerprint}:${n}`;
  const hit = recentText.get(key);
  if (hit) return Promise.resolve(hit);
  return limit(async () => {
    const o = await openPdf(book, path.join(LIBRARY_DIR, book.path));
    if (!o) throw new PeekError(413, 'this PDF is too large to preview here');
    if (n < 1 || n > o.pages) throw new PeekError(404, 'page out of range');
    epubWork = o.epub;
    standIn = o.needsFont;
    let page: mupdf.Page;
    try {
      page = o.doc.loadPage(n - 1);
    } catch (e) {
      epubWork = false;
      standIn = false;
      throw e;
    }
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
      epubWork = false;
      standIn = false;
      try { page.destroy(); } catch { /* not needed */ }
    }
    recentText.set(key, words);
    while (recentText.size > KEEP) recentText.delete(recentText.keys().next().value as string);
    return words;
  });
}
