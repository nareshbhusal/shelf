import fs from 'node:fs/promises';
import path from 'node:path';
import { EPUB_PAGES_DIR, LIBRARY_DIR } from './config.js';
import { db, type BookRow } from './db.js';
import { readFileSync } from 'node:fs';
import { epubStructure } from './epub.js';
import { EPUB_PAGE, peekAllText, peekPages } from './peek.js';
import { readEntries } from './zip.js';

/**
 * Where each page of an EPUB starts.
 *
 * The flip-through viewer lays an EPUB out into real pages (mupdf, see peek.ts) while the reader scrolls the book's own sections and works out "pages" from the
 * amount of text. Those are two page counts for one book, and a place in one (a page number) is only roughly a place in the other. This makes the layout's pages
 * a table in the reader's own terms: for every page, how far through the book it starts, counted the way the reader counts (its sections and the size of each).
 * With it a page of the viewer is a spot the reader can go to exactly, a spot in the reader is a page of the viewer, and the reader can show the viewer's page
 * numbers and total, so there is one page count.
 *
 * How: the text of every page (mupdf) and of every section (the file) are boiled down to their letters and digits. A section is found in the pages by where its
 * first words are, which gives its offset; the pages inside it are then placed by how much text came before them in that section. Sections whose words can't be
 * found (pictures only, hidden text) are spread between their neighbours by size.
 */

export interface EpubPages {
  /** Pages in the viewer. */
  total: number;
  /** For each page, the fraction (0..1) of the book at its top, in the reader's units. Never decreasing. */
  starts: number[];
  /** The exact table could not be worked out (the book laid out differently from one moment to the next): pages are spread evenly, so the totals agree but the spots are rough. */
  approx?: boolean;
}

const VERSION = 1;
const memory = new Map<string, EpubPages>();
const approxAt = new Map<string, number>();
const working = new Map<string, Promise<EpubPages>>();

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú', ccedil: 'ç', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß' };
/** Only the letters and digits, without accents or marks, lower case: what both sides can be made to agree on. */
const boil = (s: string) => s.normalize('NFD').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase();

function sectionText(html: string): string {
  const s = html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<head\b[\s\S]*?<\/head>/i, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, n: string) => {
      if (n[0] === '#') {
        const cp = n[1] === 'x' || n[1] === 'X' ? parseInt(n.slice(2), 16) : parseInt(n.slice(1), 10);
        return cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ';
      }
      return NAMED[n] ?? NAMED[n.toLowerCase()] ?? ' ';
    });
  return boil(s);
}

const fileFor = (key: string) => path.join(EPUB_PAGES_DIR, `${key.replace(/[^\w.-]+/g, '_')}.json`);

async function compute(book: BookRow, key: string): Promise<EpubPages> {
  const abs = path.join(LIBRARY_DIR, book.path);
  const st = await epubStructure(key, abs);
  const n = st.spine.length;
  const chars = st.chars ?? [];
  // the text of each section, as the reader's own sections
  const at = new Map<string, number[]>();
  st.spine.forEach((s, i) => s.kind === 'doc' && at.set(s.path, [...(at.get(s.path) ?? []), i]));
  const texts: string[] = new Array(n).fill('');
  await readEntries(abs, new Set(at.keys()), (name, data) => {
    const t = sectionText(data.toString('utf8'));
    for (const i of at.get(name) ?? []) texts[i] = t;
  }, 96 * 1024 * 1024);

  // the text of each page, and where each starts in all of it
  const pageTexts = await peekAllText(book);
  const total = pageTexts.length;
  const offsets: number[] = new Array(total);
  let all = '';
  const parts: string[] = [];
  let len = 0;
  for (let p = 0; p < total; p++) {
    offsets[p] = len;
    const t = boil(pageTexts[p]);
    parts.push(t);
    len += t.length;
  }
  all = parts.join('');
  parts.length = 0;

  // where each section begins in that text: by its first words, looking only forward
  const a: Array<number | null> = new Array(n).fill(null);
  let from = 0;
  for (let i = 0; i < n; i++) {
    const t = texts[i];
    for (const off of [0, 60, 200]) { // (a few tries from different spots, in case the first words are things that don't appear on the page)
      if (t.length < off + 24) break;
      const hit = all.indexOf(t.slice(off, off + 32), from);
      if (hit >= 0) {
        a[i] = Math.max(from, hit - off);
        from = a[i]! + Math.floor(t.length * 0.5);
        break;
      }
    }
  }
  // the others sit between the ones that were found, by size
  const edge: number[] = new Array(n + 1);
  const cum: number[] = [0];
  for (let i = 0; i < n; i++) cum.push(cum[i] + Math.max(1, texts[i].length || chars[i] || 1));
  if (a[0] === null) a[0] = 0;
  let left = 0;
  for (let i = 1; i <= n; i++) {
    const known = i === n ? len : a[i];
    if (known === null) continue;
    const l = a[left] ?? 0;
    for (let k = left + 1; k < i; k++) a[k] = Math.round(l + ((cum[k] - cum[left]) / Math.max(1, cum[i] - cum[left])) * (known - l));
    left = i;
  }
  for (let i = 0; i < n; i++) edge[i] = Math.max(i ? edge[i - 1] : 0, Math.min(len, a[i] ?? 0));
  edge[n] = len;

  // the page tops in the reader's units
  const sum = chars.reduce((x, y) => x + y, 0) || 1;
  const before: number[] = [0];
  for (let i = 0; i < n; i++) before.push(before[i] + (chars[i] ?? 0));
  const starts: number[] = [];
  let i = 0;
  for (let p = 0; p < total; p++) {
    while (i < n - 1 && edge[i + 1] <= offsets[p]) i++;
    const pos = Math.min(1, Math.max(0, (offsets[p] - edge[i]) / Math.max(1, edge[i + 1] - edge[i])));
    const f = (before[i] + pos * (chars[i] ?? 0)) / sum;
    starts.push(Math.round(Math.max(starts[p - 1] ?? 0, Math.min(1, f)) * 1e6) / 1e6);
  }
  return { total, starts };
}

