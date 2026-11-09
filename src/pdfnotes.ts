import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import * as mupdf from 'mupdf';

/**
 * Highlights and notes live INSIDE the PDF, as standard annotations (/Highlight and /Text), so
 * Okular, Evince, Acrobat etc. show the same ones and they travel with the file.
 *
 * Writing is deliberately conservative, because this is the only place Shelf ever modifies a book:
 *  - changes are an *incremental update*: bytes are only appended, the original content is untouched
 *  - before replacing anything we check the result starts with the exact original bytes, re-opens
 *    with the same page count, and that the file did not change on disk while we worked
 *  - the new file is written next to the original, fsynced, then renamed over it (atomic)
 *  - PDFs that would need a full rewrite (damaged, encrypted) are refused rather than rewritten
 */

export class NotesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Annotation {
  ref: number; // PDF object number: stable across saves, used to address it later
  page: number; // 1-based
  kind: 'highlight' | 'note' | 'ink';
  color: string; // #rrggbb
  rects: number[][]; // highlight: [x, y, w, h] per line, 0..1 of the displayed page, top-left origin
  point: [number, number] | null; // note: where the pin sits, 0..1
  strokes: number[][][]; // ink: lists of [x, y] points, 0..1 of the displayed page
  width: number | null; // ink: line width as a fraction of the page width
  note: string | null;
  quote: string | null; // highlighted text (read back from the page)
  author: string | null;
  modified: number | null; // ms
}

export interface Capabilities {
  canWrite: boolean;
  reason: string | null; // why not
}

const AUTHOR = 'Shelf';
const hex2 = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 255).toString(16).padStart(2, '0');
const toHex = (c: number[]): string => (c.length === 3 ? `#${hex2(c[0])}${hex2(c[1])}${hex2(c[2])}` : c.length === 1 ? `#${hex2(c[0])}${hex2(c[0])}${hex2(c[0])}` : c.length === 4 ? `#${hex2(1 - Math.min(1, c[0] + c[3]))}${hex2(1 - Math.min(1, c[1] + c[3]))}${hex2(1 - Math.min(1, c[2] + c[3]))}` : '#ffd84d');
const fromHex = (s: string): [number, number, number] => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255];
export const cleanHex = (v: unknown): string => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : '#ffd84d');

function open(buf: Buffer): mupdf.PDFDocument {
  let doc: mupdf.Document;
  try {
    doc = mupdf.Document.openDocument(buf, 'application/pdf');
  } catch (e) {
    throw new NotesError(422, `this PDF can't be opened for annotating (${(e as Error).message})`);
  }
  if (!(doc instanceof mupdf.PDFDocument)) throw new NotesError(422, 'not a PDF');
  if (doc.needsPassword()) throw new NotesError(422, 'this PDF is password-protected, so Shelf will not annotate it');
  return doc;
}

export function capabilities(abs: string, readOnly: boolean): Capabilities {
  if (readOnly) return { canWrite: false, reason: 'Shelf was started in read-only mode (SHELF_READONLY=1)' };
  try {
    fs.accessSync(abs, fs.constants.W_OK);
    fs.accessSync(path.dirname(abs), fs.constants.W_OK); // we write a temp file next to it, then rename
    return { canWrite: true, reason: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { canWrite: false, reason: code === 'EROFS' ? 'the library folder is mounted read-only' : 'Shelf has no permission to write to this file or its folder' };
  }
}

// ------------------------------------------------------------------ reading

const KINDS = new Set(['Highlight', 'Text', 'Ink']);

/** Merge the per-glyph-run boxes of a highlight into one box per text line. */
function mergeLines(rects: number[][]): number[][] {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out: number[][] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    const sameLine = last && Math.abs(last[1] - r[1]) < Math.max(last[3], r[3]) * 0.5 && Math.abs(last[3] - r[3]) < Math.max(last[3], r[3]) * 0.6;
    if (last && sameLine && r[0] <= last[0] + last[2] + 0.01) {
      const x0 = Math.min(last[0], r[0]);
      const y0 = Math.min(last[1], r[1]);
      const x1 = Math.max(last[0] + last[2], r[0] + r[2]);
      const y1 = Math.max(last[1] + last[3], r[1] + r[3]);
      out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
    } else out.push([...r]);
  }
  return out;
}

