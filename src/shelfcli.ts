// Small command line for shelf files, used by shelf.sh:
//   tsx src/shelfcli.ts check FILE
//   tsx src/shelfcli.ts init FILE --library DIR [--data DIR] [--port N] [--name TEXT] [--host ADDR] [--passkey KEY] [--readonly] [--require-mount DIR]...
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

/**
 * What gets written for a path the user typed. A full path (or ~/...) is written exactly as given: they
 * said where it is, so Shelf doesn't second-guess it. A relative path is resolved from where the command
 * ran and, when it lands inside the shelf file's folder, is written relative to that folder, so the
 * folder stays movable.
 */
function tidy(dir: string, given: string): string {
  if (path.isAbsolute(given) || given === '~' || given.startsWith('~/')) return given;
  const p = path.resolve(process.cwd(), given);
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
  const ignore: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i];
    const v = () => {
      if (i + 1 >= rest.length) throw new ShelfFileError(`${k} needs a value`);
      return rest[++i];
    };
    if (k === '--library') o.library = tidy(dir, v());
    else if (k === '--data') o.data = tidy(dir, v());
    else if (k === '--port') o.port = Number(v());
    else if (k === '--name') o.name = v();
    else if (k === '--host') o.host = v();
    else if (k === '--passkey') o.passkey = v();
    else if (k === '--readonly') o.readonly = true;
    else if (k === '--ignore') ignore.push(v());
    else if (k === '--require-mount') mounts.push(resolveIn(process.cwd(), v()));
    else throw new ShelfFileError(`unknown option ${k}`);
  }
  if (!o.library) throw new ShelfFileError('--library DIR is required');
  o.data ??= 'shelf-data';
  if (mounts.length) o.requireMount = mounts;
  if (ignore.length) o.ignore = ignore;
  const ordered = Object.fromEntries(['name', 'library', 'data', 'port', 'host', 'passkey', 'readonly', 'requireMount', 'ignore'].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
  fs.writeFileSync(abs, JSON.stringify(ordered, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote ${abs}:\n${fs.readFileSync(abs, 'utf8')}`);
  return check(abs);
}

try {
  if (cmd === 'check' && args[0]) process.exit(await check(args[0]));
  if (cmd === 'init' && args[0]) process.exit(await init(args[0], args.slice(1)));
  console.error('usage: shelfcli check FILE | init FILE --library DIR [--data DIR] [--port N] [--name TEXT] [--host ADDR] [--passkey KEY] [--readonly] [--require-mount DIR]');
  process.exit(2);
} catch (e) {
  console.error(`Error: ${(e as Error).message}`);
  process.exit(1);
}
