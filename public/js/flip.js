import { coverUrl } from './api.js';
import { h, icon } from './util.js';

// Flipping through a book from its card, without opening the reader. The book lifts out of the shelf into a larger pane in front of it (the
// card stays where it is), its cover opens and the pages follow, one at a time, big enough to read. Pages are pictures the server draws on
// request (PDF and comic files; an EPUB has no fixed pages). Nothing is saved: not your place, not the pictures. Open in the reader
// (Enter, or the button) to carry on from the page you are looking at.

export const canFlip = (book) => (book.format === 'pdf' || book.format === 'cbz') && !book.isFolder && book.pages > 1;

let active = null; // only one book is open at a time

export function closeFlip(animate = false) {
  active?.close(animate);
}

/**
 * @param {HTMLElement} wrap  the .cover-wrap of the card (where the book lifts from and settles back to)
 * @param {object} book
 * @param {{ open: (page: number) => void }} cb
 */
export function openFlip(wrap, book, { open }) {
  if (active) active.close(false);
  const total = book.pages;
  const dpr = window.devicePixelRatio || 1;
  const coverImg = wrap.querySelector('img');
  let ar = coverImg?.naturalWidth && coverImg?.naturalHeight ? coverImg.naturalWidth / coverImg.naturalHeight : 0.7; // the shape of one page
  ar = Math.min(1.6, Math.max(0.45, ar));
  let px = 0;
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
      if (pics.size > 12) pics.delete(pics.keys().next().value);
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
  const pane = h('div', { class: 'flip', role: 'group', 'aria-label': 'Flip through this book' }, base);
  const bar = h(
    'div',
    { class: 'flip-bar' },
    num,
    range,
    h('button', { class: 'flip-btn', title: 'Open in the reader at this page (Enter)', onClick: () => toReader() }, icon('arrow-up-right', 14), 'Open in reader'),
    h('button', { class: 'flip-btn icon', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => close(true) }, icon('x', 14)),
  );
  const stage = h('div', { class: 'flip-stage' }, pane, bar);
  const layer = h('div', { class: 'flip-layer' }, stage);
  document.body.append(layer);

  /** Fits the pane to the window: as tall as it can be, in the shape of the book's pages. */
  function fit() {
    const barH = 54;
    let H = Math.min(window.innerHeight * 0.88 - barH, 1100);
    let W = H * ar;
    if (W > window.innerWidth * 0.94) { W = window.innerWidth * 0.94; H = W / ar; }
    pane.style.width = `${Math.round(W)}px`;
    pane.style.height = `${Math.round(H)}px`;
    pane.style.perspective = `${Math.round(W * 2.2)}px`;
    bar.style.width = `${Math.round(W)}px`;
    const want = Math.min(1400, Math.max(320, Math.ceil((W * dpr) / 40) * 40));
    if (!px) px = want; // the pictures are asked for at this size; a bigger window later just scales them
    return { W, H };
  }
  const onResize = () => fit();
  window.addEventListener('resize', onResize);
  fit();

  /** The book travels between its place on the shelf and the front: the pane is drawn over the cover and eased out to full size. */
  function lift(out) {
    const a = wrap.getBoundingClientRect();
    const b = pane.getBoundingClientRect();
    const dx = a.left + a.width / 2 - (b.left + b.width / 2);
    const dy = a.top + a.height / 2 - (b.top + b.height / 2);
    const s = Math.min(a.width / b.width, a.height / b.height);
    const from = `translate(${dx}px, ${dy}px) scale(${s})`;
    if (!out) stage.style.transform = from;
    stage.classList.toggle('lifted', !out);
    stage.getBoundingClientRect();
    stage.style.transition = 'transform 320ms cubic-bezier(.2, .7, .2, 1)';
    layer.classList.toggle('shown', !out);
    stage.style.transform = out ? from : 'none';
    return new Promise((r) => setTimeout(r, 340));
  }

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
          await turn(pos, next, next === goal && gap <= 1 ? 560 : 240);
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
  layer.addEventListener('wheel', onWheel, { passive: false });

  let down = null;
  pane.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  pane.addEventListener('click', (e) => {
    if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 30) {
      go(target + (e.clientX < down.x ? 1 : -1)); // a swipe
      return;
    }
    const r = pane.getBoundingClientRect();
    go(target + (e.clientX - r.left < r.width * 0.35 ? -1 : 1));
  });
  // a click on the dimmed shelf around the book puts it back
  layer.addEventListener('pointerdown', (e) => { if (!stage.contains(e.target)) close(true); });

  const onKey = (e) => {
    if (!pane.isConnected) return close(false);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // the scrubber's own arrows
    const k = e.key;
    let handled = true;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') go(target + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') go(target - 1);
    else if (k === 'Home') go(1);
    else if (k === 'End') go(total);
    else if (k === 'Enter' && !(e.target instanceof HTMLButtonElement)) toReader();
    else if (k === 'Escape') close(true);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
  };
  document.addEventListener('keydown', onKey, true);
  const onHash = () => close(false); // the page changed under us (back button, a link): the book goes away with it
  window.addEventListener('hashchange', onHash);

  async function close(animate) {
    if (leaving) return;
    leaving = true;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('hashchange', onHash);
    if (active === handle) active = null;
    if (animate && wrap.isConnected) {
      if (pos > 0 && pane.isConnected) {
        target = 0; // the cover swings shut over the page
        await run();
      }
      await lift(true);
    }
    layer.remove();
  }
  const handle = { close };
  active = handle;

  // The cover comes forward from the shelf, then swings open on the page you were at (or the first one).
  show(0, base).then(async () => {
    ui();
    await lift(false);
    if (leaving) return;
    const at = book.progress?.page > 0 && book.progress.page <= total ? book.progress.page : 1;
    go(at);
  });
  return handle;
}
