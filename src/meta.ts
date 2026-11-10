import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';
import { usableAuthor, usableTitle } from './util.js';
import { readEpubStructure } from './epub.js';
import { imageNames, listEntries, readEntry } from './zip.js';

const execFileP = promisify(execFile);

export interface Meta {
  metaTitle?: string;
  author?: string;
  series?: string;
  number?: string;
  pages?: number;
}

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  parseTagValue: false, // keep "007" as "007"
  trimValues: true,
});

const asArray = <T>(v: T | T[] | undefined | null): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** XML text nodes come back as string, number, {#text, @_attr...} or arrays of those. */
function txt(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === 'object') return txt((v as Record<string, unknown>)['#text']);
  const s = String(v).trim();
  return s || undefined;
}

// ---------- PDF (via poppler's pdfinfo) ----------

let toolsWarned = false;

export async function pdfMeta(file: string): Promise<Meta> {
  try {
    const { stdout } = await execFileP('pdfinfo', [file], { timeout: 20_000, maxBuffer: 1 << 20 });
    const fields = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    const pages = parseInt(fields.get('Pages') ?? '', 10);
    return {
      metaTitle: usableTitle(fields.get('Title')),
      author: usableAuthor(fields.get('Author')),
      pages: Number.isFinite(pages) && pages > 0 ? pages : undefined,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT' && !toolsWarned) {
      toolsWarned = true;
      console.warn('! pdfinfo not found: install poppler-utils for PDF titles, page counts and covers');
    }
    return {};
  }
}

/** The technical fields poppler reports about a PDF, for the file info panel. Empty if pdfinfo is missing. */
export async function pdfDetails(file: string): Promise<Array<[string, string]>> {
  const want = ['Creator', 'Producer', 'CreationDate', 'ModDate', 'PDF version', 'Page size', 'Page rot', 'Encrypted', 'Tagged', 'Form', 'Optimized'];
  try {
    const { stdout } = await execFileP('pdfinfo', [file], { timeout: 20_000, maxBuffer: 1 << 20 });
    const fields = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const i = line.indexOf(':');
      if (i > 0) fields.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
    }
    return want.filter((k) => fields.get(k)).map((k) => [k, fields.get(k)!]);
  } catch {
    return [];
  }
}

export async function toolsAvailable(): Promise<{ pdfinfo: boolean; pdftoppm: boolean }> {
  const check = (cmd: string) =>
    execFileP(cmd, ['-v'], { timeout: 5000 }).then(
      () => true,
      (e: NodeJS.ErrnoException) => e.code !== 'ENOENT', // poppler prints -v to stderr, may exit 0 or 99
    );
  const [pdfinfo, pdftoppm] = await Promise.all([check('pdfinfo'), check('pdftoppm')]);
  return { pdfinfo, pdftoppm };
}

// ---------- EPUB ----------

export async function epubInfo(file: string): Promise<{ meta: Meta; coverEntry?: string }> {
  const container = xml.parse((await readEntry(file, 'META-INF/container.xml')).toString('utf8'));
  const opfPath = asArray(container?.container?.rootfiles?.rootfile)[0]?.['@_full-path'] as string | undefined;
  if (!opfPath) return { meta: {} };

  const opf = xml.parse((await readEntry(file, opfPath)).toString('utf8'));
  const pkg = opf?.package;
  const md = pkg?.metadata ?? {};
  const metas = asArray<Record<string, string>>(md.meta);
  const meta: Meta = {
    metaTitle: usableTitle(txt(md.title)),
    author: usableAuthor(asArray(md.creator).map(txt).filter(Boolean).join(', ')),
  };

  // Calibre-style and EPUB3 series info.
  const metaByName = (n: string) => metas.find((m) => m['@_name'] === n)?.['@_content'];
  meta.series =
    metaByName('calibre:series') ??
    txt(metas.find((m) => m['@_property'] === 'belongs-to-collection'));
  meta.number = metaByName('calibre:series_index') ?? undefined;
  if (meta.number) meta.number = String(parseFloat(meta.number) || meta.number);

  // Cover: EPUB3 `cover-image` property, else EPUB2 <meta name="cover" content="id">.
  const items = asArray<Record<string, string>>(pkg?.manifest?.item);
  let cover = items.find((i) => (i['@_properties'] ?? '').split(/\s+/).includes('cover-image'));
  if (!cover) {
    const id = metaByName('cover');
    if (id) cover = items.find((i) => i['@_id'] === id);
  }
  if (!cover) cover = items.find((i) => /cover/i.test(i['@_id'] ?? '') && /^image\//.test(i['@_media-type'] ?? ''));
  let coverEntry: string | undefined;
  if (cover?.['@_href']) {
    const base = path.posix.dirname(opfPath);
    const href = cover['@_href'];
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      /* keep raw */
    }
    coverEntry = path.posix.normalize(path.posix.join(base, decoded));
  }
  // Sections of the book; the reader and the progress bar count in these.
  try {
    meta.pages = (await readEpubStructure(file, false)).spine.length;
  } catch {
    /* unreadable structure: no count */
  }
  return { meta, coverEntry };
}

// ---------- CBZ ----------

/** Returns null when the archive has no images (so a random .zip isn't indexed as a comic). */
export async function cbzInfo(file: string): Promise<{ meta: Meta; images: string[] } | null> {
  const entries = await listEntries(file);
  const images = imageNames(entries);
  if (!images.length) return null;
  const meta: Meta = { pages: images.length };

  const ci = entries.find((e) => /(^|\/)comicinfo\.xml$/i.test(e.name));
  if (ci) {
    try {
      const doc = xml.parse((await readEntry(file, ci.name, 2 * 1024 * 1024)).toString('utf8'));
      const info = doc?.ComicInfo ?? {};
      const title = txt(info.Title);
      const series = txt(info.Series);
      const number = txt(info.Number);
      meta.series = series;
      meta.number = number;
      meta.author = usableAuthor(txt(info.Writer));
      meta.metaTitle = usableTitle(title) ?? (series ? usableTitle(number ? `${series} #${number}` : series) : undefined);
    } catch {
      /* malformed ComicInfo.xml: ignore */
    }
  }
  return { meta, images };
}
