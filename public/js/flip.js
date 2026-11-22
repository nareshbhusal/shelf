import { api, coverUrl } from './api.js';
import { h, icon } from './util.js';
import { setSetting, settings } from './settings.js';
import { castOf, swing, sweep, turnMs } from './leaf.js';
import { createFlipNotes } from './flipnotes.js';

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
 * @param {{ open: (page: number) => void, saved?: () => void }} cb  `saved` is told, once the book has gone back, that you set your place from here
 */
export function openFlip(wrap, book, { open, saved }) {
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
    delete into.dataset.page;
    if (content === null) return into.replaceChildren();
    if (content === 'end') return into.replaceChildren();
    const img = await load(content);
    if (typeof content === 'number' && content >= 1) into.dataset.page = String(content);
    // a PDF page also carries its highlights and notes (and, once at rest, its selectable words) in a box the shape of the picture
    if (img && notes && content >= 1) await notes.ready;
    into.replaceChildren(img ? img.cloneNode() : h('span', { class: 'flip-miss' }, 'No preview'), ...(img && notes && content >= 1 ? [notes.pageBox(content, img)] : []));
  };

  let pos = 0; // the spread on show
  let target = 0;
  let running = false;
  let leaving = false;
  let pw = 0; // width of one page, px
  let ph = 0;
  const SCALE = { min: 0.4, max: 1.15 };
  let scale = Math.min(SCALE.max, Math.max(SCALE.min, (Number(settings.flipScale) || 100) / 100)); // how big the book is shown, remembered between visits

  const halfL = h('div', { class: 'flip-pg lp' });
  const halfR = h('div', { class: 'flip-pg rp is-cover' });
  const boardL = h('div', { class: 'flip-board l' });
  const boardR = h('div', { class: 'flip-board r' });
  const stackL = h('div', { class: 'flip-stack l' });
  const stackR = h('div', { class: 'flip-stack r' });
  const tailL = h('div', { class: 'flip-tail l' });
  const tailR = h('div', { class: 'flip-tail r' });
  const pane = h('div', { class: 'flip closed', role: 'group', 'aria-label': 'Flip through this book' }, boardL, boardR, tailL, tailR, stackL, stackR, halfL, halfR);
  // Where you are, as "n / total". n is the page (or the pair of pages) on show; click it, type a page and press Enter to go there.
  const jump = h('input', { class: 'flip-n', type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: false, 'aria-label': 'Page: type a number and press Enter to go there', title: 'Type a page number and press Enter' });
  // Nothing here is saved unless you ask: this stores the page on show as your place in the book (the same progress the reader keeps).
  let placed = false;
  const placeBtn = h('button', { class: 'flip-btn icon', 'aria-label': 'Set this page as my reading progress', onClick: () => setPlace() }, icon('bookmark', 14));
  const bar = h(
    'div',
    { class: 'flip-bar' },
    jump,
    h('span', { class: 'flip-tot' }, `/ ${total}`),
    h('span', { class: 'flip-sp' }),
    placeBtn,
    h('button', { class: 'flip-btn icon', title: 'Open in the reader at this page (Enter)', 'aria-label': 'Open in the reader', onClick: () => toReader() }, icon('arrow-up-right', 14)),
    h('button', { class: 'flip-btn icon', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => close(true) }, icon('x', 14)),
    h('span', { class: 'flip-grip', title: 'Drag to resize (double-click to reset; or + and \u2212 keys)', role: 'separator', 'aria-label': 'Resize' }),
  );
  const stage = h('div', { class: 'flip-stage' }, pane, bar);
  const layer = h('div', { class: 'flip-layer' }, stage);
  pane.style.setProperty('--board', clothColour());
  pane.style.setProperty('--land', '0'); // how much of the left half (the cover's edges, the pages read) has arrived: nothing while the book is shut
  pane.style.setProperty('--cast', '0'); // how dark the crease and the landing page are: nothing at rest, most while a leaf stands upright
  document.body.append(layer);
  const notes = book.format === 'pdf' ? createFlipNotes({ book, pane, layer }) : null; // (hoisted use above is only inside functions, which run later)

  /** The colour of the hardcover's cloth: the book's spine colour (the average of its cover, the one the card's spine already shows), deepened so it reads as
   *  cloth. A book with no colour yet is measured from its cover here; and failing that, it gets a steady colour of its own from its name, never one shared by all. */
  function clothColour() {
    let rgb = null;
    const fromText = (t) => { const m = /(\d+)\D+(\d+)\D+(\d+)/.exec(t || ''); return m ? [+m[1], +m[2], +m[3]] : null; };
    rgb = fromText(wrap.closest('.book-stage')?.style.getPropertyValue('--spine')) || fromText(book.spine);
    if (!rgb && coverImg?.complete && coverImg.naturalWidth) {
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 4;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(coverImg, 0, 0, 4, 4);
        const d = g.getImageData(0, 0, 4, 4).data;
        rgb = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) { rgb[0] += d[i]; rgb[1] += d[i + 1]; rgb[2] += d[i + 2]; }
        rgb = rgb.map((v) => Math.round(v / 16));
      } catch { rgb = null; }
    }
    let hue;
    let sat;
    let lig;
    if (rgb) {
      const [r, g, b] = rgb.map((v) => v / 255);
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      lig = (mx + mn) / 2;
      const d = mx - mn;
      sat = d === 0 ? 0 : d / (1 - Math.abs(2 * lig - 1));
      hue = d === 0 ? 0 : mx === r ? ((g - b) / d + (g < b ? 6 : 0)) * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
      sat = sat < 0.08 ? sat : Math.min(0.7, sat * 1.12 + 0.03); // a little richer, if it has any colour at all
    } else {
      let hsh = 0;
      for (const ch of `${book.title || ''}${book.filename || book.path || ''}`) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
      hue = hsh % 360;
      sat = 0.32;
      lig = 0.3;
    }
    lig = Math.min(0.4, Math.max(0.2, lig)); // cloth is never white and never black
    return `hsl(${Math.round(hue)} ${Math.round(sat * 100)}% ${Math.round(lig * 100)}%)`;
  }

  /** Fits the book to the window: as tall as it can be, in the shape of the book's pages, two pages wide with room for the stacks. */
  function fit() {
    const m = MARGIN;
    const room = Math.min(window.innerHeight * 0.88 - 62, 1100) * scale;
    ph = Math.round(Math.min(room, window.innerHeight * 0.96 - 62) - 2 * m - 6);
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
    if (!px) px = Math.min(1400, Math.max(320, Math.ceil(((window.innerHeight * 0.96 - 62 - 2 * m - 6) * ar * dpr) / 40) * 40)); // pictures are asked for at the biggest size the book can be shown, so resizing never blurs them
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
  async function setPlace() {
    const page = pos === 0 ? 1 : rightPage();
    try {
      await api.put(`/books/${book.id}/progress`, { page, pos: 0 });
    } catch {
      placeBtn.title = 'Could not save your place';
      return;
    }
    book.progress = { ...book.progress, page, pos: 0, at: Date.now() };
    placed = true;
    placeBtn.replaceChildren(icon('check', 14));
    placeBtn.title = `Your place is now page ${page}`;
    setTimeout(() => { placeBtn.replaceChildren(icon('bookmark', 14)); ui(); }, 1600);
  }
  function ui() {
    placeBtn.title = pos === 0 ? 'Set page 1 as my reading progress' : `Set page ${rightPage()} as my reading progress`;
    const l = leftOf(pos);
    const r = rightOf(pos);
    const text = pos === 0 || typeof l !== 'number' ? '1' : typeof r !== 'number' ? String(l) : `${l}\u2013${r}`;
    jump.value = text;
    jump.style.width = `${text.length + 1.2}ch`;
  }
  jump.addEventListener('focus', () => jump.select());
  jump.addEventListener('blur', () => ui());
  jump.addEventListener('keydown', (e) => {
    e.stopPropagation(); // typing a number is not a shortcut
    if (e.key === 'Enter') {
      const n = Number(/\d+/.exec(jump.value)?.[0]);
      if (n) goPage(n);
      jump.blur();
    } else if (e.key === 'Escape') {
      jump.blur();
    }
  });

  /** One turn: a leaf, hinged at the spine, swings across. It has a page on each side: going forward the leaf is the right page of the spread you
   *  leave and the left page of the next one; going back it is the other way round. Under it the new page appears. */
  async function turn(from, to, ms) {
    const forward = to > from;
    const front = forward ? rightOf(from) : rightOf(to); // the leaf's page on the right-hand side, flat at the start when going forward
    const back = forward ? leftOf(to) : leftOf(from); // its page on the left-hand side
    const cover = front === 0;
    const f = h('div', { class: `flip-face f rp${cover ? ' cover' : ''}` });
    const b = h('div', { class: `flip-face b lp${cover && back === 'end' ? ' cover' : ''}` }); // when the cover is carried over onto pages further in, its back is a page
    await Promise.all([fill(front, f), fill(back, b), forward ? fill(rightOf(to), halfR) : fill(leftOf(to), halfL)]);
    if (!pane.isConnected) return;
    // The cover's edges on the left come and go with the cover itself, not after it: they follow how far round the leaf is.
    const edges = from === 0 || to === 0;
    const draw = (at) => {
      const turned = swing(f, b, forward, at);
      pane.style.setProperty('--cast', castOf(turned).toFixed(3));
      if (edges) {
        const k = Math.min(1, Math.max(0, ((to === 0 ? 1 - at : at) - 0.25) / 0.6));
        pane.style.setProperty('--land', (k * k * (3 - 2 * k)).toFixed(3));
      }
    };
    draw(0); // the starting pose, before anything is on the page
    pane.append(f, b);
    pane.classList.add('turning');
    layout(to, ms);
    await sweep(ms, draw);
    // the leaf has landed: the side it covered takes the picture it was showing
    await Promise.all([fill(leftOf(to), halfL), fill(rightOf(to), halfR)]);
    f.remove();
    b.remove();
    pane.classList.remove('turning');
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      while (pos !== target && pane.isConnected) {
        const goal = target;
        const gap = Math.abs(goal - pos);
        if (gap <= 3 && pos !== 0 && goal !== 0) {
          // a few spreads: leaves one after another (a single one is slow and calm, a run of them quick)
          const next = pos + Math.sign(goal - pos);
          await turn(pos, next, turnMs(next === goal && gap <= 1 ? 620 : 260));
          pos = next;
        } else {
          // the cover, or a long way: one sweep from here to there. The cover carries the pages on with it, so a book opens straight onto the page you were at.
          await turn(pos, goal, turnMs(pos === 0 || goal === 0 ? 760 : 560));
          pos = goal;
        }
        ui();
      }
    } finally {
      running = false;
    }
    if (notes && pane.isConnected && pos > 0 && !leaving) { notes.attachText(halfL); notes.attachText(halfR); } // at rest: the words can be selected
    for (const s of [pos + 1, pos + 2, pos - 1]) { load(leftOf(s)); load(rightOf(s)); } // the pages most likely next
  }
  const goSpread = (s) => {
    if (leaving) return;
    notes?.dismiss();
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
  layer.addEventListener('pointerdown', (e) => { touch = { x: e.clientX, y: e.clientY, inside: stage.contains(e.target) || !!e.target.closest?.('.fa-pop'), keep: bar.contains(e.target) || !!e.target.closest?.('.fa-pop'), text: e.pointerType === 'mouse' && !!e.target.closest?.('.fa-text') }; swiped = false; });
  layer.addEventListener('pointercancel', () => { touch = null; });
  layer.addEventListener('pointerup', (e) => {
    const t = touch;
    touch = null;
    if (!t || t.keep) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (Math.hypot(dx, dy) > 12) swiped = true; // a drag is not a tap, in any direction
    if (t.text) return; // a mouse dragged along the text is selecting it
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.4) {
      goSpread(target + (dx < 0 ? 1 : -1)); // the finger moves toward the spine, like turning a right-hand page: forward
    } else if (!t.inside && Math.hypot(dx, dy) < 12) {
      close(true);
    }
  });
  let tapTimer = 0;
  pane.addEventListener('click', (e) => {
    if (swiped) { swiped = false; return; } // the end of a swipe is not also a tap
    if (e.target.closest('.fa-pin') || notes?.justClosed()) return;
    if (notes?.clickAt(e)) return; // on a highlight: its note, not a page turn
    const r = pane.getBoundingClientRect();
    const dir = e.clientX - r.left < r.width / 2 && !pane.classList.contains('closed') ? -1 : 1; // the left page turns back, the right forward
    clearTimeout(tapTimer);
    if (e.target.closest('.fa-text')) {
      // a tap on the words turns the page too, but not when it is the start of a double or triple click selecting them
      tapTimer = setTimeout(() => { const sel = getSelection(); if (!sel || sel.isCollapsed) goSpread(target + dir); }, 300);
    } else goSpread(target + dir);
  });
  pane.addEventListener('dblclick', () => clearTimeout(tapTimer));

  // Resizing: drag the grip at the end of the bar (the book grows and shrinks about its middle), or press + and -; 0 or a double-click goes back to the usual size.
  const setScale = (v, save) => {
    scale = Math.min(SCALE.max, Math.max(SCALE.min, v));
    fit();
    if (save) setSetting('flipScale', Math.round(scale * 100));
  };
  const grip = bar.querySelector('.flip-grip');
  let sizing = null;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    sizing = { x: e.clientX, y: e.clientY, s: scale, w: pane.offsetWidth, h: pane.offsetHeight };
  });
  grip.addEventListener('pointermove', (e) => {
    if (!sizing) return;
    const sy = (sizing.h + 2 * (e.clientY - sizing.y)) / sizing.h;
    const sx = (sizing.w + 2 * (e.clientX - sizing.x)) / sizing.w;
    setScale(sizing.s * ((sx + sy) / 2), false);
  });
  const endSizing = () => { if (sizing) { sizing = null; setScale(scale, true); } };
  grip.addEventListener('pointerup', endSizing);
  grip.addEventListener('pointercancel', endSizing);
  grip.addEventListener('dblclick', () => setScale(1, true));

  const onKey = (e) => {
    if (!pane.isConnected) return close(false);
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target === jump || e.target instanceof HTMLTextAreaElement) return; // the page box and a note being written handle their own keys
    const k = e.key;
    let handled = true;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') goSpread(target + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') goSpread(target - 1);
    else if (k === 'Home') goSpread(1);
    else if (k === 'End') goSpread(lastSpread);
    else if (k === 'Enter' && !(e.target instanceof HTMLButtonElement)) toReader();
    else if (k === 'Escape') { if (!notes?.consumeEscape()) close(true); }
    else if (k === 'h' || k === 'H') handled = !!notes?.highlightSelection();
    else if (k === '+' || k === '=') setScale(scale * 1.08, true);
    else if (k === '-' || k === '_') setScale(scale / 1.08, true);
    else if (k === '0') setScale(1, true);
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
    notes?.destroy();
    layer.remove();
    if (placed) saved?.(); // the card's ribbon and bar now show the new place
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
