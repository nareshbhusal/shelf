import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * A "shelf file" says where one library and its Shelf data live, so nothing about them has to be
 * remembered anywhere else (no ~/.config entry, no global data folder). Typically it sits inside
 * the encrypted folder it describes:
 *
 *   { "library": "books", "data": "shelf-data", "port": 4322 }
 *
 * Paths may be absolute, start with ~/, or be relative; relative ones are relative to the folder
 * that holds the shelf file, so the whole folder can be moved or mounted somewhere else.
 *
 * Everything here is synchronous and side-effect free (it never creates or writes anything), so it
 * is safe to run before any folder exists, e.g. while a drive is not mounted.
 */

export class ShelfFileError extends Error {}

export interface ShelfSpec {
  file: string; // absolute path of the shelf file
  dir: string; // folder that holds it
  name?: string; // optional label shown in the app
  library: string; // absolute
  data: string; // absolute
  dataImplied: boolean; // "data" was not written in the file; it defaults to <file's folder>/shelf-data
  port?: number;
  host?: string; // address to listen on; default 127.0.0.1 (this computer only)
  passkey?: string; // optional pass key for the login page
  readonly: boolean;
  requireMount: string[]; // absolute
  /** Folders the scan skips: a bare name (any folder with that name) or a library-relative path. See ignoreRules(). */
  ignore: string[];
}

export interface Report {
  errors: string[];
  warnings: string[];
  info: string[];
}

const KNOWN = new Set(['name', 'library', 'data', 'port', 'host', 'passkey', 'readonly', 'requireMount', 'ignore']);
const BOOK_EXT = new Set(['.pdf', '.epub', '.cbz', '.zip']);

const expandHome = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

export function resolveIn(base: string, p: string): string {
  return path.resolve(base, expandHome(p));
}

/**
 * Turns the entries of an "ignore" list into rules the scanner can use. Each entry is a folder:
 *   "Samples"          a bare name: every folder called that, at any depth
 *   "Manga/Old"        a path, relative to the library: just that folder (and everything in it)
 *   "/full/path/..."   an absolute path (or ~/...), which must lie inside the library
 * Names are case-sensitive and a trailing slash doesn't matter.
 */
