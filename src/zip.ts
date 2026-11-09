import path from 'node:path';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import { IMAGE_MIME } from './config.js';
import { natCompare } from './util.js';

export interface ZipEntryInfo {
  name: string;
  size: number;
}

function open(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    // autoClose off: with lazy entries we may stop reading early, so we close explicitly.
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error('could not open zip'));
      else resolve(zip);
    });
  });
}

export async function listEntries(file: string): Promise<ZipEntryInfo[]> {
  const zip = await open(file);
  return new Promise((resolve, reject) => {
    const out: ZipEntryInfo[] = [];
    zip.on('entry', (e: yauzl.Entry) => {
      out.push({ name: e.fileName, size: e.uncompressedSize });
      zip.readEntry();
    });
    zip.on('end', () => {
      zip.close();
      resolve(out);
    });
    zip.on('error', (err: Error) => {
      zip.close();
      reject(err);
    });
    zip.readEntry();
  });
}

/** Stream one entry out of the zip without extracting anything else. */
export async function openEntryStream(
  file: string,
  name: string,
): Promise<{ stream: Readable; size: number }> {
  const zip = await open(file);
  return new Promise((resolve, reject) => {
    let found = false;
    zip.on('entry', (e: yauzl.Entry) => {
      if (e.fileName !== name) return zip.readEntry();
      found = true;
      zip.openReadStream(e, (err, stream) => {
        if (err || !stream) {
          zip.close();
          return reject(err ?? new Error('could not read zip entry'));
        }
        // Safe: the fd is closed only after the stream has ended.
        zip.close();
        resolve({ stream, size: e.uncompressedSize });
      });
    });
    zip.on('end', () => {
      if (!found) {
        zip.close();
        reject(new Error(`zip entry not found: ${name}`));
      }
    });
    zip.on('error', (err: Error) => {
      if (!found) {
        zip.close();
        reject(err);
      }
    });
    zip.readEntry();
  });
}

export async function readEntry(file: string, name: string, max = 64 * 1024 * 1024): Promise<Buffer> {
  const { stream } = await openEntryStream(file, name);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += (chunk as Buffer).length;
    if (total > max) {
      stream.destroy();
      throw new Error('zip entry too large');
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function imageExt(name: string): string | null {
  const base = path.posix.basename(name);
  if (base.startsWith('.') || name.startsWith('__MACOSX/')) return null;
  const ext = path.posix.extname(base).toLowerCase();
  return ext in IMAGE_MIME ? ext : null;
}

/** Image entries in natural reading order (ch2/9.jpg < ch2/10.jpg < ch10/1.jpg). */
export function imageNames(entries: ZipEntryInfo[]): string[] {
  return entries
    .filter((e) => !e.name.endsWith('/') && imageExt(e.name))
    .map((e) => e.name)
    .sort(natCompare);
}

// Sorted page lists, cached so serving page N doesn't re-list the whole archive each time.
const pageCache = new Map<string, string[]>();

export async function comicPages(
  key: string,
  file: string,
): Promise<string[]> {
  const hit = pageCache.get(key);
  if (hit) {
    pageCache.delete(key);
    pageCache.set(key, hit); // refresh LRU position
    return hit;
  }
  const names = imageNames(await listEntries(file));
  pageCache.set(key, names);
  if (pageCache.size > 64) pageCache.delete(pageCache.keys().next().value as string);
  return names;
}
