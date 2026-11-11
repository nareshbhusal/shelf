import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { DATA_DIR, HOST, HOST_LIBRARY, IN_DOCKER, LIBRARY_DIR, OPENER_SOCKET, PDFJS_DIR, PORT, READONLY, ROOT, SHELF_NAME } from './config.js';
import { AUTH_ON, authGate } from './auth.js';
import { ensureThumb } from './covers.js';
import { db, type BookRow } from './db.js';
import { checkpoint, storageStats } from './hygiene.js';
import { buildArgv, helperAlive, launch, launchViaHelper, parseTemplate } from './launch.js';
import { EPUB_MIME, epubStructure } from './epub.js';
import { pdfDetails, toolsAvailable } from './meta.js';
import { applyRename, planRename, RenameError } from './rename.js';
import { purgeMissing, scanState, startScan } from './scanner.js';
import {
  addAnnotation as addNote,
  capabilities as notesCapabilities,
  cleanHex,
  deleteAnnotation as deleteNote,
  listAll as listNotes,
  NotesError,
  updateAnnotation as updateNote,
} from './pdfnotes.js';
import { fingerprint, natCompare } from './util.js';
import { comicPages, imageExt, openEntryStream } from './zip.js';
import { IMAGE_MIME } from './config.js';

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const app = express();
app.disable('x-powered-by');

// DNS-rebinding defence. A hostile web page can point its own domain at 127.0.0.1 and then talk to
// this server as if it were same-origin. Browsers always send the name they used in the Host header,
// so only accept localhost, raw IP addresses (which can't be rebound), and names you list yourself.
const extraHosts = (process.env.SHELF_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
app.use((req, res, next) => {
  const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  const ok =
    host === 'localhost' || host === '[::1]' || /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || extraHosts.includes(host);
  if (ok) return next();
  res.status(403).type('text/plain').send(
    `Blocked: this server doesn't answer to the name "${host}". If that's really you, set SHELF_ALLOWED_HOSTS=${host}`,
  );
});
app.use(express.json({ limit: '2mb' }));

// Any website you visit could poke localhost. Refuse cross-origin writes.
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host;
    } catch {
      /* fallthrough */
    }
    if (!ok) return res.status(403).json({ error: 'cross-origin request blocked' });
  }
  next();
});

authGate(app); // no-op unless a pass key is set; everything below needs the login

// ---------- helpers ----------

const qstr = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const toInt = (v: unknown): number => {
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  if (!Number.isInteger(n)) throw new HttpError(400, 'expected an integer');
  return n;
};
const intArray = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n)) : [];
const likeEsc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
/** "1,2,3" -> [1,2,3]; empty or junk entries are dropped (Number('') would otherwise become 0). */
const idList = (v: unknown): number[] =>
  (typeof v === 'string' ? v : '')
    .split(',')
    .filter((s) => /^\d+$/.test(s))
    .map(Number);

function getBook(idParam: unknown): BookRow {
  const row = db.prepare('SELECT * FROM books WHERE id = ?').get(toInt(idParam)) as BookRow | undefined;
  if (!row) throw new HttpError(404, 'book not found');
  return row;
}

function absPath(book: BookRow): string {
  const abs = path.resolve(LIBRARY_DIR, book.path);
  if (!abs.startsWith(LIBRARY_DIR + path.sep)) throw new HttpError(400, 'bad path');
  return abs;
}

/** Content-addressed URLs (?v=<fingerprint>) can be cached forever. */
function cacheHeaders(req: Request, res: Response, book: BookRow) {
  const v = qstr(req.query.v);
  res.setHeader('Cache-Control', v && v === book.fingerprint ? 'public, max-age=31536000, immutable' : 'no-cache');
}

function tagMap(): Map<number, number[]> {
  const m = new Map<number, number[]>();
  for (const r of db.prepare('SELECT book_id, tag_id FROM book_tags').all() as Array<{ book_id: number; tag_id: number }>) {
    const list = m.get(r.book_id);
    if (list) list.push(r.tag_id);
    else m.set(r.book_id, [r.tag_id]);
  }
  return m;
}

type BookX = BookRow & { position?: number };

function bookDTO(b: BookX, tags: Map<number, number[]>) {
  return {
    id: b.id,
    path: b.path,
    dir: b.dir,
    filename: b.filename,
    format: b.format,
    size: b.size,
    title: b.title,
    author: b.author,
    series: b.series,
    number: b.number,
    pages: b.pages,
    fingerprint: b.fingerprint,
    addedAt: b.added_at,
    progress: { page: b.progress_page, at: b.progress_at, pos: b.progress_pos },
    tagIds: tags.get(b.id) ?? [],
    position: b.position,
  };
}

// ---------- comic folders ----------
//
// Folders are never stored as anything: this is derived from the index each time.
//   group:  a folder with two or more comic files (.cbz / .zip) directly inside it. It is shown as one
//           card named after the folder, with the cover of its first comic. Series and collections of
//           one-shots are treated alike; opening it lists its comics alphabetically.
//   single: a folder whose only content is one comic file (the layout Kavita requires). The wrapper folder
//           disappears from the listing and the comic itself is shown.
//   plain:  anything else, shown as an ordinary folder.

interface DirInfo {
  path: string;
  name: string;
  total: number;
  kind: 'plain' | 'group' | 'single';
  units: number;
  done: number;
  fraction: number; // 0..1 of the whole series, counted in pages (a finished part counts in full)
  cover: { id: number; fingerprint: string } | null;
  bookId: number | null;
}

type ComicRow = { id: number; dir: string; format: string; filename: string; fingerprint: string; pages: number | null; progress_page: number };

/** How far through a set of comics you are: pages read over pages in total (parts without a known length count by part). */
function seriesFraction(comics: Array<{ pages: number | null; progress_page: number }>): number {
  let read = 0;
  let all = 0;
  for (const c of comics) {
    const n = c.pages && c.pages > 0 ? c.pages : 1;
    all += n;
    read += c.pages ? Math.min(c.progress_page, n) : c.progress_page > 0 ? 1 : 0;
  }
  return all ? read / all : 0;
}

