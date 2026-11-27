// Tiny DOM helper: h('div', { class: 'x', onClick: fn }, child, 'text', [more children])
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let deferredValue;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'value') deferredValue = v; // <select> needs its options to exist first
      else if (k in el) el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  if (deferredValue !== undefined) el.value = deferredValue;
  return el;
}

const ICONS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  library: '<path d="M5 3v18M10 5v16M15 3v18"/><path d="m19 6 2 14"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.2"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  book: '<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/>',
  session: '<rect x="3" y="8" width="14" height="12" rx="2"/><path d="M7 8V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  notepin: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M12 7v5M9.5 9.5h5"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  pen: '<path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  rows: '<path d="M3 5h18M3 12h18M3 19h18"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  pages: '<path d="M12 6c-2-1.5-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13c-3-.5-6 0-8 1.5zM12 6v13"/>',
  'arrow-up-right': '<path d="M7 17 17 7M9 7h8v8"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  flag: '<path d="M5 21V4M5 5h12l-2.5 4L17 13H5"/>',
  more: '<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  spread: '<path d="M12 6c-2-1.6-5-2-8-1.5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-13C17 4 14 4.4 12 6z"/><path d="M12 6v13"/>',
  shuffle: '<path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  paged: '<rect x="4" y="5" width="7" height="14" rx="1"/><rect x="13" y="5" width="7" height="14" rx="1"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  prev: '<path d="M6 5v14M19 5 9 12l10 7z"/>',
  next: '<path d="M18 5v14M5 5l10 7L5 19z"/>',
  back: '<path d="M19 12H5m6-7-7 7 7 7"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  inbox: '<path d="M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z"/>',
  note: '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5M8.5 9h7M8.5 12.5h4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5H5V6h5"/>',
};

export function icon(name, size = 18) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.innerHTML =
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ''}</svg>`;
  return span;
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function hueOf(str) {
  let x = 0;
  for (const ch of str) x = (x * 31 + ch.codePointAt(0)) >>> 0;
  return x % 360;
}
export const tagColor = (tag) => tag.color || `hsl(${hueOf(tag.name.toLowerCase())} 55% 55%)`;

export function initials(title) {
  const m = title.match(/[\p{L}\p{N}]/gu) ?? ['?'];
  return m.slice(0, 2).join('').toUpperCase();
}

// ---- hash routing: #/files/Some%20Dir/Sub?r=1   #/all?q=x&tags=1,2   #/list/3   #/read/42
export function parseHash(raw = location.hash) {
  const s = raw.replace(/^#/, '') || '/files';
  const [p, qs = ''] = s.split('?');
  const segs = p.split('/').filter(Boolean).map((x) => {
    try {
      return decodeURIComponent(x);
    } catch {
      return x;
    }
  });
  return { name: segs[0] || 'files', rest: segs.slice(1), query: new URLSearchParams(qs), raw: s };
}

export function hashFor(name, rest = [], query = {}) {
  const q = new URLSearchParams(
    Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  ).toString();
  return '#/' + [name, ...rest.map(encodeURIComponent)].join('/') + (q ? `?${q}` : '');
}

export const dirSegments = (dir) => (dir ? dir.split('/') : []);

/** "today", "yesterday", "5 days ago", "3 weeks ago", "4 months ago". */
export function ago(ms) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

/** Reading progress as 0..1. EPUBs count the position inside the section too; the others count pages. */
/** The estimated page an EPUB is on. */
export const epubPage = (b) => Math.max(1, Math.min(b.pages, Math.ceil(progressFraction(b) * b.pages)));
export function progressFraction(b) {
  const p = b.progress;
  if (!b.pages || !p?.page) return 0;
  if (b.format === 'epub') return Math.min(1, Math.max(0, p.frac ?? 0)); // fraction of the whole book, by text length
  return Math.min(1, p.page / b.pages);
}
/** Finished = the last page (EPUB: the end of the last section). */
export const isFinished = (b) =>
  b.format === 'epub' ? (b.progress?.frac ?? 0) >= 0.98 : !!b.pages && b.progress?.page >= b.pages;
/** "page 12 of 300" / "section 3 of 12 (34%)". */
export function progressText(b) {
  const p = b.progress;
  if (!p?.page) return '';
  if (b.format === 'epub') return b.pages ? `page ~${epubPage(b)} of ~${b.pages} (${Math.floor(progressFraction(b) * 100)}%)${isFinished(b) ? ', finished' : ''}` : `${Math.floor(progressFraction(b) * 100)}%`;
  return b.pages ? `page ${p.page} of ${b.pages}${isFinished(b) ? ' (finished)' : ''}` : `page ${p.page}`;
}

// The DOM's own append/replaceChildren print a null as the text "null"; the views build their children with
// `cond ? element : null`, so skip those the way h() does.
for (const name of ['append', 'prepend', 'replaceChildren']) {
  const native = Element.prototype[name];
  Element.prototype[name] = function (...nodes) {
    return native.apply(this, nodes.filter((n) => n != null && n !== false));
  };
}

/** Back out of the reader/viewer: step back in history when we came from a library page (so it is shown as we left it,
 *  scroll position included), otherwise go to the file's folder. */
export function goBack(fallbackHref) {
  if (history.state?.from) history.back();
  else location.hash = fallbackHref;
}

/** Part of every page-picture address: raised whenever Shelf changes how a page is drawn, because the browser keeps those pictures for a day and would go on showing old ones (with the old boxes). */
export const RENDER_V = 4;
