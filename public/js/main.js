import { createLibraryView } from './library.js';
import { createReader } from './reader.js';
import { addToList, dragHasBooks, readDrop } from './listadd.js';
import { copyList, createSessionView, openListInViewer, openSessionPicker, unlinkList, viewerItems } from './sessions.js';
import { applySettings, onSettings, openSettings, setSetting, settings, sidebarOrder, syncSettings } from './settings.js';
import { appName, events, refreshInfo, refreshMeta, refreshSessions, startSessionPolling, runScan, store, subscribe, watchScan } from './store.js';
import { api } from './api.js';
import { startTilt } from './tilt.js';
import { askText, confirmDialog, popMenu, toast } from './ui.js';
import { debounce, dirSegments, h, hashFor, icon, parseHash, plural, tagColor } from './util.js';

applySettings();
startTilt();

const app = document.getElementById('app');
let view = null;
let route = parseHash();

// ---------------------------------------------------------------- shell
const sidebar = h('aside', { class: 'sidebar' });
const searchInput = h('input', { type: 'search', class: 'search', placeholder: 'Search title, author, folder, tag…  ( / )', 'aria-label': 'Search' });
const scanPill = h('div', { class: 'scan-pill hidden' });
const rescanBtn = h(
  'button',
  {
    class: 'icon-btn rescan',
    title: 'Look for new, moved or removed files now (Shift-click: re-read every file)',
    onClick: async (e) => {
      try {
        await runScan({ full: e.shiftKey });
      } catch (err) {
        toast(err.message, 'error');
      }
    },
  },
  icon('refresh', 18),
);
const topbar = h(
  'header',
  { class: 'topbar' },
  h('button', { class: 'icon-btn menu-btn', title: 'Menu', onClick: () => document.body.classList.toggle('nav-open') }, icon('menu')),
  h('div', { class: 'search-wrap' }, icon('search', 16), searchInput),
  scanPill,
  rescanBtn,
  h('button', { class: 'icon-btn', title: 'Settings (,)', onClick: openSettings }, icon('settings')),
);
const main = h('main', { class: 'main' });
const shell = h('div', { class: 'shell' }, sidebar, h('div', { class: 'content-col' }, topbar, main));
app.append(shell);
document.body.addEventListener('click', (e) => {
  if (document.body.classList.contains('nav-open') && !e.target.closest('.sidebar, .menu-btn')) document.body.classList.remove('nav-open');
});

// ---------------------------------------------------------------- search
// A search stays in the place you are (a folder, a list, "recent"…); the library view offers a link to search everything.
const SCOPED = new Set(['all', 'files', 'list', 'recent', 'added']);
const goSearch = debounce(() => {
  const q = searchInput.value.trim();
  if (SCOPED.has(route.name)) {
    const qs = new URLSearchParams(route.query);
    if (q) qs.set('q', q);
    else if (qs.has('q')) qs.delete('q');
    else return;
    const path = route.raw.split('?')[0];
    const next = '#' + path + (qs.toString() ? `?${qs}` : '');
    // Replace while typing so the back button isn't a pile of keystrokes.
    history.replaceState(null, '', next);
    onRoute();
  } else if (q) location.hash = hashFor('all', [], { q });
}, 250);
searchInput.addEventListener('input', goSearch);
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    searchInput.value = '';
    searchInput.blur();
    goSearch();
  }
});
document.addEventListener('keydown', (e) => {
  const t = e.target?.tagName;
  if (e.key === '/' && t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT' && route.name !== 'read') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  } else if (e.key === ',' && !e.ctrlKey && !e.metaKey && !e.altKey && t !== 'INPUT' && t !== 'TEXTAREA' && t !== 'SELECT' && !document.querySelector('.modal')) {
    e.preventDefault();
    openSettings();
  }
});

// ---------------------------------------------------------------- sidebar
const expandedKey = 'shelf.expanded.v1';
const expanded = new Set();
try {
  for (const d of JSON.parse(localStorage.getItem(expandedKey) || '[]')) expanded.add(d);
} catch { /* ignore */ }
const saveExpanded = () => {
  try { localStorage.setItem(expandedKey, JSON.stringify([...expanded])); } catch { /* ignore */ }
};

const link = (href, active, ...kids) => h('a', { class: 'nav-item' + (active ? ' active' : ''), href }, ...kids);