function quadRect(q: number[]): [number, number, number, number] {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  return [x0, y0, x1, y1];
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

function readPage(doc: mupdf.PDFDocument, pageIndex: number): Annotation[] {
  const page = doc.loadPage(pageIndex);
  const annots = page.getAnnotations().filter((a) => KINDS.has(a.getType()));
  if (!annots.length) return [];
  const [bx0, by0, bx1, by1] = page.getBounds();
  const bw = bx1 - bx0 || 1;
  const bh = by1 - by0 || 1;
  const norm = (x0: number, y0: number, x1: number, y1: number) => [r5((x0 - bx0) / bw), r5((y0 - by0) / bh), r5((x1 - x0) / bw), r5((y1 - y0) / bh)];

  let rot = 0;
  try { rot = (((page.getObject().getInheritable('Rotate').asNumber() || 0) % 360) + 360) % 360; } catch { /* no /Rotate */ }
  let stext: mupdf.StructuredText | null = null;
  const out: Annotation[] = [];
  for (const a of annots) {
    const type = a.getType();
    const obj = a.getObject();
    if (!obj.get('IRT').isNull()) continue; // a reply to another annotation, not a note of its own
    const ref = obj.asIndirect();
    if (!ref) continue;
    let color = '#ffd84d';
    try { color = toHex(a.getColor() as number[]); } catch { /* keep default */ }
    const contents = (a.getContents() || '').trim() || null;
    let modified: number | null = null;
    try { modified = a.getModificationDate()?.getTime() || null; } catch { /* no date */ }
    const author = (a.hasAuthor() ? a.getAuthor() : '') || null;

    if (type === 'Highlight') {
      let quads: number[][] = [];
      try { quads = a.getQuadPoints() as unknown as number[][]; } catch { /* none */ }
      if (!quads.length) continue;
      const rects = mergeLines(quads.map((q) => {
        const [x0, y0, x1, y1] = quadRect(q);
        return norm(x0, y0, x1, y1);
      }));
      let quote: string | null = null;
      try {
        stext ??= page.toStructuredText('preserve-whitespace');
        const parts: string[] = [];
        for (const q of quads) {
          const [x0, y0, x1, y1] = quadRect(q);
          const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
          // Walk along the direction the text runs on screen (it depends on the page rotation).
          const run = Math.max(x1 - x0, y1 - y0);
          const inset = Math.min(0.6, run * 0.02); // stay just inside the box so a neighbour's glyph isn't picked up
          const [p, e]: [mupdf.Point, mupdf.Point] =
            rot === 90 ? [[mx, y0 + inset], [mx, y1 - inset]]
            : rot === 270 ? [[mx, y1 - inset], [mx, y0 + inset]]
            : rot === 180 ? [[x1 - inset, my], [x0 + inset, my]]
            : [[x0 + inset, my], [x1 - inset, my]];
          const t = stext.copy(p, e).replace(/\s+/g, ' ').trim();
          if (t) parts.push(t);
        }
        quote = parts.join(' ').replace(/(\w)- (\w)/g, '$1$2') || null; // undo line-end hyphenation
      } catch { /* the text is a nicety */ }
      out.push({ ref, page: pageIndex + 1, kind: 'highlight', color, rects, point: null, strokes: [], width: null, note: contents, quote, author, modified });
    } else if (type === 'Ink') {
      let list: mupdf.Point[][] = [];
      try { list = a.getInkList(); } catch { /* none */ }
      const strokes = list.filter((st) => st.length).map((st) => st.map(([x, y]) => [r5((x - bx0) / bw), r5((y - by0) / bh)]));
      if (!strokes.length) continue;
      let w = 1;
      try { w = a.getBorderWidth() || 1; } catch { /* default */ }
      out.push({ ref, page: pageIndex + 1, kind: 'ink', color, rects: [], point: null, strokes, width: r5(w / bw), note: contents, quote: null, author, modified });
    } else {
      const [x0, y0, x1, y1] = a.getRect();
      out.push({ ref, page: pageIndex + 1, kind: 'note', color, rects: [], point: [r5((x0 - bx0) / bw), r5((y0 - by0) / bh)], strokes: [], width: null, note: contents, quote: null, author, modified });
    }
  }
  return out;
}

export function listAll(abs: string): Annotation[] {
  const doc = open(fs.readFileSync(abs));
  const n = doc.countPages();
  const out: Annotation[] = [];
  for (let i = 0; i < n; i++) out.push(...readPage(doc, i));
  return out;
}

// ------------------------------------------------------------------ writing

const queues = new Map<string, Promise<unknown>>();

/** One write at a time per file (two quick clicks must not race each other). */
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

export interface WriteResult {
  page: Annotation[]; // annotations now on the affected page
  size: number;
  mtimeMs: number;
}

async function mutate(abs: string, pageIndex: number, change: (doc: mupdf.PDFDocument, page: mupdf.PDFPage) => void): Promise<WriteResult> {
  return serial(abs, async () => {
    const before = await fsp.stat(abs);
    const original = await fsp.readFile(abs);
    const doc = open(original);
    if (doc.wasRepaired()) {
      throw new NotesError(422, 'this PDF has a damaged structure; adding annotations would mean rewriting it, which Shelf does not do to your files');
    }
    const count = doc.countPages();
    if (pageIndex < 0 || pageIndex >= count) throw new NotesError(400, 'page out of range');
    const page = doc.loadPage(pageIndex);
    change(doc, page);
    page.update();

    let out: Buffer;
    try {
      out = Buffer.from(doc.saveToBuffer('incremental').asUint8Array());
    } catch (e) {
      throw new NotesError(422, `this PDF can't be updated in place (${(e as Error).message})`);
    }
    // Safety checks before touching the real file.
    if (out.length < original.length || Buffer.compare(out.subarray(0, original.length), original) !== 0) {
      throw new NotesError(500, 'refusing to save: the update would not preserve the original file bytes');
    }
    const check = open(out);
    if (check.countPages() !== count) throw new NotesError(500, 'refusing to save: page count changed');
    const mid = await fsp.stat(abs);
    if (mid.size !== before.size || mid.mtimeMs !== before.mtimeMs) {
      throw new NotesError(409, 'the file changed on disk while saving; nothing was written. Try again');
    }

    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.shelf-tmp`);
    const fh = await fsp.open(tmp, 'w', before.mode & 0o777);
    try {
      await fh.writeFile(out);
      await fh.sync();
    } catch (e) {
      await fh.close();
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    await fh.close();
    try {
      await fsp.chmod(tmp, before.mode & 0o777);
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true });
      throw e;
    }
    const after = await fsp.stat(abs);
    return { page: readPage(check, pageIndex), size: after.size, mtimeMs: Math.floor(after.mtimeMs) }; // floored like the scanner, so the next scan agrees
  });
}

const rectToQuad = (r: number[], b: number[]): mupdf.Quad => {
  const [bx0, by0, bx1, by1] = b;
  const x0 = bx0 + r[0] * (bx1 - bx0), x1 = bx0 + (r[0] + r[2]) * (bx1 - bx0);
  const y0 = by0 + r[1] * (by1 - by0), y1 = by0 + (r[1] + r[3]) * (by1 - by0);
  // order used by PDF producers: top-left, top-right, bottom-left, bottom-right
  return [x0, y0, x1, y0, x0, y1, x1, y1];
};

export interface NewAnnotation {
  page: number;
  kind: 'highlight' | 'note' | 'ink';
  color: string;
  rects?: number[][];
  strokes?: number[][][];
  width?: number;
  point?: [number, number];
  note: string | null;
}

export function addAnnotation(abs: string, a: NewAnnotation): Promise<WriteResult> {
  return mutate(abs, a.page - 1, (_doc, page) => {
    const bounds = page.getBounds();
    const ann = page.createAnnotation(a.kind === 'highlight' ? 'Highlight' : a.kind === 'ink' ? 'Ink' : 'Text');
    const color = fromHex(cleanHex(a.color));
    ann.setColor(color);
    if (a.kind === 'ink') {
      const [bx0, by0, bx1, by1] = bounds;
      ann.setInkList((a.strokes ?? []).map((st) => st.map(([x, y]): mupdf.Point => [bx0 + x * (bx1 - bx0), by0 + y * (by1 - by0)])));
      ann.setBorderWidth(Math.max(0.3, (a.width ?? 0.004) * (bx1 - bx0)));
    } else if (a.kind === 'highlight') {
      ann.setQuadPoints((a.rects ?? []).map((r) => rectToQuad(r, bounds)));
    } else {
      const [px, py] = a.point ?? [0.05, 0.05];
      const [bx0, by0, bx1, by1] = bounds;
      const x = bx0 + px * (bx1 - bx0), y = by0 + py * (by1 - by0);
      ann.setRect([x, y, x + 20, y + 20]);
      ann.setIcon('Note');
    }
    if (a.note) ann.setContents(a.note);
    ann.setAuthor(AUTHOR);
    const now = new Date();
    ann.setCreationDate(now);
    ann.setModificationDate(now);
    ann.update();
  });
}

function findAnnot(page: mupdf.PDFPage, ref: number): mupdf.PDFAnnotation {
  const a = page.getAnnotations().find((x) => KINDS.has(x.getType()) && x.getObject().asIndirect() === ref);
  if (!a) throw new NotesError(404, 'that annotation is no longer in the file (it may have been changed by another program). Reload the book');
  return a;
}

export function updateAnnotation(abs: string, pageNo: number, ref: number, patch: { note?: string | null; color?: string }): Promise<WriteResult> {
  return mutate(abs, pageNo - 1, (_doc, page) => {
    const a = findAnnot(page, ref);
    if (patch.color !== undefined) a.setColor(fromHex(cleanHex(patch.color)));
    if (patch.note !== undefined) a.setContents(patch.note ?? '');
    a.setModificationDate(new Date());
    a.update();
  });
}

export function deleteAnnotation(abs: string, pageNo: number, ref: number): Promise<WriteResult> {
  return mutate(abs, pageNo - 1, (_doc, page) => {
    page.deleteAnnotation(findAnnot(page, ref));
  });
}
