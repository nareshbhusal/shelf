import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { listEntries, readEntries, readEntry } from './zip.js';

export interface SpineItem {
  path: string; // entry name inside the zip
  size: number; // uncompressed bytes, used to guess its height before it is loaded
  kind: 'doc' | 'image';
}
export interface TocItem {
  title: string;
  path: string; // zip entry the item points to
  frag: string; // '#...' without the '#', '' if none
  children: TocItem[];
}
export interface EpubStructure {
  title?: string;
  spine: SpineItem[];
  /** Characters of text in each spine item (set once text has been counted). */
  chars?: number[];
  toc: TocItem[];
  rtl: boolean;
  entries: Set<string>;
}

// Parsed XML is loosely typed on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = Record<string, any>;

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, parseTagValue: false, trimValues: true });
const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** All the text inside a parsed XML node, however deeply nested (<a><span>Chapter</span> 1</a>). */
function flatText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(flatText).join(' ');
  if (typeof v === 'object') {
    return Object.entries(v as Record<string, unknown>)
      .filter(([k]) => !k.startsWith('@_'))
      .map(([, x]) => flatText(x))
      .join(' ');
  }
  return '';
}
const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Resolve a (possibly percent-encoded, possibly fragment-carrying) href against a zip entry. */
export function resolveHref(fromEntry: string, href: string): { path: string; frag: string } {
  const [p, ...rest] = href.split('#');
  const frag = decode(rest.join('#'));
  if (!p) return { path: fromEntry, frag };
  return { path: path.posix.normalize(path.posix.join(path.posix.dirname(fromEntry), decode(p))), frag };
}

// The nav document is parsed with element order kept, so "Chapter <i>One</i>" reads in the right order.
const xmlOrdered = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, preserveOrder: true, parseTagValue: false, trimValues: true });
type PO = N[];
const tagOf = (n: N) => Object.keys(n).find((k) => k !== ':@') ?? '';
const textPO = (nodes: PO): string =>
  nodes.map((n) => (tagOf(n) === '#text' ? String(n['#text']) : textPO((n[tagOf(n)] as PO) ?? []))).join(' ');

function parseNav(source: string, navPath: string): TocItem[] {
  const doc = xmlOrdered.parse(source) as PO;
  const navs: N[] = [];
  const walk = (nodes: PO) => {
    for (const n of nodes) {
      const t = tagOf(n);
      if (t === 'nav') navs.push(n);
      else if (t !== '#text' && Array.isArray(n[t])) walk(n[t] as PO);
    }
  };
  walk(doc);
  const pick = navs.find((n) => String(n[':@']?.['@_type'] ?? '').split(/\s+/).includes('toc')) ?? navs[0];
  if (!pick) return [];

  const list = (nodes: PO): TocItem[] => {
    const out: TocItem[] = [];
    for (const li of nodes.filter((n) => tagOf(n) === 'li')) {
      const kids = li.li as PO;
      const a = kids.find((n) => tagOf(n) === 'a');
      const label = tidy(textPO(((a ?? kids.find((n) => tagOf(n) === 'span'))?.[a ? 'a' : 'span'] as PO) ?? []));
      const ol = kids.find((n) => tagOf(n) === 'ol');
      const children = ol ? list(ol.ol as PO) : [];
      const href = a?.[':@']?.['@_href'] as string | undefined;
      if (href) {
        const r = resolveHref(navPath, href);
        out.push({ title: label || r.path, path: r.path, frag: r.frag, children });
      } else if (children.length) {
        out.push(...children);
      }
    }
    return out;
  };
  const ol = (pick.nav as PO).find((n) => tagOf(n) === 'ol');
  return ol ? list(ol.ol as PO) : [];
}

function parseNcx(doc: Record<string, unknown>, ncxPath: string): TocItem[] {
  const points = (n: unknown): TocItem[] => {
    const out: TocItem[] = [];
    for (const p of asArray<N>(n as N)) {
      const src = (p?.content as N | undefined)?.['@_src'] as string | undefined;
      const children = points(p?.navPoint);
      if (src) {
        const r = resolveHref(ncxPath, src);
        const label = tidy(flatText((p?.navLabel as N | undefined)?.text ?? p?.navLabel));
        out.push({ title: label || r.path, path: r.path, frag: r.frag, children });
      } else out.push(...children);
    }
    return out;
  };
  const ncx = doc?.ncx as Record<string, unknown> | undefined;
  return points((ncx?.navMap as Record<string, unknown> | undefined)?.navPoint);
}

// A "page" of an EPUB is an estimate: ~1800 characters of text, about a paperback page. Sections made
// of pictures (comics, fixed layouts) count one page each.
export const CHARS_PER_PAGE = 1800;
export const pagesFromChars = (chars: number[]) => Math.max(1, Math.round(chars.reduce((a, b) => a + b, 0) / CHARS_PER_PAGE));

