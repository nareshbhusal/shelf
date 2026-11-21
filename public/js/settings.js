import { api } from './api.js';
import { booksChanged, refreshInfo, refreshMeta, refreshSessions, runScan, store } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';
import { fmtBytes, h, icon } from './util.js';
import { openReadersManager } from './readers.js';
import { identityHelp, openMissing } from './missing.js';

export const SORTS = [
  ['title', 'Name'],
  ['author', 'Author'],
  ['added', 'Date added'],
  ['path', 'Folder / path'],
  ['size', 'File size'],
  ['pages', 'Pages'],
  ['read', 'Last read'],
  ['random', 'Random'],
];

export const SIDEBAR_SECTIONS = [['browse', 'Browse'], ['folders', 'Folders'], ['lists', 'Reading lists (and sessions)'], ['tags', 'Tags']];
/** The sidebar sections in the order chosen; unknown names are dropped and any that are missing go last. */
export const sidebarOrder = () => {
  const want = String(settings.sidebarOrder ?? '').split(',').filter((k) => SIDEBAR_SECTIONS.some(([x]) => x === k));
  const seen = [...new Set(want)];
  for (const [k] of SIDEBAR_SECTIONS) if (!seen.includes(k)) seen.push(k);
  return seen;
};

// What a card shows: always, only while the pointer is over it, or never (progress also: until the book is finished).
const SHOW = [['always', 'Always'], ['hover', 'On hover'], ['never', 'Never']];
/** These used to be on/off switches; an old saved true/false becomes always/never. */
const CARD_PARTS = ['showAuthor', 'showFormat', 'showPages', 'showTags', 'showProgress'];
function cardPart(key, v) {
  const item = SCHEMA.flatMap((g) => g.items).find((i) => i.key === key);
  if (v === true) return 'always';
  if (v === false) return 'never';
  return item.options.some(([o]) => o === v) ? v : item.default;
}

