import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { listEntries, readEntries, readEntry } from './zip.js';

/**
 * mupdf is what lays an EPUB out into pages for the flip-through viewer, and its HTML engine is narrower than a browser's. Three common things it shows as the text
 * "[image]" instead of a picture, which is what a book's own cover page tends to be made of:
 *   - a picture wrapped in inline SVG (`<svg><image xlink:href="cover.jpg"/></svg>`, what Calibre and Sigil write for a cover),
 *   - a picture in a format it can't read (WebP, AVIF, an SVG file),
 *   - a picture whose path starts at the root of the book (`src="/OEBPS/images/cover.jpg"`).
 * Fonts are the other thing: a book's own fonts are very often "obfuscated" (the first kilobyte scrambled with a key made from the book's identifier; a publisher's
 * way of keeping them from being lifted, listed in META-INF/encryption.xml). Readers undo that, mupdf doesn't, so the page falls back to its built-in font, which
 * has none of the letters of a transliterated Sanskrit or Pali text (ṇ ṣ ḥ ṃ ...), and they show as empty boxes. The scrambling is undone here, in the copy.
 * This makes a corrected copy of the book in memory for it (the file in the library is never touched): the SVG wrapper becomes a plain <img>, odd formats become PNG
 * (and are made smaller, as they're only drawn for a page), root paths become relative. Returns null when nothing needed changing, so the file itself is used.
 */

const HTML = /\.(x?html?)$/i;
const ODD_IMAGE = /\.(webp|avif|svg|heic|heif)$/i;
const MAX_BYTES = 120 * 1024 * 1024;
/** A page of a book can be a whole volume (an "all volumes" EPUB has files of tens of megabytes), so the limit for reading one is high. */
const MAX_HTML = 96 * 1024 * 1024;

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

const ENC = 'META-INF/encryption.xml';
const IDPF = 'http://www.idpf.org/2008/embedding';
const ADOBE = 'http://ns.adobe.com/pdf/enc#RC';
/** Letters the built-in font of mupdf doesn't have (Latin Extended-B and Additional, IPA, combining marks): a book with these needs a font that does. */
const NEEDS_FONT = /[ƀ-ͯḀ-ỿ]/;

const xor = (data: Buffer, key: Buffer, n: number) => {
  const out = Buffer.from(data);
  for (let i = 0; i < Math.min(n, out.length); i++) out[i] ^= key[i % key.length];
  return out;
};
const readSmall = (abs: string, name: string) => readEntry(abs, name, 4 * 1024 * 1024).then((b) => b.toString('utf8')).catch(() => null);

/** The two keys a book's fonts can be scrambled with, made from the identifier the package names as its unique one. */
async function fontKeys(abs: string): Promise<{ idpf: Buffer | null; adobe: Buffer | null }> {
  const none = { idpf: null, adobe: null };
  const container = await readSmall(abs, 'META-INF/container.xml');
  const opfPath = container && /full-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1];
  const opf = opfPath ? await readSmall(abs, opfPath) : null;
  if (!opf) return none;
  const ref = /<package\b[^>]*\bunique-identifier\s*=\s*["']([^"']+)["']/i.exec(opf)?.[1];
  const ids = [...opf.matchAll(/<(?:\w+:)?identifier\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?identifier>/gi)];
  const pick = ids.find((m) => ref && new RegExp(`\\bid\\s*=\\s*["']${ref}["']`).test(m[1])) ?? ids[0];
  if (!pick) return none;
  const uid = pick[2].replace(/&amp;/g, '&');
  const hex = uid.replace(/^\s*urn:uuid:/i, '').replace(/[-\s]/g, '');
  return {
    idpf: crypto.createHash('sha1').update(uid.replace(/[ \t\r\n]/g, ''), 'utf8').digest(),
    adobe: /^[0-9a-f]{32}$/i.test(hex) ? Buffer.from(hex, 'hex') : null,
  };
}