function childDirs(parent: string): DirInfo[] {
  const rows = (
    parent === ''
      ? db.prepare(`SELECT id, dir, format, filename, fingerprint, pages, progress_page FROM books WHERE missing = 0 AND dir != ''`).all()
      : db
          .prepare(`SELECT id, dir, format, filename, fingerprint, pages, progress_page FROM books WHERE missing = 0 AND dir LIKE ? ESCAPE '\\'`)
          .all(likeEsc(parent) + '/%')
  ) as ComicRow[];
  const prefix = parent === '' ? '' : parent + '/';
  const byChild = new Map<string, ComicRow[]>();
  for (const r of rows) {
    const first = r.dir.slice(prefix.length).split('/')[0];
    const key = prefix + first;
    let list = byChild.get(key);
    if (!list) byChild.set(key, (list = []));
    list.push(r);
  }
  const out: DirInfo[] = [];
  for (const [p, list] of byChild) {
    const direct = list.filter((r) => r.dir === p);
    const comics = direct.filter((r) => r.format === 'cbz').sort((a, b) => natCompare(a.filename, b.filename));
    let kind: DirInfo['kind'] = 'plain';
    if (comics.length >= 2) kind = 'group';
    else if (comics.length === 1 && list.length === 1) kind = 'single';
    out.push({
      path: p,
      name: path.posix.basename(p),
      total: list.length,
      kind,
      units: comics.length,
      done: kind === 'group' ? comics.filter((c) => c.pages && c.progress_page >= c.pages).length : 0,
      fraction: kind === 'group' ? seriesFraction(comics) : 0,
      cover: kind === 'group' ? { id: comics[0].id, fingerprint: comics[0].fingerprint } : null,
      bookId: kind === 'single' ? comics[0].id : null,
    });
  }
  return out.sort((a, b) => natCompare(a.name, b.name));
}

app.get('/api/dirs', (req, res) => {
  const parent = typeof req.query.parent === 'string' ? req.query.parent : '';
  res.json(childDirs(parent));
});

// The parts of a series (a "group" folder): its comics in reading order, and where to carry on from.
// The reader uses the same list to read from one part straight into the next.
app.get('/api/series', (req, res) => {
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const rows = (dir === '' ? [] : db.prepare(`SELECT * FROM books WHERE missing = 0 AND dir = ? AND format = 'cbz'`).all(dir)) as BookX[];
  if (rows.length < 2) throw new HttpError(404, 'not a series');
  rows.sort((a, b) => natCompare(a.filename, b.filename));
  const isDone = (r: BookX) => !!r.pages && r.progress_page >= r.pages;
  const started = rows.filter((r) => r.progress_at !== null);
  let next = rows[0];
  let state: 'new' | 'reading' | 'done' = 'new';
  if (started.length) {
    const last = started.reduce((a, b) => ((b.progress_at ?? 0) > (a.progress_at ?? 0) ? b : a));
    if (!isDone(last)) {
      next = last;
      state = 'reading';
    } else {
      const after = rows.slice(rows.indexOf(last) + 1).find((r) => !isDone(r)) ?? rows.find((r) => !isDone(r));
      if (after) {
        next = after;
        state = 'reading';
      } else {
        state = 'done'; // everything read: "read again" starts at the first part
      }
    }
  }
  const tags = tagMap();
  res.json({
    dir,
    name: path.posix.basename(dir),
    parts: rows.map((r) => bookDTO(r, tags)),
    next: next.id,
    state,
    done: rows.filter(isDone).length,
    fraction: seriesFraction(rows),
  });
});

// ---------- books: listing & search ----------

app.get('/api/books', (req, res) => {
  const where: string[] = ['b.missing = 0'];
  const params: unknown[] = [];
  let join = '';
  let select = `b.*`;

  const dir = typeof req.query.dir === 'string' ? req.query.dir : undefined;
  if (dir !== undefined) {
    if (req.query.recursive === '1') {
      if (dir !== '') {
        where.push(`(b.dir = ? OR b.dir LIKE ? ESCAPE '\\')`);
        params.push(dir, likeEsc(dir) + '/%');
      }
    } else if (req.query.collapse === '1') {
      // Also the lone comic inside each single-comic wrapper folder (see "comic folders").
      const lone = childDirs(dir).filter((d) => d.kind === 'single').map((d) => d.path);
      where.push(`(b.dir = ?${lone.length ? ` OR b.dir IN (${lone.map(() => '?').join(',')})` : ''})`);
      params.push(dir, ...lone);
    } else {
      where.push('b.dir = ?');
      params.push(dir);
    }
  }

  const format = qstr(req.query.format);
  if (format) {
    where.push('b.format = ?');
    params.push(format);
  }

  // Every search word must match title/author/series/path, or one of the book's tag names.
  const q = qstr(req.query.q);
  if (q) {
    for (const term of q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      const like = `%${likeEsc(term)}%`;
      where.push(`(
        (b.title || ' ' || COALESCE(b.author,'') || ' ' || COALESCE(b.series,'') || ' ' || b.path) LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM book_tags bt JOIN tags t ON t.id = bt.tag_id
                   WHERE bt.book_id = b.id AND t.name LIKE ? ESCAPE '\\'))`);
      params.push(like, like);
    }
  }

  // Selected tags combine with AND.
  for (const tid of idList(req.query.tags)) {
    where.push('EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id AND bt.tag_id = ?)');
    params.push(tid);
  }
  if (req.query.untagged === '1') where.push('NOT EXISTS (SELECT 1 FROM book_tags bt WHERE bt.book_id = b.id)');
  if (req.query.recent === '1') where.push('b.progress_at IS NOT NULL');
  // "Recently added": first indexed within the last N days, not counting the library's very first scan
  // (everything found then would otherwise look new). A moved or renamed file keeps its original date.
  const addedDays = qstr(req.query.added) ? toInt(qstr(req.query.added)) : 0;
  if (addedDays > 0) {
    where.push('b.added_at >= ? AND b.added_at > (SELECT MIN(added_at) FROM books)');
    params.push(Date.now() - Math.min(addedDays, 3650) * 86_400_000);
  }

  const list = qstr(req.query.list);
  if (list) {
    join = 'JOIN list_items li ON li.book_id = b.id AND li.list_id = ?';
    select = `b.*, li.position AS position`;
  }

  const sql = `SELECT ${select} FROM books b ${join} WHERE ${where.join(' AND ')}`;
  const rows = db.prepare(sql).all(...(list ? [toInt(list)] : []), ...params) as BookX[];

  const sort = qstr(req.query.sort) ?? (list ? 'manual' : 'title');
  const dirSign = req.query.order === 'desc' ? -1 : 1;
  const cmp: Record<string, (a: BookX, b: BookX) => number> = {
    title: (a, b) => natCompare(a.title, b.title),
    filename: (a, b) => natCompare(a.filename, b.filename),
    author: (a, b) => natCompare(a.author ?? '￿', b.author ?? '￿') || natCompare(a.title, b.title),
    path: (a, b) => natCompare(a.path, b.path),
    added: (a, b) => a.added_at - b.added_at || natCompare(a.title, b.title),
    size: (a, b) => a.size - b.size,
    pages: (a, b) => (a.pages ?? 0) - (b.pages ?? 0),
    read: (a, b) => (a.progress_at ?? 0) - (b.progress_at ?? 0),
    manual: (a, b) => (a.position ?? 0) - (b.position ?? 0),
  };
  const fn = cmp[sort] ?? cmp.title;
  rows.sort((a, b) => fn(a, b) * dirSign);

  const tags = tagMap();
  res.json(rows.map((r) => bookDTO(r, tags)));
});

