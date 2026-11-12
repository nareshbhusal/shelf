import { api, coverUrl, fileUrl } from './api.js';
import { chip, openBookInfo, openListPicker, openTagPicker } from './dialogs.js';
import { openWithMenu, readerMenuItems } from './openwith.js';
import { openRename } from './rename.js';
import { renameFolder, trashBooks, trashFolder } from './trash.js';
import { bookName, onSettings, setSetting, settings, SORTS } from './settings.js';
import { booksChanged, events, refreshMeta, store, subscribe, tagById } from './store.js';
import { askText, confirmDialog, popMenu, toast } from './ui.js';
import { ago, dirSegments, fmtBytes, h, hashFor, hueOf, icon, initials, plural, progressFraction } from './util.js';

const openHref = (b) => hashFor('read', [String(b.id)]);
/** From a folder listing, a lone comic in its own folder opens that folder (the series page); everywhere else it opens the reader. */
const cardHref = (b, inDir) => (b.group && inDir !== null && inDir !== b.dir ? hashFor('files', dirSegments(b.dir)) : openHref(b));

const finishedPct = (b) => Math.round(progressFraction(b) * 100);

/** Builds the books query for a route, plus a heading. */
function describe(route) {
  const q = route.query;
  const params = new URLSearchParams();
  let crumbs = null;
  let title = 'All books';
  const ctx = { kind: route.name, listId: null, dir: null };

  if (route.name === 'files') {
    const dir = route.rest.join('/');
    ctx.dir = dir;
    params.set('dir', dir);
    if (q.get('r') === '1') params.set('recursive', '1');
    crumbs = [{ label: 'Library', href: hashFor('files', [], q.get('r') === '1' ? { r: 1 } : {}) }];
    route.rest.forEach((seg, i) =>
      crumbs.push({ label: seg, href: hashFor('files', route.rest.slice(0, i + 1), q.get('r') === '1' ? { r: 1 } : {}) }),
    );
    title = route.rest.at(-1) ?? 'Library';
  } else if (route.name === 'list') {
    ctx.listId = Number(route.rest[0]);
    params.set('list', String(ctx.listId));
    title = store.lists.find((l) => l.id === ctx.listId)?.name ?? 'Reading list';
  } else if (route.name === 'recent') {
    params.set('recent', '1');
    title = 'Recently read';
  } else if (route.name === 'added') {
    title = 'Recently added'; // the time window is added in load(), since it's a setting you can change here
  } else {
    for (const k of ['q', 'tags', 'format']) if (q.get(k)) params.set(k, q.get(k));
    if (q.get('untagged') === '1') params.set('untagged', '1');
    if (q.get('q')) title = `Search: ${q.get('q')}`;
    else if (q.get('untagged') === '1') title = 'Untagged';
    else if (q.get('tags')) title = 'Tagged';
  }
  return { params, crumbs, title, ctx };
}

