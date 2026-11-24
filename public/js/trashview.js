import { api } from './api.js';
import { booksChanged, refreshInfo, refreshMeta, runScan, store } from './store.js';
import { modal, toast } from './ui.js';
import { ago, fmtBytes, h, plural } from './util.js';

/**
 * The trash: what "Move to trash" put into the library's .shelf-trash folder, with a way to put it back where it was.
 * Nothing here erases anything (Shelf never does); to get rid of things for good, delete that folder yourself.
 */

const key = (i) => `${i.batch}\n${i.rel}`;

export async function openTrash({ onChange } = {}) {
  let items;
  try {
    items = (await api.get('/trash')).items;
  } catch (e) {
    return toast(e.message, 'error');
  }
  const readOnly = !!store.info?.readOnly;
  const picked = new Set();
  const list = h('div', { class: 'missing-list trash-list' });
  const head = h('p', { class: 'muted small' });
  const restoreSel = h('button', { class: 'btn primary', onClick: () => restore(items.filter((i) => picked.has(key(i)))) }, 'Put back selected');
  const selAll = h('button', { class: 'btn', onClick: () => {
    const free = items.filter((i) => !i.blocked);
    if (free.every((i) => picked.has(key(i)))) picked.clear();
    else free.forEach((i) => picked.add(key(i)));
    draw();
  } }, 'Select all');
  const m = modal({
    title: 'Trash',
    wide: true,
    body: [head, list],
    footer: [selAll, h('span', { class: 'grow' }), restoreSel, h('button', { class: 'btn', onClick: () => m.close() }, 'Close')],
  });

  async function restore(what) {
    if (!what.length) return;
    restoreSel.disabled = true;
    try {
      const r = await api.post('/trash/restore', { items: what.map((i) => ({ batch: i.batch, rel: i.rel })) });
      if (r.failed?.length) toast(`Couldn’t put back “${r.failed[0].path.split('/').pop()}”: ${r.failed[0].error}${r.failed.length > 1 ? ` (and ${r.failed.length - 1} more)` : ''}`, 'error');
      if (r.restored) {
        toast(`Put back ${plural(r.restored, 'item')}`);
        runScan().catch(() => {}); // the server has started one already; this just follows it, so the books show up on the shelf
        Promise.all([refreshMeta(), refreshInfo()]).then(booksChanged).catch(() => {});
      }
      items = (await api.get('/trash')).items;
      for (const k of [...picked]) if (!items.some((i) => key(i) === k)) picked.delete(k);
      onChange?.(items.length);
    } catch (e) {
      toast(e.message, 'error');
    }
    draw();
  }

  function draw() {
    const bytes = items.reduce((a, i) => a + i.size, 0);
    head.textContent = items.length
      ? `${plural(items.length, 'item')} in the trash (${fmtBytes(bytes)}). Putting an item back moves it to where it was, and its tags, lists, progress and bookmarks are there again. Nothing is overwritten, and Shelf never empties the trash: to get rid of things for good, delete the “.shelf-trash” folder in your library yourself.`
      : 'The trash is empty. Books and folders you move to the trash are kept in the “.shelf-trash” folder inside your library until you delete that folder yourself.';
    restoreSel.disabled = !picked.size || readOnly;
    restoreSel.textContent = picked.size ? `Put back selected (${picked.size})` : 'Put back selected';
    selAll.disabled = !items.some((i) => !i.blocked);
    if (readOnly) head.textContent += ' Shelf is in read-only mode, so nothing can be put back.';
    list.replaceChildren(
      ...items.map((i) => {
        const cb = h('input', { type: 'checkbox', checked: picked.has(key(i)), disabled: i.blocked || readOnly, 'aria-label': `Select ${i.name}` });
        cb.addEventListener('change', () => { cb.checked ? picked.add(key(i)) : picked.delete(key(i)); draw(); });
        return h(
          'div',
          { class: 'missing-row trash-row' },
          cb,
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'mtitle' }, i.title || i.name, i.isDir ? h('span', { class: 'chip-mini' }, 'FOLDER') : i.format ? h('span', { class: 'chip-mini' }, i.format.toUpperCase()) : null, h('span', { class: 'muted small' }, fmtBytes(i.size))),
            h('code', { class: 'mpath' }, i.rel),
            h(
              'div',
              { class: 'muted small' },
              `Moved to the trash ${ago(i.trashedAt)}` + (i.isDir ? ` · ${plural(i.files, 'file')}` : '') + (i.blocked ? ' · something is already at its old place, so it can’t be put back until that is moved' : ''),
            ),
          ),
          h('button', { class: 'btn small', disabled: i.blocked || readOnly, title: i.blocked ? 'Something is already at its old place' : `Put back in ${i.dir || 'the top folder'}`, onClick: () => restore([i]) }, 'Put back'),
        );
      }),
    );
  }
  draw();
}