app.get('/api/books/:id', (req, res) => {
  const book = getBook(req.params.id);
  res.json(bookDTO(book, tagMap()));
});

// Everything Shelf knows about one file, for the reader's info panel.
app.get('/api/books/:id/info', async (req, res) => {
  const b = getBook(req.params.id);
  const file = absPath(b);
  let st: fs.Stats | undefined;
  try {
    st = fs.statSync(file);
  } catch { /* missing: reported below */ }
  const tags = (db.prepare('SELECT t.name FROM book_tags bt JOIN tags t ON t.id = bt.tag_id WHERE bt.book_id = ? ORDER BY t.name').all(b.id) as Array<{ name: string }>).map((t) => t.name);
  const lists = (db.prepare('SELECT l.id, l.name FROM list_items li JOIN lists l ON l.id = li.list_id WHERE li.book_id = ? ORDER BY l.name').all(b.id) as Array<{ id: number; name: string }>);
  res.json({
    ...bookDTO(b, tagMap()),
    metaTitle: b.meta_title,
    location: path.join(HOST_LIBRARY || LIBRARY_DIR, b.path),
    exists: !!st,
    modifiedAt: st?.mtimeMs ?? null,
    tags,
    lists,
    pdf: b.format === 'pdf' && st ? await pdfDetails(file) : [],
  });
});

// Directory tree with recursive counts, for the sidebar and folder browsing.
app.get('/api/tree', (_req, res) => {
  const rows = db.prepare('SELECT dir, COUNT(*) AS n, MAX(progress_at) AS last_read FROM books WHERE missing = 0 GROUP BY dir').all() as Array<{ dir: string; n: number; last_read: number | null }>;
  // lastRead = the most recent time any book in that folder (or below it) was read; the sidebar can sort by it.
  const nodes = new Map<string, { path: string; name: string; parent: string; direct: number; total: number; lastRead: number | null }>();
  const ensure = (p: string) => {
    let node = nodes.get(p);
    if (!node) {
      const parent = path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p);
      node = { path: p, name: path.posix.basename(p), parent, direct: 0, total: 0, lastRead: null };
      nodes.set(p, node);
    }
    return node;
  };
  for (const { dir, n, last_read } of rows) {
    if (dir === '') continue;
    const parts = dir.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const node = ensure(parts.slice(0, i).join('/'));
      node.total += n;
      if (last_read && (node.lastRead ?? 0) < last_read) node.lastRead = last_read;
    }
    ensure(dir).direct = n;
  }
  const rootDirect = rows.find((r) => r.dir === '')?.n ?? 0;
  const total = rows.reduce((s, r) => s + r.n, 0);
  res.json({
    root: { direct: rootDirect, total },
    dirs: [...nodes.values()].sort((a, b) => natCompare(a.path, b.path)),
  });
});

// ---------- books: file, cover, pages ----------

