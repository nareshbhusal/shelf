import path from 'node:path';
import { DATA_DIR, type Format } from './config.js';

export interface BookRow {
  id: number;
  path: string; // relative to the library root, forward slashes
  dir: string; // relative directory, '' for the root
  filename: string;
  format: Format;
  size: number;
  mtime_ms: number;
  fingerprint: string;
  meta_title: string | null; // title from file metadata, if it looked usable
  title: string; // meta_title, else derived from the filename
  author: string | null;
  series: string | null;
  number: string | null;
  pages: number | null;
  added_at: number;
  missing: number;
  progress_page: number;
  progress_at: number | null;
  progress_pos: number | null; // EPUB: how far into the section (0..1)
}

// SQLite comes from Node itself (node:sqlite), not from a prebuilt native add-on. The add-on we used
// before needed a newer glibc than Ubuntu 20.04 has; Node's own binary doesn't.
// Node prints an "ExperimentalWarning" when the module loads on some 22.x versions; keep the log clean.
const emit = process.emitWarning;
process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
  if (/SQLite/i.test(typeof w === 'string' ? w : w.message)) return;
  return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
}) as typeof process.emitWarning;
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emit;

const raw = new DatabaseSync(path.join(DATA_DIR, 'shelf.db'));

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Stmt {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number; lastInsertRowid: number };
}

// better-sqlite3 quietly ignored object keys the statement doesn't use, and accepted undefined/booleans.
// node:sqlite is stricter, so adapt arguments the same lenient way.
const norm = (v: unknown) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
function prepare(sql: string): Stmt {
  const st = raw.prepare(sql);
  const names = new Set([...sql.matchAll(/[@:$]([A-Za-z_]\w*)/g)].map((m) => m[1]));
  const fix = (args: unknown[]) =>
    args.map((a) =>
      a && typeof a === 'object' && !Array.isArray(a) && !(a instanceof Uint8Array)
        ? Object.fromEntries(Object.entries(a).filter(([k]) => names.has(k)).map(([k, v]) => [k, norm(v)]))
        : norm(a),
    );
  return {
    get: (...a) => st.get(...(fix(a) as never[])),
    all: (...a) => st.all(...(fix(a) as never[])),
    run: (...a) => st.run(...(fix(a) as never[])) as { changes: number; lastInsertRowid: number },
  };
}

/** The small slice of the better-sqlite3 API the rest of the code uses. */
export const db = {
  exec: (sql: string) => raw.exec(sql),
  prepare: prepare,
  pragma: (stmt: string) => void raw.exec(`PRAGMA ${stmt}`),
  /** Returns a function that runs `fn` inside one transaction (all or nothing). */
  transaction<T>(fn: () => T): () => T {
    return () => {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    };
  },
  /** Consistent snapshot of the live database into a new file. */
  async backup(dest: string): Promise<void> {
    raw.exec(`VACUUM INTO '${dest.replaceAll("'", "''")}'`);
  },
  close: () => raw.close(),
};
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS books (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  dir           TEXT NOT NULL,
  filename      TEXT NOT NULL,
  format        TEXT NOT NULL,
  size          INTEGER NOT NULL,
  mtime_ms      INTEGER NOT NULL,
  fingerprint   TEXT NOT NULL,
  meta_title    TEXT,
  title         TEXT NOT NULL,
  author        TEXT,
  series        TEXT,
  number        TEXT,
  pages         INTEGER,
  added_at      INTEGER NOT NULL,
  missing       INTEGER NOT NULL DEFAULT 0,
  progress_page INTEGER NOT NULL DEFAULT 0,
  progress_at   INTEGER,
  progress_pos  REAL
);
CREATE INDEX IF NOT EXISTS books_dir ON books(dir);
CREATE INDEX IF NOT EXISTS books_fp ON books(fingerprint);

CREATE TABLE IF NOT EXISTS tags (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color TEXT
);
CREATE TABLE IF NOT EXISTS book_tags (
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (book_id, tag_id)
);
CREATE INDEX IF NOT EXISTS book_tags_tag ON book_tags(tag_id);

CREATE TABLE IF NOT EXISTS lists (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS list_items (
  list_id  INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  book_id  INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  PRIMARY KEY (list_id, book_id)
);
CREATE INDEX IF NOT EXISTS list_items_book ON list_items(book_id);

-- External programs ("Open with ..."). scope: 'books' (selected books) or 'lists' (a whole reading list).
CREATE TABLE IF NOT EXISTS readers (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  command  TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  scope    TEXT NOT NULL DEFAULT 'books'
);

-- Small key/value store: display settings (key 'settings', JSON) live here instead of only in the browser.
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);
if (!(db.prepare('PRAGMA table_info(books)').all() as Array<{ name: string }>).some((c) => c.name === 'progress_pos')) {
  db.exec('ALTER TABLE books ADD COLUMN progress_pos REAL');
}
// Older databases had one set of programs for both; keep every program available for both kinds.
if (!(db.prepare('PRAGMA table_info(readers)').all() as Array<{ name: string }>).some((c) => c.name === 'scope')) {
  db.exec("ALTER TABLE readers ADD COLUMN scope TEXT NOT NULL DEFAULT 'books'");
  db.exec("INSERT INTO readers (name, command, position, scope) SELECT name, command, position, 'lists' FROM readers");
}
// Highlights/notes are stored inside the PDFs themselves, never here. (Earlier dev builds had a table for them.)
db.exec('DROP TABLE IF EXISTS annotations');
db.pragma('user_version = 6');
