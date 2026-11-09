import { api, coverUrl, fileUrl } from './api.js';
import { refreshMeta, store, tagById } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';
import { bookName } from './settings.js';
import { openWithMenu } from './openwith.js';
import { dirSegments, fmtBytes, h, hashFor, icon, initials, hueOf, tagColor } from './util.js';

export const chip = (tag) =>
  h('span', { class: 'chip', style: { '--c': tagColor(tag) } }, h('i', { class: 'dot' }), tag.name);

const triState = (n, total) => (n === 0 ? 'none' : n === total ? 'all' : 'some');
const triBox = (state) =>
  h('span', { class: `tri ${state}` }, state === 'all' ? icon('check', 13) : state === 'some' ? '–' : '');

// ---------------------------------------------------------------- tags
/**
 * Tag one or many books. Each click applies immediately. `books` are live objects; we keep their
 * tagIds up to date so the checkbox states stay right without refetching.
 */
export function openTagPicker(books, { onChange } = {}) {
  const total = books.length;
  const ids = books.map((b) => b.id);
  const input = h('input', { type: 'text', class: 'text-input', placeholder: 'Find or create a tag…', autocomplete: 'off' });
  const listEl = h('div', { class: 'picker-list' });
  const countFor = (id) => books.filter((b) => b.tagIds.includes(id)).length;

  const visible = () => {
    const q = input.value.trim().toLowerCase();
    return store.tags.filter((t) => t.name.toLowerCase().includes(q));
  };
  const canCreate = () => {
    const q = input.value.trim();
    return q && !store.tags.some((t) => t.name.toLowerCase() === q.toLowerCase());
  };

  function render() {
    const rows = visible().map((t) => {
      const state = triState(countFor(t.id), total);
      return h(
        'button',
        { class: 'picker-row', onClick: () => toggle(t, state) },
        triBox(state),
        h('span', { class: 'dot', style: { background: tagColor(t) } }),
        h('span', { class: 'grow' }, t.name),
        h('span', { class: 'muted' }, String(t.count)),
      );
    });
    if (canCreate()) {
      rows.push(
        h('button', { class: 'picker-row create', onClick: create }, icon('plus', 14), h('span', { class: 'grow' }, `Create “${input.value.trim()}”`)),
      );
    }
    if (!rows.length) rows.push(h('div', { class: 'muted pad' }, 'No tags yet. Type a name to create one.'));
    listEl.replaceChildren(...rows);
  }

  async function toggle(tag, state) {
    try {
      if (state === 'all') {
        await api.post('/bulk/tags', { bookIds: ids, remove: [tag.id] });
        for (const b of books) b.tagIds = b.tagIds.filter((x) => x !== tag.id);
      } else {
        await api.post('/bulk/tags', { bookIds: ids, add: [tag.id] });
        for (const b of books) if (!b.tagIds.includes(tag.id)) b.tagIds.push(tag.id);
      }
      await refreshMeta();
      render();
      onChange?.();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function create() {
    const name = input.value.trim();
    if (!name) return;
    try {
      const res = await api.post('/bulk/tags', { bookIds: ids, addNames: [name] });
      const tag = res.created[0];
      for (const b of books) if (!b.tagIds.includes(tag.id)) b.tagIds.push(tag.id);
      input.value = '';
      await refreshMeta();
      render();
      onChange?.();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (canCreate()) create();
    else {
      const rows = visible();
      if (rows.length === 1) toggle(rows[0], triState(countFor(rows[0].id), total));
    }
  });

  const m = modal({
    title: total === 1 ? 'Tags' : `Tags for ${total} books`,
    body: [input, listEl],
    footer: h('button', { class: 'btn primary', onClick: () => m.close() }, 'Done'),
  });
  render();
  input.focus();
  return m;
}

// ---------------------------------------------------------------- reading lists
export async function openListPicker(books, { onChange } = {}) {
  const total = books.length;
  const ids = books.map((b) => b.id);
  const members = new Map(); // listId -> Set(bookId)
  const load = async () => {
    members.clear();
    const rows = await api.get(`/lists-for-books?ids=${ids.join(',')}`);
    for (const r of rows) {
      if (!members.has(r.list_id)) members.set(r.list_id, new Set());
      members.get(r.list_id).add(r.book_id);
    }
  };
  await load();

  const input = h('input', { type: 'text', class: 'text-input', placeholder: 'Find or create a reading list…', autocomplete: 'off' });
  const listEl = h('div', { class: 'picker-list' });
  const countIn = (id) => members.get(id)?.size ?? 0;
  const visible = () => {
    const q = input.value.trim().toLowerCase();
    return store.lists.filter((l) => l.name.toLowerCase().includes(q));
  };
  const canCreate = () => {
    const q = input.value.trim();
    return q && !store.lists.some((l) => l.name.toLowerCase() === q.toLowerCase());
  };

  function render() {
    const rows = visible().map((l) => {
      const state = triState(countIn(l.id), total);
      return h(
        'button',
        { class: 'picker-row', onClick: () => toggle(l, state) },
        triBox(state),
        icon('list', 15),
        h('span', { class: 'grow' }, l.name),
        h('span', { class: 'muted' }, String(l.count)),
      );
    });
    if (canCreate()) {
      rows.push(h('button', { class: 'picker-row create', onClick: create }, icon('plus', 14), h('span', { class: 'grow' }, `Create “${input.value.trim()}”`)));
    }
    if (!rows.length) rows.push(h('div', { class: 'muted pad' }, 'No reading lists yet. Type a name to create one.'));
    listEl.replaceChildren(...rows);
  }

  async function toggle(list, state) {
    try {
      if (state === 'all') {
        await Promise.all(ids.map((id) => api.del(`/lists/${list.id}/items/${id}`)));
      } else {
        await api.post(`/lists/${list.id}/items`, { bookIds: ids });
      }
      await Promise.all([refreshMeta(), load()]);
      render();
      onChange?.();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function create() {
    const name = input.value.trim();
    if (!name) return;
    try {
      const list = await api.post('/lists', { name });
      await api.post(`/lists/${list.id}/items`, { bookIds: ids });
      input.value = '';
      await Promise.all([refreshMeta(), load()]);
      render();
      onChange?.();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (canCreate()) create();
    else {
      const rows = visible();
      if (rows.length === 1) toggle(rows[0], triState(countIn(rows[0].id), total));
    }
  });

  const m = modal({
    title: total === 1 ? 'Reading lists' : `Reading lists for ${total} books`,
    body: [input, listEl],
    footer: h('button', { class: 'btn primary', onClick: () => m.close() }, 'Done'),
  });
  render();
  input.focus();
}

// ---------------------------------------------------------------- book details
export async function openBookInfo(book, { onChange } = {}) {
  const [memberships] = await Promise.all([api.get(`/lists-for-books?ids=${book.id}`)]);
  const listIds = new Set(memberships.map((r) => r.list_id));
  const lists = store.lists.filter((l) => listIds.has(l.id));
  const tags = book.tagIds.map((id) => tagById.get(id)).filter(Boolean);

  const img = h('img', { src: coverUrl(book), alt: '', onError: () => img.remove() });
  const cover = h(
    'div',
    { class: 'info-cover' },
    h('div', { class: 'ph', style: { background: `hsl(${hueOf(bookName(book))} 35% 28%)` } }, h('span', null, initials(bookName(book)))),
    img,
  );

  const finished = book.pages && book.progress.page >= book.pages;
  const fields = [
    ['Format', book.format.toUpperCase()],
    book.pages ? ['Pages', String(book.pages)] : null,
    ['Size', fmtBytes(book.size)],
    book.series ? ['Series', book.series + (book.number ? ` #${book.number}` : '')] : null,
    book.progress.page ? ['Progress', book.pages ? `page ${book.progress.page} of ${book.pages}${finished ? ' (finished)' : ''}` : `page ${book.progress.page}`] : null,
  ].filter(Boolean);

  const folderLink = h('a', { href: hashFor('files', dirSegments(book.dir)), onClick: () => m.close() }, book.dir || '(library root)');

  const readable = book.format !== 'epub';
  const actions = [
    readable
      ? h('a', { class: 'btn primary', href: hashFor('read', [String(book.id)]), onClick: () => m.close() }, book.progress.page && !finished ? 'Continue reading' : 'Read')
      : null,
    h('button', { class: 'btn', onClick: () => openTagPicker([book], { onChange }) }, icon('tag', 15), 'Tags'),
    h('button', { class: 'btn', onClick: () => openListPicker([book], { onChange }) }, icon('list', 15), 'Lists'),
    h('button', { class: 'btn', onClick: (e) => openWithMenu(e.currentTarget, { bookIds: [book.id] }, 1) }, icon('external', 15), 'Open with…'),
    h('a', { class: 'btn', href: fileUrl(book, true) }, 'Download'),
  ];

  const body = h(
    'div',
    { class: 'info' },
    cover,
    h(
      'div',
      { class: 'info-main' },
      h('h3', null, bookName(book)),
      book.author ? h('div', { class: 'muted' }, book.author) : null,
      h('dl', null, fields.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]), h('dt', null, 'Folder'), h('dd', null, folderLink), h('dt', null, 'File'), h('dd', { class: 'break' }, book.filename)),
      !readable ? h('div', { class: 'callout' }, 'EPUB reading is not built yet. You can download it, and it is still searchable, taggable and listable.') : null,
      h('div', { class: 'chips' }, tags.length ? tags.map((t) => h('a', { href: hashFor('all', [], { tags: t.id }), onClick: () => m.close() }, chip(t))) : h('span', { class: 'muted small' }, 'No tags')),
      lists.length ? h('div', { class: 'chips' }, lists.map((l) => h('a', { class: 'chip plain', href: hashFor('list', [String(l.id)]), onClick: () => m.close() }, icon('list', 12), l.name))) : null,
      h('div', { class: 'btn-row' }, actions),
      book.progress.page
        ? h(
            'button',
            {
              class: 'link-btn',
              onClick: async () => {
                if (!(await confirmDialog('Reset reading progress for this book?', { okLabel: 'Reset' }))) return;
                await api.del(`/books/${book.id}/progress`);
                book.progress = { page: 0, at: null };
                m.close();
                onChange?.();
              },
            },
            'Reset reading progress',
          )
        : null,
    ),
  );
  const m = modal({ title: 'Details', body, wide: true });
}