app.get('/api/books/:id/file', (req, res) => {
  const book = getBook(req.params.id);
  const abs = absPath(book);
  cacheHeaders(req, res, book);
  if (req.query.download === '1') res.attachment(book.filename);
  else res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(book.filename)}`);
  // sendFile handles Range requests, which is what lets pdf.js load huge PDFs page by page.
  res.sendFile(abs, { dotfiles: 'allow', acceptRanges: true, cacheControl: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'file not found on disk; try rescanning' });
  });
});

app.get('/api/books/:id/cover', async (req, res) => {
  const book = getBook(req.params.id);
  const thumb = await ensureThumb(book);
  if (!thumb) return res.status(404).json({ error: 'no cover' });
  cacheHeaders(req, res, book);
  res.sendFile(thumb, { dotfiles: 'allow', cacheControl: false });
});

app.get('/api/books/:id/pages', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'cbz') throw new HttpError(400, 'not a comic archive');
  const pages = await comicPages(`${book.id}:${book.fingerprint}`, absPath(book));
  res.json({ count: pages.length });
});

app.get('/api/books/:id/pages/:n', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'cbz') throw new HttpError(400, 'not a comic archive');
  const abs = absPath(book);
  const pages = await comicPages(`${book.id}:${book.fingerprint}`, abs);
  const n = toInt(req.params.n);
  if (n < 1 || n > pages.length) throw new HttpError(404, 'page out of range');
  const name = pages[n - 1];
  const { stream, size } = await openEntryStream(abs, name);
  const ext = imageExt(name) ?? '.jpg';
  res.setHeader('Content-Type', IMAGE_MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(size));
  cacheHeaders(req, res, book);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// ---------- EPUB reading ----------
// The reader shows each section (spine item) in a sandboxed iframe that points straight at these URLs,
// so images, styles and fonts load by their own relative paths. Scripts inside books never run:
// the iframe is sandboxed without allow-scripts and the CSP below forbids everything but passive content.

const EPUB_CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";

app.get('/api/books/:id/epub', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'epub') throw new HttpError(400, 'not an EPUB');
  let st;
  try {
    st = await epubStructure(`${book.id}:${book.fingerprint}`, absPath(book));
  } catch (e) {
    throw new HttpError(422, `can't read this EPUB: ${(e as Error).message}`);
  }
  // The section count doubles as "pages" for progress bars.
  if (book.pages !== st.spine.length) db.prepare('UPDATE books SET pages = ? WHERE id = ?').run(st.spine.length, book.id);
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    title: st.title,
    rtl: st.rtl,
    spine: st.spine.map((s) => ({ path: s.path, size: s.size, kind: s.kind })),
    toc: st.toc,
  });
});

app.get('/api/books/:id/epub/f/*rest', async (req, res) => {
  const book = getBook(req.params.id);
  if (book.format !== 'epub') throw new HttpError(400, 'not an EPUB');
  const parts = (req.params as unknown as { rest: string[] }).rest;
  const name = parts.join('/');
  const st = await epubStructure(`${book.id}:${book.fingerprint}`, absPath(book)).catch(() => null);
  if (!st || !st.entries.has(name) || name.startsWith('META-INF/')) return res.status(404).type('text/plain').send('not in this book');
  const ext = path.posix.extname(name).toLowerCase();
  let type = EPUB_MIME[ext] ?? 'application/octet-stream';
  if (req.query.html === '1' && type.startsWith('application/xhtml')) type = 'text/html; charset=utf-8'; // lenient fallback for sloppy XHTML
  if (ext === '.js') type = 'text/plain; charset=utf-8'; // never executable
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Security-Policy', EPUB_CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  cacheHeaders(req, res, book);
  const { stream, size } = await openEntryStream(absPath(book), name);
  res.setHeader('Content-Length', String(size));
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// ---------- renaming files ----------
//
// The only change Shelf makes to the library besides saving PDF notes (see rename.ts for the rules).
// Send {items: [{id, name}]}; `name` has no extension. With dryRun the answer says what would happen.
app.post('/api/rename', async (req, res) => {
  if (READONLY) throw new HttpError(403, 'Shelf is in read-only mode, so it will not rename files.');
  const raw = req.body?.items;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 5000) throw new HttpError(400, 'items: 1 to 5000 books expected');
  const items = raw.map((r) => {
    if (!r || typeof r.name !== 'string') throw new HttpError(400, 'each item needs an id and a name');
    return { id: toInt(r.id), name: r.name };
  });
  const dry = req.body?.dryRun === true;
  if (!dry && scanState.running) throw new HttpError(409, 'Shelf is scanning the library right now. Try again in a moment.');
  const plans = await planRename(items);
  if (dry) return void res.json({ plans });
  const bad = plans.filter((p) => p.error);
  if (bad.length) return void res.status(409).json({ error: `${bad.length} name(s) can't be used; nothing was renamed.`, plans });
  try {
    const renamed = await applyRename(plans);
    res.json({ renamed, plans });
  } catch (e) {
    if (e instanceof RenameError) throw new HttpError(e.status, e.message);
    throw e;
  }
});

// ---------- reading progress ----------

app.put('/api/books/:id/progress', (req, res) => {
  const book = getBook(req.params.id);
  let page = toInt(req.body?.page);
  if (page < 1) page = 1;
  if (book.pages && page > book.pages) page = book.pages;
  // EPUB: where inside the section (0..1). Other formats don't send it.
  const rawPos = req.body?.pos;
  const pos = typeof rawPos === 'number' && Number.isFinite(rawPos) ? Math.min(1, Math.max(0, rawPos)) : null;
  db.prepare('UPDATE books SET progress_page = ?, progress_pos = ?, progress_at = ? WHERE id = ?').run(page, pos, Date.now(), book.id);
  res.json({ page, pos });
});

app.delete('/api/books/:id/progress', (req, res) => {
  const book = getBook(req.params.id);
  db.prepare('UPDATE books SET progress_page = 0, progress_pos = NULL, progress_at = NULL WHERE id = ?').run(book.id);
  res.json({ ok: true });
});

// ---------- tags ----------

const TAG_SQL = `
  SELECT t.id, t.name, t.color,
         (SELECT COUNT(*) FROM book_tags bt JOIN books b ON b.id = bt.book_id
          WHERE bt.tag_id = t.id AND b.missing = 0) AS count
  FROM tags t`;

function cleanName(v: unknown, max = 80): string {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
  if (!s) throw new HttpError(400, 'name is required');
  return s.slice(0, max);
}
const cleanColor = (v: unknown) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : null);

app.get('/api/tags', (_req, res) => {
  const tags = db.prepare(TAG_SQL).all() as Array<{ name: string }>;
  tags.sort((a, b) => natCompare(a.name, b.name));
  res.json(tags);
});

app.post('/api/tags', (req, res) => {
  const name = cleanName(req.body?.name);
  db.prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)').run(name, cleanColor(req.body?.color));
  res.json(db.prepare(`${TAG_SQL} WHERE t.name = ?`).get(name));
});

