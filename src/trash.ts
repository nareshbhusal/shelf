import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LIBRARY_DIR } from './config.js';
import { db } from './db.js';

// Deleting never removes anything: books and folders are moved into a trash folder inside the library
// (so it is on the same drive, and an encrypted library keeps its trash inside the encryption). The
// scan skips it because its name starts with a dot. To undo, move the item back out; Shelf recognises it
// by its content and its tags, lists and reading progress come back with it. Emptying the trash is up to you.

export const TRASH_DIR = '.shelf-trash';

export interface TrashResult {
  trashed: number;
  failed: Array<{ path: string; error: string }>;
  /** Library-relative folder the items went into. */
  into: string;
}

const stampNow = () => new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');

/** Moves library-relative paths (files or folders) into the trash, keeping their folder structure inside it. */
export async function moveToTrash(rels: string[]): Promise<TrashResult> {
  const clean = [...new Set(rels.map((r) => path.posix.normalize(r.replace(/\\/g, '/')).replace(/\/+$/, '')))].filter((r) => r && r !== '.');
  // An item inside another item of the batch goes along with it.
  const top = clean.filter((r) => !clean.some((o) => o !== r && r.startsWith(o + '/')));
  const into = path.posix.join(TRASH_DIR, `${stampNow()}-${crypto.randomBytes(2).toString('hex')}`);
  const failed: TrashResult['failed'] = [];
  let trashed = 0;
  for (const rel of top) {
    try {
      if (rel.startsWith('../') || rel === '..' || path.posix.isAbsolute(rel)) throw new Error('not inside the library');
      if (rel === TRASH_DIR || rel.startsWith(TRASH_DIR + '/')) throw new Error('already in the trash');
      const abs = path.resolve(LIBRARY_DIR, rel);
      if (!abs.startsWith(LIBRARY_DIR + path.sep)) throw new Error('not inside the library');
      await fs.lstat(abs); // it must exist
      const dest = path.resolve(LIBRARY_DIR, into, rel);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(abs, dest);
      db.prepare(`UPDATE books SET missing = 1 WHERE path = ? OR substr(path, 1, ?) = ?`).run(rel, rel.length + 1, rel + '/');
      trashed++;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      failed.push({ path: rel, error: err.code === 'ENOENT' ? 'it is no longer there' : err.code === 'EACCES' || err.code === 'EPERM' ? "not allowed (the drive may be read-only)" : err.message });
    }
  }
  return { trashed, failed, into };
}
