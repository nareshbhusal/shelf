import { api } from './api.js';
import { bookName } from './settings.js';
import { booksChanged, refreshMeta } from './store.js';
import { toast } from './ui.js';
import { debounce, h, icon, plural } from './util.js';

// Putting books into a reading list without the picker dialog: drop them on the list (from another page,
// another tab, a link, files from the desktop) or search for them in the field on the list page.

export const BOOKS_TYPE = 'application/x-shelf-books';

/** Mark a drag as carrying these books (cards also carry their link, so other tabs and other programs can use it). */
export function carryBooks(e, ids) {
  e.dataTransfer.setData(BOOKS_TYPE, JSON.stringify(ids));
  e.dataTransfer.effectAllowed = 'copyMove';
}

/** Does this drag look like something that could hold books? (dragover can only see the types.) */
export function dragHasBooks(dt) {
  const t = [...(dt?.types ?? [])];
  return t.includes(BOOKS_TYPE) || t.includes('Files') || t.includes('text/uri-list') || t.includes('text/plain');
}

/** What a drop carries: book ids we put there ourselves, other text (links, paths) and desktop files. */
export function readDrop(dt) {
  const ids = [];
  try {
    const raw = dt.getData(BOOKS_TYPE);
    if (raw) ids.push(...JSON.parse(raw).filter(Number.isInteger));
  } catch { /* not ours */ }
  const texts = [];
  if (!ids.length) {
    for (const type of ['text/uri-list', 'text/plain']) {
      for (const line of (dt.getData(type) || '').split(/\r?\n/)) {
        const t = line.trim();
        if (t && !(type === 'text/uri-list' && t.startsWith('#') && !t.startsWith('#/')) && !texts.includes(t)) texts.push(t);
      }
    }
  }
  const files = [...(dt.files ?? [])].map((f) => ({ name: f.name, size: f.size }));
  return { ids, texts, files };
}

/** Turn links, paths and file names into book ids (the server knows the library). */
async function resolve({ ids, texts, files }) {
  const out = new Set(ids);
  let unknown = [];
  if (texts.length || files.length) {
    const r = await api.post('/resolve', { texts, files });
    r.bookIds.forEach((b) => out.add(b));
    unknown = r.unknown;
  }
  return { ids: [...out], unknown };
}

/** Add whatever was dropped or pasted to a list. `at` puts the new books at that position. */
export async function addToList(list, input, { at } = {}) {
  try {
    const { ids, unknown } = await resolve(input);
    if (!ids.length) {
      toast(unknown.length ? `Nothing in this library matches ${unknown.length === 1 ? `“${unknown[0].slice(0, 60)}”` : `those ${unknown.length} items`}.` : 'Nothing to add.', 'error');
      return null;
    }
    const before = list.count ?? 0;
    const after = await api.post(`/lists/${list.id}/items`, { bookIds: ids, ...(Number.isInteger(at) ? { at } : {}) });
    const added = Math.max(0, after.count - before);
    const bits = [added ? `${plural(added, 'book')} added` : 'already in the list'];
    if (added && ids.length > added) bits.push(`${ids.length - added} already there`);
    if (unknown.length) bits.push(`${unknown.length} not found in this library`);
    toast(`“${list.name}”: ${bits.join(', ')}`);
    await refreshMeta();
    booksChanged();
    return { added, ids };
  } catch (e) {
    toast(e.message, 'error');
    return null;
  }
}

// A link or a path (a bare name like "d.pdf" is searched for instead).
const looksLikeLocation = (t) => /^(https?:|file:)/i.test(t) || /^(~|\/|\.\/)/.test(t) || (t.includes('/') && /\.(pdf|epub|cbz|zip)$/i.test(t));

/**
 * The "add books" field on a reading list's page: type to search the library, pick what you want (it stays
 * open so you can pick several), or paste a link or path. Results can also be dragged into the list below,
 * between two cards, to choose the position.
 */
