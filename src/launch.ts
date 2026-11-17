import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { TMP_DIR } from './config.js';

/**
 * Starts the user's own programs ("Open with ..."). There is deliberately NO shell involved:
 * the command is split into arguments ourselves and run directly, so a file called
 * `x"; rm -rf ~; ".pdf` is just a harmless argument. Consequence: pipes, &&, $VARIABLES are not
 * interpreted. For anything fancy, point the command at your own script.
 */

/** Splits a command line like a shell would for quotes and backslashes, nothing more. */
export function splitCommand(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
    } else if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      inToken = true;
    } else if (/\s/.test(c)) {
      if (inToken) out.push(cur);
      cur = '';
      inToken = false;
    } else {
      cur += c;
      inToken = true;
    }
  }
  if (quote) throw new Error(`unclosed ${quote} in the command`);
  if (inToken) out.push(cur);
  return out;
}

export interface CommandInfo {
  tokens: string[];
  takesMany: boolean; // contains {files} or {files:...}
}

const SINGLE = /\{(file|dir|name|page|page0)\}/;
const EACH = /^\{files:(.+)\}$/s; // one argument per book, built from the text after "files:"

/** Validates a command template. Throws a readable Error. */
export function parseTemplate(template: string): CommandInfo {
  const tokens = splitCommand(template);
  if (!tokens.length) throw new Error('the command is empty');
  if (/\{(file|files|dir|name|page|page0)[}:]/.test(tokens[0])) throw new Error('the program itself cannot be {file}; put the program name first');
  for (const t of tokens) {
    if (t.includes('{files') && t !== '{files}' && !EACH.test(t)) throw new Error('{files} must stand alone as its own argument, or be written {files:TEXT} (for example {files:{file}#{page}})');
    const m = EACH.exec(t);
    if (m && !/\{(file|name|dir)\}/.test(m[1])) throw new Error('{files:TEXT} needs {file} (or {name}, {dir}) inside TEXT, e.g. {files:{file}#{page}}');
  }
  return { tokens, takesMany: tokens.some((t) => t === '{files}' || EACH.test(t)) };
}

/**
 * {file}  the first book's path      {dir}  its folder      {name}  its file name
 * {page}  the page to open at (1-based: where you stopped reading, or 1)      {page0}  the same, counting from 0
 * {files} every book's path, one argument each (reading lists / multi-select)
 * {files:TEXT}  one argument per book, TEXT filled in for each (so {files:{file}#{page}} gives each book its own page)
 * If the command mentions none of them, the file path is appended as the last argument.
 */
export function buildArgv(template: string, files: string[], opts: { expandHome?: boolean; pages?: number[] } = {}): string[] {
  const { tokens, takesMany } = parseTemplate(template);
  if (!files.length) throw new Error('no files to open');
  if (files.length > 1 && !takesMany) {
    throw new Error('this command takes one file at a time. Add {files} to it to open several (e.g. for a reading list).');
  }
  const mentions = tokens.some((t) => SINGLE.test(t) || t === '{files}' || EACH.test(t));
  const all = mentions ? tokens : [...tokens, '{file}'];
  const home = os.homedir();
  const pageOf = (i: number) => Math.max(1, Math.floor(opts.pages?.[i] ?? 1) || 1);
  const fill = (t: string, i: number) =>
    t
      .replaceAll('{file}', files[i])
      .replaceAll('{dir}', path.dirname(files[i]))
      .replaceAll('{name}', path.basename(files[i]))
      .replaceAll('{page0}', String(pageOf(i) - 1))
      .replaceAll('{page}', String(pageOf(i)));
  const argv: string[] = [];
  for (const t of all) {
    if (t === '{files}') {
      argv.push(...files);
      continue;
    }
    const each = EACH.exec(t);
    if (each) {
      files.forEach((_, i) => argv.push(fill(each[1], i)));
      continue;
    }
    let out = fill(t, 0);
    if (opts.expandHome !== false && (out === '~' || out.startsWith('~/'))) out = home + out.slice(1);
    argv.push(out);
  }
  return argv;
}

/**
 * Runs the program detached (it keeps running if Shelf restarts). We wait ~1.5s: if it fails to
 * start or exits with an error in that time we report why, otherwise we assume it is up.
 * Its stderr goes to a temp file, not a pipe, so closing our side can never SIGPIPE a GUI app.
 */
export function launch(argv: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const logPath = path.join(TMP_DIR, `shelf-launch-${process.pid}-${Date.now()}.log`);
    let fd: number;
    try {
      fd = fs.openSync(logPath, 'w');
    } catch (e) {
      return reject(e);
    }
    const tail = () => {
      try {
        return fs.readFileSync(logPath, 'utf8').trim().slice(-300);
      } catch {
        return '';
      }
    };
    const cleanup = () => {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      fs.rm(logPath, { force: true }, () => {});
    };
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const detail = err ? tail() : '';
      cleanup();
      if (err) reject(new Error(detail ? `${err.message}: ${detail}` : err.message));
      else resolve();
    };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: ['ignore', 'ignore', fd], cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(), env: process.env });
    } catch (e) {
      return finish(e as Error);
    }
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === 'ENOENT' ? `command not found: ${argv[0]}` : e.code === 'EACCES' ? `not allowed to run: ${argv[0]}` : e.message)),
    );
    child.on('exit', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${path.basename(argv[0])} exited with ${code ?? signal}`));
    });
    child.unref();
    timer = setTimeout(() => finish(), 1500);
  });
}

/**
 * In Docker: ask the helper running on the host (tools/shelf-opener.py) to start the program there.
 * The socket lives in a private folder that is mounted into the container.
 */
export function launchViaHelper(socketPath: string, argv: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    let done = false;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      sock.destroy();
      err ? reject(err) : resolve();
    };
    sock.setTimeout(8000, () => finish(new Error('the opener on your computer did not answer')));
    sock.on('connect', () => sock.write(JSON.stringify({ argv, cwd }) + '\n'));
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      if (!buf.includes('\n')) return;
      try {
        const r = JSON.parse(buf.split('\n')[0]);
        finish(r.ok ? undefined : new Error(r.error || 'the opener refused'));
      } catch {
        finish(new Error('unreadable answer from the opener'));
      }
    });
    sock.on('error', (e: NodeJS.ErrnoException) =>
      finish(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'OPENER_DOWN' : e.message)),
    );
  });
}

/** Is something answering on the helper's socket? (A leftover socket file from a dead helper doesn't count.) */
export function helperAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const end = (v: boolean) => {
      sock.destroy();
      resolve(v);
    };
    sock.setTimeout(1000, () => end(false));
    sock.on('connect', () => end(true));
    sock.on('error', () => end(false));
  });
}
