import { castOf, swing, sweep, turnMs, reduceMotion } from './leaf.js';

// The reader's "flip" page turn, for the two-pages-side-by-side layout: a leaf, hinged at the spine, swings over the spread exactly as in the flip-through viewer
// (the leaf, its shading and its timing are leaf.js, shared). The reader's own pages stay where they are underneath; a small overlay holds only what moves: the leaf
// and the page it uncovers. The pictures on it are the server's page pictures (the ones the viewer uses), so they can be there before the reader has drawn those pages.
// When the leaf has landed the reader jumps (unseen) to the new spread and the overlay goes. Anything it can't do well (right-to-left, a lone page such as the
// cover, a page that won't load in time) is left to the normal slide, which the caller falls back to.

/** Where the picture of a page really is inside its element (a comic page is fitted into half the window, tucked toward the spine). */
function pictureRect(el) {
  const r = el.getBoundingClientRect();
  if (el.tagName !== 'IMG' || !el.naturalWidth) return r;
  const k = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
  const w = el.naturalWidth * k;
  const hh = el.naturalHeight * k;
  const [px, py] = getComputedStyle(el).objectPosition.split(' ').map((v) => (parseFloat(v) / 100));
  return { left: r.left + (r.width - w) * (Number.isFinite(px) ? px : 0.5), top: r.top + (r.height - hh) * (Number.isFinite(py) ? py : 0.5), width: w, height: hh };
}

/**
 * @param {{ root: HTMLElement, pagesEl: HTMLElement, scroller: HTMLElement, peekUrl: (pageEl: HTMLElement, width: number) => string | null }} o
 */
export function createReaderFlip({ root, pagesEl, scroller, peekUrl }) {
  const rows = () => [...pagesEl.querySelectorAll(':scope > .spread')];
  const pagesOf = (row) => [...(row?.children ?? [])].filter((c) => c.dataset?.page);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const widthFor = (rect) => Math.min(1400, Math.max(320, Math.ceil((rect.width * dpr) / 40) * 40));

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
   */
  async function turn(from, to, count, land) {
    if (busy || reduceMotion()) return false;
    const rs = rows();
    if (rs.length !== count) return false; // another layout (several parts, scrolling): not here
    const [oL, oR] = pagesOf(rs[from]);
    const [nL, nR] = pagesOf(rs[to]);
    if (pagesOf(rs[from]).length !== 2 || pagesOf(rs[to]).length !== 2 || rs[from].classList.contains('lone') || rs[to].classList.contains('lone')) return false;
    const forward = to > from;
    const LL = pictureRect(oL);
    const RR = pictureRect(oR);
    const area = scroller.getBoundingClientRect();
    if (RR.right < area.left || RR.left > area.right || LL.width < 40 || RR.width < 40) return false;
    const frontEl = forward ? oR : nR; // the leaf's page on the right-hand side at the start
    const backEl = forward ? nL : oL; // its page on the left-hand side at the end
    const underEl = forward ? nR : nL; // the page the leaf uncovers
    busy = true;
    try {
      const urls = [frontEl, backEl, underEl].map(urlOf);
      if (urls.some((u) => !u)) return false;
      const [fi, bi, ui] = await within(Promise.all(urls.map(load)), 400);
      if (!fi || !bi || !ui) return false;
      const spine = oR.getBoundingClientRect().left;
      const pane = document.createElement('div');
      pane.className = 'rflip';
      Object.assign(pane.style, { left: `${area.left}px`, top: `${area.top}px`, width: `${area.width}px`, height: `${area.height}px`, perspective: `${Math.round(RR.width * 4.5)}px` });
      const place = (el, rect, originX) => {
        Object.assign(el.style, { left: `${rect.left - area.left}px`, top: `${rect.top - area.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, bottom: 'auto', transformOrigin: `${originX}px 50%` });
        return el;
      };
      const pic = (img) => { const c = img.cloneNode(); c.style.objectFit = 'fill'; return c; };
      const under = place(Object.assign(document.createElement('div'), { className: `flip-pg ${forward ? 'rp' : 'lp'}` }), forward ? RR : LL, 0);
      under.append(pic(ui));
      const f = place(Object.assign(document.createElement('div'), { className: 'flip-face f' }), RR, spine - RR.left);
      const b = place(Object.assign(document.createElement('div'), { className: 'flip-face b' }), LL, spine - LL.left);
      f.append(pic(fi));
      b.append(pic(bi));
      pane.append(under, f, b);
      const draw = (at) => {
        const turned = swing(f, b, forward, at);
        pane.style.setProperty('--cast', castOf(turned).toFixed(3));
      };
      draw(0);
      root.append(pane);
      await sweep(turnMs(Math.abs(to - from) === 1 ? 620 : 560), draw);
      land(); // under the leaf's final picture the reader moves to the new spread
      const t0 = performance.now();
      while (performance.now() - t0 < 600 && ![nL, nR].every((el) => ready(el))) await new Promise((r) => setTimeout(r, 40)); // until the reader has drawn them
      pane.remove();
      return true;
    } finally {
      busy = false;
    }
  }
  return { turn, warm, get busy() { return busy; } };
}