const BLOCK = /<\/?(?:p|div|br|h[1-6]|li|tr|section|blockquote|pre)\b[^>]*>/gi;
function textChars(html: string): number {
  let s = html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '').replace(/<head\b[\s\S]*?<\/head>/i, '');
  const picture = /<(img|image|svg)\b/i.test(s);
  s = s.replace(BLOCK, ' ').replace(/<[^>]*>/g, '').replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, '.').replace(/\s+/g, ' ').trim();
  return picture && s.length < 200 ? CHARS_PER_PAGE : s.length;
}

/** Text length of every spine item, from one pass over the file. Items that can't be read are guessed from their size. */
export async function countText(file: string, spine: SpineItem[]): Promise<number[]> {
  const out = spine.map((s) => (s.kind === 'image' ? CHARS_PER_PAGE : Math.round(s.size * 0.45)));
  const at = new Map<string, number[]>();
  spine.forEach((s, i) => s.kind === 'doc' && at.set(s.path, [...(at.get(s.path) ?? []), i]));
  try {
    await readEntries(file, new Set(at.keys()), (name, data) => {
      const n = textChars(data.toString('utf8'));
      for (const i of at.get(name) ?? []) out[i] = n;
    });
  } catch {
    /* keep the guesses */
  }
  return out.map((n) => Math.max(1, n));
}

const cache = new Map<string, EpubStructure>();

/** Reading order and table of contents of an EPUB. Cached per book version (key = id + fingerprint). */
export async function epubStructure(key: string, file: string): Promise<EpubStructure> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const out = await readEpubStructure(file);
  out.chars = await countText(file, out.spine);
  cache.set(key, out);
  while (cache.size > 12) cache.delete(cache.keys().next().value as string);
  return out;
}

export async function readEpubStructure(file: string, withToc = true): Promise<EpubStructure> {
  const entriesList = await listEntries(file);
  const entries = new Set(entriesList.map((e) => e.name));
  const sizes = new Map(entriesList.map((e) => [e.name, e.size]));

  const container = xml.parse((await readEntry(file, 'META-INF/container.xml')).toString('utf8'));
  const opfPath = asArray<Record<string, string>>(container?.container?.rootfiles?.rootfile)[0]?.['@_full-path'];
  if (!opfPath) throw new Error('not a valid EPUB (no package document)');
  const opf = xml.parse((await readEntry(file, opfPath)).toString('utf8'));
  const pkg = opf?.package;
  const items = asArray<Record<string, string>>(pkg?.manifest?.item);
  const byId = new Map(items.map((i) => [i['@_id'], i]));
  const at = (href: string) => resolveHref(opfPath, href).path;

  const spine: SpineItem[] = [];
  for (const ref of asArray<Record<string, string>>(pkg?.spine?.itemref)) {
    const it = byId.get(ref['@_idref']);
    if (!it?.['@_href']) continue;
    const p = at(it['@_href']);
    if (!entries.has(p)) continue;
    const type = it['@_media-type'] ?? '';
    const kind: SpineItem['kind'] = /^image\//.test(type) ? 'image' : 'doc';
    if (kind === 'doc' && !/xhtml|html|xml|svg/.test(type)) continue; // not something we can show
    spine.push({ path: p, size: sizes.get(p) ?? 0, kind });
  }
  if (!spine.length) throw new Error('this EPUB has no readable content');

  // Table of contents: EPUB3 nav document, else EPUB2 NCX, else one entry per section.
  let toc: TocItem[] = [];
  if (withToc) try {
    const navItem = items.find((i) => (i['@_properties'] ?? '').split(/\s+/).includes('nav'));
    if (navItem?.['@_href']) {
      const p = at(navItem['@_href']);
      if (entries.has(p)) toc = parseNav((await readEntry(file, p)).toString('utf8'), p);
    }
    if (!toc.length) {
      const ncxItem = byId.get(pkg?.spine?.['@_toc']) ?? items.find((i) => i['@_media-type'] === 'application/x-dtbncx+xml');
      if (ncxItem?.['@_href']) {
        const p = at(ncxItem['@_href']);
        if (entries.has(p)) toc = parseNcx(xml.parse((await readEntry(file, p)).toString('utf8')), p);
      }
    }
  } catch {
    /* a broken TOC shouldn't stop the book from opening */
  }
  const inSpine = new Set(spine.map((s) => s.path));
  const keep = (list: TocItem[]): TocItem[] => list.filter((t) => inSpine.has(t.path)).map((t) => ({ ...t, children: keep(t.children) }));
  toc = keep(toc);
  if (!toc.length) toc = spine.map((s, i) => ({ title: `Section ${i + 1}`, path: s.path, frag: '', children: [] }));

  const md = pkg?.metadata ?? {};
  const t = asArray(md.title)[0];
  const rtl = String(pkg?.spine?.['@_page-progression-direction'] ?? '') === 'rtl';
  return { title: tidy(flatText(t)) || undefined, spine, toc, rtl, entries };
}

export const EPUB_MIME: Record<string, string> = {
  '.xhtml': 'application/xhtml+xml',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xml': 'application/xhtml+xml',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
};
