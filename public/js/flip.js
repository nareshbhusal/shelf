import { coverUrl } from './api.js';
import { h, icon } from './util.js';

// Flipping through a book on its card, without opening the reader. The cover turns like the cover of a book and the pages follow, one
// at a time. Pages are small pictures the server draws on request (PDF and comic files; an EPUB has no fixed pages). Nothing is saved:
// not your place, not the pictures. Open in the reader (Enter, or the button) to carry on from the page you are looking at.

export const canFlip = (book) => (book.format === 'pdf' || book.format === 'cbz') && !book.isFolder && book.pages > 1;

let active = null; // only one book is open at a time

export function closeFlip(animate = false) {
  active?.close(animate);
}

/**
 * @param {HTMLElement} wrap  the .cover-wrap of the card
 * @param {object} book
 * @param {{ open: (page: number) => void }} cb
 */
export function openFlip(wrap, book, { open }) {
  if (active) active.close(false);
  const total = book.pages;
  const px = Math.min(700, Math.max(240, Math.ceil((wrap.clientWidth * (window.devicePixelRatio || 1)) / 40) * 40));
  const url = (n) => (n === 0 ? coverUrl(book) : `/api/books/${book.id}/peek/${n}?w=${px}&v=${book.fingerprint}`);

  // Pictures already fetched, so turning back is instant. Resolves to the <img>, or null when the page can't be drawn.
  const pics = new Map();
  const load = (n) => {
    if (n < 0 || n > total) return Promise.resolve(null);
    let p = pics.get(n);
    if (!p) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.src = url(n);
      p = img.decode().then(() => img, () => null);
      pics.set(n, p);
      if (pics.size > 14) pics.delete(pics.keys().next().value);
    }
    return p;
  };
  const show = async (n, into) => {
    const img = await load(n);
    into.replaceChildren(img ? img.cloneNode() : h('span', { class: 'flip-miss' }, 'No preview'));
    into.classList.toggle('is-cover', n === 0);
  };

  let pos = 0; // 0 is the cover, 1 the first page
  let target = 0;
  let running = false;
  let leaving = false;

  const base = h('div', { class: 'flip-page is-cover' });
  const num = h('span', { class: 'flip-num' });
  const range = h('input', { type: 'range', min: 1, max: total, value: 1, 'aria-label': 'Page', onInput: () => (num.textContent = `${range.value} / ${total}`), onChange: () => go(Number(range.value)) });
  const stop = (e) => e.stopPropagation();
  const closeBtn = h('button', { class: 'flip-btn flip-close', title: 'Close (Esc)', 'aria-label': 'Close', onClick: (e) => { e.preventDefault(); e.stopPropagation(); close(true); } }, icon('x', 14));
  const openBtn = h('button', { class: 'flip-btn flip-open', title: 'Open in the reader at this page (Enter)', 'aria-label': 'Open in the reader', onClick: (e) => { e.preventDefault(); e.stopPropagation(); toReader(); } }, icon('arrow-up-right', 14));
  const pane = h('div', { class: 'flip', role: 'group', 'aria-label': 'Flip through this book' }, base, openBtn, closeBtn, h('div', { class: 'flip-bar', onClick: stop }, num, range));
  wrap.append(pane);
  wrap.classList.add('flipping');
  wrap.closest('.card')?.classList.add('flipping-card');

  function toReader() {
    const page = Math.max(1, pos);
    close(false);
    open(page);
  }
  function ui() {
    num.textContent = pos === 0 ? `${total} pages` : `${pos} / ${total}`;
    if (pos > 0) range.value = String(pos);
  }

  /** One turn: a leaf swings about the spine edge. Forward, the page you are on lifts off the next one; backward, the earlier page falls back over it. */
  async function turn(from, to, ms) {
    const forward = to > from;
    const leaf = h('div', { class: 'flip-leaf ' + (forward ? 'fwd' : 'back') });
    await Promise.all([show(forward ? from : to, leaf), forward ? show(to, base) : null]);
    if (!pane.isConnected) return;
    leaf.style.setProperty('--ms', `${ms}ms`);
    base.after(leaf);
    leaf.getBoundingClientRect(); // lets the starting pose be drawn before the move
    pane.classList.add('turning');
    leaf.classList.add('go');
    await new Promise((r) => setTimeout(r, ms + 30));
    if (!forward) await show(to, base);
    leaf.remove();
    pane.classList.remove('turning');
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      while (pos !== target && pane.isConnected) {
        const goal = target;
        const gap = Math.abs(goal - pos);
        if (pos === 0 || goal === 0 || gap <= 4) {
          // the cover opening or closing is one turn; a few pages away is a quick run of turns
          const next = pos === 0 || goal === 0 ? goal : pos + Math.sign(goal - pos);
          await turn(pos, next, next === goal && gap <= 1 ? 520 : 220);
          pos = next;
        } else {
          pos = goal; // far away (the slider): no turning, just the page
          await show(pos, base);
        }
        ui();
      }
    } finally {
      running = false;
    }
    for (const n of [pos + 1, pos + 2, pos - 1]) load(n); // the pages most likely next
  }
  function go(n) {
    if (leaving) return;
    target = Math.max(0, Math.min(total, n));
    run();
  }

  let wheelAt = 0;
  const onWheel = (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelAt < 240 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    wheelAt = now;
    go(target + (e.deltaY + e.deltaX > 0 ? 1 : -1));
  };
  pane.addEventListener('wheel', onWheel, { passive: false });

  let down = null;
  pane.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  pane.addEventListener('click', (e) => {
    // The card is a link: nothing in here may follow it.
    e.preventDefault();
    e.stopPropagation();
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 30) {
      go(target + (e.clientX < down.x ? 1 : -1)); // a swipe
      return;
    }
    const r = pane.getBoundingClientRect();
    go(target + (e.clientX - r.left < r.width * 0.35 ? -1 : 1));
  });
  pane.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });

  const onKey = (e) => {
    if (!pane.isConnected) return close(false); // the list was redrawn under us
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    let handled = true;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') go(target + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') go(target - 1);
    else if (k === 'Home') go(1);
    else if (k === 'End') go(total);
    else if (k === 'Enter') toReader();
    else if (k === 'Escape') close(true);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  const onOutside = (e) => {
    if (!pane.isConnected) return close(false);
    if (pane.contains(e.target) || e.target.closest?.('.flipbtn')) return; // the card's own button decides for itself
    close(true);
    if (e.target.closest?.('.card')) {
      // a click that only meant "put it away" shouldn't also open another book
      const eat = (c) => { c.preventDefault(); c.stopPropagation(); };
      document.addEventListener('click', eat, { capture: true, once: true });
      setTimeout(() => document.removeEventListener('click', eat, true), 600);
    }
  };
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onOutside, true);

  async function close(animate) {
    if (leaving) return;
    leaving = true;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onOutside, true);
    if (active === handle) active = null;
    if (animate && pos > 0 && pane.isConnected) {
      target = 0; // the cover swings shut over the page
      await run();
    }
    pane.remove();
    wrap.classList.remove('flipping');
    wrap.closest('.card')?.classList.remove('flipping-card');
  }
  const handle = { close };
  active = handle;

  // The cover is on show; it swings open on the page you were at (or the first one).
  show(0, base).then(() => {
    ui();
    const at = book.progress?.page > 0 && book.progress.page <= total ? book.progress.page : 1;
    go(at);
  });
  return handle;
}