app.patch('/api/tags/:id', (req, res) => {
  const id = toInt(req.params.id);
  const cur = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as { name: string; color: string | null } | undefined;
  if (!cur) throw new HttpError(404, 'tag not found');
  const name = req.body?.name !== undefined ? cleanName(req.body.name) : cur.name;
  const color = req.body?.color !== undefined ? cleanColor(req.body.color) : cur.color;
  try {
    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
  } catch {
    throw new HttpError(409, 'a tag with that name already exists');
  }
  res.json(db.prepare(`${TAG_SQL} WHERE t.id = ?`).get(id));
});

app.delete('/api/tags/:id', (req, res) => {
  db.prepare('DELETE FROM tags WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

// One endpoint for tagging one or many books: add existing tags, add-or-create by name, remove.
app.post('/api/bulk/tags', (req, res) => {
  const bookIds = intArray(req.body?.bookIds);
  const add = intArray(req.body?.add);
  const remove = intArray(req.body?.remove);
  const addNames: string[] = Array.isArray(req.body?.addNames) ? req.body.addNames.map((n: unknown) => cleanName(n)) : [];
  const created: unknown[] = [];

  db.transaction(() => {
    for (const name of addNames) {
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
      const t = db.prepare(`${TAG_SQL} WHERE t.name = ?`).get(name) as { id: number };
      add.push(t.id);
      created.push(t);
    }
    const ins = db.prepare('INSERT OR IGNORE INTO book_tags (book_id, tag_id) VALUES (?, ?)');
    const del = db.prepare('DELETE FROM book_tags WHERE book_id = ? AND tag_id = ?');
    const exists = db.prepare('SELECT 1 FROM books WHERE id = ?');
    for (const b of bookIds) {
      if (!exists.get(b)) continue;
      for (const t of add) ins.run(b, t);
      for (const t of remove) del.run(b, t);
    }
  })();
  res.json({ ok: true, created });
});

// ---------- reading lists ----------

const LIST_SQL = `
  SELECT l.id, l.name, l.created_at AS createdAt,
         (SELECT COUNT(*) FROM list_items li JOIN books b ON b.id = li.book_id
          WHERE li.list_id = l.id AND b.missing = 0) AS count
  FROM lists l`;

app.get('/api/lists', (_req, res) => {
  const lists = db.prepare(LIST_SQL).all() as Array<{ name: string }>;
  lists.sort((a, b) => natCompare(a.name, b.name));
  res.json(lists);
});

app.post('/api/lists', (req, res) => {
  const name = cleanName(req.body?.name);
  const info = db.prepare('INSERT INTO lists (name, created_at) VALUES (?, ?)').run(name, Date.now());
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(info.lastInsertRowid));
});

app.patch('/api/lists/:id', (req, res) => {
  const id = toInt(req.params.id);
  db.prepare('UPDATE lists SET name = ? WHERE id = ?').run(cleanName(req.body?.name), id);
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id));
});

app.delete('/api/lists/:id', (req, res) => {
  db.prepare('DELETE FROM lists WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/lists/:id/items', (req, res) => {
  const id = toInt(req.params.id);
  if (!db.prepare('SELECT 1 FROM lists WHERE id = ?').get(id)) throw new HttpError(404, 'list not found');
  const bookIds = intArray(req.body?.bookIds);
  db.transaction(() => {
    let pos = (db.prepare('SELECT COALESCE(MAX(position), -1) AS p FROM list_items WHERE list_id = ?').get(id) as { p: number }).p + 1;
    const ins = db.prepare('INSERT OR IGNORE INTO list_items (list_id, book_id, position) VALUES (?, ?, ?)');
    const exists = db.prepare('SELECT 1 FROM books WHERE id = ?');
    for (const b of bookIds) {
      if (exists.get(b) && ins.run(id, b, pos).changes) pos++;
    }
  })();
  res.json(db.prepare(`${LIST_SQL} WHERE l.id = ?`).get(id));
});

app.delete('/api/lists/:id/items/:bookId', (req, res) => {
  db.prepare('DELETE FROM list_items WHERE list_id = ? AND book_id = ?').run(toInt(req.params.id), toInt(req.params.bookId));
  res.json({ ok: true });
});

// Which lists contain these books? (for the "add to list" picker)
app.get('/api/lists-for-books', (req, res) => {
  const ids = idList(req.query.ids);
  const rows = ids.length
    ? (db
        .prepare(`SELECT list_id, book_id FROM list_items WHERE book_id IN (${ids.map(() => '?').join(',')})`)
        .all(...ids) as Array<{ list_id: number; book_id: number }>)
    : [];
  res.json(rows);
});

app.put('/api/lists/:id/order', (req, res) => {
  const id = toInt(req.params.id);
  const order = intArray(req.body?.bookIds);
  db.transaction(() => {
    const upd = db.prepare('UPDATE list_items SET position = ? WHERE list_id = ? AND book_id = ?');
    order.forEach((bookId, i) => upd.run(i, id, bookId));
  })();
  res.json({ ok: true });
});

// ---------- annotations: highlights + notes, stored inside the PDF itself ----------

const cleanText = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);

function pdfOf(idParam: unknown): { book: BookRow; abs: string } {
  const book = getBook(idParam);
  if (book.format !== 'pdf') throw new HttpError(400, 'highlights and notes are only available for PDF files (comics and EPUBs have no standard way to store them)');
  return { book, abs: absPath(book) };
}

/** Our own write changed the file; tell the index so the next scan doesn't see a stranger. */
async function afterWrite(book: BookRow, abs: string, w: { size: number; mtimeMs: number }) {
  const fp = await fingerprint(abs, w.size);
  db.prepare('UPDATE books SET size = ?, mtime_ms = ?, fingerprint = ? WHERE id = ?').run(w.size, w.mtimeMs, fp, book.id);
  return { size: w.size, fingerprint: fp };
}

function notesGuard<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((e) => {
    if (e instanceof NotesError) throw new HttpError(e.status, e.message);
    throw e;
  });
}

