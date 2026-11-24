import { api, coverUrl } from './api.js';
import { h, icon } from './util.js';
import { setSetting, settings } from './settings.js';
import { castOf, swing, sweep, turnMs } from './leaf.js';
import { MARGIN, bulkOf, clothOf, edgesOf, makeDecor, placeDecor } from './bookdecor.js';
import { createFlipNotes } from './flipnotes.js';
import { createBookmarks } from './bookmarks.js';

// Flipping through a book from its card, without opening the reader. The book lifts out of the shelf into a larger one in front of it (the
// card stays where it is): a closed book whose cover swings open to a two-page spread, with the pages read on the left and the pages still
// to read on the right, both as stacks of paper whose thickness follows how many pages each side holds. Pages turn as double-sided leaves
// hinged at the spine. The pages are pictures the server draws on request (PDF and comic files; an EPUB is laid out into pages for it, so its page numbers
// are the flip-through's own, not the reader's). Nothing is saved unless you ask: not your place, not the pictures. Open in the reader (Enter, or the button) to carry on from the page you are looking at.

export const canFlip = (book) => (book.format === 'pdf' || book.format === 'cbz' || book.format === 'epub') && !book.isFolder && book.pages > 1;

let active = null; // only one book is open at a time

export function closeFlip(animate = false) {
  active?.close(animate);
}


/**
 * @param {HTMLElement} wrap  the .cover-wrap of the card (where the book lifts from and settles back to)
 * @param {object} book
 * @param {{ open: (page: number, total: number) => void, saved?: () => void }} cb  `saved` is told, once the book has gone back, that you set your place from here
 */
export function openFlip(wrap, book, cb) {
  if (book.format !== 'epub') return openBook(wrap, book, cb);
  // An EPUB's pages exist once the server has laid the book out: ask how many there are before the book opens (it keeps the layout for the turns that follow).
  if (active) active.close(false);
  let stopped = false;
  const waiting = { close() { stopped = true; wrap.classList.remove('flip-wait'); if (active === waiting) active = null; } };
  active = waiting;
  wrap.classList.add('flip-wait');
  api.get(`/books/${book.id}/peek`).then(({ pages }) => {
    if (stopped) return;
    waiting.close();
    // the same book, with the pages it has here (anything the viewer writes to it lands on this copy; setting your place is told to the server instead)
    openBook(wrap, Object.assign(Object.create(book), { pages }), cb);
  }).catch(() => waiting.close());
  return waiting;
}

