import { coverUrl } from './api.js';
import { h, icon } from './util.js';

// Flipping through a book from its card, without opening the reader. The book lifts out of the shelf into a larger one in front of it (the
// card stays where it is): a closed book whose cover swings open to a two-page spread, with the pages read on the left and the pages still
// to read on the right, both as stacks of paper whose thickness follows how many pages each side holds. Pages turn as double-sided leaves
// hinged at the spine. The pages are pictures the server draws on request (PDF and comic files; an EPUB has no fixed pages). Nothing is saved:
// not your place, not the pictures. Open in the reader (Enter, or the button) to carry on from the page you are looking at.

export const canFlip = (book) => (book.format === 'pdf' || book.format === 'cbz') && !book.isFolder && book.pages > 1;

let active = null; // only one book is open at a time

export function closeFlip(animate = false) {
  active?.close(animate);
}

const MARGIN = 7; // the board of the cover around the pages, in px

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
  const bulk = Math.min(1, Math.max(0, Math.log(total / 20) / Math.log(100))); // as on the card: how thick a book this is
  let px = 0;
  const url = (n) => (n === 0 ? coverUrl(book) : `/api/books/${book.id}/peek/${n}?w=${px}&v=${book.fingerprint}`);

  // What is on each side of a spread. Spread 0 is the closed book; spread 1 shows the inside of the cover and page 1; after that two pages each.
  // A side can be a page number, 'end' (the endpaper, inside a cover) or null (nothing: the closed book has no left side).
  const lastSpread = 1 + Math.floor(total / 2);
  const norm = (n) => (n === 'end' || n > total ? 'end' : n);
  const leftOf = (s) => (s <= 0 ? null : s === 1 ? 'end' : norm(2 * (s - 1)));
  const rightOf = (s) => (s <= 0 ? 0 : s === 1 ? 1 : norm(2 * (s - 1) + 1));
  const spreadOf = (page) => (page <= 1 ? 1 : Math.min(lastSpread, 1 + Math.floor(page / 2)));

  // Pictures already fetched, so turning back is instant. Resolves to the <img>, or null when the page can't be drawn.
  const pics = new Map();
  const load = (n) => {
    if (typeof n !== 'number' || n < 0 || n > total) return Promise.resolve(null);
    let p = pics.get(n);
    if (!p) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.src = url(n);
      p = img.decode().then(() => img, () => null);
      pics.set(n, p);
      if (pics.size > 24) pics.delete(pics.keys().next().value);
    }
    return p;
  };
  /** Puts one side's content into an element: a page picture, the cover, or the plain endpaper. */
  const fill = async (content, into) => {
    into.classList.toggle('is-end', content === 'end');
    into.classList.toggle('is-cover', content === 0);
    if (content === null) return into.replaceChildren();
    if (content === 'end') return into.replaceChildren();
    const img = await load(content);
    into.replaceChildren(img ? img.cloneNode() : h('span', { class: 'flip-miss' }, 'No preview'));
  };

  let pos = 0; // the spread on show
  let target = 0;
  let running = false;
  let leaving = false;
  let pw = 0; // width of one page, px
  let ph = 0;

  const halfL = h('div', { class: 'flip-pg lp' });
  const halfR = h('div', { class: 'flip-pg rp is-cover' });
  const boardL = h('div', { class: 'flip-board l' });
  const boardR = h('div', { class: 'flip-board r' });
  const stackL = h('div', { class: 'flip-stack l' });
  const stackR = h('div', { class: 'flip-stack r' });
  const tailL = h('div', { class: 'flip-tail l' });
  const tailR = h('div', { class: 'flip-tail r' });
  const pane = h('div', { class: 'flip closed', role: 'group', 'aria-label': 'Flip through this book' }, boardL, boardR, tailL, tailR, stackL, stackR, halfL, halfR);
  const num = h('span', { class: 'flip-num' });
  const range = h('input', { type: 'range', min: 1, max: total, value: 1, 'aria-label': 'Page', onInput: () => (num.textContent = `${range.value} / ${total}`), onChange: () => goPage(Number(range.value)) });
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
  if (book.spine) pane.style.setProperty('--board', `rgb(${book.spine})`);
  document.body.append(layer);

  /** Fits the book to the window: as tall as it can be, in the shape of the book's pages, two pages wide with room for the stacks. */
  function fit() {
    const m = MARGIN;
    const room = window.innerHeight * 0.88 - 62;
    ph = Math.round(Math.min(room, 1100) - 2 * m - 6);
    pw = ph * ar;
    const stacks = 2 * pw * (0.012 + 0.05 * bulk);
    const across = window.innerWidth * 0.96 - 2 * m - stacks;
    if (2 * pw > across) { pw = across / 2; ph = pw / ar; }
    pw = Math.round(pw);
    ph = Math.round(ph);
    pane.style.width = `${2 * pw}px`;
    pane.style.height = `${ph}px`;
    pane.style.perspective = `${Math.round(pw * 4.5)}px`;
    bar.style.width = `${2 * pw + 2 * m}px`;
    if (!px) px = Math.min(1400, Math.max(320, Math.ceil((pw * dpr) / 40) * 40)); // pictures are asked for at this size; a bigger window later just scales them
    layout(pos, 0);
  }
  const onResize = () => fit();
  window.addEventListener('resize', onResize);

  /** Where the board, the paper stacks and the book itself sit for a spread (the book slides so the closed cover is centred). */
  function layout(s, ms) {
    const m = MARGIN;
    const closed = s <= 0;
    const T = pw * (0.012 + 0.05 * bulk); // thickness of all the paper
    const leftN = closed ? 0 : Math.min(total, 2 * (s - 1));
    const rightN = total - leftN;
    const L = closed ? 0 : Math.max(2, T * Math.sqrt(leftN / total));
    const R = rightN <= 0 ? 0 : Math.max(2, T * Math.sqrt(rightN / total));
    pane.style.setProperty('--ms', `${ms}ms`);
    pane.classList.toggle('closed', closed);
    pane.style.transform = closed ? `translateX(${-Math.round(pw / 2)}px)` : 'none';
    const tailH = Math.max(2, Math.round(T * 0.28));
    // The right half of the board is the book's own; the left half is the cover once it has landed, so it is not there (and does not slide in) before that.
    Object.assign(boardR.style, { top: `${-m}px`, bottom: `${-m - tailH}px`, left: `${pw}px`, right: `${-R - m}px` });
    Object.assign(boardL.style, { top: `${-m}px`, bottom: `${-m - tailH}px`, left: `${-L - m}px`, right: `${pw}px` });
    Object.assign(stackL.style, { left: `${-L}px`, width: `${L}px` });
    Object.assign(stackR.style, { right: `${-R}px`, width: `${R}px` });
    Object.assign(tailR.style, { left: `${pw}px`, right: `${-R}px`, height: `${tailH}px`, bottom: `${-tailH}px` });
    Object.assign(tailL.style, { left: `${-L}px`, right: `${pw}px`, height: `${tailH}px`, bottom: `${-tailH}px` });
  }
  fit();

  /** The book travels between its place on the shelf and the front: it is drawn over the card's cover and eased out to full size. */
  function lift(out) {
    const a = wrap.getBoundingClientRect();
    const b = halfR.getBoundingClientRect();
    const o = stage.getBoundingClientRect();
    const s = Math.min(a.width / b.width, a.height / b.height);
    const ox = o.left + o.width / 2;
    const oy = o.top + o.height / 2;
    const dx = a.left + a.width / 2 - ox - s * (b.left + b.width / 2 - ox);
    const dy = a.top + a.height / 2 - oy - s * (b.top + b.height / 2 - oy);
    const from = `translate(${dx}px, ${dy}px) scale(${s})`;
    if (!out) stage.style.transform = from;
    stage.getBoundingClientRect();
    stage.style.transition = 'transform 340ms cubic-bezier(.2, .7, .2, 1)';
    layer.classList.toggle('shown', !out);
    stage.style.transform = out ? from : 'none';
    return new Promise((r) => setTimeout(r, 360));
  }

  const rightPage = () => {
    const r = rightOf(pos);
    return typeof r === 'number' && r >= 1 ? r : typeof leftOf(pos) === 'number' ? leftOf(pos) : 1;
  };
  function toReader() {
    const page = pos === 0 ? 1 : rightPage();
    close(false);
    open(page);
  }
  function ui() {
    const l = leftOf(pos);
    const r = rightOf(pos);
    if (pos === 0) num.textContent = `${total} pages`;
    else if (typeof l !== 'number') num.textContent = `1 / ${total}`;
    else if (typeof r !== 'number') num.textContent = `${l} / ${total}`;
    else num.textContent = `${l}–${r} / ${total}`;
    if (pos > 0) range.value = String(rightPage());
  }

  /** The cover and the pages the book rests at, without turning (the first picture, and far jumps). */
  async function settle(s) {
    await Promise.all([fill(leftOf(s), halfL), fill(rightOf(s), halfR)]);
    layout(s, 0);
  }

  /** One turn: a leaf, hinged at the spine, swings across. It has a page on each side: going forward the leaf is the right page of the spread you
   *  leave and the left page of the next one; going back it is the other way round. Under it the new page appears. */
  async function turn(from, to, ms) {
    const forward = to > from;
    const front = forward ? rightOf(from) : rightOf(to);
    const back = forward ? leftOf(to) : leftOf(from);
    const cover = front === 0;
    const f = h('div', { class: 'flip-face f rp' });
    const b = h('div', { class: 'flip-face b lp' });
    const leaf = h('div', { class: `flip-leaf ${forward ? 'fwd' : 'back'}${cover ? ' cover' : ''}` }, f, b);
    await Promise.all([fill(front, f), fill(back, b), forward ? fill(rightOf(to), halfR) : fill(leftOf(to), halfL)]);
    if (!pane.isConnected) return;
    leaf.style.setProperty('--ms', `${ms}ms`);
    pane.append(leaf);
    pane.classList.add('turning');
    layout(to, ms);
    swing(leaf, f, b, forward, ms);
    leaf.classList.add('go');
    await new Promise((r) => setTimeout(r, ms + 30));
    // the leaf has landed: the side it covered takes the picture it was showing
    await Promise.all([fill(leftOf(to), halfL), fill(rightOf(to), halfR)]);
    leaf.remove();
    pane.classList.remove('turning');
  }

  /** The leaf swings about the spine, and which of its two pages is seen changes at the quarter turn, on the very same clock: the page being left is shown
   *  for the first half, the page arriving for the second. (Hiding "the far side of a flat page" is left to the browser's 3D, which not every browser does the
   *  same way, so nothing here depends on it: the side that is turned away is simply not shown.) */
  function swing(leaf, f, b, forward, ms) {
    const ease = 'cubic-bezier(.45, .05, .25, 1)';
    const timing = { duration: ms, easing: ease, fill: 'both' };
    leaf.animate([{ transform: `rotateY(${forward ? 0 : -180}deg)` }, { transform: `rotateY(${forward ? -180 : 0}deg)` }], timing);
    const sides = (el, firstHalf) => {
      const a = firstHalf ? 'visible' : 'hidden';
      const z = firstHalf ? 'hidden' : 'visible';
      el.animate([{ visibility: a, offset: 0 }, { visibility: a, offset: 0.5 }, { visibility: z, offset: 0.5 }, { visibility: z, offset: 1 }], timing);
    };
    sides(f, forward); // going forward the leaf starts face-up (its front shows first); going back it starts lying face-down
    sides(b, !forward);
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      while (pos !== target && pane.isConnected) {
        const goal = target;
        if (goal === 0 && pos > 1) {
          pos = 1; // closing from deep inside: the pages are not all turned back, the book is just shut from its first spread
          await settle(pos);
        }
        const gap = Math.abs(goal - pos);
        if (gap <= 3 || pos === 0 || goal === 0) {
          // one spread at a time: the cover opening or closing is a slow turn, a few spreads away a quick run of turns
          const next = pos + Math.sign(goal - pos);
          await turn(pos, next, pos === 0 || next === 0 ? 720 : next === goal && gap <= 1 ? 620 : 260);
          pos = next;
        } else {
          pos = goal; // far away (the scrubber): no turning, just the spread
          await settle(pos);
        }
        ui();
      }
    } finally {
      running = false;
    }
    for (const s of [pos + 1, pos + 2, pos - 1]) { load(leftOf(s)); load(rightOf(s)); } // the pages most likely next
  }
  const goSpread = (s) => {
    if (leaving) return;
    target = Math.max(0, Math.min(lastSpread, s));
    run();
  };
  const goPage = (p) => goSpread(spreadOf(Math.max(1, Math.min(total, p))));

  let wheelAt = 0;
  const onWheel = (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - wheelAt < 240 || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 4) return;
    wheelAt = now;
    goSpread(target + (e.deltaY + e.deltaX > 0 ? 1 : -1));
  };
  layer.addEventListener('wheel', onWheel, { passive: false });

  // Swiping turns the page (a finger, a pen or a dragged mouse; a sideways two-finger swipe on a trackpad arrives as the wheel, above). A tap or click on the
  // left page turns back and on the right forward; a tap on the dimmed shelf around the book puts it back. The scrubber keeps its own dragging.
  let touch = null;
  let swiped = false;
  layer.addEventListener('pointerdown', (e) => { touch = { x: e.clientX, y: e.clientY, inside: stage.contains(e.target), range: e.target === range }; swiped = false; });
  layer.addEventListener('pointercancel', () => { touch = null; });
  layer.addEventListener('pointerup', (e) => {
    const t = touch;
    touch = null;
    if (!t || t.range) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.hypot(dx, dy) > 12) swiped = true; // a drag is not a tap, in any direction
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      goSpread(target + (dx < 0 ? 1 : -1)); // the finger moves toward the spine, like turning a right-hand page: forward
    } else if (!t.inside && Math.hypot(dx, dy) < 12) {
      close(true);
    }
  });
  pane.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; } // the end of a swipe is not also a tap
    const r = pane.getBoundingClientRect();
    goSpread(target + (e.clientX - r.left < r.width / 2 && !pane.classList.contains('closed') ? -1 : 1)); // the left page turns back, the right forward
  });

  const onKey = (e) => {
    if (!pane.isConnected) return close(false);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target instanceof HTMLInputElement && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return; // the scrubber's own arrows
    const k = e.key;
    let handled = true;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') goSpread(target + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') goSpread(target - 1);
    else if (k === 'Home') goSpread(1);
    else if (k === 'End') goSpread(lastSpread);
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
        target = 0; // the book closes, the cover swinging shut over the pages
        await run();
      }
      await lift(true);
    }
    layer.remove();
  }
  const handle = { close };
  active = handle;

  // The closed book comes forward from the shelf, then the cover swings open on the spread you were at (the first one if you have not read it).
  fill(0, halfR).then(async () => {
    ui();
    await lift(false);
    if (leaving) return;
    const at = book.progress?.page > 0 && book.progress.page <= total ? book.progress.page : 1;
    goPage(at);
  });
  return handle;
}