app.get('/api/books/:id/annotations', (req, res) => {
  const { abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  try {
    res.json({ ...caps, supported: true, items: listNotes(abs) });
  } catch (e) {
    if (e instanceof NotesError) return void res.json({ canWrite: false, reason: e.message, supported: false, items: [] });
    throw e;
  }
});

app.post('/api/books/:id/annotations', async (req, res) => {
  const { book, abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  if (!caps.canWrite) throw new HttpError(403, `can't save into this file: ${caps.reason}`);
  const kind = req.body?.kind;
  if (kind !== 'highlight' && kind !== 'note' && kind !== 'ink') throw new HttpError(400, 'kind must be "highlight", "note" or "ink"');
  const page = toInt(req.body?.page);
  if (page < 1 || (book.pages && page > book.pages)) throw new HttpError(400, 'page out of range');
  const note = cleanText(req.body?.note, 20000);
  let rects: number[][] | undefined;
  let point: [number, number] | undefined;
  let strokes: number[][][] | undefined;
  let width: number | undefined;
  if (kind === 'ink') {
    strokes = normStrokes(req.body?.strokes);
    if (!strokes.length) throw new HttpError(400, 'a drawing needs at least one stroke with two points');
    width = Math.min(0.03, Math.max(0.0005, Number(req.body?.width) || 0.004));
  } else if (kind === 'highlight') {
    rects = normRects(req.body?.rects);
    if (!rects.length) throw new HttpError(400, 'a highlight needs at least one rectangle');
  } else {
    if (!note) throw new HttpError(400, 'a note needs text');
    const p = Array.isArray(req.body?.point) ? req.body.point.map(Number) : [0.05, 0.05];
    point = [Math.min(0.97, Math.max(0, p[0] || 0)), Math.min(0.97, Math.max(0, p[1] || 0))];
  }
  const w = await notesGuard(() => addNote(abs, { page, kind, color: cleanHex(req.body?.color), rects, point, strokes, width, note }));
  res.json({ page: w.page, ...(await afterWrite(book, abs, w)) });
});

app.patch('/api/books/:id/annotations/:ref', async (req, res) => {
  const { book, abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  if (!caps.canWrite) throw new HttpError(403, `can't save into this file: ${caps.reason}`);
  const patch: { note?: string | null; color?: string } = {};
  if (req.body?.note !== undefined) patch.note = cleanText(req.body.note, 20000);
  if (req.body?.color !== undefined) patch.color = cleanHex(req.body.color);
  const w = await notesGuard(() => updateNote(abs, toInt(req.body?.page), toInt(req.params.ref), patch));
  res.json({ page: w.page, ...(await afterWrite(book, abs, w)) });
});

app.delete('/api/books/:id/annotations/:ref', async (req, res) => {
  const { book, abs } = pdfOf(req.params.id);
  const caps = notesCapabilities(abs, READONLY);
  if (!caps.canWrite) throw new HttpError(403, `can't save into this file: ${caps.reason}`);
  const w = await notesGuard(() => deleteNote(abs, toInt(req.query.page), toInt(req.params.ref)));
  res.json({ page: w.page, ...(await afterWrite(book, abs, w)) });
});

const normStrokes = (v: unknown): number[][][] => {
  if (!Array.isArray(v)) return [];
  const out: number[][][] = [];
  for (const st of v.slice(0, 200)) {
    if (!Array.isArray(st)) continue;
    const pts: number[][] = [];
    for (const p of st.slice(0, 3000)) {
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]), y = Number(p[1]);
      if (Number.isFinite(x) && Number.isFinite(y)) pts.push([Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))]);
    }
    if (pts.length >= 2) out.push(pts);
  }
  return out;
};

const normRects = (v: unknown): number[][] => {
  if (!Array.isArray(v)) return [];
  const out: number[][] = [];
  for (const r of v.slice(0, 300)) {
    if (!Array.isArray(r) || r.length !== 4) continue;
    const [x, y, w, h] = r.map(Number);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    const cx = Math.min(1, Math.max(0, x)), cy = Math.min(1, Math.max(0, y));
    const cw = Math.min(1 - cx, Math.max(0, w)), ch = Math.min(1 - cy, Math.max(0, h));
    if (cw > 0.0005 && ch > 0.0005) out.push([cx, cy, cw, ch]);
  }
  return out;
};

// ---------- external readers ("Open with ...") ----------

type Scope = 'books' | 'lists';
interface ReaderRow { id: number; name: string; command: string; scope: Scope }
const READERS_SQL = 'SELECT id, name, command, scope FROM readers ORDER BY position, id';
const READER_ONE = 'SELECT id, name, command, scope FROM readers WHERE id = ?';
const cleanScope = (v: unknown): Scope => {
  if (v === undefined || v === 'books') return 'books';
  if (v === 'lists') return 'lists';
  throw new HttpError(400, 'scope must be "books" or "lists"');
};

