// Small command line for shelf files, used by shelf.sh:
//   tsx src/shelfcli.ts check FILE
//   tsx src/shelfcli.ts init FILE --library DIR [--data DIR] [--port N] [--name TEXT] [--readonly] [--require-mount DIR]...
import fs from 'node:fs';
import path from 'node:path';
import { checkShelf, portBusy, printReport, readShelfFile, resolveIn, ShelfFileError } from './shelffile.js';

const [, , cmd, ...args] = process.argv;

async function check(file: string): Promise<number> {
  const spec = readShelfFile(file);
  console.log(`Shelf file ${spec.file}${spec.name ? ` (${spec.name})` : ''}`);
  const r = checkShelf(spec);
  if (spec.port && (await portBusy(spec.port))) r.errors.push(`port ${spec.port} is already in use (another instance running?).`);
  printReport(r);
  console.log(r.errors.length ? 'Not OK: fix the lines marked ERR.' : r.warnings.length ? 'OK, with warnings.' : 'All good.');
  return r.errors.length ? 1 : 0;
}

/** Paths inside the shelf file's folder are written relative, so the folder stays movable. */
function tidy(dir: string, p: string): string {
  const rel = path.relative(dir, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
}

async function init(file: string, rest: string[]): Promise<number> {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  if (fs.existsSync(abs)) throw new ShelfFileError(`${abs} already exists; not overwriting it.`);
  if (!fs.existsSync(dir)) throw new ShelfFileError(`${dir} doesn't exist (is the drive mounted?). Shelf won't create it.`);
  const o: Record<string, unknown> = {};
  const mounts: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    const v = () => {
      if (i + 1 >= rest.length) throw new ShelfFileError(`${k} needs a value`);
      return rest[++i];
    };
    if (k === '--library') o.library = tidy(dir, resolveIn(process.cwd(), v()));
    else if (k === '--data') o.data = tidy(dir, resolveIn(process.cwd(), v()));
    else if (k === '--port') o.port = Number(v());
    else if (k === '--name') o.name = v();
    else if (k === '--readonly') o.readonly = true;
    else if (k === '--require-mount') mounts.push(resolveIn(process.cwd(), v()));
    else throw new ShelfFileError(`unknown option ${k}`);
  }
  if (!o.library) throw new ShelfFileError('--library DIR is required');
  o.data ??= 'shelf-data';
  if (mounts.length) o.requireMount = mounts;
  const ordered = Object.fromEntries(['name', 'library', 'data', 'port', 'readonly', 'requireMount'].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  fs.writeFileSync(abs, JSON.stringify(ordered, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote ${abs}:\n${fs.readFileSync(abs, 'utf8')}`);
  return check(abs);
}

try {
  if (cmd === 'check' && args[0]) process.exit(await check(args[0]));
  if (cmd === 'init' && args[0]) process.exit(await init(args[0], args.slice(1)));
  console.error('usage: shelfcli check FILE | init FILE --library DIR [--data DIR] [--port N] [--name TEXT] [--readonly] [--require-mount DIR]');
  process.exit(2);
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}
