import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, THUMB_DIR } from './config.js';
import { db } from './db.js';

/**
 * Covers are cached by content fingerprint, so a deleted, replaced or edited book leaves its old
 * cover behind. Remove every cached cover (and "no cover" marker) that no book row refers to, plus
 * temp files left by a crashed render. Rows marked missing still count: their cover stays until
 * you "forget" them.
 */
export async function gcThumbs(): Promise<number> {
  const keep = new Set(
    (db.prepare('SELECT DISTINCT fingerprint FROM books').all() as Array<{ fingerprint: string }>).map((r) => r.fingerprint),
  );
  let removed = 0;
  let names: string[];
  try {
    names = await fs.readdir(THUMB_DIR);
  } catch {
    return 0;
  }
  for (const name of names) {
    const m = /^([0-9a-f]{40})\.jpg(\.none)?$/.exec(name);
    if (m && keep.has(m[1])) continue;
    const full = path.join(THUMB_DIR, name);
    if (!m) {
      // Not a cover: a temp/render leftover. Only touch it if it's old, so we never race a render in progress.
      const st = await fs.stat(full).catch(() => null);
      if (!st || Date.now() - st.mtimeMs < 10 * 60_000) continue;
    }
    await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    removed++;
  }
  return removed;
}

export function checkpoint(): void {
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    /* busy: harmless, it will happen next time */
  }
}

async function sizeOf(file: string): Promise<number> {
  return fs.stat(file).then((s) => s.size, () => 0);
}

export async function storageStats() {
  let thumbCount = 0;
  let thumbBytes = 0;
  try {
    for (const name of await fs.readdir(THUMB_DIR)) {
      if (!name.endsWith('.jpg')) continue;
      thumbCount++;
      thumbBytes += await sizeOf(path.join(THUMB_DIR, name));
    }
  } catch {
    /* no cache yet */
  }
  const dbFile = path.join(DATA_DIR, 'shelf.db');
  const dbBytes = (await sizeOf(dbFile)) + (await sizeOf(dbFile + '-wal')) + (await sizeOf(dbFile + '-shm'));
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    dataDir: DATA_DIR,
    dbBytes,
    thumbCount,
    thumbBytes,
    books: count('SELECT COUNT(*) AS n FROM books'),
  };
}