function cleanCommand(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw new HttpError(400, 'command is required');
  if (s.length > 1000) throw new HttpError(400, 'command is too long');
  try {
    parseTemplate(s);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  return s;
}
const readerDTO = (r: ReaderRow) => ({ ...r, takesMany: parseTemplate(r.command).takesMany });

app.get('/api/readers', (_req, res) => {
  res.json((db.prepare(READERS_SQL).all() as ReaderRow[]).map(readerDTO));
});

app.post('/api/readers', (req, res) => {
  const name = cleanName(req.body?.name, 60);
  const command = cleanCommand(req.body?.command);
  const scope = cleanScope(req.body?.scope);
  const pos = (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM readers').get() as { p: number }).p;
  const info = db.prepare('INSERT INTO readers (name, command, position, scope) VALUES (?, ?, ?, ?)').run(name, command, pos, scope);
  res.json(readerDTO(db.prepare(READER_ONE).get(info.lastInsertRowid) as ReaderRow));
});

app.patch('/api/readers/:id', (req, res) => {
  const id = toInt(req.params.id);
  const cur = db.prepare(READER_ONE).get(id) as ReaderRow | undefined;
  if (!cur) throw new HttpError(404, 'reader not found');
  const name = req.body?.name !== undefined ? cleanName(req.body.name, 60) : cur.name;
  const command = req.body?.command !== undefined ? cleanCommand(req.body.command) : cur.command;
  db.prepare('UPDATE readers SET name = ?, command = ? WHERE id = ?').run(name, command, id);
  res.json(readerDTO({ id, name, command, scope: cur.scope }));
});

app.delete('/api/readers/:id', (req, res) => {
  db.prepare('DELETE FROM readers WHERE id = ?').run(toInt(req.params.id));
  res.json({ ok: true });
});

// Only ever runs a command YOU saved above. The request just says which saved reader and which books.
app.post('/api/readers/:id/open', async (req, res) => {
  const viaHelper = IN_DOCKER;
  if (viaHelper && (!OPENER_SOCKET || !HOST_LIBRARY)) {
    throw new HttpError(409, "Shelf is running in Docker without the desktop helper, so it can't start programs on your computer. Start it with ./shelf.sh start (that also starts the helper).");
  }
  const reader = db.prepare(READER_ONE).get(toInt(req.params.id)) as ReaderRow | undefined;
  if (!reader) throw new HttpError(404, 'reader not found');
  // Programs for books and for reading lists are separate sets.
  const wanted: Scope = req.body?.listId !== undefined ? 'lists' : 'books';
  if (reader.scope !== wanted) throw new HttpError(400, `“${reader.name}” is set up for ${reader.scope === 'lists' ? 'reading lists' : 'books'}, not for ${wanted === 'lists' ? 'reading lists' : 'books'}`);

  let books: BookRow[];
  if (req.body?.listId !== undefined) {
    books = db
      .prepare('SELECT b.* FROM list_items li JOIN books b ON b.id = li.book_id WHERE li.list_id = ? AND b.missing = 0 ORDER BY li.position')
      .all(toInt(req.body.listId)) as BookRow[];
  } else {
    const ids = intArray(req.body?.bookIds);
    const get = db.prepare('SELECT * FROM books WHERE id = ? AND missing = 0');
    books = ids.map((id) => get.get(id) as BookRow | undefined).filter((b): b is BookRow => !!b);
  }
  if (!books.length) throw new HttpError(400, 'nothing to open');
  if (books.length > 500) throw new HttpError(400, 'too many files (limit 500)');
  const files = books.map(absPath).filter((f) => fs.existsSync(f));
  if (!files.length) throw new HttpError(404, 'the files are not on disk; try rescanning');

  // From Docker the program runs on the host, so it needs the host's idea of where the files are.
  const toHost = (f: string) => (viaHelper ? path.join(HOST_LIBRARY, path.relative(LIBRARY_DIR, f)) : f);
  const targets = files.map(toHost);
  let argv: string[];
  try {
    argv = buildArgv(reader.command, targets, { expandHome: !viaHelper }); // the helper expands ~ for the host
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  try {
    if (viaHelper) await launchViaHelper(OPENER_SOCKET, argv, path.dirname(targets[0]));
    else await launch(argv, path.dirname(files[0]));
  } catch (e) {
    const m = (e as Error).message;
    if (m === 'OPENER_DOWN') {
      throw new HttpError(409, "The desktop helper isn't running (it stops when the computer restarts). Run ./shelf.sh start again on your computer and retry.");
    }
    throw new HttpError(502, `${reader.name}: ${m}`);
  }
  res.json({ launched: files.length, skipped: books.length - files.length });
});

// ---------- storage & backup ----------

app.get('/api/storage', async (_req, res) => res.json(await storageStats()));

// A consistent copy of the whole database (tags, lists, progress, programs), safe to take while running.
// Readable export of the things you made in Shelf (tags, lists, progress, programs) plus the book index.
// Books are identified by path AND content fingerprint, so it can be matched to files that were moved.
// Highlights/notes/drawings are inside the PDFs and display settings are in the browser (the page
// adds those to the file it downloads), so neither is in here.
// ---------- display settings (kept in the shelf's own data so every browser agrees) ----------

const SETTINGS_KEY = 'settings';
type Settings = Record<string, string | number | boolean>;
function readSettings(): Settings {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
  try {
    const o = row ? JSON.parse(row.value) : {};
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
}
const writeSettings = (o: Settings) =>
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(SETTINGS_KEY, JSON.stringify(o));

/** Only plain, small values under sane names; the server doesn't need to know which settings exist. */
function cleanSettings(body: unknown): Record<string, string | number | boolean | null> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'expected an object of settings');
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,40}$/.test(k)) throw new HttpError(400, `bad setting name "${k}"`);
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= 100)) out[k] = v;
    else throw new HttpError(400, `bad value for "${k}"`);
  }
  if (Object.keys(out).length > 80) throw new HttpError(400, 'too many settings');
  return out;
}

app.get('/api/settings', (_req, res) => res.json(readSettings()));
// Merge: a null value removes that key (back to its default).
app.patch('/api/settings', (req, res) => {
  const cur: Record<string, unknown> = readSettings();
  for (const [k, v] of Object.entries(cleanSettings(req.body))) {
    if (v === null) delete cur[k];
    else cur[k] = v;
  }
  if (Object.keys(cur).length > 80) throw new HttpError(400, 'too many settings');
  writeSettings(cur as Settings);
  res.json(cur);
});
// Replace everything ({} resets all display settings).
app.put('/api/settings', (req, res) => {
  const next = Object.fromEntries(Object.entries(cleanSettings(req.body)).filter(([, v]) => v !== null)) as Settings;
  writeSettings(next);
  res.json(next);
});