// Adding a display option = adding one entry here, a CSS rule (or a line in applySettings), and you're done.
// The settings dialog is generated from this table.
const SCHEMA = [
  {
    group: 'Library',
    items: [
      { key: 'nameSource', label: 'Show names from', type: 'select', options: [['filename', 'File name'], ['metadata', 'Book metadata (title)']], default: 'filename' },
      { key: 'view', label: 'Layout', type: 'select', options: [['grid', 'Grid'], ['list', 'List']], default: 'grid' },
      { key: 'cardWidth', label: 'Card width', type: 'range', min: 100, max: 320, step: 10, unit: 'px', default: 170 },
      { key: 'cardGap', label: 'Card gap', type: 'range', min: 4, max: 40, step: 2, unit: 'px', default: 16 },
      { key: 'coverFit', label: 'Cover fit', type: 'select', options: [['cover', 'Fill (crop)'], ['contain', 'Fit (letterbox)']], default: 'cover' },
      { key: 'coverRatio', label: 'Cover shape', type: 'select', options: [['2 / 3', 'Portrait 2:3'], ['3 / 4', 'Portrait 3:4'], ['1 / 1', 'Square']], default: '2 / 3' },
      { key: 'titleLines', label: 'Title lines', type: 'select', options: [['1', '1'], ['2', '2'], ['3', '3']], default: '2' },
      { key: 'groupComics', label: 'Multi-part series as one card (folders with several comics)', type: 'checkbox', default: true },
      { key: 'showAuthor', label: 'Author / folder line', type: 'select', options: SHOW, default: 'always' },
      { key: 'showFormat', label: 'Format badge', type: 'select', options: SHOW, default: 'always' },
      { key: 'showPages', label: 'Page count', type: 'select', options: SHOW, default: 'always' },
      { key: 'showTags', label: 'Tags on cards', type: 'select', options: SHOW, default: 'never' },
      { key: 'progressStyle', label: 'Reading progress shown as', type: 'select', options: [['ribbon', 'Bookmark ribbon'], ['bar', 'Bar along the bottom']], default: 'ribbon' },
      { key: 'showProgress', label: 'Reading progress', type: 'select', options: [['always', 'Always'], ['unfinished', 'Until finished'], ['hover', 'On hover'], ['never', 'Never']], default: 'always' },
    ],
  },
  {
    // Each of these draws something extra on every card. On a big library or an old computer, turn off what you can live without
    // (page edges and shadows cost the most while scrolling; tilt and shading only work while the pointer is on a book).
    group: 'Card effects',
    items: [
      { key: 'pageEdge', label: 'Books as solids: page edges, spine, thickness (heaviest)', type: 'checkbox', default: true },
      { key: 'spineColour', label: 'Spine takes the cover\'s colour', type: 'checkbox', default: true },
      { key: 'cardTilt', label: 'Tilt covers toward the pointer', type: 'checkbox', default: true },
      { key: 'cardShade', label: 'Shading that follows the tilt', type: 'checkbox', default: true },
      { key: 'coverShadow', label: 'Shadows under covers', type: 'checkbox', default: true },
      { key: 'badgeBlur', label: 'Frosted format and page badges', type: 'checkbox', default: true },
      { key: 'ribbonShadow', label: 'Shadow under bookmark ribbons', type: 'checkbox', default: true },
      { key: 'cardMotion', label: 'Animated card motion (lift, ease, ribbon growth)', type: 'checkbox', default: true },
      { key: 'flipPeek', label: 'Flip through books on their cards', type: 'checkbox', default: true },
    ],
  },
  {
    group: 'Sorting',
    items: [
      { key: 'sort', label: 'Sort by', type: 'select', options: SORTS, default: 'title' },
      { key: 'order', label: 'Order', type: 'select', options: [['asc', 'Ascending'], ['desc', 'Descending']], default: 'asc' },
      { key: 'treeSort', label: 'Folder list in the sidebar', type: 'select', options: [['name', 'A–Z'], ['recent', 'Recently read first']], default: 'name' },
      { key: 'addedDays', label: '"Recently added" covers the last', type: 'select', options: [['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', 'year']], default: '30' },
    ],
  },
  {
    group: 'Appearance',
    items: [
      { key: 'theme', label: 'Theme', type: 'select', options: [['dark', 'Dark'], ['black', 'Black'], ['light', 'Light'], ['sepia', 'Sepia']], default: 'dark' },
      { key: 'accent', label: 'Accent color', type: 'color', default: '#d2a65b' },
      { key: 'uiScale', label: 'Interface size', type: 'range', min: 85, max: 130, step: 5, unit: '%', default: 100 },
      { key: 'sidebarWidth', label: 'Sidebar width', type: 'range', min: 200, max: 400, step: 10, unit: 'px', default: 270 },
      { key: 'sidebarOrder', label: 'Sidebar sections (top to bottom)', type: 'order', options: SIDEBAR_SECTIONS, default: SIDEBAR_SECTIONS.map(([k]) => k).join(','), stacked: true },
      { key: 'sessionsEnabled', label: 'Use docsessions', type: 'checkbox', default: true, hidden: true },
      { key: 'sessionsOpen', label: 'Sessions folded open under Reading lists', type: 'checkbox', default: true, hidden: true },
    ],
  },
  {
    group: 'Reader',
    items: [
      { key: 'readerBg', label: 'Background', type: 'select', options: [['theme', 'Match theme'], ['black', 'Black'], ['dark', 'Dark'], ['gray', 'Gray'], ['paper', 'Paper']], default: 'theme' },
      { key: 'modePdf', label: 'PDF reading mode', type: 'select', options: [['scroll', 'Continuous scroll'], ['paged', 'One page at a time (horizontal)']], default: 'scroll' },
      { key: 'modeEpub', label: 'Book (EPUB) reading mode', type: 'select', options: [['scroll', 'Continuous scroll'], ['paged', 'Pages, turned like a book']], default: 'scroll' },
      { key: 'modeComic', label: 'Comic reading mode', type: 'select', options: [['scroll', 'Continuous scroll'], ['paged', 'One page at a time (horizontal)']], default: 'scroll' },
      { key: 'rtlComic', label: 'Comic page order (one page at a time)', type: 'select', options: [['ltr', 'Left to right'], ['rtl', 'Right to left (manga)']], default: 'ltr' },
      { key: 'spreadPdf', label: 'PDF pages', type: 'select', options: [['single', 'One at a time'], ['double', 'Two side by side']], default: 'single' },
      { key: 'spreadComic', label: 'Comic pages', type: 'select', options: [['single', 'One at a time'], ['double', 'Two side by side']], default: 'single' },
      { key: 'spreadCover', label: 'Two side by side: first page on its own (cover)', type: 'checkbox', default: true },
      { key: 'showFolios', label: 'Scrolling: page numbers between pages', type: 'checkbox', default: true },
      { key: 'pagedAnimation', label: 'Animate page turns (one page at a time)', type: 'checkbox', default: true },
      { key: 'pdfWidth', label: 'PDF page width', type: 'range', min: 400, max: 2000, step: 50, unit: 'px', default: 900 },
      { key: 'comicWidth', label: 'Comic page width', type: 'range', min: 300, max: 1800, step: 50, unit: 'px', default: 900 },
      { key: 'epubWidth', label: 'EPUB text width', type: 'range', min: 400, max: 1200, step: 20, unit: 'px', default: 720 },
      { key: 'epubFontSize', label: 'EPUB text size', type: 'range', min: 12, max: 36, step: 1, unit: 'px', default: 18 },
      { key: 'epubLine', label: 'EPUB line spacing', type: 'range', min: 1.2, max: 2.2, step: 0.05, unit: '', default: 1.6 },
      { key: 'epubFont', label: 'EPUB font', type: 'select', options: [['serif', 'Serif'], ['sans', 'Sans'], ['book', "The book's own"]], default: 'serif' },
      { key: 'pageGap', label: 'Comic page gap', type: 'range', min: 0, max: 40, step: 2, unit: 'px', default: 0 },
    ],
  },
];