function folderNode(dir, byParent, activeDir, depth) {
  const kids = byParent.get(dir.path) ?? [];
  const open = expanded.has(dir.path) || (activeDir !== null && (activeDir === dir.path || activeDir.startsWith(dir.path + '/')) && expanded.has('*auto:' + dir.path));
  const isOpen = expanded.has(dir.path);
  const row = h(
    'div',
    { class: 'nav-row', style: { '--depth': depth } },
    kids.length
      ? h('button', {
          class: 'twisty' + (isOpen ? ' open' : ''),
          'aria-label': isOpen ? 'Collapse' : 'Expand',
          onClick: (e) => {
            e.preventDefault();
            isOpen ? expanded.delete(dir.path) : expanded.add(dir.path);
            saveExpanded();
            renderSidebar();
          },
        }, icon('chevron', 12))
      : h('span', { class: 'twisty-gap' }),
    link(hashFor('files', dirSegments(dir.path)), activeDir === dir.path, icon('folder', 15), h('span', { class: 'grow ellipsis' }, dir.name), h('span', { class: 'count' }, String(dir.total))),
  );
  void open;
  const out = [row];
  if (isOpen) for (const k of kids) out.push(...folderNode(k, byParent, activeDir, depth + 1));
  return out;
}

const sessionOf = (uuid) => (uuid ? store.sessions?.sessions.find((x) => x.uuid === uuid) : undefined);

