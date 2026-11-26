import crypto from 'node:crypto';
import path from 'node:path';
import zlib from 'node:zlib';
import sharp from 'sharp';
import { fallbackFaces } from './fallbackfont.js';
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
 * Smaller things in the same copy: a reference to a file that is there under another capitalisation (`Styles/0001.css` for `styles/0001.css`; a browser's reader
 * is not as strict as a zip), a stylesheet missing the `;` between two declarations, `epub:type` rules (mupdf has no namespaced attribute selectors, so a book's
 * "hide the page-list nav" is turned into a class rule), a font that is really a WOFF.
 * This makes a corrected copy of the book in memory for it (the file in the library is never touched): the SVG wrapper becomes a plain <img>, odd formats become PNG
 * (and are made smaller, as they're only drawn for a page), root paths become relative. Returns null when nothing needed changing, so the file itself is used.
 */

const HTML = /\.(x?html?)$/i;
const ODD_IMAGE = /\.(webp|avif|svg|heic|heif)$/i;
const MAX_BYTES = 120 * 1024 * 1024;
/** A page of a book can be a whole volume (an "all volumes" EPUB has files of tens of megabytes), so the limit for reading one is high. */
const MAX_HTML = 96 * 1024 * 1024;

/** What mending a page needs to know about the rest of the book. */
interface Ctx {
  /** lower-case path -> the path as it is in the book (for references that differ only in capitals). */
  lower?: Map<string, string>;
  names?: Set<string>;
  /** a stylesheet of the book selects on epub:type, so those elements get a class that the (rewritten) rule can select. */
  epubType?: boolean;
}

/** A reference from the file `entry` to another file in the book, put right when it names a file that is there under other capitals or percent-encoding. */
function fixRef(entry: string, ref: string, ctx: Ctx): string {
  if (!ctx.names || !ctx.lower || !ref || ref.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//')) return ref;
  const m = /^([^#?]*)([#?][\s\S]*)?$/.exec(ref);
  if (!m || !m[1]) return ref;
  const dir = path.posix.dirname(entry);
  let decoded = m[1];
  try { decoded = decodeURIComponent(decoded); } catch { /* as written */ }
  const target = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(dir, decoded));
  if (ctx.names.has(target)) return ref;
  const actual = ctx.lower.get(target.toLowerCase());
  if (!actual) return ref;
  return path.posix.relative(dir, actual).split('/').map(encodeURIComponent).join('/') + (m[2] ?? '');
}

/** The text of a stylesheet with the things mupdf chokes on put right; the same text when there is nothing to do. */
export function mendCss(entry: string, css: string, ctx: Ctx = {}): string {
  let out = css;
  // two declarations run together (`text-indent: -1em  line-height: 1.4em;`): a browser drops the first; mupdf drops the rule. Put the missing ; in.
  out = out.replace(/([^;{}\s,(])([ \t\r\n]+)((?:margin|padding|line-height|text-indent|text-align|font(?:-[a-z]+)?|color|background(?:-[a-z]+)?|border(?:-[a-z]+)*|display|width|height|float|clear|page-break-[a-z]+|text-decoration|vertical-align|white-space)[ \t]*:)/gi, (all, a: string, ws: string, prop: string) => (/[{;]\s*$/.test(a) ? all : `${a};${ws}${prop}`));
  // epub:type selectors: no namespaced attributes in mupdf, so they become classes (the elements get them, see mendHtml)
  out = out.replace(/\[\s*epub(?:\\?:|\|)type\s*(~?=)\s*(?:"([^"]*)"|'([^']*)'|([\w-]+))\s*\]/gi, (_all, _op: string, a?: string, b?: string, c?: string) => `.epubtype-${(a ?? b ?? c ?? '').trim()}`);
  // urls (fonts, images) that name a file by other capitals
  if (ctx.names) out = out.replace(/url\(\s*(["']?)([^)"']+)\1\s*\)/gi, (all, q: string, ref: string) => { const f = fixRef(entry, ref.trim(), ctx); return f === ref.trim() ? all : `url(${q}${f}${q})`; });
  return out;
}

/** The text of a page with those three things put right; the same text when there is nothing to do. */
export function mendHtml(entry: string, html: string, ctx: Ctx = {}): string {
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
  // pictures and stylesheets named by other capitals
  if (ctx.names) {
    out = out.replace(/<(?:img|link)\b[^>]*>/gi, (tag) => tag.replace(/(\b(?:src|href)\s*=\s*)(["'])([^"']*)\2/i, (_, pre: string, q: string, href: string) => `${pre}${q}${fixRef(entry, href, ctx)}${q}`));
  }
  // epub:type="pagebreak" -> also class="epubtype-pagebreak", for the rules mendCss made
  if (ctx.epubType) {
    out = out.replace(/<([a-zA-Z][\w:-]*)(\s[^>]*?)\bepub:type\s*=\s*(["'])([^"']*)\3([^>]*)>/g, (all, tag: string, before: string, _q: string, types: string, after: string) => {
      const cls = types.split(/\s+/).filter(Boolean).map((t) => `epubtype-${t}`).join(' ');
      const rest = `${before}epub:type="${types}"${after}`;
      return /\bclass\s*=\s*(["'])/i.test(rest) ? `<${tag}${rest.replace(/\bclass\s*=\s*(["'])/i, (_m, q: string) => `class=${q}${cls} `)}>` : `<${tag}${rest} class="${cls}">`;
    });
  }
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

const isFont = (b: Buffer) => b.length > 12 && (b.readUInt32BE(0) === 0x00010000 || ['OTTO', 'true', 'ttcf', 'typ1'].includes(b.toString('latin1', 0, 4)));

/** A WOFF (1) font as the plain TrueType/OpenType file mupdf can read; null if it isn't one. */
export function woffToSfnt(b: Buffer): Buffer | null {
  if (b.length < 44 || b.toString('latin1', 0, 4) !== 'wOFF') return null;
  try {
    const flavor = b.readUInt32BE(4);
    const n = b.readUInt16BE(12);
    const tables: Array<{ tag: Buffer; data: Buffer; sum: number }> = [];
    for (let i = 0; i < n; i++) {
      const e = 44 + i * 20;
      const off = b.readUInt32BE(e + 4);
      const comp = b.readUInt32BE(e + 8);
      const orig = b.readUInt32BE(e + 12);
      const raw = b.subarray(off, off + comp);
      tables.push({ tag: b.subarray(e, e + 4), data: comp < orig ? zlib.inflateSync(raw) : raw, sum: b.readUInt32BE(e + 16) });
    }
    const head = Buffer.alloc(12 + 16 * n);
    head.writeUInt32BE(flavor, 0);
    head.writeUInt16BE(n, 4);
    const pow = 2 ** Math.floor(Math.log2(Math.max(1, n)));
    head.writeUInt16BE(pow * 16, 6);
    head.writeUInt16BE(Math.log2(pow), 8);
    head.writeUInt16BE(n * 16 - pow * 16, 10);
    let at = head.length;
    const bodies: Buffer[] = [];
    tables.forEach((t, i) => {
      const d = 12 + i * 16;
      t.tag.copy(head, d);
      head.writeUInt32BE(t.sum, d + 4);
      head.writeUInt32BE(at, d + 8);
      head.writeUInt32BE(t.data.length, d + 12);
      const pad = (4 - (t.data.length % 4)) % 4;
      bodies.push(t.data, Buffer.alloc(pad));
      at += t.data.length + pad;
    });
    return Buffer.concat([head, ...bodies]);
  } catch {
    return null;
  }
}

/** The keys a book's fonts can be scrambled with, made from the identifier the package names as its unique one (that one first; the others as a second chance). */
async function fontKeys(abs: string): Promise<{ idpf: Buffer[]; adobe: Buffer[] }> {
  const none = { idpf: [], adobe: [] };
  const container = await readSmall(abs, 'META-INF/container.xml');
  const opfPath = container && /full-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1];
  const opf = opfPath ? await readSmall(abs, opfPath) : null;
  if (!opf) return none;
  const ref = /<package\b[^>]*\bunique-identifier\s*=\s*["']([^"']+)["']/i.exec(opf)?.[1];
  const ids = [...opf.matchAll(/<(?:\w+:)?identifier\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?identifier>/gi)];
  const pick = ids.find((m) => ref && new RegExp(`\\bid\\s*=\\s*["']${ref}["']`).test(m[1]));
  const order = [...(pick ? [pick] : []), ...ids.filter((m) => m !== pick)];
  const out: { idpf: Buffer[]; adobe: Buffer[] } = { idpf: [], adobe: [] };
  for (const m of order) {
    const uid = m[2].replace(/&amp;/g, '&');
    const hex = uid.replace(/^\s*urn:uuid:/i, '').replace(/[-\s]/g, '');
    out.idpf.push(crypto.createHash('sha1').update(uid.replace(/[ \t\r\n]/g, ''), 'utf8').digest());
    if (/^[0-9a-f]{32}$/i.test(hex)) out.adobe.push(Buffer.from(hex, 'hex'));
  }
  return out;
}

/** The font a scrambled file really holds: tried with the package's key, then every other key the book could have (and not at all if it is already a font). */
function descramble(data: Buffer, alg: string, keys: { idpf: Buffer[]; adobe: Buffer[] }): Buffer | null {
  if (isFont(data)) return data; // listed as scrambled but isn't (it happens)
  const tries: Array<[Buffer, number]> = alg === IDPF
    ? [...keys.idpf.map((k) => [k, 1040] as [Buffer, number]), ...keys.adobe.map((k) => [k, 1024] as [Buffer, number])]
    : [...keys.adobe.map((k) => [k, 1024] as [Buffer, number]), ...keys.idpf.map((k) => [k, 1040] as [Buffer, number])];
  for (const [k, n] of tries) {
    const out = xor(data, k, n);
    if (isFont(out) || woffToSfnt(out)) return woffToSfnt(out) ?? out;
  }
  return null;
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
    if (!uri || !((alg === IDPF && keys.idpf.length) || (alg === ADOBE && keys.adobe.length))) continue; // anything else is real protection: left as it is
    let name = uri.replace(/^\/+/, '');
    try { name = decodeURIComponent(name); } catch { /* as written */ }
    if (names.has(name)) todo.push({ block: m[0], name, alg });
  }
  if (!todo.length) return null;
  const files = new Map<string, Buffer>();
  const algOf = new Map(todo.map((t) => [t.name, t.alg]));
  await readEntries(abs, new Set(todo.map((t) => t.name)), (name, data) => {
    const font = descramble(data, algOf.get(name)!, keys);
    if (font) files.set(name, font);
  }, 16 * 1024 * 1024);
  let rest = xml;
  for (const t of todo) if (files.has(t.name)) rest = rest.replace(t.block, '');
  return { files, encryption: /<(?:\w+:)?EncryptedData\b/i.test(rest) ? rest : null };
}

/**
 * Letters mupdf can't be trusted with: the dotted and dashed letters of transliterated Sanskrit and Pali, Vietnamese and the like (Latin Extended Additional),
 * and a letter with a combining mark after it. A book's own font may lack them or draw an empty box for them, and mupdf only borrows a letter from another font
 * when the font has no glyph for it at all. So each run of them is wrapped in a span set in a font that is put inside the copy of the book (from here, see
 * fallbackfont.ts), and the box never shows. This is what a browser does by itself when it shows the same book.
 */
const SPECIAL = /[A-Za-z]?[̀-ͯ]+|[Ḁ-ỿ]+/g;
const FB_DIR = 'shelf-fb';
const FB_FILE: Record<string, string> = { r: 'regular.ttf', b: 'bold.ttf', i: 'italic.ttf', bi: 'bolditalic.ttf' };

export function wrapSpecial(entry: string, html: string): string {
  // numeric references to those letters (&#7751;) are made plain first, so they are found too
  let text = html.replace(/&#(x[0-9a-f]+|\d+);/gi, (m, n: string) => {
    const cp = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : parseInt(n, 10);
    return (cp >= 0x1e00 && cp <= 0x1eff) || (cp >= 0x300 && cp <= 0x36f) ? String.fromCodePoint(cp) : m;
  });
  if (!(new RegExp(SPECIAL.source)).test(text)) return html;
  text = text.replace(/(<!--[\s\S]*?-->|<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)|(<[^>]*>)|([^<]+)/gi, (m, keep: string | undefined, tag: string | undefined, run: string | undefined) =>
    keep ?? tag ?? (run as string).replace(SPECIAL, (x) => `<span style="font-family:ShelfFB">${x}</span>`));
  const rel = path.posix.relative(path.posix.dirname(entry), FB_DIR) || FB_DIR;
  const face = (key: string, weight: string, style: string) => `@font-face{font-family:"ShelfFB";font-weight:${weight};font-style:${style};src:url("${rel}/${FB_FILE[key]}")}`;
  const css = `<style type="text/css">${face('r', 'normal', 'normal')}${face('b', 'bold', 'normal')}${face('i', 'normal', 'italic')}${face('bi', 'bold', 'italic')}</style>`;
  if (/<\/head>/i.test(text)) return text.replace(/<\/head>/i, `${css}</head>`);
  if (/<head\b[^>]*>/i.test(text)) return text.replace(/<head\b[^>]*>/i, (h) => `${h}${css}`);
  return text.replace(/<body\b/i, `<head>${css}</head><body`);
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
  const faces = await fallbackFaces().catch(() => null); // the stand-in letters' font, which goes into the copy
  let usedFaces = false;
  const names = new Set(entries.map((e) => e.name));
  const ctx: Ctx = { names, lower: new Map(entries.map((e) => [e.name.toLowerCase(), e.name])) };
  // stylesheets first (what the pages need to know about them comes from here)
  const css = entries.filter((e) => /\.css$/i.test(e.name) && e.size <= 8 * 1024 * 1024);
  const cssText = new Map<string, string>();
  await readEntries(abs, new Set(css.map((e) => e.name)), (name, data) => { cssText.set(name, data.toString('utf8')); }, 8 * 1024 * 1024);
  for (const [name, text] of cssText) {
    if (/\[\s*epub(?:\\?:|\|)type/i.test(text)) ctx.epubType = true;
    const fixed = mendCss(name, text, ctx);
    if (fixed !== text) changed.set(name, Buffer.from(fixed, 'utf8'));
  }
  await readEntries(abs, new Set(html.map((e) => e.name)), (name, data) => {
    const text = data.toString('utf8');
    if (!needsFont && NEEDS_FONT.test(text)) needsFont = true;
    let fixed = mendHtml(name, text, ctx);
    if (faces) fixed = wrapSpecial(name, fixed);
    if (fixed !== text) changed.set(name, Buffer.from(fixed, 'utf8'));
    if (faces && fixed.includes('font-family:ShelfFB')) usedFaces = true;
  }, MAX_HTML);
  const fonts = await unscrambleFonts(abs, entries).catch(() => null);
  if (fonts) {
    for (const [n, d] of fonts.files) changed.set(n, d);
    if (fonts.encryption === null) removed.add(ENC);
    else changed.set(ENC, Buffer.from(fonts.encryption, 'utf8'));
  }
  // a font that is a WOFF (mupdf only reads plain TrueType/OpenType)
  const woffs = entries.filter((e) => /\.(woff|ttf|otf)$/i.test(e.name) && !changed.has(e.name) && e.size <= 16 * 1024 * 1024);
  if (woffs.length) {
    await readEntries(abs, new Set(woffs.map((e) => e.name)), (name, data) => {
      const sfnt = woffToSfnt(data);
      if (sfnt) changed.set(name, sfnt);
    }, 16 * 1024 * 1024);
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
  const added = new Map<string, Buffer>();
  if (faces && usedFaces) for (const k of Object.keys(FB_FILE)) added.set(`${FB_DIR}/${FB_FILE[k]}`, faces[k as keyof typeof faces]);
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
  for (const [name, data] of added) all.push({ name, data });
  return { bytes: zipOf(all), needsFont };
}