/** Unscrambles the fonts listed in encryption.xml. Returns the new contents of those files, and of encryption.xml (null: it has nothing left in it, drop it). */
async function unscrambleFonts(abs: string, entries: Array<{ name: string }>): Promise<{ files: Map<string, Buffer>; encryption: string | null } | null> {
  if (!entries.some((e) => e.name === ENC)) return null;
  const xml = await readSmall(abs, ENC);
  if (!xml) return null;
  const keys = await fontKeys(abs);
  const names = new Set(entries.map((e) => e.name));
  const blocks = [...xml.matchAll(/<(?:\w+:)?EncryptedData\b[\s\S]*?<\/(?:\w+:)?EncryptedData>/gi)];
  const todo: Array<{ block: string; name: string; alg: string }> = [];
  for (const m of blocks) {
    const alg = /Algorithm\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1] ?? '';
    const uri = /<(?:\w+:)?CipherReference\b[^>]*\bURI\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1];
    if (!uri || !((alg === IDPF && keys.idpf) || (alg === ADOBE && keys.adobe))) continue; // anything else is real protection: left as it is
    let name = uri.replace(/^\/+/, '');
    try { name = decodeURIComponent(name); } catch { /* as written */ }
    if (names.has(name)) todo.push({ block: m[0], name, alg });
  }
  if (!todo.length) return null;
  const files = new Map<string, Buffer>();
  const algOf = new Map(todo.map((t) => [t.name, t.alg]));
  await readEntries(abs, new Set(todo.map((t) => t.name)), (name, data) => {
    files.set(name, algOf.get(name) === IDPF ? xor(data, keys.idpf!, 1040) : xor(data, keys.adobe!, 1024));
  }, 16 * 1024 * 1024);
  let rest = xml;
  for (const t of todo) if (files.has(t.name)) rest = rest.replace(t.block, '');
  return { files, encryption: /<(?:\w+:)?EncryptedData\b/i.test(rest) ? rest : null };
}

export interface Mended {
  /** The corrected book, or null when the file as it is will do. */
  bytes: Buffer | null;
  /** The text has letters the built-in font lacks, so a font that has them should stand in for it. */
  needsFont: boolean;
}

export async function mendedEpub(abs: string): Promise<Mended> {
  const entries = await listEntries(abs);
  const html = entries.filter((e) => HTML.test(e.name) && e.size <= MAX_HTML);
  const odd = entries.filter((e) => ODD_IMAGE.test(e.name) && e.size <= 25 * 1024 * 1024);
  const changed = new Map<string, Buffer>();
  const removed = new Set<string>();
  let needsFont = false;
  await readEntries(abs, new Set(html.map((e) => e.name)), (name, data) => {
    const text = data.toString('utf8');
    if (!needsFont && NEEDS_FONT.test(text)) needsFont = true;
    const fixed = mendHtml(name, text);
    if (fixed !== text) changed.set(name, Buffer.from(fixed, 'utf8'));
  }, MAX_HTML);
  const fonts = await unscrambleFonts(abs, entries).catch(() => null);
  if (fonts) {
    for (const [n, d] of fonts.files) changed.set(n, d);
    if (fonts.encryption === null) removed.add(ENC);
    else changed.set(ENC, Buffer.from(fonts.encryption, 'utf8'));
  }
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
  if (!changed.size && !removed.size) return { bytes: null, needsFont };
  const total = entries.reduce((a, e) => a + e.size, 0);
  if (total > MAX_BYTES) return { bytes: null, needsFont };
  const all: Array<{ name: string; data: Buffer }> = [];
  const order = entries.map((e) => e.name).filter((n) => !removed.has(n));
  const rest = new Map<string, Buffer>();
  await readEntries(abs, new Set(order.filter((n) => !changed.has(n) && !n.endsWith('/'))), (n, d) => rest.set(n, d), MAX_BYTES);
  for (const n of order) {
    if (n.endsWith('/')) continue;
    const data = changed.get(n) ?? rest.get(n);
    if (data) all.push({ name: n, data });
  }
  return { bytes: zipOf(all), needsFont };
}