export async function epubPages(book: BookRow): Promise<EpubPages> {
  if (book.format !== 'epub') throw new Error('not an EPUB');
  const key = `${book.id}:${book.fingerprint}`;
  let hit = memory.get(key);
  if (hit?.approx && Date.now() - (approxAt.get(key) ?? 0) > 10 * 60_000) { memory.delete(key); hit = undefined; } // (try for the real one again after a while)
  if (hit && hit.total > 0 && book.pages !== hit.total) db.prepare('UPDATE books SET pages = ? WHERE id = ?').run(hit.total, book.id);
  if (hit) return hit;
  let job = working.get(key);
  if (!job) {
    job = (async () => {
      const file = fileFor(`${book.fingerprint}`);
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8')) as EpubPages & { v: number; layout: string };
        if (saved.v === VERSION && saved.layout === JSON.stringify(EPUB_PAGE) && Array.isArray(saved.starts) && saved.starts.length === saved.total) return { total: saved.total, starts: saved.starts };
      } catch { /* not worked out yet */ }
      let t: EpubPages;
      try {
        t = await compute(book, key);
      } catch (e) {
        console.warn(`[shelf] could not work out exact pages for "${book.title}": ${(e as Error).message}`);
        const total = await peekPages(book);
        approxAt.set(key, Date.now());
        return { total, starts: Array.from({ length: total }, (_, i) => i / total), approx: true };
      }
      await fs.writeFile(file, JSON.stringify({ v: VERSION, layout: JSON.stringify(EPUB_PAGE), ...t })).catch(() => {});
      return t;
    })().then((t) => {
      // the page count of the book is the viewer's one (so the card, the viewer and the reader all say the same)
      if (t.total > 0 && book.pages !== t.total) db.prepare('UPDATE books SET pages = ? WHERE id = ?').run(t.total, book.id);
      memory.set(key, t);
      while (memory.size > 24) memory.delete(memory.keys().next().value as string);
      return t;
    }).finally(() => working.delete(key));
    working.set(key, job);
  }
  return job;
}

/** The page count of an EPUB whose pages have been worked out before (null if not yet), without waiting for anything. Looked up by the file's fingerprint. */
export function knownPages(book: { fingerprint: string; id?: number }): number | null {
  const hit = book.id != null ? memory.get(`${book.id}:${book.fingerprint}`) : undefined;
  if (hit) return hit.total;
  try {
    const saved = JSON.parse(readFileSync(fileFor(`${book.fingerprint}`), 'utf8')) as EpubPages & { v: number; layout: string };
    return saved.v === VERSION && saved.layout === JSON.stringify(EPUB_PAGE) && saved.total > 0 ? saved.total : null;
  } catch {
    return null;
  }
}

/**
 * Make every EPUB's page count (the one on its card) the viewer's, for each book whose pages have been worked out. A scan or a metadata rebuild writes
 * an estimate from the text length, so this runs after one; it only reads the small saved tables, and only of books that were opened.
 */
export function syncEpubPageCounts(): number {
  let fixed = 0;
  const rows = db.prepare("SELECT id, fingerprint, pages FROM books WHERE format = 'epub' AND missing = 0").all() as Array<{ id: number; fingerprint: string; pages: number | null }>;
  const set = db.prepare('UPDATE books SET pages = ? WHERE id = ?');
  for (const r of rows) {
    const known = knownPages(r);
    if (known && known !== r.pages) { set.run(known, r.id); fixed++; }
  }
  return fixed;
}

/** Which section holds these words: the one a position was worked out to (from how far through the book it is, which is only close) or one next to it. */
export async function sectionHolding(book: BookRow, quote: string, guess: number): Promise<number> {
  const abs = path.join(LIBRARY_DIR, book.path);
  const st = await epubStructure(`${book.id}:${book.fingerprint}`, abs);
  const q = boil(quote).slice(0, 160);
  if (q.length < 8) return guess;
  const tries = [guess, guess + 1, guess - 1, guess + 2, guess - 2].filter((i) => i >= 0 && i < st.spine.length && st.spine[i].kind === 'doc');
  const found = new Map<string, boolean>();
  const names = new Set(tries.map((i) => st.spine[i].path));
  await readEntries(abs, names, (name, data) => { found.set(name, sectionText(data.toString('utf8')).includes(q)); }, 96 * 1024 * 1024).catch(() => {});
  for (const i of tries) if (found.get(st.spine[i].path)) return i;
  return guess;
}
