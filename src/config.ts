import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkShelf, printReport, readShelfFile, type ShelfSpec } from './shelffile.js';

export type Format = 'pdf' | 'epub' | 'cbz';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

// A shelf file (SHELF_FILE=...) is authoritative for library, data, port and read-only. It is checked
// before anything is created, so a missing/locked drive or the wrong data folder stops Shelf cold.
let spec: ShelfSpec | undefined;
if (process.env.SHELF_FILE) {
  try {
    spec = readShelfFile(process.env.SHELF_FILE);
  } catch (e) {
    console.error(`Shelf: ${(e as Error).message}`);
    process.exit(1);
  }
  const report = checkShelf(spec);
  printReport(report, console.error);
  if (report.errors.length) {
    console.error('Shelf: not starting. Nothing was created or changed.');
    process.exit(1);
  }
}
export const SHELF_NAME = spec?.name ?? process.env.SHELF_NAME ?? '';
export const LIBRARY_DIR = spec?.library ?? path.resolve(process.env.LIBRARY_DIR ?? path.join(ROOT, 'library'));
export const DATA_DIR = spec?.data ?? path.resolve(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
export const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
/** Scratch space. Everything Shelf writes outside the library goes under DATA_DIR, never the system /tmp. */
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const PDFJS_DIR = path.join(ROOT, 'node_modules', 'pdfjs-dist');

// Inside a container we can't launch programs on the user's desktop ("Open with ...").
export const IN_DOCKER =
  process.env.SHELF_DOCKER === '1' ? true : process.env.SHELF_DOCKER === '0' ? false : fs.existsSync('/.dockerenv');

// Docker only: the host-side helper (tools/shelf-opener.py) that starts programs on your desktop, and
// where your library really lives on the host (the server only sees it as /library).
export const OPENER_SOCKET = process.env.SHELF_OPENER_SOCKET ?? '';
export const HOST_LIBRARY = process.env.SHELF_HOST_LIBRARY ?? '';

// The only thing Shelf ever writes into your library is highlights/notes inside PDFs you annotate.
// SHELF_READONLY=1 turns even that off: books are then strictly read-only (annotations still display).
export const READONLY = spec ? spec.readonly : process.env.SHELF_READONLY === '1';

// No auth in this version, so listen on localhost only unless told otherwise.
export const PORT = spec?.port ?? Number(process.env.PORT ?? 4321);
export const HOST = process.env.HOST ?? '127.0.0.1';

export const EXT_FORMAT: Record<string, Format> = {
  '.pdf': 'pdf',
  '.epub': 'epub',
  '.cbz': 'cbz',
  '.zip': 'cbz', // only indexed if it actually contains images
};

export const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
};

fs.mkdirSync(THUMB_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
for (const f of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, f), { recursive: true, force: true }); // leftovers of a killed run
