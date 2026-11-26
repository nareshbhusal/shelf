import { castOf, swing, sweep, turnMs, reduceMotion } from './leaf.js';
import { MARGIN, bulkOf, edgesOf, makeDecor, placeDecor } from './bookdecor.js';

// The reader's "flip" mode, for the two-pages-side-by-side layout. Two things:
//
// 1. The book. At rest, every spread of two pages (and the lone cover) is drawn as the flip-through viewer draws its book: the cloth board under the pages, the stacks of
//    paper beside them (thicker on the side you have still to read) and the bottom edge of the block. The pieces and where they go are bookdecor.js, shared with the viewer.
//    They sit in each row of the reader, behind the pages.
// 2. The turn. A leaf, hinged at the spine, swings over the spread exactly as in the viewer (leaf.js is shared too). The reader's own pages stay where they are underneath;
//    a small overlay holds only what moves: the leaf and the page it uncovers, while the stacks change thickness in the row itself. Opening and closing the cover is the
//    viewer's own: the cover is the leaf, the whole book slides and changes size as it opens, and the overlay then draws the whole book (cloth, stacks, the cover's back).
//    The pictures on the overlay are the server's page pictures (the ones the viewer uses), so they can be there before the reader has drawn those pages.
// When the leaf has landed the reader jumps (unseen) to the new spread and the overlay goes. Anything it can't do well (right-to-left, a lone page that is not the cover,
// a page that won't load in time) is left to the normal slide, which the caller falls back to.

/** Where the picture of a page really is inside its element (a comic page is fitted into half the window, tucked toward the spine). */
function pictureRect(el, like) {
  const r = el.getBoundingClientRect();
  // a comic page that is not drawn yet (the next spread, off screen) has the shape of the picture the server sent for it
  const nw = el.naturalWidth || like?.naturalWidth;
  const nh = el.naturalHeight || like?.naturalHeight;
  if (el.tagName !== 'IMG' || !nw) return r;
  const k = Math.min(r.width / nw, r.height / nh);
  const w = nw * k;
  const hh = nh * k;
  const [px, py] = getComputedStyle(el).objectPosition.split(' ').map((v) => (parseFloat(v) / 100));
  return { left: r.left + (r.width - w) * (Number.isFinite(px) ? px : 0.5), top: r.top + (r.height - hh) * (Number.isFinite(py) ? py : 0.5), width: w, height: hh };
}
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * @param {{ root: HTMLElement, pagesEl: HTMLElement, scroller: HTMLElement, peekUrl: (pageEl: HTMLElement, width: number) => string | null,
 *   total: () => number, bound: () => boolean, cloth: () => string }} o
 */
