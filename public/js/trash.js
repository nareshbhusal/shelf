import { api } from './api.js';
import { askText, confirmDialog, toast } from './ui.js';
import { plural } from './util.js';
import { bookName } from './settings.js';

// Folder rename, and "delete" (which only moves things into the trash folder inside the library).

/** Rename a folder. Resolves to {from, to} or null when cancelled / failed. */
export async function renameFolder(dir, name) {
  const next = await askText({ title: 'Rename folder', label: `New name for “${name}”`, value: name, okLabel: 'Rename' });
  if (!next || next === name) return null;
  try {
    const r = await api.post('/rename-folder', { dir, name: next });
    toast(`Renamed to “${next}”`);
    return r;
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

const sentence = (what) => `${what} will be moved into the “.shelf-trash” folder inside your library, not erased. Move it back out to undo; its tags and reading progress come back with it.`;

async function send(body) {
  try {
    const r = await api.post('/trash', body);
    if (r.failed.length) toast(`${r.failed[0].path}: ${r.failed[0].error}${r.failed.length > 1 ? ` (+${r.failed.length - 1} more)` : ''}`, 'error');
    if (r.trashed) toast(`Moved ${plural(r.trashed, 'item')} to the trash`);
    return r.trashed > 0;
  } catch (e) {
    toast(e.message, 'error');
    return false;
  }
}

/** Only the book files go; the folder they were in stays (an empty folder is harmless, and yours to delete). */
export async function trashBooks(books) {
  const what = books.length === 1 ? `“${bookName(books[0])}”` : `These ${books.length} books`;
  if (!(await confirmDialog(sentence(what), { okLabel: 'Move to trash', danger: true }))) return false;
  return send({ books: books.map((b) => b.id) });
}

export async function trashFolder(dir, name, total) {
  const what = `The folder “${name}”${total ? ` with its ${plural(total, 'book')}` : ''}`;
  if (!(await confirmDialog(sentence(what), { okLabel: 'Move to trash', danger: true }))) return false;
  return send({ dirs: [dir] });
}