function openBook(wrap, book, { open, saved }) {
  if (active) active.close(false);
  const total = book.pages;
  const dpr = window.devicePixelRatio || 1;
  const coverImg = wrap.querySelector('img');
  let ar = coverImg?.naturalWidth && coverImg?.naturalHeight ? coverImg.naturalWidth / coverImg.naturalHeight : 0.7; // the shape of one page
  ar = Math.min(1.6, Math.max(0.45, ar));
  const bulk = bulkOf(total); // as on the card: how thick a book this is
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
  const decor = makeDecor();
  const { boardL, boardR, stackL, stackR, tailL, tailR } = decor;
  const pane = h('div', { class: 'flip closed', role: 'group', 'aria-label': 'Flip through this book' }, boardL, boardR, tailL, tailR, stackL, stackR, halfL, halfR);
  // Where you are, as "n / total". n is the page (or the pair of pages) on show; click it, type a page and press Enter to go there.
  const jump = h('input', { class: 'flip-n', type: 'text', inputmode: 'numeric', autocomplete: 'off', spellcheck: false, 'aria-label': 'Page: type a number and press Enter to go there', title: 'Type a page number and press Enter' });
  // Nothing here is saved unless you ask: this stores the page on show as your place in the book (the same progress the reader keeps).
  let placed = false;
  const placeBtn = h('button', { class: 'flip-btn icon', 'aria-label': 'Set this page as my reading progress', onClick: () => setPlace() }, icon('flag', 14));
  // Bookmarks (any number, kept by Shelf): the right-hand page on show, like the place button. An EPUB's are told by how far through the book they are.
  const pageNow = () => (pos === 0 ? 1 : rightPage());
  const isEpub = book.format === 'epub';
  const epubPage = (m) => Math.max(1, Math.min(total, Math.round((m.frac ?? 0) * total) + 1));
  const marks = createBookmarks({
    host: () => layer,
    bookId: () => book.id,
    className: 'flip-btn icon',
    size: 14,
    below: false,
    dark: true,
    place: () => (isEpub ? { frac: (pageNow() - 1) / total } : { page: pageNow(), pos: 0 }),
    same: (m, p) => (isEpub ? m.frac != null && Math.abs(m.frac - p.frac) < 0.5 / total : m.page === p.page),
    describe: (m) => `Page ${isEpub ? epubPage(m) : m.page}`,
    jump: (m) => goPage(isEpub ? epubPage(m) : m.page),
  });
  const bar = h(
    'div',
    { class: 'flip-bar' },
    h('span', { class: 'flip-sp' }),
    jump,
    h('span', { class: 'flip-tot' }, `/ ${total}`),
    marks.button,
    placeBtn,
    h('button', { class: 'flip-btn icon', title: 'Open in the reader at this page (Enter)', 'aria-label': 'Open in the reader', onClick: () => toReader() }, icon('arrow-up-right', 14)),
    h('button', { class: 'flip-btn icon', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => close(true) }, icon('x', 14)),
    h('span', { class: 'flip-grip', title: 'Drag to resize (double-click to reset; or + and \u2212 keys)', role: 'separator', 'aria-label': 'Resize' }),
  );
  const stage = h('div', { class: 'flip-stage' }, pane, bar);
  const layer = h('div', { class: 'flip-layer' }, stage);
  layer.style.setProperty('--dim', String(Math.min(95, Math.max(0, Number(settings.flipDim ?? 66))) / 100)); // how dark the shelf behind goes (Settings)
  pane.style.setProperty('--board', clothColour());
  pane.style.setProperty('--land', '0'); // whether the left half of the book (board, edge, pages read) is there itself: not while the book is shut, nor while a cover turns
  pane.style.setProperty('--cast', '0'); // how dark the crease and the landing page are: nothing at rest, most while a leaf stands upright
  document.body.append(layer);
  const notes = book.format === 'pdf' ? createFlipNotes({ book, pane, layer }) : null; // (hoisted use above is only inside functions, which run later)

  function clothColour() {
    return clothOf(book, { spineText: wrap.closest('.book-stage')?.style.getPropertyValue('--spine'), coverImg });
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

  /** How thick the paper is on each side of a spread, and the bottom edge of the block. */
  function edgesAt(s) {
    return edgesOf({ pw, total, bulk, leftN: s <= 0 ? 0 : Math.min(total, 2 * (s - 1)) });
  }
  /** Where the board, the paper stacks and the book itself sit for a spread (the book slides so the closed cover is centred). */
  function layout(s, ms) {
    const closed = s <= 0;
    const { L, R, tail: tailH } = edgesAt(s);
    pane.style.setProperty('--ms', `${ms}ms`);
    pane.classList.toggle('closed', closed);
    pane.style.transform = closed ? `translateX(${-Math.round(pw / 2)}px)` : 'none';
    // The right half of the board is the book's own; the left half is the cover once it has landed, so it is not there (and does not slide in) before that.
    placeDecor(decor, { pw, L, R, tail: tailH });
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
    open(page, total);
  }
  async function setPlace() {
    const page = pos === 0 ? 1 : rightPage();
    try {
      // an EPUB is told how far through the book this page is (the reader finds the section and spot); the others, the page
      const saved = await api.put(`/books/${book.id}/progress`, book.format === 'epub' ? { frac: (page - 1) / total } : { page, pos: 0 });
      book.progress = { ...book.progress, page: saved.page ?? page, pos: saved.pos ?? 0, frac: saved.frac ?? null, at: Date.now() };
    } catch {
      placeBtn.title = 'Could not save your place';
      return;
    }
    placed = true;
    placeBtn.replaceChildren(icon('check', 14));
    placeBtn.title = `Your place is now page ${page}`;
    setTimeout(() => { placeBtn.replaceChildren(icon('flag', 14)); ui(); }, 1600);
  }
  function ui() {
    placeBtn.title = pos === 0 ? 'Set page 1 as my reading progress' : `Set page ${rightPage()} as my reading progress`;
    const l = leftOf(pos);
    const r = rightOf(pos);
    const text = pos === 0 || typeof l !== 'number' ? '1' : typeof r !== 'number' ? String(l) : `${l}\u2013${r}`;
    marks.refresh();
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
    const cover = front === 0; // the cover is turning (opening or closing, with whatever pages it carries)
    const f = h('div', { class: `flip-face f rp${cover ? ' hard' : ''}` });
    // The cover's back lands on the left as the whole left half of the book: the cloth board, the edge of the pages and the bottom of the block drawn on it as they are
    // on the book itself, so what is there once it has landed is exactly what was turning, with nothing arriving afterwards.
    const b = h('div', { class: `flip-face b lp${cover ? ' hard' : ''}` });
    if (cover) {
      const e = edgesAt(to === 0 ? from : to);
      b.style.setProperty('--L', `${e.L}px`);
      b.style.setProperty('--tail', `${e.tail}px`);
      if (to === 0) pane.style.setProperty('--land', '0'); // closing: the leaf stands in for the left half from the start
    }
    await Promise.all([fill(front, f), fill(back, b), forward ? fill(rightOf(to), halfR) : fill(leftOf(to), halfL)]);
    if (!pane.isConnected) return;
    const draw = (at) => {
      const turned = swing(f, b, forward, at);
      pane.style.setProperty('--cast', castOf(turned).toFixed(3));
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
    if (to > 0) pane.style.setProperty('--land', '1'); // the left half is the book's own again, in the same moment
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
    if (e.target.closest?.('.bm-panel')) return; // the bookmarks list scrolls itself
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
  layer.addEventListener('pointerdown', (e) => { touch = { x: e.clientX, y: e.clientY, inside: stage.contains(e.target) || !!e.target.closest?.('.fa-pop, .bm-panel'), keep: bar.contains(e.target) || !!e.target.closest?.('.fa-pop, .bm-panel'), text: e.pointerType === 'mouse' && !!e.target.closest?.('.fa-text') }; swiped = false; });
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
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return; // the page box, a bookmark's name and a note being written handle their own keys
    const k = e.key;
    let handled = true;
    if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === ' ') goSpread(target + 1);
    else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'Backspace') goSpread(target - 1);
    else if (k === 'Home') goSpread(1);
    else if (k === 'End') goSpread(lastSpread);
    else if (k === 'Enter' && !(e.target instanceof HTMLButtonElement)) toReader();
    else if (k === 'Escape') { if (!marks.consumeEscape() && !notes?.consumeEscape()) close(true); }
    else if (k === 'b' || k === 'B') marks.toggleHere();
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
    marks.destroy();
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
    const sec = book.format === 'epub' ? (book.progress?.at ? Math.round((book.progress.frac ?? 0) * total) : 0) : book.progress?.page; // an EPUB's saved place is a section and a spot: from how far through it is
    const at = sec > 0 && sec <= total ? sec : 1;
    goPage(at);
  });
  return handle;
}