export function createReaderFlip({ root, pagesEl, scroller, peekUrl, total, bound, cloth }) {
  const rows = () => [...pagesEl.querySelectorAll(':scope > .spread')];
  const pagesOf = (row) => [...(row?.children ?? [])].filter((c) => c.dataset?.page);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  // the browser paints a page's box on whole device pixels; a box placed by a script at a fraction of one is drawn blurred and a hair off, which shows as a lift
  const snap = (v) => Math.round(v * dpr) / dpr;
  const box = (left, top, width, height) => { const L = snap(left); const T = snap(top); return { left: L, top: T, width: snap(left + width) - L, height: snap(top + height) - T }; };
  const widthFor = (rect) => Math.min(1400, Math.max(320, Math.round(rect.width * dpr))); // as many pixels as it will be shown at, so it is not scaled again

  // ------------------------------------------------------------------ the book at rest
  /**
   * Where the book is in a row, as the viewer lays it out (viewport coordinates): `spine` and the page size, the thickness of the stacks, the bottom edge. The lone cover
   * is drawn like the viewer's closed book, whose cover overhangs the board by MARGIN on three sides; a lone page elsewhere (the last) and a double-width page are not a book here.
   */
  function geomOf(row, like) {
    const t = total();
    if (!row || !t || row.classList.contains('wide')) return null;
    const bulk = bulkOf(t);
    const pg = pagesOf(row);
    if (pg.length === 2) {
      const a = pictureRect(pg[0], like?.get(pg[0]));
      const b = pictureRect(pg[1], like?.get(pg[1]));
      if (a.width < 40 || b.width < 40) return null;
      const top = Math.min(a.top, b.top);
      const bottom = Math.max(a.top + a.height, b.top + b.height);
      const pw = a.width;
      return { closed: false, spine: b.left, top, pw, pr: b.width, ph: bottom - top, ...edgesOf({ pw: (a.width + b.width) / 2, total: t, bulk, leftN: Number(pg[0].dataset.page) || 1 }) };
    }
    if (pg.length === 1 && row.classList.contains('lone') && Number(pg[0].dataset.page) === 1) {
      const c = pictureRect(pg[0], like?.get(pg[0]));
      if (c.width < 40 || c.height < 40) return null;
      const pw = c.width - MARGIN;
      return { closed: true, spine: c.left, top: c.top + MARGIN, pw, pr: pw, ph: c.height - 2 * MARGIN, cover: c, ...edgesOf({ pw, total: t, bulk, leftN: 0 }) };
    }
    return null;
  }

  const held = new WeakMap(); // row -> { el, d }
  /** Draws the book into a row (or takes it away, with g = null). */
  function paint(row, g) {
    let hd = held.get(row);
    if (!g || !bound()) {
      if (hd) { hd.el.remove(); held.delete(row); }
      row.style.removeProperty('--cl');
      row.style.removeProperty('--pt');
      row.style.removeProperty('--ph');
      return;
    }
    if (!hd) {
      const d = makeDecor();
      const el = document.createElement('i'); // not a div or an img, so the pages are still the first and last of their kind in the row
      el.className = 'rbook';
      el.setAttribute('aria-hidden', 'true');
      el.append(...d.all);
      row.prepend(el);
      hd = { el, d };
      held.set(row, hd);
    }
    const r = row.getBoundingClientRect();
    // placed where the layout says, unrounded: the browser then rounds it as it rounds the pages next to it
    Object.assign(hd.el.style, { left: `${g.spine - g.pw - r.left}px`, top: `${g.top - r.top}px`, width: `${g.pw + g.pr}px`, height: `${g.ph}px` });
    hd.el.style.setProperty('--board', cloth());
    hd.el.classList.toggle('closed', g.closed);
    hd.g = g;
    placeDecor(hd.d, { pw: g.pw, L: g.L, R: g.R, tail: g.tail });
    if (g.closed) { // the lone cover: a hinge shading along its left edge, as on the viewer's cover (drawn by CSS from these)
      row.style.setProperty('--cl', `${g.cover.left - r.left}px`);
      row.style.setProperty('--ct', `${g.cover.top - r.top}px`);
      row.style.setProperty('--ch', `${g.cover.height}px`);
      row.style.setProperty('--cw', `${g.cover.width}px`);
    } else row.style.removeProperty('--cl');
    // the crease down the middle of a spread runs as far as the pages do, not the whole row (which is taller than the book: it would cross the cloth and reach the desk)
    if (!g.closed) { row.style.setProperty('--pt', `${g.top - r.top}px`); row.style.setProperty('--ph', `${g.ph}px`); }
    else { row.style.removeProperty('--pt'); row.style.removeProperty('--ph'); }
  }
  let near = [0, 0];
  let timer = 0;
  /** Draws the book into the rows that are on or next to the screen (all of them would be a lot to measure for a long book). `i` is the slot you are at. */
  function decorate(i = near[0], span = 3) {
    near = [i, span];
    cancelAnimationFrame(timer);
    const rs = rows();
    for (let j = 0; j < rs.length; j++) {
      if (Math.abs(j - i) <= span) paint(rs[j], bound() ? geomOf(rs[j]) : null);
      else if (held.has(rs[j]) || !bound()) paint(rs[j], null);
    }
  }
  const later = () => { cancelAnimationFrame(timer); timer = requestAnimationFrame(() => decorate()); };
  // pictures arriving change where a comic page's picture really is
  pagesEl.addEventListener('load', later, true);
  const mo = new MutationObserver(() => { if (bound()) later(); });
  mo.observe(pagesEl, { childList: true });

  // ------------------------------------------------------------------ the turn
  const pics = new Map();
  const load = (url) => {
    let p = pics.get(url);
    if (!p) {
      const img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      img.src = url;
      p = img.decode().then(() => img, () => null);
      pics.set(url, p);
      if (pics.size > 16) pics.delete(pics.keys().next().value);
    }
    return p;
  };
  const urlOf = (el) => peekUrl(el, widthFor(pictureRect(el)));
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

  /** Asks for the pictures of the pages around a spread in advance, so the first turn isn't kept waiting. */
  function warm(i, count) {
    const rs = rows();
    if (rs.length !== count) return;
    for (const j of [i, i + 1, i - 1]) for (const el of pagesOf(rs[j])) { const u = urlOf(el); if (u) load(u); }
  }

  const ready = (el) => (el.tagName === 'IMG' ? el.complete && el.naturalWidth > 0 : !!el.querySelector('canvas'));

  let busy = false;
  /**
   * Turns from slot `from` to slot `to`. `land()` moves the reader to the new slot, instantly. Resolves true once it has turned, or false at once if it can't (nothing
   * was changed then, and the caller slides instead).
   *
   * Two kinds of turn. Between two spreads the hinge (the spine) stays put and the leaf swings over it. Between the cover, which stands alone in the middle of the window,
   * and the first spread, the cover is the leaf: it is hinged at its own left edge and the whole book slides across as it turns, so the hinge ends up in the middle,
   * exactly as the flip-through viewer opens its cover. Its back is then the first page of the spread (the next one is the page it uncovers). In reverse it closes onto the lone cover.
   */
  async function turn(from, to, count, land) {
    if (busy || reduceMotion()) return false;
    const rs = rows();
    if (rs.length !== count) return false; // another layout (several parts, scrolling): not here
    const rowA = rs[from];
    const rowB = rs[to];
    const pa = pagesOf(rowA);
    const pb = pagesOf(rowB);
    const loneA = rowA.classList.contains('lone');
    const loneB = rowB.classList.contains('lone');
    if (rowA.classList.contains('wide') || rowB.classList.contains('wide')) return false;
    let kind = 'pair'; // pair -> pair
    if (loneA || loneB) {
      if (from === 0 && loneA && !loneB && pa.length === 1 && pb.length === 2) kind = 'open';
      else if (to === 0 && loneB && !loneA && pb.length === 1 && pa.length === 2) kind = 'close';
      else return false; // a lone page elsewhere (the last one): slide
    } else if (pa.length !== 2 || pb.length !== 2) return false;
    const forward = to > from;
    const area = scroller.getBoundingClientRect();
    const mid = area.left + area.width / 2;
    const withBook = bound();

    // who is who: the leaf's page on the right at the start (frontEl), its page on the left at the end (backEl), the page it uncovers (underEl), a page that simply stays (restEl)
    let frontEl, backEl, underEl = null, restEl = null;
    let LL, RR; // where a left and a right page are, as pictures, around the hinge (RR is just right of it)
    let spine = mid;
    let g0 = null; // the book's own geometry at the start and at the end of a cover turn (see geomOf)
    let g1 = null;
    if (kind === 'pair') {
      const [oL, oR] = pa;
      const [nL, nR] = pb;
      LL = pictureRect(oL);
      RR = pictureRect(oR);
      spine = oR.getBoundingClientRect().left;
      frontEl = forward ? oR : nR;
      backEl = forward ? nL : oL;
      underEl = forward ? nR : nL;
      if (RR.right < area.left || RR.left > area.right || LL.width < 40 || RR.width < 40) return false;
    } else {
      const cover = kind === 'open' ? pa[0] : pb[0];
      const [pL, pR] = kind === 'open' ? pb : pa;
      const cr = pictureRect(cover);
      if (cr.width < 40) return false;
      // the lone cover is fitted to the window on its own, so it is a little bigger than a page of a pair: the whole book changes size, smoothly, as it opens
      RR = { left: spine, top: cr.top, width: cr.width, height: cr.height };
      LL = RR;
      frontEl = cover;
      backEl = pL;
      if (kind === 'open') underEl = pR;
      else restEl = pR;
    }
    const w = RR.width;

    busy = true;
    try {
      const wanted = [frontEl, backEl, underEl, restEl].filter(Boolean);
      const urls = wanted.map(urlOf);
      if (urls.some((u) => !u)) return false;
      const got = await within(Promise.all(urls.map(load)), 400);
      if (!got || got.some((g) => !g)) return false;
      const img = new Map(wanted.map((el, k) => [el, got[k]]));
      if (kind !== 'pair') {
        // the other row is a window's width away in the strip: seen from where this one is, it will be where this one is once the reader has moved
        const away = (g, row) => (g ? { ...g, spine: g.spine + rowA.getBoundingClientRect().left - row.getBoundingClientRect().left } : g);
        const gc = away(geomOf(kind === 'open' ? rowA : rowB, img), kind === 'open' ? rowA : rowB);
        const gp = away(geomOf(kind === 'open' ? rowB : rowA, img), kind === 'open' ? rowB : rowA);
        [g0, g1] = kind === 'open' ? [gc, gp] : [gp, gc];
        if (!g0 || !g1) return false;
      }
      const pane = document.createElement('div');
      pane.className = 'rflip';
      // for finding what draws a stray line in one browser: localStorage.setItem('shelf.flipdebug', 'hair crease shade') in the console, then turn a page; each word switches that layer off
      try { for (const k of (localStorage.getItem('shelf.flipdebug') || '').split(/\s+/).filter(Boolean)) pane.classList.add(`no-${k}`); } catch { /* no storage */ }
      Object.assign(pane.style, { left: `${snap(area.left)}px`, top: `${snap(area.top)}px`, width: `${snap(area.width)}px`, height: `${snap(area.height)}px` });
      pane.style.setProperty('--cw', `${Math.min(23, Math.max(10, area.width * 0.022))}px`); // the reader's crease is 4.4% of the window wide, split between the two pages
      // the hairline of the crease, placed and drawn as the reader draws its own (same width rule, same centre), so it stays on the same pixel when the turn ends
      const hair = Object.assign(document.createElement('div'), { className: 'rhair' });
      // as wide as the reader's own crease box (a hairline drawn in a box of another width falls on other pixels)
      let hw = Math.min(46, Math.max(20, area.width * 0.044));
      try { const sp = rowA.matches('.spread') ? rowA : rowA.querySelector('.spread'); const w2 = sp && parseFloat(getComputedStyle(sp, '::after').width); if (w2 > 0) hw = w2; } catch { /* the formula will do */ }
      hair.style.setProperty('--hw', `${hw}px`);
      // The hairline stays at exactly the spot of the reader's own (x, top, height are window coordinates), whatever the pane's own offset is at that moment: while the turn
      // runs the pane sits on whole device pixels, once it has landed on the reader's own (unrounded) place. Measured from the pane's left and top it would be off by the
      // rounding (up to half a pixel), which Chrome smooths over but Firefox draws as a line that is a pixel to the side, or twice as thick, until the turn ends.
      let paneL = snap(area.left);
      let paneT = snap(area.top);
      let hairLast = null;
      const hairAt = (x, top, height) => { hairLast = [x, top, height]; Object.assign(hair.style, { left: `${x - paneL}px`, top: `${top - paneT}px`, height: `${height}px` }); };
      const hairSettle = () => { paneL = area.left; paneT = area.top; if (hairLast) hairAt(...hairLast); };
      const pic = (el, side) => {
        const c = img.get(el).cloneNode();
        c.style.objectFit = 'contain';
        c.style.objectPosition = side === 'r' ? 'left center' : 'right center';
        return c;
      };

      let draw;
      let settle = () => {};
      let hide = null;
      if (kind === 'pair') {
        pane.style.perspective = `${Math.round(w * 4.5)}px`;
        const part = (cls, el, rc, side) => {
          const e = Object.assign(document.createElement('div'), { className: cls });
          const bx = box(rc.left, rc.top, rc.width, rc.height);
          Object.assign(e.style, { left: `${bx.left - area.left}px`, top: `${bx.top - area.top}px`, width: `${bx.width}px`, height: `${bx.height}px`, bottom: 'auto', transformOrigin: `${spine - rc.left}px 50%` });
          e.append(pic(el, side));
          return e;
        };
        const under = part(`flip-pg ${forward ? 'rp' : 'lp'}`, underEl, forward ? RR : LL, forward ? 'r' : 'l');
        const f = part('flip-face f rp', frontEl, RR, 'r');
        const b = part('flip-face b lp', backEl, LL, 'l');
        pane.append(under, f, b, hair);
        hairAt(mid, Math.min(LL.top, RR.top), Math.max(LL.top + LL.height, RR.top + RR.height) - Math.min(LL.top, RR.top));
        // the stacks follow the leaf: the paper moves from one side to the other as it turns (they live in the row, behind the pages)
        const ga = withBook ? geomOf(rowA, img) : null;
        const gb = withBook ? geomOf(rowB, img) : null;
        const hd = ga && gb ? held.get(rowA) : null;
        // when it has landed everything flat is put exactly where the reader's own page is (unrounded, no transform): the browser then rounds it just as it rounds that page,
        // whichever browser it is, so the page does not shift by a pixel when the overlay goes
        settle = () => {
          Object.assign(pane.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
          hairSettle();
          const put = (e, rc) => Object.assign(e.style, { left: `${rc.left - area.left}px`, top: `${rc.top - area.top}px`, width: `${rc.width}px`, height: `${rc.height}px` });
          put(under, forward ? RR : LL);
          const landed = forward ? b : f;
          put(landed, forward ? LL : RR);
          landed.style.transform = 'none';
          landed.style.willChange = 'auto';
          (forward ? f : b).style.visibility = 'hidden';
        };
        draw = (at) => {
          const turned = swing(f, b, forward, at);
          pane.style.setProperty('--cast', castOf(turned).toFixed(3));
          if (hd) placeDecor(hd.d, { pw: ga.pw, L: lerp(ga.L, gb.L, at), R: lerp(ga.R, gb.R, at), tail: lerp(ga.tail, gb.tail, at) });
        };
      } else {
        // the book itself, drawn the way the viewer draws it: a pane two pages wide, the board and stacks on it, the pages, and the leaf
        const bk = document.createElement('div');
        bk.className = 'flip rbk closed';
        bk.style.setProperty('--board', cloth());
        bk.style.setProperty('--land', '0'); // the left half is the cover's back (hard.b), until the reader has the real one
        bk.style.setProperty('--cast', '0');
        const decor = makeDecor();
        const side = Object.assign(document.createElement('div'), { className: `flip-pg rp` });
        const gP = kind === 'open' ? g1 : g0; // the spread's, for the cover's back
        const f = Object.assign(document.createElement('div'), { className: 'flip-face f rp hard is-cover' });
        const b = Object.assign(document.createElement('div'), { className: 'flip-face b lp hard' });
        b.style.setProperty('--L', `${gP.L}px`);
        b.style.setProperty('--tail', `${gP.tail}px`);
        side.append(pic(kind === 'open' ? underEl : restEl, 'r'));
        f.append(pic(frontEl, 'r'));
        b.append(pic(backEl, 'l'));
        bk.append(...decor.all, side, f, b);
        pane.append(bk, hair);
        settle = () => {
          Object.assign(pane.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px` });
          hairSettle();
          Object.assign(bk.style, { left: `${g1.spine - g1.pw - area.left}px`, top: `${g1.top - area.top}px`, width: `${g1.pw + g1.pr}px`, height: `${g1.ph}px` });
          placeDecor(decor, { pw: g1.pw, L: g1.L, R: g1.R, tail: g1.tail });
          const landed = forward ? b : f;
          landed.style.transform = 'none';
          landed.style.willChange = 'auto';
          (forward ? f : b).style.visibility = 'hidden';
        };
        draw = (at) => {
          const k = { spine: lerp(g0.spine, g1.spine, at), top: lerp(g0.top, g1.top, at), pw: lerp(g0.pw, g1.pw, at), ph: lerp(g0.ph, g1.ph, at), L: lerp(g0.L, g1.L, at), R: lerp(g0.R, g1.R, at), tail: lerp(g0.tail, g1.tail, at) };
          const pw = snap(k.pw);
          const bx = box(k.spine - pw, k.top, 2 * pw, k.ph);
          Object.assign(bk.style, { left: `${bx.left - area.left}px`, top: `${bx.top - area.top}px`, width: `${bx.width}px`, height: `${bx.height}px`, perspective: `${Math.round(pw * 4.5)}px` });
          placeDecor(decor, { pw, L: k.L, R: k.R, tail: k.tail });
          hairAt(kind === 'open' ? lerp(g0.spine, mid, at) : lerp(mid, g1.spine, at), bx.top, bx.height);
          const turned = swing(f, b, forward, at);
          pane.style.setProperty('--cast', castOf(turned).toFixed(3));
          pane.style.setProperty('--cr', (forward ? at : 1 - at).toFixed(3)); // a lone cover has no crease; the book makes one as it opens
        };
      }
      draw(0);
      // from here the overlay draws the book alone: the reader's own row for a lone cover or its spread would otherwise show where the book is no longer
      if (kind !== 'pair') hide = rowA;
      if (hide) hide.style.visibility = 'hidden';
      if (kind === 'pair') rowA.classList.add('rflipping'); // its own hairline is left out while the pane draws one (see app.css)
      root.append(pane);
      try {
        await sweep(turnMs(Math.abs(to - from) === 1 ? 620 : 560), draw);
        settle();
        if (withBook) paint(rowB, geomOf(rowB, img)); // the book of the row it lands on is there before it is shown
        land(); // under the leaf's final picture the reader moves to the new spread
      } finally {
        if (hide) hide.style.visibility = '';
        rowA.classList.remove('rflipping');
      }
      const t0 = performance.now();
      while (performance.now() - t0 < 600 && ![...pb].every((el) => ready(el))) await new Promise((r) => setTimeout(r, 40)); // until the reader has drawn them
      pane.remove();
      if (withBook) decorate(to); // the row it left, whose stacks were moved, is put right
      return true;
    } finally {
      busy = false;
    }
  }
  return { turn, warm, decorate, later, get busy() { return busy; }, destroy() { mo.disconnect(); cancelAnimationFrame(timer); pagesEl.removeEventListener('load', later, true); } };
}