const KEY = 'shelf.settings.v1';
export const settings = {};
for (const g of SCHEMA) for (const it of g.items) settings[it.key] = it.default;
settings.shuffleSeed = 0; // the order "Random" uses; kept (and synced) so browsing around doesn't reshuffle, replaced only by Shuffle
try {
  Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}'));
} catch {
  /* corrupt or unavailable storage: use defaults */
}

/** What to call a book on screen: its file name (default) or the title found in its metadata. */
export const stripExt = (filename) => filename.replace(/\.[^.]+$/, '');
// A lone comic in its own folder is called by the folder (that is the series); a folder of images has no extension to strip.
export const bookName = (b) => b.group ?? (settings.nameSource === 'metadata' ? b.title : b.isFolder ? b.filename : stripExt(b.filename));

const listeners = new Set();
export const onSettings = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

// Settings live in the shelf's own data (so every browser and device sees the same ones); the browser
// keeps a copy only so the page paints correctly before the server answers.
const cache = () => {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
};
let pending = {};
let saveTimer = null;
const flushSettings = () => {
  clearTimeout(saveTimer);
  const body = pending;
  pending = {};
  if (!Object.keys(body).length) return;
  api.patch('/settings', body).catch(() => {
    // Couldn't reach the server: keep them for the next change so nothing is silently lost.
    pending = { ...body, ...pending };
  });
};
window.addEventListener('pagehide', () => {
  if (!Object.keys(pending).length) return;
  try {
    fetch('/api/settings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending), keepalive: true });
  } catch { /* ignore */ }
});

/** Called once at startup: the server's copy wins; a first run on a new shelf uploads what this browser already had. */
export async function syncSettings() {
  let remote;
  try {
    remote = await api.get('/settings');
  } catch {
    return; // offline or locked: carry on with the browser's copy
  }
  const known = new Set(Object.keys(settings));
  const have = Object.keys(remote).filter((k) => known.has(k));
  if (have.length) {
    for (const k of have) settings[k] = remote[k];
    cache();
    applySettings();
    listeners.forEach((f) => f('*'));
  } else {
    const changed = {};
    for (const g of SCHEMA) for (const it of g.items) if (settings[it.key] !== it.default) changed[it.key] = settings[it.key];
    if (Object.keys(changed).length) api.patch('/settings', changed).catch(() => {});
  }
}

export function setSetting(key, value) {
  settings[key] = value;
  cache();
  pending[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSettings, 400);
  applySettings();
  listeners.forEach((f) => f(key));
}

export function applySettings() {
  const root = document.documentElement;
  const s = settings;
  root.dataset.theme = s.theme;
  root.dataset.coverFit = s.coverFit;
  root.dataset.readerBg = s.readerBg;
  for (const k of CARD_PARTS) root.dataset[k] = s[k] = cardPart(k, s[k]);
  root.dataset.pageEdge = s.pageEdge ? '1' : '0';
  root.dataset.cardTilt = s.cardTilt ? '1' : '0';
  for (const k of ['spineColour', 'cardShade', 'coverShadow', 'badgeBlur', 'ribbonShadow', 'cardMotion', 'flipPeek']) root.dataset[k] = s[k] ? '1' : '0';
  root.dataset.progressStyle = s.progressStyle;
  root.dataset.showFolios = s.showFolios ? '1' : '0';
  const set = (k, v) => root.style.setProperty(k, v);
  set('--card-w', `${s.cardWidth}px`);
  set('--gap', `${s.cardGap}px`);
  set('--cover-ratio', s.coverRatio);
  set('--cover-fit', s.coverFit);
  set('--title-lines', s.titleLines);
  set('--accent', s.accent);
  set('--sidebar-w', `${s.sidebarWidth}px`);
  set('--page-gap', `${s.pageGap}px`);
  root.style.fontSize = `${(16 * s.uiScale) / 100}px`;
}

function orderControl(item) {
  const box = h('div', { class: 'order-list' });
  const draw = () => {
    const cur = sidebarOrder();
    box.replaceChildren(
      ...cur.map((k, i) =>
        h(
          'div',
          { class: 'order-row' },
          h('span', { class: 'grow' }, item.options.find(([x]) => x === k)?.[1] ?? k),
          h('button', { class: 'icon-btn', title: 'Move up', 'aria-label': 'Move up', disabled: i === 0, onClick: () => move(i, -1) }, icon('up', 14)),
          h('button', { class: 'icon-btn', title: 'Move down', 'aria-label': 'Move down', disabled: i === cur.length - 1, onClick: () => move(i, 1) }, icon('down', 14)),
        ),
      ),
    );
  };
  const move = (i, d) => {
    const cur = sidebarOrder();
    [cur[i], cur[i + d]] = [cur[i + d], cur[i]];
    setSetting(item.key, cur.join(','));
    draw();
  };
  draw();
  return box;
}

function control(item) {
  const cur = settings[item.key];
  if (item.type === 'order') return orderControl(item);
  if (item.type === 'select') {
    return h(
      'select',
      { class: 'sel', value: String(cur), onChange: (e) => setSetting(item.key, e.target.value) },
      item.options.map(([v, label]) => h('option', { value: v }, label)),
    );
  }
  if (item.type === 'checkbox') {
    return h('input', { type: 'checkbox', checked: !!cur, onChange: (e) => setSetting(item.key, e.target.checked) });
  }
  if (item.type === 'color') {
    return h('input', { type: 'color', class: 'color-input', value: cur, onInput: (e) => setSetting(item.key, e.target.value) });
  }
  const out = h('span', { class: 'muted range-val' }, `${cur}${item.unit ?? ''}`);
  const input = h('input', {
    type: 'range',
    min: item.min,
    max: item.max,
    step: item.step,
    value: Math.min(item.max, cur),
    onInput: (e) => {
      out.textContent = `${e.target.value}${item.unit ?? ''}`;
      setSetting(item.key, Number(e.target.value));
    },
  });
  return h('div', { class: 'range-wrap' }, input, out);
}

async function exportData() {
  try {
    const data = await api.get('/export');
    const browserSettings = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k?.startsWith('shelf.')) continue;
        const raw = localStorage.getItem(k);
        try { browserSettings[k] = JSON.parse(raw); } catch { browserSettings[k] = raw; }
      }
    } catch { /* storage unavailable */ }
    data.browserSettings = browserSettings; // small per-browser conveniences (pen colour, reader bar...)
    const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `shelf-export-${new Date().toISOString().slice(0, 10)}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`Exported ${data.tags.length} tags, ${data.lists.length} reading lists, ${data.books.length} books`);
  } catch (e) {
    toast(`Export failed: ${e.message}`, 'error');
  }
}

export function openSettings() {
  const info = store.info;
  const sections = SCHEMA.map((g) =>
    h(
      'section',
      { class: 'set-group' },
      h('h3', null, g.group),
      g.items.filter((it) => !it.hidden).map((it) =>
        h('div', { class: 'set-row' + (it.stacked ? ' stacked' : '') }, h('label', null, it.label), control(it)),
      ),
    ),
  );

  const busy = (btn, fn) => async () => {
    btn.disabled = true;
    try {
      await fn();
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.disabled = false;
    }
  };

  const rescanBtn = h('button', { class: 'btn' }, 'Rescan library');
  rescanBtn.onclick = busy(rescanBtn, async () => {
    await runScan();
    toast('Scanning…');
  });
  const rebuildBtn = h('button', { class: 'btn' }, 'Rebuild metadata');
  rebuildBtn.onclick = busy(rebuildBtn, async () => {
    await runScan({ full: true });
    toast('Re-reading metadata for every book…');
  });
  const coversBtn = h('button', { class: 'btn', title: 'Draw every cover again from its file. Nothing in your library changes.' }, 'Rebuild all covers');
  coversBtn.onclick = busy(coversBtn, async () => {
    const r = await api.post('/covers/rebuild-all');
    toast(`${r.removed} covers cleared. They are drawn again as you browse the library.`);
  });
  const missing = info?.missing ?? 0;
  // Opens the list of missing books, where each can be looked at and forgotten (or all at once).
  const purgeBtn = h('button', { class: 'btn', title: 'See which books are missing and what Shelf remembers about them' });
  const missingLabel = () => (purgeBtn.textContent = store.info?.missing ? `Missing books (${store.info.missing})…` : 'Missing books…');
  missingLabel();
  refreshInfo().then(missingLabel).catch(() => {}); // the count may have changed since the page loaded
  purgeBtn.onclick = () => openMissing({ onChange: missingLabel });
  const resetBtn = h('button', { class: 'btn' }, 'Reset display settings');
  resetBtn.onclick = () => {
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    pending = {};
    api.put('/settings', {}).catch((e) => toast(`Couldn't reset on the server: ${e.message}`, 'error'));
    for (const g of SCHEMA) for (const it of g.items) settings[it.key] = it.default;
    applySettings();
    listeners.forEach((f) => f('*'));
    m.close();
    openSettings();
  };

  const tools = info?.tools;
  const warn =
    tools && (!tools.pdfinfo || !tools.pdftoppm)
      ? h(
          'div',
          { class: 'callout warn' },
          'poppler-utils is not installed, so PDF covers, titles and page counts are unavailable. Run ',
          h('code', null, 'sudo apt install poppler-utils'),
          ', then press “Rebuild metadata”.',
        )
      : null;

  const storageEl = h('div', { class: 'muted small' }, 'Measuring…');
  api.get('/storage').then(
    (s) =>
      storageEl.replaceChildren(
        `${s.books} books · database ${fmtBytes(s.dbBytes)} · ${s.thumbCount} cached covers (${fmtBytes(s.thumbBytes)})`,
        h('br'),
        'Stored in ',
        h('code', null, s.dataDir),
        '. Books are never copied anywhere. Your library is only read, except that highlights and notes you add are saved inside that PDF itself' + (store.info?.readOnly ? ' (disabled: read-only mode)' : '') + '.',
      ),
    () => storageEl.replaceChildren('Could not read storage info.'),
  );

  const programs = h(
    'section',
    { class: 'set-group' },
    h('h3', null, 'Open with your own programs'),
    h('div', { class: 'muted small' },
      store.readers.length
        ? ['books', 'lists'].map((sc) => `${sc === 'books' ? 'Books' : 'Reading lists'}: ${store.readers.filter((r) => r.scope === sc).map((r) => r.name).join(', ') || 'none'}`).join('  ·  ')
        : 'None yet. Add Okular, Zathura, or your own script (separately for books and for reading lists).'),
    info?.docker && !info?.opener
      ? h('div', { class: 'callout warn' }, "Shelf is in Docker and the desktop helper isn't running. Run ", h('code', null, './shelf.sh start'), ' on your computer to start it.')
      : null,
    h('div', { class: 'btn-row' }, h('button', { class: 'btn', onClick: () => openReadersManager() }, 'Manage programs…')),
  );

  // docsessions: an external app, on or off like any other.
  const apps = (() => {
    const box = h('section', { class: 'set-group' }, h('h3', null, 'docsessions (PDF viewer sessions)'));
    const status = h('div', { class: 'muted small' });
    const draw = async () => {
      const inf = store.info;
      if (!inf?.sessionsConfigured) {
        box.replaceChildren(
          h('h3', null, 'docsessions (PDF viewer sessions)'),
          h('div', { class: 'muted small' }, 'Not set up. Tell Shelf how to run it with the "sessions" key of the shelf file, the --sessions option or SHELF_SESSIONS, then restart Shelf.'),
        );
        return;
      }
      const on = !!inf.sessions;
      const cb = h('input', { type: 'checkbox', checked: on, id: 'sessions-on' });
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        try {
          await api.patch('/settings', { sessionsEnabled: cb.checked });
          settings.sessionsEnabled = cb.checked;
          await refreshInfo();
          if (cb.checked) await refreshSessions();
          else { store.sessions = null; store.sessionsError = ''; }
          if (!cb.checked && /^#\/session\//.test(location.hash)) location.hash = '#/files';
        } catch (e) { toast(e.message, 'error'); }
        draw();
      });
      box.replaceChildren(
        h('h3', null, 'docsessions (PDF viewer sessions)'),
        h('div', { class: 'set-row' }, h('label', { for: 'sessions-on' }, 'Use docsessions with Shelf'), cb),
        h('div', { class: 'muted small' }, 'Command: ', h('code', null, inf.sessionsCommand)),
        status,
      );
      if (!on) { status.textContent = 'Off: the Sessions sidebar section, “Add to session” and “Open in a viewer” are hidden. Linked lists keep their link and wake up when you turn it back on. Session files are never touched either way.'; return; }
      status.textContent = 'Checking…';
      try {
        const d = await api.get('/sessions');
        const vs = (d.viewers ?? []).filter((v) => v.installed).map((v) => v.display_name || v.id);
        status.textContent = `Working: ${d.sessions.length} session${d.sessions.length === 1 ? '' : 's'}; viewers installed: ${vs.join(', ') || 'none'}.`;
      } catch (e) { status.textContent = `Not working: ${e.message}`; }
    };
    draw();
    return box;
  })();

  const backup = h(
    'section',
    { class: 'set-group' },
    h('h3', null, 'Storage & backup'),
    storageEl,
    h('div', { class: 'muted small' }, 'Tags, reading lists, programs and reading progress live in this database (highlights and notes live inside the PDFs themselves). Rescanning also deletes cached covers of books that no longer exist.'),
    h('div', { class: 'btn-row' },
      h('a', { class: 'btn', href: '/api/backup', download: '' }, 'Download backup'),
      h('button', { class: 'btn', title: 'A readable JSON file: tags, reading lists, progress, programs, display settings and the book index', onClick: exportData }, 'Export data (JSON)'),
    ),
    h('div', { class: 'muted small' }, 'The backup is the whole database, for restoring this exact setup. The export is a readable JSON file of your tags, reading lists (in order), progress, programs, display settings and the book index. Books are identified by path and content fingerprint. Highlights, notes and drawings are not in it: they are inside the PDFs.'),
  );

  const maintenance = h(
    'section',
    { class: 'set-group' },
    h('h3', null, 'Library'),
    h('div', { class: 'muted small' }, 'Folder: ', h('code', null, info?.libraryDir ?? '…')),
    warn,
    h('div', { class: 'btn-row' }, rescanBtn, rebuildBtn, coversBtn, purgeBtn),
    identityHelp(),
    h('div', { class: 'muted small' }, 'Display settings are saved with this shelf, so every browser you open it from uses the same ones.'),
    h('div', { class: 'btn-row' }, resetBtn),
    info?.auth
      ? h('form', { method: 'post', action: '/logout', class: 'btn-row' }, h('button', { class: 'btn', type: 'submit', title: 'Forget the pass key in this browser' }, 'Lock Shelf (sign out)'))
      : null,
  );

  const m = modal({ title: 'Display & settings', body: [...sections, programs, apps, backup, maintenance], wide: true });
}
