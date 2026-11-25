import { api } from './api.js';

// One page count for an EPUB: the server lays the book out into pages (what the flip-through viewer shows) and says where each starts, as how far through
// the book it is in the reader's own terms. With that table a page number is a spot the reader can go to, and a spot in the reader is a page number.

const cache = new Map(); // book id -> promise of { total, starts, exact }

/** The table for a book: { total, starts[], exact }. If the server can't make it, pages are spread evenly (exact: false). */
export function loadEpubPages(book) {
  const key = `${book.id}:${book.fingerprint ?? ''}`;
  let p = cache.get(key);
  if (!p) {
    p = api
      .get(`/books/${book.id}/epub-pages`)
      .then((t) => (t && Array.isArray(t.starts) && t.starts.length ? { total: t.starts.length, starts: t.starts, exact: true } : Promise.reject(new Error('empty'))))
      .catch(() => {
        cache.delete(key);
        const total = Math.max(1, book.pages || 1);
        return { total, starts: Array.from({ length: total }, (_, i) => i / total), exact: false };
      });
    cache.set(key, p);
  }
  return p;
}

const EPS = 2e-5; // a spot a hair before the top of a page (rounding, landing a character short) still counts as that page

/** The page (1-based) a spot `frac` (0..1) of the way through the book falls on. */
export function pageOf(t, frac) {
  const f = Math.min(1, Math.max(0, Number(frac) || 0)) + EPS;
  const s = t.starts;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid] <= f) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** How far through the book the top of page `page` (1-based) is. */
export function fracOf(t, page) {
  const i = Math.min(t.starts.length, Math.max(1, Math.round(page))) - 1;
  return t.starts[i];
}