app.get('/api/export', (_req, res) => {
  const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : null);
  const all = db.prepare('SELECT * FROM books ORDER BY path').all() as BookRow[];
  const tagRows = db.prepare('SELECT id, name, color FROM tags ORDER BY name').all() as Array<{ id: number; name: string; color: string | null }>;
  const tagName = new Map(tagRows.map((t) => [t.id, t.name]));
  const tagsOf = new Map<number, string[]>();
  for (const r of db.prepare('SELECT book_id, tag_id FROM book_tags').all() as Array<{ book_id: number; tag_id: number }>) {
    const n = tagName.get(r.tag_id);
    if (n) (tagsOf.get(r.book_id) ?? tagsOf.set(r.book_id, []).get(r.book_id)!).push(n);
  }
  const listRows = db.prepare('SELECT id, name, created_at FROM lists ORDER BY id').all() as Array<{ id: number; name: string; created_at: number }>;
  const listName = new Map(listRows.map((l) => [l.id, l.name]));
  const byId = new Map(all.map((b) => [b.id, b]));
  const items = db.prepare('SELECT list_id, book_id FROM list_items ORDER BY list_id, position').all() as Array<{ list_id: number; book_id: number }>;
  const inLists = new Map<number, string[]>();
  const listBooks = new Map<number, unknown[]>();
  for (const it of items) {
    const b = byId.get(it.book_id);
    if (!b) continue;
    (listBooks.get(it.list_id) ?? listBooks.set(it.list_id, []).get(it.list_id)!).push({ path: b.path, title: b.title, fingerprint: b.fingerprint, ...(b.missing ? { missing: true } : {}) });
    (inLists.get(b.id) ?? inLists.set(b.id, []).get(b.id)!).push(listName.get(it.list_id) ?? '?');
  }
  res.json({
    format: 'shelf-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    name: SHELF_NAME || undefined,
    tags: tagRows.map((t) => ({ name: t.name, color: t.color, books: all.filter((b) => tagsOf.get(b.id)?.includes(t.name)).length })),
    lists: listRows.map((l) => ({ name: l.name, createdAt: iso(l.created_at), books: listBooks.get(l.id) ?? [] })),
    settings: readSettings(),
    programs: (db.prepare(READERS_SQL).all() as ReaderRow[]).map((r) => ({ name: r.name, command: r.command, scope: r.scope })),
    books: all.map((b) => ({
      path: b.path,
      fingerprint: b.fingerprint,
      title: b.title,
      author: b.author,
      series: b.series,
      number: b.number,
      format: b.format,
      pages: b.pages,
      size: b.size,
      ...(b.missing ? { missing: true } : {}),
      tags: tagsOf.get(b.id) ?? [],
      lists: inLists.get(b.id) ?? [],
      progress: b.progress_page || b.progress_at ? { page: b.progress_page, ...(b.progress_pos != null ? { pos: b.progress_pos } : {}), at: iso(b.progress_at) } : null,
    })),
  });
});

// To restore: stop Shelf, replace shelf.db in the data folder with this file (and delete shelf.db-wal / -shm).
app.get('/api/backup', async (_req, res, next) => {
  const tmp = path.join(DATA_DIR, `backup-${Date.now()}.tmp`);
  try {
    await db.backup(tmp);
  } catch (e) {
    return next(e);
  }
  const day = new Date().toISOString().slice(0, 10);
  res.download(tmp, `shelf-backup-${day}.db`, { dotfiles: 'allow' }, () => fs.rm(tmp, { force: true }, () => {}));
});

// ---------- scan, stats, info ----------

app.post('/api/scan', (req, res) => res.status(202).json(startScan(req.query.full === '1')));
app.get('/api/scan', (_req, res) => res.json(scanState));

app.post('/api/purge-missing', async (_req, res) => res.json({ removed: await purgeMissing() }));

app.get('/api/info', async (_req, res) => {
  const counts = db
    .prepare(`SELECT format, COUNT(*) AS n FROM books WHERE missing = 0 GROUP BY format`)
    .all() as Array<{ format: string; n: number }>;
  res.json({
    name: SHELF_NAME,
    auth: AUTH_ON,
    libraryDir: LIBRARY_DIR,
    docker: IN_DOCKER,
    opener: IN_DOCKER ? !!OPENER_SOCKET && (await helperAlive(OPENER_SOCKET)) : true,
    readOnly: READONLY,
    display: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY),
    tools: await toolsAvailable(),
    missing: (db.prepare('SELECT COUNT(*) AS n FROM books WHERE missing = 1').get() as { n: number }).n,
    byFormat: Object.fromEntries(counts.map((c) => [c.format, c.n])),
  });
});

// ---------- static ----------

const vendor = (name: string) =>
  app.use(`/vendor/pdfjs/${name}`, express.static(path.join(PDFJS_DIR, name), { maxAge: '7d' }));
['build', 'cmaps', 'standard_fonts', 'wasm', 'iccs'].forEach(vendor);
app.use(express.static(path.join(ROOT, 'public')));

app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not found')));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return res.destroy();
  res.status(status).json({ error: err instanceof Error ? err.message : 'server error' });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`shelf: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`library: ${LIBRARY_DIR}`);
  if (AUTH_ON) console.log('pass key: required to open Shelf');
  else if (!/^(127\.|localhost$|::1$)/.test(HOST)) console.warn(`WARNING: listening on ${HOST} with no pass key: anyone who can reach this port can read your books. Set SHELF_PASSKEY (or "passkey" in the shelf file).`);
  startScan();
});

// `docker stop` sends SIGTERM; without a handler a container's main process ignores it and gets
// killed after 10 seconds. Close cleanly so the database is flushed.
function shutdown() {
  server.close();
  server.closeAllConnections();
  try {
    checkpoint();
    db.close();
  } catch {
    /* already closed */
  }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
