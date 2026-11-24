import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { listEntries, readEntries } from './zip.js';

/**
 * mupdf is what lays an EPUB out into pages for the flip-through viewer, and its HTML engine is narrower than a browser's. Three common things it shows as the text
 * "[image]" instead of a picture, which is what a book's own cover page tends to be made of:
 *   - a picture wrapped in inline SVG (`<svg><image xlink:href="cover.jpg"/></svg>`, what Calibre and Sigil write for a cover),
 *   - a picture in a format it can't read (WebP, AVIF, an SVG file),
 *   - a picture whose path starts at the root of the book (`src="/OEBPS/images/cover.jpg"`).
 * This makes a corrected copy of the book in memory for it (the file in the library is never touched): the SVG wrapper becomes a plain <img>, odd formats become PNG
 * (and are made smaller, as they're only drawn for a page), root paths become relative. Returns null when nothing needed changing, so the file itself is used.
 */

const HTML = /\.(x?html?)$/i;
const ODD_IMAGE = /\.(webp|avif|svg|heic|heif)$/i;
const MAX_BYTES = 120 * 1024 * 1024;

/** The text of a page with those three things put right; the same text when there is nothing to do. */
export function mendHtml(entry: string, html: string): string {
  const dir = path.posix.dirname(entry);
  const relative = (href: string) => (/^\/(?!\/)/.test(href) ? path.posix.relative(dir, href.slice(1)) || href : href);
  const attr = /(\b(?:src|(?:xlink:)?href)\s*=\s*)(["'])([^"']*)\2/i;
  // inline SVG that is only a picture becomes the picture
  let out = html.replace(/<svg\b[^>]*>([\s\S]*?)<\/svg>/gi, (all, body: string) => {
    if (/<(path|rect|circle|ellipse|line|polyline|polygon|text|use|foreignObject)\b/i.test(body)) return all;
    const img = /<image\b[^>]*>/i.exec(body);
    const m = img ? attr.exec(img[0]) : null;
    return m ? `<img src="${relative(m[3])}" alt=""/>` : all;
  });
  // a path from the root of the book, made relative to this page
  out = out.replace(/<img\b[^>]*>/gi, (tag) => tag.replace(attr, (_, pre: string, q: string, href: string) => `${pre}${q}${relative(href)}${q}`));
  return out;
}

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

/** A zip file with its entries stored as they are (no compression: it only has to be read once, in memory). */
function zipOf(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = zlib.crc32(f.data);
    const head = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), name]);
    central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(f.data.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    parts.push(head, f.data);
    offset += head.length + f.data.length;
  }
  const dir = Buffer.concat(central);
  return Buffer.concat([...parts, dir, u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(dir.length), u32(offset), u16(0)]);
}

export async function mendedEpub(abs: string): Promise<Buffer | null> {
  const entries = await listEntries(abs);
  const html = entries.filter((e) => HTML.test(e.name) && e.size <= 8 * 1024 * 1024);
  const odd = entries.filter((e) => ODD_IMAGE.test(e.name) && e.size <= 25 * 1024 * 1024);
  const changed = new Map<string, Buffer>();
  await readEntries(abs, new Set(html.map((e) => e.name)), (name, data) => {
    const text = data.toString('utf8');
    const fixed = mendHtml(name, text);
    if (fixed !== text) changed.set(name, Buffer.from(fixed, 'utf8'));
  });
  if (odd.length) {
    for (const e of odd.slice(0, 300)) { // one at a time, so they aren't all held in memory at once
      const raw: Buffer[] = [];
      await readEntries(abs, new Set([e.name]), (_n, d) => raw.push(d), 25 * 1024 * 1024);
      if (!raw[0]) continue;
      try {
        changed.set(e.name, await sharp(raw[0], { failOn: 'none', density: 144 }).resize({ width: 1600, withoutEnlargement: true }).png().toBuffer());
      } catch { /* left as it is: shown as "[image]" */ }
    }
  }
  if (!changed.size) return null;
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > MAX_BYTES) return null;
  const all: Array<{ name: string; data: Buffer }> = [];
  const order = entries.map((e) => e.name);
  const rest = new Map<string, Buffer>();
  await readEntries(abs, new Set(order.filter((n) => !changed.has(n) && !n.endsWith('/'))), (n, d) => rest.set(n, d), MAX_BYTES);
  for (const n of order) {
    if (n.endsWith('/')) continue;
    const data = changed.get(n) ?? rest.get(n);
    if (data) all.push({ name: n, data });
  }
  return zipOf(all);
}