export function listAdder({ getList, has, onAdded }) {
  const input = h('input', { type: 'text', class: 'adder-input', placeholder: 'Add books: search by title, author, folder or tag, or paste a link or a path…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Add books to this list' });
  const drop = h('div', { class: 'adder-drop hidden', role: 'listbox' });
  const box = h('div', { class: 'adder' }, h('span', { class: 'adder-ic' }, icon('plus', 16)), input, drop);
  let results = [];
  let active = 0;
  let seq = 0;
  const added = new Set(); // picked in this field: shown as in the list at once, before the page reloads

  const close = () => { drop.classList.add('hidden'); active = 0; };
  const add = async (ids, row) => {
    const r = await addToList(getList(), { ids, texts: [], files: [] });
    if (r) {
      ids.forEach((i) => added.add(i));
      onAdded?.();
      draw();
    }
  };
  const addText = async (t) => {
    const r = await addToList(getList(), { ids: [], texts: [t], files: [] });
    if (r) { input.value = ''; close(); onAdded?.(); }
  };

  function draw() {
    const q = input.value.trim();
    if (!q) return close();
    const rows = [];
    if (looksLikeLocation(q)) {
      rows.push(h('button', { class: 'adder-row loc' + (active === 0 ? ' active' : ''), onMousedown: (e) => e.preventDefault(), onClick: () => addText(q) }, icon('link', 15), h('span', { class: 'grow ellipsis' }, `Add the book at “${q}”`)));
    }
    const off = rows.length;
    results.forEach((b, i) => {
      const inList = added.has(b.id) || has(b.id);
      rows.push(
        h(
          'button',
          {
            class: 'adder-row' + (i + off === active ? ' active' : '') + (inList ? ' done' : ''),
            draggable: !inList,
            onMousedown: (e) => e.preventDefault(),
            onClick: () => !inList && add([b.id]),
            onDragstart: (e) => {
              carryBooks(e, [b.id]);
              e.dataTransfer.setData('text/plain', `${location.origin}/#/read/${b.id}`);
            },
          },
          h('img', { class: 'adder-thumb', src: `/api/books/${b.id}/cover`, alt: '', loading: 'lazy', onError: (e) => e.target.replaceWith(h('span', { class: 'adder-thumb blank' }, icon('book', 14))) }),
          h('span', { class: 'adder-main' }, h('span', { class: 'adder-title ellipsis' }, bookName(b)), h('span', { class: 'adder-sub ellipsis' }, b.dir || 'Library root')),
          h('span', { class: 'chip-mini' }, b.format.toUpperCase()),
          h('span', { class: 'adder-state' }, inList ? '✓ in list' : icon('plus', 14)),
        ),
      );
    });
    if (!rows.length) rows.push(h('div', { class: 'adder-empty muted' }, 'No book matches.'));
    drop.replaceChildren(...rows);
    drop.classList.remove('hidden');
  }

  const search = debounce(async () => {
    const q = input.value.trim();
    const mine = ++seq;
    if (!q) return close();
    try {
      const r = looksLikeLocation(q) ? [] : await api.get(`/books?q=${encodeURIComponent(q)}&limit=12&sort=title`);
      if (mine !== seq) return;
      results = r;
      active = 0;
      draw();
    } catch { /* ignore */ }
  }, 160);

  input.addEventListener('input', () => { added.clear(); search(); });
  input.addEventListener('focus', () => input.value.trim() && draw());
  input.addEventListener('blur', () => setTimeout(close, 150));
  input.addEventListener('keydown', (e) => {
    const n = drop.querySelectorAll('.adder-row').length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); active = (active + 1) % n; draw(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); active = (active - 1 + n) % n; draw(); }
    else if (e.key === 'Escape') { close(); input.blur(); }
    else if (e.key === 'Enter') { e.preventDefault(); drop.querySelectorAll('.adder-row')[active]?.click(); }
  });
  input.addEventListener('paste', (e) => {
    const t = (e.clipboardData?.getData('text') ?? '').trim();
    if (t && t.includes('\n')) { e.preventDefault(); addToList(getList(), { ids: [], texts: t.split(/\r?\n/), files: [] }).then((r) => r && onAdded?.()); }
  });
  return { el: box, focus: () => input.focus() };
}