export function ignoreRules(library: string, entries: string[]): string[] {
  const out: string[] = [];
  for (const raw of entries) {
    let e = raw.trim().replace(/[\\/]+$/, '');
    if (!e) continue;
    if (e === '~' || e.startsWith('~/') || path.isAbsolute(e)) {
      const rel = path.relative(library, path.resolve(expandHome(e)));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new ShelfFileError(`"ignore": ${raw} is not inside the library ${library}`);
      e = rel;
    }
    e = e.split(path.sep).join('/').replace(/^\.\//, '');
    out.push(e);
  }
  return out;
}

export function readShelfFile(file: string): ShelfSpec {
  const abs = path.resolve(expandHome(file));
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    throw new ShelfFileError(`can't read the shelf file ${abs}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ShelfFileError(`${abs} is not valid JSON (${(e as Error).message}). Strict JSON: double quotes, no comments, no trailing commas.`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ShelfFileError(`${abs}: expected a JSON object like { "library": "books", "data": "shelf-data" }`);
  const o = raw as Record<string, unknown>;
  const dir = path.dirname(abs);

  const str = (k: string, required = false): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null) {
      if (required) throw new ShelfFileError(`${abs}: "${k}" is required`);
      return undefined;
    }
    if (typeof v !== 'string' || !v.trim()) throw new ShelfFileError(`${abs}: "${k}" must be a non-empty text (a path)`);
    return v.trim();
  };
  const lib = str('library', true)!;
  const dataRaw = str('data');
  const name = str('name');
  if (name && name.length > 40) throw new ShelfFileError(`${abs}: "name" is too long (40 characters at most)`);

  let port: number | undefined;
  if (o.port !== undefined) {
    if (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new ShelfFileError(`${abs}: "port" must be a whole number from 1 to 65535`);
    port = o.port;
  }
  let host: string | undefined;
  if (o.host !== undefined) {
    if (typeof o.host !== 'string' || !o.host.trim()) throw new ShelfFileError(`${abs}: "host" must be an address such as "127.0.0.1" or "0.0.0.0"`);
    host = o.host.trim();
  }
  let passkey: string | undefined;
  if (o.passkey !== undefined) {
    if (typeof o.passkey !== 'string') throw new ShelfFileError(`${abs}: "passkey" must be text`);
    passkey = o.passkey || undefined;
  }
  if (o.readonly !== undefined && typeof o.readonly !== 'boolean') throw new ShelfFileError(`${abs}: "readonly" must be true or false`);
  let mounts: string[] = [];
  if (o.requireMount !== undefined) {
    const v = o.requireMount;
    const arr = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string' || !x.trim())) throw new ShelfFileError(`${abs}: "requireMount" must be a path or a list of paths`);
    mounts = (arr as string[]).map((m) => resolveIn(dir, m.trim()));
  }

  let ignore: string[] = [];
  if (o.ignore !== undefined) {
    const v = o.ignore;
    const arr = typeof v === 'string' ? [v] : v;
    if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string' || !x.trim())) throw new ShelfFileError(`${abs}: "ignore" must be a folder or a list of folders`);
    ignore = ignoreRules(resolveIn(dir, lib), arr as string[]);
  }

  return {
    file: abs,
    dir,
    name,
    library: resolveIn(dir, lib),
    // No "data" means next to the shelf file, never a global folder: the data must not silently
    // end up outside the place the file lives in.
    data: dataRaw ? resolveIn(dir, dataRaw) : path.join(dir, 'shelf-data'),
    dataImplied: !dataRaw,
    port,
    host,
    passkey,
    readonly: o.readonly === true,
    requireMount: mounts,
    ignore,
  };
}

/** Unknown keys are almost always typos ("libary"). Reported as warnings by check(). */
export function unknownKeys(file: string): string[] {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return Object.keys(o).filter((k) => !KNOWN.has(k));
  } catch {
    return [];
  }
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const canAccess = (p: string, mode: number) => {
  try {
    fs.accessSync(p, mode);
    return true;
  } catch {
    return false;
  }
};

/** Exactly a mount point (also FUSE/bind mounts), not just a folder inside one. */
export function isMountPoint(p: string): boolean {
  const target = real(p);
  try {
    const mi = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    for (const line of mi.split('\n')) {
      const mp = line.split(' ')[4];
      if (mp && mp.replace(/\\040/g, ' ').replace(/\\011/g, '\t') === target) return true;
    }
    return false;
  } catch {
    try {
      return fs.statSync(target).dev !== fs.statSync(path.dirname(target)).dev; // not Linux: best effort
    } catch {
      return false;
    }
  }
}

function hasBook(root: string, budget = 4000): boolean {
  const stack = [root];
  let seen = 0;
  while (stack.length && seen < budget) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      seen++;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.')) stack.push(path.join(d, e.name));
      } else if (BOOK_EXT.has(path.extname(e.name).toLowerCase())) return true;
    }
  }
  return false;
}

/** Does this data folder's database belong to this library? Looks at a sample of the books it knows. */
function identity(spec: ShelfSpec, r: Report) {
  const dbFile = path.join(spec.data, 'shelf.db');
  if (!fs.existsSync(dbFile)) {
    r.info.push('No database yet: a new one is created on first start.');
    return;
  }
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (/SQLite/i.test(typeof w === 'string' ? w : w.message)) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  process.emitWarning = emit;
  let db: InstanceType<typeof DatabaseSync> | undefined;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const total = (db.prepare('SELECT COUNT(*) AS n FROM books WHERE missing = 0').get() as { n: number }).n;
    if (!total) {
      r.info.push('The database exists but knows no books yet.');
      return;
    }
    const sample = db.prepare('SELECT path FROM books WHERE missing = 0 ORDER BY id LIMIT 40').all() as Array<{ path: string }>;
    const found = sample.filter((b) => fs.existsSync(path.join(spec.library, b.path))).length;
    if (found === 0) {
      r.errors.push(`The data folder knows ${total} books, but none of the ${sample.length} sampled ones are in ${spec.library}. It looks like data of a different library, or the library is not mounted/located where it used to be. Nothing was started.`);
    } else if (found < sample.length / 2) {
      r.warnings.push(`Only ${found} of ${sample.length} sampled books of this data folder were found in the library. Wrong data folder, or a lot has moved?`);
    } else {
      r.info.push(`Data folder matches the library (${found} of ${sample.length} sampled books found; ${total} known).`);
    }
  } catch (e) {
    r.warnings.push(`Couldn't read the existing database (${(e as Error).message}).`);
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
  // Older launcher versions wrote the library path next to the data. Informational only: mount points move.
  const legacy = path.join(spec.data, '.library-path');
  try {
    const old = fs.readFileSync(legacy, 'utf8').trim();
    if (old && real(old) !== real(spec.library)) r.info.push(`An older Shelf recorded ${old} in ${legacy}; this shelf file uses ${spec.library}.`);
  } catch { /* none */ }
}

export function checkShelf(spec: ShelfSpec): Report {
  const r: Report = { errors: [], warnings: [], info: [] };
  const unknown = unknownKeys(spec.file);
  if (unknown.length) r.warnings.push(`Unknown key${unknown.length > 1 ? 's' : ''} in the shelf file (typo?): ${unknown.join(', ')}`);
  if (spec.dataImplied) r.info.push(`No "data" in the shelf file: using ${spec.data} (next to the file).`);

  const open = spec.host && !/^(127\.|localhost$|\[?::1\]?$)/.test(spec.host);
  if (spec.passkey) r.info.push('Pass key: set (login required).' + (spec.passkey.length < 6 ? ' It is short; a longer one is harder to guess.' : ''));
  else if (open) r.warnings.push(`"host" is ${spec.host}, so other computers on the network can reach Shelf, and there is no "passkey". Anyone who can reach the port can read your books.`);

  // 1. mounts first: if a drive is locked nothing below means anything
  for (const m of spec.requireMount) {
    if (!isMountPoint(m)) r.errors.push(`${m} is not a mount point (is the drive unlocked?).`);
  }

  // 2. library
  let libOk = false;
  try {
    const st = fs.statSync(spec.library);
    if (!st.isDirectory()) r.errors.push(`library ${spec.library} is not a folder.`);
    else if (!canAccess(spec.library, fs.constants.R_OK | fs.constants.X_OK)) r.errors.push(`library ${spec.library} can't be read by this user.`);
    else {
      libOk = true;
      if (!spec.readonly && !canAccess(spec.library, fs.constants.W_OK)) r.warnings.push(`library ${spec.library} is not writable: saving highlights, notes and drawings will fail. Fix the permissions or set "readonly": true.`);
      if (!hasBook(spec.library)) r.warnings.push(`no books (pdf, epub, cbz, zip) found in ${spec.library}. Right folder?`);
      else r.info.push(`Library: ${spec.library}${spec.readonly ? ' (read-only)' : ''}`);
    }
  } catch {
    r.errors.push(`library ${spec.library} does not exist.`);
  }

  // 2b. ignored folders: a path that matches nothing is usually a typo (bare names can match nothing legitimately)
  if (libOk && spec.ignore.length) {
    const gone = spec.ignore.filter((e) => e.includes('/') && !fs.existsSync(path.join(spec.library, e)));
    r.info.push(`Ignoring ${spec.ignore.length} folder${spec.ignore.length === 1 ? '' : 's'}: ${spec.ignore.join(', ')}`);
    for (const g of gone) r.warnings.push(`ignore: ${g} doesn't exist in the library (typo, or not mounted?).`);
  }

  // 3. data folder: may be created, but never its missing parent (that would write to the wrong disk)
  const dataExists = fs.existsSync(spec.data);
  if (dataExists) {
    if (!fs.statSync(spec.data).isDirectory()) r.errors.push(`data ${spec.data} is not a folder.`);
    else if (!canAccess(spec.data, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK)) r.errors.push(`data folder ${spec.data} is not readable and writable by this user.`);
  } else {
    const parent = path.dirname(spec.data);
    if (!fs.existsSync(parent)) r.errors.push(`data folder ${spec.data} doesn't exist and neither does its parent ${parent}. Shelf doesn't create missing parents (it could land on the wrong disk).`);
    else if (!canAccess(parent, fs.constants.W_OK)) r.errors.push(`can't create ${spec.data}: ${parent} is not writable.`);
    else r.info.push(`Data folder ${spec.data} will be created.`);
  }

  // 4. relations between the pieces
  const L = real(spec.library), D = real(spec.data);
  if (L === D) r.errors.push('library and data are the same folder.');
  else if (inside(L, D)) r.errors.push('the library is inside the data folder.');
  else if (inside(D, L)) r.warnings.push('the data folder is inside the library: covers and the database would sit among your books.');
  for (const m of spec.requireMount) {
    const M = real(m);
    if (!inside(L, M)) r.warnings.push(`library is not inside the required mount ${m}: it would not be protected by it.`);
    if (!inside(D, M)) r.warnings.push(`data folder is not inside the required mount ${m}: tags, lists and covers would be stored outside it.`);
  }

  // 5. does the data belong to this library?
  if (libOk && dataExists && !r.errors.length) identity(spec, r);

  return r;
}

/** Is something already listening there? (Used by the launcher; the server itself just fails to bind.) */
export function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

export function printReport(r: Report, out: (s: string) => void = console.log) {
  for (const s of r.info) out(`  ok  ${s}`);
  for (const s of r.warnings) out(`  !   ${s}`);
  for (const s of r.errors) out(`  ERR ${s}`);
}