function renderSidebar() {
  const activeDir = route.name === 'files' ? route.rest.join('/') : null;
  const activeTag = new Set((route.name === 'all' ? route.query.get('tags') ?? '' : '').split(',').filter(Boolean).map(Number));
  const activeList = route.name === 'list' ? Number(route.rest[0]) : null;

  // make sure the folders leading to the current one are open
  if (activeDir) {
    const parts = dirSegments(activeDir);
    for (let i = 1; i < parts.length; i++) expanded.add(parts.slice(0, i).join('/'));
  }

  const byParent = new Map();
  for (const d of store.tree.dirs) {
    if (!byParent.has(d.parent)) byParent.set(d.parent, []);
    byParent.get(d.parent).push(d);
  }
  // Sidebar order: by name (the server's order), or folders read most recently first. A folder counts as
  // read when anything inside it (at any depth) was; folders never read go last, by name.
  if (settings.treeSort === 'recent') {
    for (const list of byParent.values()) list.sort((a, b) => (b.lastRead ?? 0) - (a.lastRead ?? 0));
  }

  const section = (title, actions, ...kids) =>
    h('section', { class: 'nav-section' }, h('div', { class: 'nav-head' }, h('span', null, title), actions), ...kids);

  const tagsEl = store.tags.length
    ? store.tags.map((t) =>
        h(
          'div',
          { class: 'nav-row tag-row' },
          link(hashFor('all', [], { tags: t.id }), activeTag.has(t.id), h('i', { class: 'dot', style: { background: tagColor(t) } }), h('span', { class: 'grow ellipsis' }, t.name), h('span', { class: 'count' }, String(t.count))),
          h('button', { class: 'row-more', title: 'Tag options', onClick: (e) => tagMenu(e.currentTarget, t) }, icon('more', 14)),
        ),
      )
    : [h('div', { class: 'nav-empty' }, 'No tags yet. Select books and press Tag.')];

  const listsEl = store.lists.length
    ? store.lists.map((l) => {
        const row = h(
          'div',
          { class: 'nav-row tag-row' },
          link(
            hashFor('list', [String(l.id)]),
            activeList === l.id,
            icon('list', 15),
            h('span', { class: 'grow ellipsis' }, l.name),
            l.sessionUuid && store.info?.sessions ? h('span', { class: 'linked-ic', title: `Linked with session “${sessionOf(l.sessionUuid)?.display_name ?? 'session'}”` }, icon('link', 12)) : null,
            h('span', { class: 'count' }, String(l.count)),
          ),
          h('button', { class: 'row-more', title: 'List options', onClick: (e) => listMenu(e.currentTarget, l) }, icon('more', 14)),
        );
        // Books dragged from anywhere can be dropped on a list.
        row.addEventListener('dragover', (e) => {
          if (!dragHasBooks(e.dataTransfer)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          row.classList.add('drop-hot');
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop-hot'));
        row.addEventListener('drop', async (e) => {
          e.preventDefault();
          row.classList.remove('drop-hot');
          await addToList(l, readDrop(e.dataTransfer));
        });
        return row;
      })
    : [h('div', { class: 'nav-empty' }, 'No reading lists yet.')];

  // Sessions (docsessions) hang under Reading lists as a foldable sub-section.
  const sessionRows = !store.info?.sessions
    ? null
    : store.sessionsError
      ? [h('div', { class: 'nav-empty', title: store.sessionsError }, 'Unavailable: ' + store.sessionsError.slice(0, 80))]
      : !store.sessions
        ? [h('div', { class: 'nav-empty' }, 'Loading…')]
        : store.sessions.sessions.length
          ? store.sessions.sessions.map((s) =>
              link(
                hashFor('session', [s.uuid]),
                route.name === 'session' && route.rest[0] === s.uuid,
                icon('session', 15),
                h('span', { class: 'grow ellipsis' }, s.display_name || s.name || 'Session'),
                s.listId ? h('span', { class: 'linked-ic', title: 'Linked with a reading list' }, icon('link', 12)) : null,
                s.state !== 'stopped' ? h('i', { class: 'dot live', title: 'Open in the viewer' }) : null,
                h('span', { class: 'count' }, String(s.total)),
              ),
            )
          : [h('div', { class: 'nav-empty' }, 'No sessions yet.')];
  const sessionsOpen = settings.sessionsOpen !== false;
  const sessionsSub = sessionRows
    ? h(
        'div',
        { class: 'nav-sub' },
        h(
          'div',
          { class: 'nav-subhead' },
          h('button', { class: 'twisty' + (sessionsOpen ? ' open' : ''), 'aria-label': sessionsOpen ? 'Collapse sessions' : 'Expand sessions', 'aria-expanded': String(sessionsOpen), onClick: () => setSetting('sessionsOpen', !sessionsOpen) }, icon('chevron', 12)),
          h('button', { class: 'subtitle', onClick: () => setSetting('sessionsOpen', !sessionsOpen) }, 'Sessions', store.sessions ? h('span', { class: 'count' }, String(store.sessions.sessions.length)) : null),
          h('button', { class: 'icon-btn tiny', title: 'Reload sessions', onClick: () => refreshSessions() }, icon('refresh', 13)),
        ),
        sessionsOpen ? h('div', { class: 'nav-subbody' }, ...sessionRows) : null,
      )
    : null;

  const rootDirect = store.tree.root.direct;
  const sectionEls = {
    browse: section('Browse', null,
        link('#/all', route.name === 'all' && !route.query.get('tags') && !route.query.get('q') && route.query.get('untagged') !== '1', icon('library', 15), h('span', { class: 'grow' }, 'All books'), h('span', { class: 'count' }, String(store.tree.root.total))),
        link('#/recent', route.name === 'recent', icon('clock', 15), h('span', { class: 'grow' }, 'Recently read')),
        link('#/added', route.name === 'added', icon('plus', 15), h('span', { class: 'grow' }, 'Recently added')),
        link(hashFor('all', [], { untagged: 1 }), route.name === 'all' && route.query.get('untagged') === '1', icon('inbox', 15), h('span', { class: 'grow' }, 'Untagged')),
      ),
    folders: section('Folders',
        h('button', {
          class: 'icon-btn tiny' + (settings.treeSort === 'recent' ? ' on' : ''),
          title: settings.treeSort === 'recent' ? 'Folders: recently read first (click for A–Z)' : 'Folders: A–Z (click for recently read first)',
          'aria-pressed': settings.treeSort === 'recent' ? 'true' : 'false',
          onClick: () => setSetting('treeSort', settings.treeSort === 'recent' ? 'name' : 'recent'),
        }, icon('clock', 14)),
        link('#/files', route.name === 'files' && !activeDir, icon('folder', 15), h('span', { class: 'grow' }, 'Library root'), rootDirect ? h('span', { class: 'count' }, String(store.tree.root.total)) : null),
        ...(byParent.get('') ?? []).flatMap((d) => folderNode(d, byParent, activeDir, 0)),
      ),
    lists: section('Reading lists', h('button', { class: 'icon-btn tiny', title: 'New reading list', onClick: newList }, icon('plus', 14)), ...listsEl, sessionsSub),
    tags: section('Tags', h('button', { class: 'icon-btn tiny', title: 'New tag', onClick: newTag }, icon('plus', 14)), ...tagsEl),
  };
  const orderedSections = sidebarOrder().map((k) => sectionEls[k]);

  sidebar.replaceChildren(
    h('a', { class: 'brand', href: '#/files' }, icon('library', 22), h('span', null, appName())),
    h(
      'nav',
      null,
      ...orderedSections,
    ),
    h('div', { class: 'side-foot' },
      h('button', { class: 'nav-item', onClick: openSettings, title: 'Display, programs, storage, backup  (,)' }, icon('settings', 15), h('span', { class: 'grow' }, 'Settings')),
    ),
  );
}

async function newList() {
  const name = await askText({ title: 'New reading list', label: 'Name', okLabel: 'Create' });
  if (!name) return;
  try {
    const l = await api.post('/lists', { name });
    await refreshMeta();
    location.hash = hashFor('list', [String(l.id)]);
  } catch (e) { toast(e.message, 'error'); }
}
async function newTag() {
  const name = await askText({ title: 'New tag', label: 'Name', okLabel: 'Create' });
  if (!name) return;
  try {
    await api.post('/tags', { name });
    await refreshMeta();
  } catch (e) { toast(e.message, 'error'); }
}
function tagMenu(anchor, t) {
  popMenu(anchor, [
    { label: 'Rename…', onClick: async () => {
      const name = await askText({ title: 'Rename tag', value: t.name, okLabel: 'Rename' });
      if (!name || name === t.name) return;
      try { await api.patch(`/tags/${t.id}`, { name }); await refreshMeta(); } catch (e) { toast(e.message, 'error'); }
    } },
    { label: 'Set color…', onClick: async () => {
      const { pickColor } = await import('./ui.js');
      const c = await pickColor(t.color);
      if (c === null) return;
      await api.patch(`/tags/${t.id}`, { color: c || null });
      await refreshMeta();
      events.dispatchEvent(new Event('books-changed'));
    } },
    '-',
    { label: 'Delete tag', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete the tag “${t.name}”? It is removed from ${plural(t.count, 'book')}. The books themselves are untouched.`, { okLabel: 'Delete', danger: true }))) return;
      await api.del(`/tags/${t.id}`);
      await refreshMeta();
      if (route.name === 'all' && route.query.get('tags')) location.hash = '#/all';
      events.dispatchEvent(new Event('books-changed'));
    } },
  ]);
}
function listMenu(anchor, l) {
  popMenu(anchor, [
    ...(store.info?.sessions
      ? [
          { label: 'Open in a viewer…', disabled: !l.count, onClick: () => popMenu(anchor, viewerItems({ current: sessionOf(l.sessionUuid)?.viewer, pick: (v) => openListInViewer(l, v, { restart: sessionOf(l.sessionUuid)?.state !== 'stopped' && !!sessionOf(l.sessionUuid) }) })) },
          { label: 'Send to a session…', onClick: () => openSessionPicker({ listId: l.id, listName: l.name }) },
          l.sessionUuid ? { label: 'Open its session', onClick: () => (location.hash = hashFor('session', [l.sessionUuid])) } : null,
          l.sessionUuid ? { label: 'Unlink from its session', onClick: () => unlinkList(l) } : null,
          '-',
        ].filter((x) => x !== null)
      : []),
    { label: 'Copy list', onClick: () => copyList(l) },
    { label: 'Rename…', onClick: async () => {
      const name = await askText({ title: 'Rename reading list', value: l.name, okLabel: 'Rename' });
      if (!name || name === l.name) return;
      try { await api.patch(`/lists/${l.id}`, { name }); await refreshMeta(); } catch (e) { toast(e.message, 'error'); }
    } },
    '-',
    { label: 'Delete list', danger: true, onClick: async () => {
      if (!(await confirmDialog(`Delete the reading list “${l.name}”? The books themselves are untouched.`, { okLabel: 'Delete', danger: true }))) return;
      await api.del(`/lists/${l.id}`);
      await refreshMeta();
      if (route.name === 'list' && Number(route.rest[0]) === l.id) location.hash = '#/files';
    } },
  ]);
}

// ---------------------------------------------------------------- scan status
function renderScan() {
  const s = store.scan;
  rescanBtn.classList.toggle('spinning', !!s?.running);
  if (s?.running && !store.quiet) {
    scanPill.classList.remove('hidden');
    scanPill.textContent = s.total ? `Scanning ${s.processed}/${s.total}…` : 'Scanning…';
  } else scanPill.classList.add('hidden');
}

// ---------------------------------------------------------------- routing
let routeSeq = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scroll memory: every history entry remembers how far its page was scrolled, so coming back (or reloading)
// lands where you were, while a fresh visit starts at the top. `scrollKey` is the page being tracked; it is
// null while a page is changing, so a late scroll event can't write into the wrong entry.
let scrollKey = null;
let scrollTimer = 0;
function rememberScroll() {
  clearTimeout(scrollTimer);
  if (scrollKey === null || scrollKey !== location.hash) return;
  try { history.replaceState({ ...history.state, scroll: main.scrollTop }, ''); } catch { /* rate-limited or not allowed: forget it */ }
}
main.addEventListener('scroll', () => { clearTimeout(scrollTimer); scrollTimer = setTimeout(rememberScroll, 120); }, { passive: true });
addEventListener('pagehide', rememberScroll);
function restoreScroll(target, seq) {
  let tries = 0;
  const step = () => {
    if (seq !== routeSeq) return;
    main.scrollTop = target;
    if (target && Math.abs(main.scrollTop - target) > 2 && ++tries < 30) return requestAnimationFrame(step); // not tall enough yet
    scrollKey = location.hash;
  };
  step();
}

let lastRouteName = null;
async function onRoute() {
  const seq = ++routeSeq;
  const savedScroll = Number(history.state?.scroll) || 0;
  scrollKey = null;
  clearTimeout(scrollTimer);
  route = parseHash();
  const cameFrom = lastRouteName; // the page we are leaving (null on a first load or reload)
  lastRouteName = route.name;
  if (route.name === 'read' && cameFrom && cameFrom !== 'read') {
    try { history.replaceState({ ...history.state, from: true }, ''); } catch { /* fine */ }
  }
  document.body.classList.remove('nav-open');
  document.body.classList.toggle('reading', route.name === 'read');
  view?.destroy();
  view = null;
  const wasReading = main.firstElementChild?.classList.contains('reader');
  if (wasReading) {
    main.replaceChildren();
    // The reader just saved its position: refresh so "recently read" ordering and progress are current.
    setTimeout(() => refreshMeta().catch(() => {}), 700);
  }

  if (route.name === 'session') {
    const v = createSessionView(route);
    await Promise.race([v.ready, sleep(150)]);
    if (seq !== routeSeq) return v.destroy();
    view = v;
    main.replaceChildren(v.el);
    restoreScroll(savedScroll, seq);
    document.title = `${v.title} — ${appName()}`;
    v.ready.then(() => seq === routeSeq && (document.title = `${v.title} — ${appName()}`));
    searchInput.value = '';
  } else if (route.name === 'read') {
    document.title = appName(); // the reader sets the real title once it knows the book
    main.replaceChildren();
    const r = await createReader(route.rest[0], { page: Number(route.query.get('page')) || 0, frac: Number(route.query.get('frac')) || 0 });
    if (seq !== routeSeq) return r.destroy(); // navigated away while loading
    view = r;
    main.append(r.el);
  } else {
    const v = createLibraryView(route);
    // Keep the previous page on screen until the new one has data (max 150ms), so typing in
    // search or switching folders doesn't flash "Loading…". The old DOM is just replaced.
    await Promise.race([v.ready, sleep(150)]);
    if (seq !== routeSeq) return v.destroy();
    view = v;
    main.replaceChildren(v.el);
    restoreScroll(savedScroll, seq);
    v.ready.then(() => seq === routeSeq && savedScroll && main.scrollTop < savedScroll - 2 && restoreScroll(savedScroll, seq)); // data arrived late
    document.title = `${v.title} — ${appName()}`;
    if (document.activeElement !== searchInput) searchInput.value = route.query.get('q') ?? '';
  }
  renderSidebar();
}

window.addEventListener('hashchange', onRoute);
onSettings((k) => (k === 'treeSort' || k === 'sidebarOrder' || k === 'sessionsOpen' || k === '*') && renderSidebar());
subscribe(() => {
  renderSidebar();
  renderScan();
});
let lastScanEnd = Date.now();
events.addEventListener('scan-finished', (e) => {
  lastScanEnd = Date.now();
  const s = e.detail;
  if (s.error) toast(s.error, 'error');
  else if (s.added || s.moved || s.missing) toast(`Scan: ${s.added} new, ${s.moved} moved, ${s.missing} missing`);
});

// Tags/lists/counts can change from another tab or after a scan; refresh the sidebar when we come back.
// The server scans once at startup. We also rescan quietly whenever you come back to this tab (at most
// every 30s), so files you just added in a file manager show up without pressing anything.
function maybeRescan() {
  if (document.visibilityState !== 'visible' || route.name === 'read' || store.scan?.running) return;
  if (Date.now() - lastScanEnd < 30_000) return;
  lastScanEnd = Date.now();
  runScan({ quiet: true }).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    refreshMeta().catch(() => {});
    refreshSessions();
    maybeRescan();
  }
});
window.addEventListener('focus', maybeRescan);

// ---------------------------------------------------------------- boot
(async () => {
  await Promise.all([refreshMeta(), refreshInfo(), syncSettings()]).catch((e) => toast(e.message, 'error'));
  refreshSessions();
  startSessionPolling(() => route.name === 'session' || route.name === 'list');
  await onRoute();
  watchScan(); // picks up the scan the server starts on boot; refreshes everything when it ends
})();
