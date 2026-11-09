import { api } from './api.js';
import { openReadersManager } from './readers.js';
import { store } from './store.js';
import { popMenu, toast } from './ui.js';

/** target is { bookIds: [...] } or { listId }. */
export async function openWith(reader, target) {
  try {
    const r = await api.post(`/readers/${reader.id}/open`, target);
    toast(`Opened in ${reader.name}` + (r.skipped ? ` (${r.skipped} missing file${r.skipped === 1 ? '' : 's'} skipped)` : ''));
  } catch (e) {
    toast(e.message, 'error');
  }
}

export const scopeOf = (target) => (target.listId !== undefined ? 'lists' : 'books');

/** Menu entries, one per saved program of the right kind. `count` is how many files would be opened. */
export function readerMenuItems(target, count) {
  const scope = scopeOf(target);
  const mine = store.readers.filter((r) => r.scope === scope);
  if (!mine.length) return [{ label: scope === 'lists' ? 'Add a program for reading lists…' : 'Open with…', onClick: () => openReadersManager(scope) }];
  return mine.map((r) => {
    const tooMany = count > 1 && !r.takesMany;
    return {
      label: `Open with ${r.name}`,
      disabled: tooMany,
      title: tooMany ? 'This command takes one file at a time. Add {files} to it to open several.' : undefined,
      onClick: () => openWith(r, target),
    };
  });
}

export function openWithMenu(anchor, target, count) {
  popMenu(anchor, [...readerMenuItems(target, count), '-', { label: 'Manage programs…', onClick: () => openReadersManager(scopeOf(target)) }]);
}
