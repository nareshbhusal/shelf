import { api } from './api.js';

// Shared, mostly-read-only app data. Views subscribe and re-render when it changes.
export const store = {
  tags: [],
  lists: [],
  readers: [],
  tree: { root: { direct: 0, total: 0 }, dirs: [] },
  info: null,
  scan: null,
};
export const tagById = new Map();
/** "Shelf", or "Shelf (name)" when the shelf file gives this instance a name. */
export const appName = () => (store.info?.name ? `Shelf (${store.info.name})` : 'Shelf');

const subs = new Set();
export const subscribe = (fn) => {
  subs.add(fn);
  return () => subs.delete(fn);
};
const emit = () => subs.forEach((f) => f());

// 'books-changed' tells the library view to refetch its book list.
export const events = new EventTarget();
export const booksChanged = () => events.dispatchEvent(new Event('books-changed'));

export async function refreshMeta() {
  const [tags, lists, tree, readers] = await Promise.all([api.get('/tags'), api.get('/lists'), api.get('/tree'), api.get('/readers')]);
  Object.assign(store, { tags, lists, tree, readers });
  tagById.clear();
  for (const t of tags) tagById.set(t.id, t);
  emit();
}

export async function refreshInfo() {
  store.info = await api.get('/info');
  emit();
}

// ---- scanning: the server scans on boot; we poll its progress and refresh when it finishes.
let timer = null;
let quietScan = false; // an automatic rescan: only disturb the page if something actually changed

export function watchScan() {
  if (timer) return;
  const tick = async () => {
    try {
      store.scan = await api.get('/scan');
    } catch {
      timer = null;
      return;
    }
    emit();
    if (store.scan.running) {
      timer = setTimeout(tick, 500);
    } else {
      timer = null;
      await Promise.all([refreshMeta(), refreshInfo()]);
      const s = store.scan;
      events.dispatchEvent(new CustomEvent('scan-finished', { detail: s }));
      if (!quietScan || s.added || s.moved || s.missing || s.updated) booksChanged();
      quietScan = false;
    }
  };
  tick();
}

export async function runScan({ full = false, quiet = false } = {}) {
  quietScan = quiet;
  store.quiet = quiet; // background rescans don't flash the "Scanning…" pill
  store.scan = await api.post('/scan' + (full ? '?full=1' : ''));
  emit();
  watchScan();
}