export function createLibraryView(route) {
  const { params, crumbs, title, ctx } = describe(route);
  const isList = ctx.kind === 'list';
  const isRecent = ctx.kind === 'recent';
  const isAdded = ctx.kind === 'added';
  let listSort = 'manual'; // lists default to the order you arranged; this isn't a global setting
  let books = [];
  let series = null; // the folder being viewed, when it is a series: {parts, next, state, done, fraction}
  let dirInfo = new Map(); // child folder path -> {kind: plain|group|single, ...} (files view only)
  let loaded = false;
  let dead = false;
  let reqSeq = 0;
  let markReady;
  const ready = new Promise((r) => (markReady = r)); // first load finished (lets the router avoid a "Loading…" flash)
  const selected = new Set();
  let lastClicked = -1;
  const cardEls = new Map();

  const root = h('div', { class: 'library' });
  const head = h('div', { class: 'lib-head' });
  const filters = h('div', { class: 'filter-bar' });
  const selBar = h('div', { class: 'sel-bar hidden' });
  const content = h('div', { class: 'lib-content' });
  root.append(head, filters, selBar, content);

  const sortKey = () => (isRecent ? 'read' : isAdded ? 'added' : isList ? listSort : settings.sort);
  // "Name" sorts by whatever name is displayed, so the order always matches what you see.
  const apiSort = () => (sortKey() === 'title' && settings.nameSource === 'filename' ? 'filename' : sortKey());
  const sortOrder = () => (isRecent || isAdded ? 'desc' : isList && listSort === 'manual' ? 'asc' : settings.order);

  // ------------------------------------------------------------ data
  async function load() {
    const seq = ++reqSeq;
    const p = new URLSearchParams(params);
    p.set('sort', apiSort());
    p.set('order', sortOrder());
    if (isAdded) p.set('added', String(settings.addedDays));
    // Comic folders: a folder with 2+ comics is one card; a folder with a single comic shows that comic.
    const folders = ctx.kind === 'files' && route.query.get('r') !== '1' && settings.groupComics;
    if (folders) p.set('collapse', '1');
    try {
      const [data, dirs] = await Promise.all([api.get('/books?' + p), folders ? api.get('/dirs?parent=' + encodeURIComponent(ctx.dir)) : []]);
      if (dead || seq !== reqSeq) return;
      // A folder with 2+ comics is a series: ask where to carry on reading from.
      let ser = null;
      // (A folder whose only content is one comic is a series of one: it gets the same page.)
      const comics = data.filter((b) => b.format === 'cbz');
      if (ctx.kind === 'files' && route.query.get('r') !== '1' && ctx.dir !== '' && (comics.length >= 2 || (comics.length === 1 && comics[0].group && comics[0].dir === ctx.dir))) {
        ser = await api.get('/series?dir=' + encodeURIComponent(ctx.dir)).catch(() => null);
        if (dead || seq !== reqSeq) return;
      }
      series = ser;
      books = data;
      dirInfo = new Map(dirs.map((d) => [d.path, d]));
      loaded = true;
      for (const id of [...selected]) if (!books.some((b) => b.id === id)) selected.delete(id);
      render();
    } catch (e) {
      if (!dead) content.replaceChildren(h('div', { class: 'empty' }, `Could not load books: ${e.message}`));
    } finally {
      markReady();
    }
  }

  // ------------------------------------------------------------ header + filters
  function renderHead() {
    const left = h('div', { class: 'lib-title' });
    if (crumbs) {
      left.append(
        h(
          'nav',
          { class: 'crumbs', 'aria-label': 'Folder path' },
          crumbs.flatMap((c, i) => [
            i ? icon('chevron', 12) : null,
            i === crumbs.length - 1 ? h('span', { class: 'cur' }, c.label) : h('a', { href: c.href }, c.label),
          ]),
        ),
      );
    } else {
      left.append(h('h1', null, title));
    }
    const count = books.length;
    left.append(h('span', { class: 'muted count' }, loaded ? plural(count, 'book') : ''));

    const controls = h('div', { class: 'lib-controls' });

    if (ctx.kind === 'files') {
      const rec = route.query.get('r') === '1';
      controls.append(
        h(
          'label',
          { class: 'toggle', title: 'Include books from all subfolders' },
          h('input', {
            type: 'checkbox',
            checked: rec,
            onChange: (e) => {
              const query = {};
              if (e.target.checked) query.r = 1;
              location.hash = hashFor('files', route.rest, query);
            },
          }),
          'Subfolders',
        ),
      );
    }

    if (isAdded) {
      controls.append(
        h(
          'select',
          { class: 'sel', title: 'How far back to look', value: String(settings.addedDays), onChange: (e) => setSetting('addedDays', e.target.value) },
          [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days'], ['365', 'Last year']].map(([v, l]) => h('option', { value: v }, l)),
        ),
      );
    }
    if (!isRecent && !isAdded) {
      const options = isList ? [['manual', 'Manual order'], ...SORTS] : SORTS;
      const sel = h(
        'select',
        {
          class: 'sel',
          title: 'Sort by',
          value: sortKey(),
          onChange: (e) => {
            if (isList) {
              listSort = e.target.value;
              load();
            } else setSetting('sort', e.target.value);
          },
        },
        options.map(([v, l]) => h('option', { value: v }, l)),
      );
      controls.append(sel);
      if (!(isList && listSort === 'manual')) {
        controls.append(
          h(
            'button',
            { class: 'icon-btn', title: settings.order === 'asc' ? 'Ascending' : 'Descending', onClick: () => setSetting('order', settings.order === 'asc' ? 'desc' : 'asc') },
            h('span', { class: 'arrow' }, settings.order === 'asc' ? '↑' : '↓'),
          ),
        );
      }
    }
    if (isList) {
      controls.append(
        h('button', { class: 'btn small', title: 'Open every book in this list with one of your programs', onClick: (e) => openWithMenu(e.currentTarget, { listId: ctx.listId }, books.length) }, icon('external', 14), 'Open list with…'),
      );
    }
    if (ctx.kind === 'files' && ctx.dir && canRename()) {
      const dirName = ctx.dir.split('/').at(-1);
      controls.append(
        h('button', {
          class: 'icon-btn',
          title: 'This folder: rename or move to trash',
          'aria-label': 'Folder actions',
          onClick: (e) =>
            popMenu(e.currentTarget, [
              { label: 'Rename folder…', onClick: () => doRenameFolder(ctx.dir, dirName) },
              { label: 'Move folder to trash…', danger: true, onClick: () => doTrashFolder(ctx.dir, dirName, loaded ? books.length : 0) },
            ]),
        }, icon('more', 18)),
      );
    }
    const view = settings.view;
    controls.append(
      h(
        'div',
        { class: 'seg' },
        h('button', { class: view === 'grid' ? 'on' : '', title: 'Grid', onClick: () => setSetting('view', 'grid') }, icon('grid', 16)),
        h('button', { class: view === 'list' ? 'on' : '', title: 'List', onClick: () => setSetting('view', 'list') }, icon('rows', 16)),
      ),
    );
    head.replaceChildren(left, controls);
  }

  function renderFilters() {
    const items = [];
    if (ctx.kind === 'all') {
      const ids = (route.query.get('tags') ?? '').split(',').filter(Boolean).map(Number);
      for (const id of ids) {
        const t = tagById.get(id);
        if (!t) continue;
        const rest = ids.filter((x) => x !== id);
        items.push(
          h('a', { class: 'filter-pill', href: hashFor('all', [], { q: route.query.get('q'), tags: rest.join(','), format: route.query.get('format') }) }, chip(t), icon('x', 12)),
        );
      }
      const fmt = route.query.get('format');
      const addFmt = (f) =>
        h('a', { class: 'seg-pill' + (fmt === f ? ' on' : ''), href: hashFor('all', [], { q: route.query.get('q'), tags: route.query.get('tags'), untagged: route.query.get('untagged'), format: fmt === f ? '' : f }) }, f.toUpperCase());
      items.push(h('span', { class: 'spacer' }), ...['pdf', 'cbz', 'epub'].filter((f) => (store.info?.byFormat?.[f] ?? 0) > 0).map(addFmt));
    }
    filters.replaceChildren(...items);
    filters.classList.toggle('hidden', !items.length);
  }

  // ------------------------------------------------------------ selection
  function renderSelBar() {
    const n = selected.size;
    selBar.classList.toggle('hidden', n === 0);
    if (!n) return;
    const picked = () => books.filter((b) => selected.has(b.id));
    selBar.replaceChildren(
      h('strong', null, `${n} selected`),
      h('button', { class: 'btn small', onClick: () => openTagPicker(picked(), { onChange: afterEdit(picked) }) }, icon('tag', 14), 'Tag'),
      h('button', { class: 'btn small', onClick: () => openListPicker(picked(), { onChange: afterEdit(picked) }) }, icon('list', 14), 'Add to list'),
      h('button', { class: 'btn small', onClick: (e) => openWithMenu(e.currentTarget, { bookIds: [...selected] }, selected.size) }, icon('external', 14), 'Open with…'),
      canRename() ? h('button', { class: 'btn small', onClick: () => openRename(picked(), { onDone: afterRename }) }, icon('edit', 14), 'Rename…') : null,
      canRename() ? h('button', { class: 'btn small danger', onClick: () => doTrashBooks(picked()) }, icon('trash', 14), 'Move to trash…') : null,
      isList
        ? h(
            'button',
            {
              class: 'btn small',
              onClick: async () => {
                const ids = [...selected];
                await Promise.all(ids.map((id) => api.del(`/lists/${ctx.listId}/items/${id}`)));
                selected.clear();
                await refreshMeta();
                load();
              },
            },
            'Remove from list',
          )
        : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small', onClick: () => { books.forEach((b) => selected.add(b.id)); syncSelection(); } }, 'Select all'),
      h('button', { class: 'btn small', onClick: () => { selected.clear(); syncSelection(); } }, 'Clear'),
    );
  }

  function syncSelection() {
    for (const [id, el] of cardEls) el.classList.toggle('selected', selected.has(id));
    root.classList.toggle('selecting', selected.size > 0);
    renderSelBar();
  }

  function toggleSelect(book, index, shift) {
    if (shift && lastClicked >= 0) {
      const [a, b] = [Math.min(lastClicked, index), Math.max(lastClicked, index)];
      for (let i = a; i <= b; i++) selected.add(books[i].id);
    } else if (selected.has(book.id)) selected.delete(book.id);
    else selected.add(book.id);
    lastClicked = index;
    syncSelection();
  }

  const canRename = () => !store.info?.readOnly;
  const afterRename = () => {
    selected.clear();
    syncSelection();
    refreshMeta();
    booksChanged(); // reload: names (and so order) changed
  };
  /** After a folder was renamed or trashed: if this page was inside it, follow it (or step out to the parent). */
  const leaveIfInside = (dir, to) => {
    const here = ctx.dir ?? '';
    if (here === dir || here.startsWith(dir + '/')) {
      const target = to === null ? dir.split('/').slice(0, -1).join('/') : to + here.slice(dir.length);
      location.hash = hashFor('files', dirSegments(target));
    }
  };
  const afterFolderChange = async (dir, to) => {
    selected.clear();
    await refreshMeta();
    leaveIfInside(dir, to);
    booksChanged();
  };
  const doRenameFolder = async (dir, name) => {
    const r = await renameFolder(dir, name);
    if (r) await afterFolderChange(r.from, r.to);
  };
  const doTrashFolder = async (dir, name, total) => {
    if (await trashFolder(dir, name, total)) await afterFolderChange(dir, null);
  };
  const doTrashBooks = async (list) => {
    if (await trashBooks(list)) {
      selected.clear();
      await refreshMeta();
      booksChanged();
    }
  };
  const afterEdit = (getBooks) => () => {
    for (const b of getBooks()) replaceCard(b);
    if (ctx.kind === 'all' && (route.query.get('tags') || route.query.get('untagged'))) load();
  };

  // ------------------------------------------------------------ cards
  function coverEl(book) {
    // `loading` must be set BEFORE `src`, or the browser starts the fetch eagerly and ignores lazy.
    const img = h('img', { loading: 'lazy', decoding: 'async', alt: '', draggable: false });
    img.src = coverUrl(book);
    img.addEventListener('error', () => img.remove());
    return h(
      'div',
      { class: 'cover' },
      h('div', { class: 'ph', style: { background: `hsl(${hueOf(bookName(book))} 32% 26%)` } }, h('span', null, initials(bookName(book)))),
      img,
    );
  }

  function tagChips(book) {
    const tags = book.tagIds.map((id) => tagById.get(id)).filter(Boolean);
    return h('div', { class: 'tags' }, tags.map(chip));
  }

  function bookCard(book, index) {
    const inDir = ctx.kind === 'files' && route.query.get('r') !== '1' && settings.groupComics ? ctx.dir : null;
    const pct = finishedPct(book);
    const sub = isAdded ? `Added ${ago(book.addedAt)}` : book.author ?? (book.series ? book.series + (book.number ? ` #${book.number}` : '') : book.group ? '' : book.dir.split('/').at(-1) ?? '');
    const check = h(
      'button',
      {
        class: 'check',
        title: 'Select',
        'aria-label': 'Select',
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleSelect(book, index, e.shiftKey);
        },
      },
      icon('check', 14),
    );
    const more = h(
      'button',
      {
        class: 'more',
        title: 'More',
        'aria-label': 'More actions',
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          popMenu(e.currentTarget, [
            { label: 'Open', onClick: () => (location.hash = cardHref(book, inDir)) },
            { label: 'Details', onClick: () => openBookInfo(book, { onChange: () => { replaceCard(book); } }) },
            { label: 'Tags…', onClick: () => openTagPicker([book], { onChange: afterEdit(() => [book]) }) },
            { label: 'Add to reading list…', onClick: () => openListPicker([book], { onChange: afterEdit(() => [book]) }) },
            canRename() && !book.isFolder ? { label: 'Rename…', onClick: () => openRename([book], { onDone: afterRename }) } : null,
            canRename() && book.group ? { label: 'Rename folder…', onClick: () => doRenameFolder(book.dir, book.group) } : null,
            ...readerMenuItems({ bookIds: [book.id] }, 1),
            book.isFolder ? null : { label: 'Download', onClick: () => (location.href = fileUrl(book, true)) },
            canRename() ? { label: 'Move to trash…', danger: true, onClick: () => doTrashBooks([book]) } : null,
          ].filter(Boolean));
        },
      },
      icon('more', 16),
    );

    const card = h(
      'a',
      {
        class: 'card book' + (selected.has(book.id) ? ' selected' : ''),
        href: cardHref(book, inDir),
        dataset: { id: book.id, format: book.format },
        title: `${bookName(book)}\n${book.path}`,
        draggable: isList && listSort === 'manual',
        onClick: (e) => {
          if (e.ctrlKey || e.metaKey || e.shiftKey || selected.size > 0) {
            e.preventDefault();
            toggleSelect(book, index, e.shiftKey);
          }
        },
        onContextmenu: (e) => {
          e.preventDefault();
          more.click();
        },
      },
      h('div', { class: 'cover-wrap' }, coverEl(book), h('span', { class: 'badge fmt' }, book.format.toUpperCase()), check, more, pct ? h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })) : null),
      h(
        'div',
        { class: 'meta' },
        h('div', { class: 'title' }, bookName(book)),
        h('div', { class: 'sub' }, sub),
        h('div', { class: 'row-info' }, h('span', null, book.pages ? `${book.format === 'epub' ? '~' : ''}${book.pages} p` : ''), h('span', null, fmtBytes(book.size)), h('span', null, book.group ? book.dir.split('/').slice(0, -1).join('/') : book.dir)),
        tagChips(book),
      ),
    );
    if (isList) wireDrag(card, book);
    return card;
  }

  function replaceCard(book) {
    const old = cardEls.get(book.id);
    if (!old) return;
    const fresh = bookCard(book, books.indexOf(book));
    cardEls.set(book.id, fresh);
    old.replaceWith(fresh);
  }

  /** Rename / trash for a folder card (not for read-only libraries). */
  function folderMore(d, total, extra = []) {
    if (!canRename()) return null;
    const more = h(
      'button',
      {
        class: 'more',
        title: 'More',
        'aria-label': 'More actions',
        onClick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          popMenu(e.currentTarget, [
            { label: 'Open', onClick: () => (location.hash = hashFor('files', dirSegments(d.path))) },
            ...extra,
            { label: 'Rename folder…', onClick: () => doRenameFolder(d.path, d.name) },
            { label: 'Move folder to trash…', danger: true, onClick: () => doTrashFolder(d.path, d.name, total) },
          ]);
        },
      },
      icon('more', 16),
    );
    return more;
  }

  function folderCard(d) {
    const rec = route.query.get('r') === '1';
    const more = folderMore(d, d.total);
    return h(
      'a',
      { class: 'card folder', href: hashFor('files', dirSegments(d.path), rec ? { r: 1 } : {}), onContextmenu: more ? (e) => { e.preventDefault(); more.click(); } : null },
      h('div', { class: 'cover-wrap' }, h('div', { class: 'folder-art' }, icon('folder', 40)), more),
      h('div', { class: 'meta' }, h('div', { class: 'title' }, d.name), h('div', { class: 'sub' }, plural(d.total, 'book'))),
    );
  }

  const groupCount = (info) => plural(info.units, 'comic') + (info.pages ? ` · ${info.pages.toLocaleString('en-US')} ${info.pages === 1 ? 'page' : 'pages'}` : '');

  /** A folder holding 2+ comics: one card, named after the folder, covered by its first comic. */
  function groupCard(d, info) {
    const rec = route.query.get('r') === '1';
    const pct = Math.floor((info.fraction ?? 0) * 100);
    const img = h('img', { loading: 'lazy', decoding: 'async', alt: '', draggable: false });
    img.src = coverUrl(info.cover);
    img.addEventListener('error', () => img.remove());
    const groupBooks = () => api.get('/books?dir=' + encodeURIComponent(d.path));
    const more = folderMore(d, info.units, [
      { label: `Tag all ${info.units}…`, onClick: async () => openTagPicker(await groupBooks(), { onChange: () => {} }) },
      { label: `Add all ${info.units} to reading list…`, onClick: async () => openListPicker(await groupBooks(), { onChange: () => {} }) },
    ]);
    return h(
      'a',
      { class: 'card folder group', href: hashFor('files', dirSegments(d.path), rec ? { r: 1 } : {}), title: `${d.name}\n${groupCount(info)}`, onContextmenu: more ? (e) => { e.preventDefault(); more.click(); } : null },
      h(
        'div',
        { class: 'series-stack' },
        h(
          'div',
          { class: 'cover-wrap' },
          h('div', { class: 'cover' }, h('div', { class: 'ph', style: { background: `hsl(${hueOf(d.name)} 32% 26%)` } }, h('span', null, initials(d.name))), img),
          h('span', { class: 'badge fmt' }, `×${info.units}`),
          more,
          pct ? h('div', { class: 'progress' }, h('i', { style: { width: `${pct}%` } })) : null,
        ),
      ),
      h('div', { class: 'meta' }, h('div', { class: 'title' }, d.name), h('div', { class: 'sub' }, `${groupCount(info)}${info.done ? `, ${info.done} read` : pct ? `, ${pct}%` : ''}`)),
    );
  }

  // ------------------------------------------------------------ drag to reorder (reading lists, manual order)
  let dragId = null;
  function wireDrag(card, book) {
    card.addEventListener('dragstart', (e) => {
      dragId = book.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(book.id));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      dragId = null;
      card.classList.remove('dragging');
      content.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (dragId == null || dragId === book.id) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = settings.view === 'list' ? e.clientY > r.top + r.height / 2 : e.clientX > r.left + r.width / 2;
      card.classList.toggle('drop-after', after);
      card.classList.toggle('drop-before', !after);
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-before', 'drop-after'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      if (dragId == null || dragId === book.id) return;
      const after = card.classList.contains('drop-after');
      const order = books.map((b) => b.id).filter((id) => id !== dragId);
      let at = order.indexOf(book.id) + (after ? 1 : 0);
      order.splice(at, 0, dragId);
      try {
        await api.put(`/lists/${ctx.listId}/order`, { bookIds: order });
        await load();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  // ------------------------------------------------------------ render
  function render() {
    const scroller = root.closest('.main');
    const keepY = scroller ? scroller.scrollTop : 0;
    renderHead();
    renderFilters();
    cardEls.clear();
    content.className = `lib-content view-${settings.view}`;

    if (!loaded) {
      content.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
      return;
    }

    const items = [];
    if (isAdded) items.push(addedNote());
    const panel = series ? seriesPanel() : null;
    if (ctx.kind === 'files' && route.query.get('r') !== '1') {
      const dir = route.rest.join('/');
      for (const d of store.tree.dirs.filter((x) => x.parent === dir)) {
        const info = dirInfo.get(d.path);
        if (info?.kind === 'single') continue; // its one comic is in `books`
        items.push(info?.kind === 'group' ? groupCard(d, info) : folderCard(d));
      }
    }
    books.forEach((b, i) => {
      const el = bookCard(b, i);
      cardEls.set(b.id, el);
      items.push(el);
    });

    if (!books.length && isAdded) {
      content.replaceChildren(h('div', { class: 'grid' }, items), emptyState());
    } else if (!items.length) {
      content.replaceChildren(emptyState());
    } else {
      content.replaceChildren(...(panel ? [panel] : []), h('div', { class: 'grid' }, items));
    }
    root.classList.toggle('selecting', selected.size > 0);
    renderSelBar();
    if (scroller && keepY) scroller.scrollTop = keepY;
  }

  /** A folder of 2+ comics: one button to read it from where you left off, straight through all its parts. */
  function seriesPanel() {
    const s = series;
    const next = s.parts.find((p) => p.id === s.next);
    const pct = Math.floor(s.fraction * 100);
    const label = s.state === 'new' ? 'Read' : s.state === 'done' ? 'Read again' : 'Continue';
    const where = s.state === 'reading' && next ? ` · ${bookName(next)}${next.progress.page > 1 && !(next.pages && next.progress.page >= next.pages) ? `, page ${next.progress.page}` : ''}` : '';
    return h(
      'div',
      { class: 'series-panel' },
      h('a', { class: 'btn primary', href: hashFor('read', [String(s.state === 'done' ? s.parts[0].id : s.next)]), title: 'Opens the reader; the next part follows on without a break' }, icon('play', 14), label),
      canRename() && !s.parts.every((p) => p.isFolder) ? h('button', { class: 'btn', title: 'Rename all parts of this series with find & replace, numbering and more', onClick: () => openRename(s.parts, { onDone: afterRename }) }, icon('edit', 14), 'Rename parts…') : null,
      h(
        'div',
        { class: 'series-info' },
        h('div', null, h('strong', null, plural(s.parts.length, 'part')), h('span', { class: 'muted' }, ` · ${s.done} finished · ${pct}% read${where}`)),
        h('div', { class: 'series-bar', title: `${pct}% of the whole series` }, h('i', { style: { width: `${pct}%` } })),
      ),
    );
  }

  /** The rule for this page, stated on the page itself. */
  function addedNote() {
    return h(
      'div',
      { class: 'page-note' },
      h('strong', null, 'What counts as "recently added"'),
      h(
        'ul',
        null,
        h('li', null, `Books Shelf first found in the last ${settings.addedDays} days, newest first. Change the range with the menu above.`),
        h('li', null, 'The date is when Shelf first indexed the file (at a scan), not the file\'s own modified date. A scan runs when Shelf starts and when you return to this tab.'),
        h('li', null, 'The very first scan of a library is the starting point and does not count, otherwise every book would look new.'),
        h('li', null, 'Moving or renaming a file keeps its original date; so does editing it (for example, adding PDF notes).'),
      ),
    );
  }

  function emptyState() {
    if (store.tree.root.total === 0) {
      const scanning = store.scan?.running;
      return h(
        'div',
        { class: 'empty' },
        icon('inbox', 40),
        h('h2', null, scanning ? 'Scanning your library…' : 'No books found'),
        store.scan?.error ? h('p', { class: 'err' }, store.scan.error) : null,
        h('p', { class: 'muted' }, 'Looking in ', h('code', null, store.info?.libraryDir ?? '…'), '. Supported: PDF, CBZ (and .zip with images), EPUB.'),
      );
    }
    const msg =
      isList ? 'This reading list is empty. Select books anywhere and use “Add to list”.'
      : isRecent ? 'Nothing read yet. Books you open show up here.'
      : isAdded ? `Nothing new in the last ${settings.addedDays} days.`
      : ctx.kind === 'all' ? 'No books match.'
      : 'This folder is empty.';
    return h('div', { class: 'empty' }, icon('inbox', 40), h('p', null, msg));
  }

  // ------------------------------------------------------------ lifecycle
  const onBooks = () => load();
  events.addEventListener('books-changed', onBooks);
  const unsub = subscribe(() => {
    if (!loaded) return;
    renderHead(); // titles/lists names may have changed
    renderFilters();
  });
  const unsubSettings = (() => {
    const fn = (key) => {
      if (key === 'sort' || key === 'order' || key === 'nameSource' || key === 'groupComics' || key === 'addedDays') load();
      else if (key === 'view' || key === '*') render();
      else renderHead();
    };
    onSettings(fn);
    return fn;
  })();

  const onKey = (e) => {
    const tag = e.target?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (document.getElementById('modal-root').childElementCount) return;
    if (e.key === 'Escape' && selected.size) {
      selected.clear();
      syncSelection();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && books.length) {
      e.preventDefault();
      books.forEach((b) => selected.add(b.id));
      syncSelection();
    }
  };
  document.addEventListener('keydown', onKey);

  renderHead();
  renderFilters();
  render();
  load();

  return {
    el: root,
    title,
    ready,
    destroy() {
      dead = true;
      events.removeEventListener('books-changed', onBooks);
      unsub();
      document.removeEventListener('keydown', onKey);
      unsubSettings();
    },
  };
}
