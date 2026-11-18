import { api } from './api.js';
import { onSettings, setSetting, settings } from './settings.js';
import { toast } from './ui.js';
import { clamp, h, icon } from './util.js';
import { clearMarks, markMatches } from './search.js';

/**
 * EPUB reading, as a continuous vertical scroll like the PDF and comic readers.
 *
 * Every section of the book (a "spine item": usually a chapter) is its own sandboxed iframe that
 * points straight at the book's file on the server, so images, styles and fonts load by their own
 * relative paths. Scripts never run (sandbox without allow-scripts, plus a CSP on the server).
 * Frames are created when they come near the viewport and dropped when far away; each remembers
 * its measured height, so the page doesn't jump. Reading position is (section number, fraction
 * of that section), which is what the shell saves.
 */

const SERIF = '"Literata", Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif';
const SANS = '"Atkinson Hyperlegible Next", system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
// The bundled faces, declared inside each section (a frame doesn't inherit the page's fonts; the book's policy allows 'self').
const FACES = `@font-face { font-family: "Literata"; src: url(/fonts/literata.woff2) format("woff2"); font-weight: 200 900; font-style: normal; }
@font-face { font-family: "Literata"; src: url(/fonts/literata-italic.woff2) format("woff2"); font-weight: 200 900; font-style: italic; }
@font-face { font-family: "Atkinson Hyperlegible Next"; src: url(/fonts/atkinson.woff2) format("woff2"); font-weight: 200 800; font-style: normal; }`;

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Resolve an href found inside section `from` (a zip entry path) to { path, frag }. */
function resolveHref(from, href) {
  const u = new URL(href, `http://epub.local/${encodePath(from)}`);
  const dec = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  return { path: dec(u.pathname.slice(1)), frag: dec(u.hash.slice(1)) };
}

export async function epubImpl(book, { root, scroller, pagesEl, bar, setTotal, report, onKey, onClick, onFind, getMode }) {
  let meta;
  try {
    meta = await api.get(`/books/${book.id}/epub`);
  } catch (e) {
    throw new Error(e.message);
  }
  const N = meta.spine.length;
  setTotal(N, meta.spine.map((s) => s.chars || 1), meta.pages);

  const fileUrl = (p, extra = '') => `/api/books/${book.id}/epub/f/${encodePath(p)}?v=${book.fingerprint}${extra}`;
  const estimate = (it) => (it.kind === 'image' ? 700 : clamp(Math.round(it.size * 0.25), 320, 60000));

  let dead = false;
  let restoring = true; // no position reports until the saved position has been applied
  let colW = 720;

  // Two layouts. Scrolling: the sections are stacked and `sec.h` is a height. Flipping ("paged"): the sections are side by
  // side, each laid out in columns one screen wide, and `sec.h` is its width, a whole number of screens, one per page;
  // the book is then one strip that snaps screen by screen. Everything below is written for either, along `off()`.
  let paged = getMode?.() === 'paged';
  const geo = { vw: 800, vh: 600, W: 720, H: 500, top: 76, bottom: 58, pad: 26 };
  function measureGeo() {
    geo.vw = scroller.clientWidth || 800;
    geo.vh = scroller.clientHeight || 600;
    geo.W = Math.max(220, Math.min(colW, geo.vw - 2 * (geo.pad + 10)));
    geo.H = Math.max(200, geo.vh - geo.top - geo.bottom);
    const st = pagesEl.style;
    st.setProperty('--vw', `${geo.vw}px`);
    st.setProperty('--colw', `${geo.W}px`);
    st.setProperty('--eh', `${geo.H}px`);
    st.setProperty('--et', `${geo.top}px`);
    st.setProperty('--eb', `${geo.bottom}px`);
    st.setProperty('--pad', `${geo.pad}px`);
  }
  measureGeo();
  const pagesIn = (sec) => Math.max(1, Math.round(sec.h / geo.vw));
  const estimateExtent = (it) => (paged ? Math.max(1, Math.round(estimate(it) / geo.H)) * geo.vw : estimate(it));
  const off = () => (paged ? scroller.scrollLeft : scroller.scrollTop);
  const setOff = (v) => {
    if (paged) scroller.scrollLeft = v;
    else scroller.scrollTop = v;
  };

  const secs = meta.spine.map((it, i) => {
    const wrap = h('section', { class: `epub-sec${it.kind === 'image' ? ' img' : ''}`, dataset: { page: i + 1 } });
    const sec = { i, it, wrap, frame: null, img: null, h: estimateExtent(it), k: 1, tried: 0, ready: null, resolve: null };
    return sec;
  });
  /** The section's box takes its extent along the reading direction (and, flipping, one sheet per page). */
  function applyExtent(sec) {
    sec.wrap.style.height = paged ? '' : `${sec.h}px`;
    sec.wrap.style.width = paged ? `${sec.h}px` : '';
    paintSheets(sec);
  }
  function paintSheets(sec) {
    const have = sec.wrap.querySelectorAll(':scope > .epub-snap');
    if (!paged) {
      have.forEach((e) => e.remove());
      return;
    }
    const k = pagesIn(sec);
    if (have.length === k && sec.sheetVw === geo.vw) return;
    have.forEach((e) => e.remove());
    sec.sheetVw = geo.vw;
    const frag = document.createDocumentFragment();
    for (let n = 0; n < k; n++) frag.append(h('div', { class: 'epub-snap', style: { left: `${n * geo.vw}px`, width: `${geo.vw}px` } }, h('div', { class: 'epub-sheet' })));
    sec.wrap.prepend(frag);
  }
  secs.forEach(applyExtent);
  pagesEl.classList.add('epub');
  pagesEl.append(...secs.map((s) => s.wrap));

  // ---------------------------------------------------------------- layout helpers
  let tops = [];
  function layout() {
    const sr = scroller.getBoundingClientRect();
    const r0 = secs[0].wrap.getBoundingClientRect();
    let y = paged ? r0.left - sr.left + scroller.scrollLeft : r0.top - sr.top + scroller.scrollTop;
    tops = secs.map((s) => {
      const t = y;
      y += s.h;
      return t;
    });
  }
  const sectionAt = (y) => {
    let lo = 0, hi = N - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** Where the reader is: a section, and how far into it (flipping: the start of the page you are on). */
  const here = () => {
    layout();
    const i = sectionAt(off() + 1);
    if (paged) return { i, pos: clamp(Math.round((off() - tops[i]) / geo.vw) / pagesIn(secs[i]), 0, 1) };
    return { i, pos: clamp((off() - tops[i]) / secs[i].h, 0, 1) };
  };
  /** The scroll offset that shows section i at `pos`, or at an element of it (a link target, a search hit). */
  function offsetFor(i, { pos = 0, el = null } = {}) {
    layout();
    if (!paged) return tops[i] + (el ? el.getBoundingClientRect().top - 16 : pos * secs[i].h);
    const k = pagesIn(secs[i]);
    const pg = el ? Math.floor(Math.max(0, el.getBoundingClientRect().left) / geo.vw) : Math.floor(pos * k + 1e-6);
    return tops[i] + clamp(pg, 0, k - 1) * geo.vw;
  }
  const scrollToPos = (i, pos) => setOff(Math.max(0, offsetFor(i, { pos })));
  /** Flipping: a section's page count is only final once its text has loaded and its fonts have arrived, which can be after
   *  we have landed. Until then, if it changes, put the page back on the same fraction of the section (unless you turned a page). */
  let anchor = null;
  const anchorTo = (i, pos, ms = 2000) => { if (paged) anchor = { i, pos, stamp: userStamp, until: Date.now() + ms }; };

  /** A section changed height. If it lies wholly above the viewport, shift the scroll to keep the text still. */
  function setH(sec, hh) {
    hh = paged ? Math.max(1, Math.round(hh / geo.vw)) * geo.vw : Math.max(40, Math.ceil(hh));
    if (hh === sec.h) return;
    const sr = scroller.getBoundingClientRect();
    const r = sec.wrap.getBoundingClientRect();
    const above = paged ? r.right - sr.left <= 0 : r.bottom - sr.top <= 0;
    const delta = hh - sec.h;
    sec.h = hh;
    applyExtent(sec);
    if (paged && anchor && anchor.i === sec.i && Date.now() < anchor.until && anchor.stamp === userStamp) scrollToPos(anchor.i, anchor.pos);
    else if (above) setOff(off() + delta);
    schedule();
  }

  // ---------------------------------------------------------------- styling of the book's pages
  function css(sec = null) {
    const ds = document.documentElement.dataset;
    const paper = ds.readerBg === 'paper' || (ds.readerBg === 'theme' && (ds.theme === 'light' || ds.theme === 'sepia'));
    const fg = paper ? '#26231d' : '#d8dbe2';
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#d2a65b';
    const link = paper ? `color-mix(in srgb, ${accent} 50%, #000)` : accent;
    const fam = settings.epubFont === 'sans' ? SANS : settings.epubFont === 'serif' ? SERIF : '';
    return `${FACES}
html { height: auto !important; min-height: 0 !important; overflow: hidden !important; background: transparent !important; color-scheme: ${paper ? 'light' : 'dark'}; }
body { display: flow-root !important; box-sizing: border-box !important; width: auto !important; max-width: none !important; min-height: 0 !important; margin: 0 !important; padding: ${paged ? '0' : '32px 28px 44px'} !important;
  background: transparent !important; color: ${fg} !important; font-size: ${settings.epubFontSize}px !important; line-height: ${settings.epubLine} !important; overflow-wrap: break-word; position: static !important; }
body * { color: inherit !important; background-color: transparent !important; ${fam ? `font-family: ${fam} !important;` : ''} }
${fam ? `body { font-kerning: normal; font-optical-sizing: auto; ${settings.epubFont === 'serif' ? 'font-feature-settings: "onum", "kern";' : ''} }
body p { text-wrap: pretty; hyphens: manual; }
body :is(h1, h2, h3, h4) { line-height: 1.22 !important; text-wrap: balance; font-weight: 600 !important; letter-spacing: -.005em; }
` : ''}
${fam ? `pre, pre *, code, kbd, samp, tt { font-family: ui-monospace, Menlo, Consolas, monospace !important; }` : ''}
a, a * { color: ${link} !important; }
img, svg, video, canvas, table { max-width: 100% !important; }
img, video { height: auto !important; }
${paged ? `html { overflow: hidden !important; width: ${(sec?.k ?? 1) * geo.vw - (geo.vw - geo.W)}px !important; height: ${geo.H}px !important; }
body { width: ${(sec?.k ?? 1) * geo.vw - (geo.vw - geo.W)}px !important; height: ${geo.H}px !important; padding: 0 !important; margin: 0 !important; overflow: visible !important;
  column-width: ${geo.W}px !important; column-gap: ${geo.vw - geo.W}px !important; column-fill: auto !important; display: block !important; }
img, svg, video, canvas { max-height: ${geo.H}px !important; width: auto; object-fit: contain; break-inside: avoid; }
h1, h2, h3, h4 { break-after: avoid; }
p, li, blockquote { orphans: 2; widows: 2; }` : ''}
pre { white-space: pre-wrap !important; }
::selection { background: ${accent}66; }
html body mark.srch { background-color: rgba(255, 214, 64, .55) !important; color: inherit !important; border-radius: 2px; }
html body mark.srch.cur { background-color: rgba(255, 140, 0, .75) !important; outline: 2px solid rgba(255, 140, 0, .9); }
`;
  }
  const styleDoc = (doc, sec = null) => {
    let st = doc.getElementById('shelf-epub-style');
    if (!st) {
      st = doc.createElement('style');
      st.id = 'shelf-epub-style';
      (doc.head ?? doc.documentElement).append(st);
    }
    st.textContent = css(sec);
  };

  // ---------------------------------------------------------------- loading and unloading sections
  function mount(sec) {
    if (sec.frame || sec.img || dead) return sec.ready;
    sec.ready = new Promise((res) => (sec.resolve = res));
    if (sec.it.kind === 'image') {
      const img = h('img', { class: 'epub-img', alt: '', src: fileUrl(sec.it.path) });
      const fit = () => {
        setH(sec, paged ? geo.vw : img.getBoundingClientRect().height + 24); // flipping, an image is a page of its own
        sec.resolve();
      };
      img.addEventListener('load', fit);
      img.addEventListener('error', () => sec.resolve());
      sec.img = img;
      sec.wrap.append(img);
      return sec.ready;
    }
    const f = h('iframe', { class: 'epub-frame', title: `Section ${sec.i + 1}` });
    f.setAttribute('sandbox', 'allow-same-origin'); // same origin so we can style it; no scripts, no popups, no forms
    f.style.visibility = 'hidden';
    f.addEventListener('load', () => onFrameLoad(sec, f));
    f.src = fileUrl(sec.it.path, sec.tried ? '&html=1' : '');
    sec.frame = f;
    sec.wrap.append(f);
    setTimeout(() => sec.resolve?.(), 5000); // never wait forever on a broken section
    return sec.ready;
  }
  function unmount(sec) {
    sec.frame?.remove();
    sec.img?.remove();
    sec.frame = sec.img = null;
    sec.ready = null;
  }

  function measure(sec) {
    const doc = sec.frame?.contentDocument;
    if (!doc?.documentElement) return;
    const se = doc.scrollingElement;
    if (paged) {
      // Count the columns the text really fills (the frame may be wider than it needs), then make the frame exactly that wide.
      let right = 0;
      try {
        const rg = doc.createRange();
        rg.selectNodeContents(doc.body);
        right = rg.getBoundingClientRect().right;
      } catch { /* an empty body */ }
      const k = Math.max(1, Math.ceil((right - geo.W - 2) / geo.vw) + 1);
      if (k !== sec.k) {
        sec.k = k;
        styleDoc(doc, sec);
      }
      sec.frame.style.width = `${k * geo.vw - (geo.vw - geo.W)}px`;
      setH(sec, k * geo.vw);
      if (se && (se.scrollTop || se.scrollLeft)) { se.scrollTop = 0; se.scrollLeft = 0; }
      return;
    }
    setH(sec, doc.documentElement.getBoundingClientRect().height);
    // The frame is exactly as tall as its text; if focus ever scrolled it internally, put it back.
    if (se && se.scrollTop) se.scrollTop = 0;
  }

  function onFrameLoad(sec, f) {
    if (dead || sec.frame !== f) return;
    const doc = f.contentDocument;
    if (!doc) return sec.resolve?.();
    // Sloppy XHTML (not well-formed XML) fails to parse as XML: show it through the forgiving HTML parser instead.
    if ((doc.querySelector('parsererror') || doc.documentElement?.localName === 'parsererror') && !sec.tried) {
      sec.tried = 1;
      f.src = fileUrl(sec.it.path, '&html=1');
      return;
    }
    styleDoc(doc, sec);
    markSec(sec);
    doc.addEventListener('click', (e) => frameClick(sec, e));
    doc.addEventListener('keydown', frameKey);
    doc.addEventListener('wheel', onWheel, { passive: false });
    doc.addEventListener('load', () => measure(sec), true); // images finishing
    try {
      const ro = new f.contentWindow.ResizeObserver(() => measure(sec));
      ro.observe(doc.documentElement);
      sec.ro = ro;
    } catch { /* fall back to the measurements below */ }
    measure(sec);
    f.style.visibility = 'visible';
    setTimeout(() => measure(sec), 300);
    setTimeout(() => measure(sec), 1200);
    sec.resolve?.();
  }

  // ---------------------------------------------------------------- events from inside the frames
  function frameKey(e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f' && onFind) {
      e.preventDefault(); // the browser's find only sees the sections that happen to be loaded
      return onFind();
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (paged) return onKey(e); // the shell turns the pages
    const page = scroller.clientHeight * 0.9;
    const by = (top) => { e.preventDefault(); scroller.scrollBy({ top }); };
    if (e.key === ' ') return by(e.shiftKey ? -page : page);
    if (e.key === 'PageDown') return by(page);
    if (e.key === 'PageUp') return by(-page);
    if (e.key === 'ArrowDown') return by(70);
    if (e.key === 'ArrowUp') return by(-70);
    onKey(e);
  }

  function frameClick(sec, e) {
    const a = e.target.closest?.('a');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) openLink(sec, href);
      return;
    }
    const fr = sec.frame?.getBoundingClientRect(); // the click's place is the frame's own; the shell wants the screen's
    onClick({ detail: e.detail, target: scroller, clientX: (fr?.left ?? 0) + e.clientX, clientY: (fr?.top ?? 0) + e.clientY });
  }

  const backStack = [];
  const backBtn = h('button', { class: 'epub-back hidden', onClick: () => goBack() }, icon('back', 14), 'Back to where you were');
  let backTimer = 0;
  function pushBack() {
    backStack.push(here()); // a section and how far into it: pixel offsets drift when sections above settle to their real height
    backBtn.classList.remove('hidden');
    clearTimeout(backTimer);
    backTimer = setTimeout(() => { backStack.length = 0; backBtn.classList.add('hidden'); }, 25000);
  }
  async function goBack() {
    const at = backStack.pop();
    if (!backStack.length) backBtn.classList.add('hidden');
    if (!at) return;
    // Like a jump: land now, then put it right once the section is drawn and has its real height.
    const mine = ++jumpSeq;
    const stamp = userStamp;
    pendingIdx = -1;
    scrollToPos(at.i, at.pos);
    await mount(secs[at.i]);
    if (mine !== jumpSeq || dead) return;
    scrollToPos(at.i, at.pos);
    setTimeout(() => {
      if (dead || mine !== jumpSeq || stamp !== userStamp) return;
      scrollToPos(at.i, at.pos);
    }, 350);
  }

  function openLink(sec, href) {
    if (/^(https?:|mailto:)/i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer');
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return; // javascript:, data:, file: ... never
    const { path, frag } = resolveHref(sec.it.path, href);
    const idx = secs.findIndex((s) => s.it.path === path);
    if (idx < 0) {
      toast('That link points outside the book’s text.', 'quiet');
      return;
    }
    jumpTo(idx, frag, true);
  }

  // A jump settles in two steps (land, then correct once the target has loaded). A newer jump, or the
  // reader scrolling by hand in between, cancels the older jump's second step.
  let jumpSeq = 0;
  let userStamp = 0;
  let pendingIdx = -1; // target of a jump that hasn't settled yet (so quick repeated key presses keep counting)
  for (const ev of ['wheel', 'touchstart', 'pointerdown']) scroller.addEventListener(ev, () => (userStamp++, (pendingIdx = -1)), { passive: true });
  const targetIn = (idx, frag) => {
    const doc = secs[idx].frame?.contentDocument;
    return frag && doc ? doc.getElementById(frag) ?? doc.getElementsByName?.(frag)?.[0] ?? null : null;
  };
  async function jumpTo(idx, frag = '', remember = false) {
    idx = clamp(idx, 0, N - 1);
    if (remember) pushBack();
    const mine = ++jumpSeq;
    const stamp = userStamp;
    pendingIdx = idx;
    layout();
    setOff(tops[idx]); // land near it right away; extents settle once it loads
    await mount(secs[idx]);
    if (mine !== jumpSeq || dead) return;
    setOff(Math.max(0, offsetFor(idx, { el: targetIn(idx, frag) })));
    setTimeout(() => {
      if (dead || mine !== jumpSeq || stamp !== userStamp) return;
      pendingIdx = -1;
      setOff(Math.max(0, offsetFor(idx, { el: targetIn(idx, frag) })));
    }, 350);
  }

  // ---------------------------------------------------------------- what's near the viewport
  let raf = 0;
  function schedule() {
    if (raf || dead) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  }
  function update() {
    if (dead) return;
    layout();
    const t = off();
    const vh = paged ? geo.vw : scroller.clientHeight || 800; // how far is "near": a screen, along the reading direction
    for (const s of secs) {
      const top = tops[s.i], bot = top + s.h;
      if (bot > t - vh * 1.5 && top < t + vh * 2.5) mount(s);
      else if ((bot < t - vh * 5 || top > t + vh * 6) && (s.frame || s.img)) unmount(s);
    }
    if (restoring) return;
    const i = sectionAt(t + 1);
    const pos = paged ? Math.min(1, Math.round((t - tops[i]) / geo.vw) / pagesIn(secs[i])) : clamp((t - tops[i]) / secs[i].h, 0, 1);
    report(i + 1, pos);
    markToc(i);
  }
  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  // ---------------------------------------------------------------- flipping
  let heading = null; // where a page turn that is still animating is heading, so quick key presses count from there
  function turnPage(dir) {
    restoring = false;
    const now = Math.round(scroller.scrollLeft / geo.vw);
    const last = Math.max(0, Math.round(scroller.scrollWidth / geo.vw) - 1);
    const to = clamp((heading && Date.now() - heading.t < 700 ? heading.i : now) + dir, 0, last);
    heading = { i: to, t: Date.now() };
    pendingIdx = -1;
    userStamp++; // a turn cancels the settling of an earlier jump
    scroller.scrollTo({ left: to * geo.vw, behavior: settings.pagedAnimation !== false ? 'smooth' : 'instant' });
  }
  let wheelAt = 0;
  function onWheel(e) {
    if (!paged || e.ctrlKey || Math.abs(e.deltaY) < Math.abs(e.deltaX) || Math.abs(e.deltaY) < 4) return; // sideways wheels and swipes already scroll the strip
    e.preventDefault();
    if (Date.now() - wheelAt < 340) return; // one turn per flick, not one per tick of its momentum
    wheelAt = Date.now();
    turnPage(e.deltaY > 0 ? 1 : -1);
  }
  scroller.addEventListener('wheel', onWheel, { passive: false });
  /** The screen changed size (a window resize, the contents panel opening): lay the columns out again, keeping the place. */
  let relayoutTimer = 0;
  function relayoutPaged(keep = true) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => {
      if (dead || !paged) return;
      const p = keep && !restoring ? here() : null;
      measureGeo();
      for (const s of secs) {
        if (s.frame?.contentDocument?.documentElement) {
          s.k = 1;
          styleDoc(s.frame.contentDocument, s);
          measure(s);
        } else if (!s.frame && !s.img) {
          s.h = estimateExtent(s.it);
          applyExtent(s);
        } else paintSheets(s);
      }
      if (p) {
        scrollToPos(p.i, p.pos);
        setTimeout(() => !dead && paged && scrollToPos(p.i, p.pos), 250);
      }
      schedule();
    }, 120);
  }
  const ro = new ResizeObserver(() => paged && relayoutPaged());
  ro.observe(scroller);

  // ---------------------------------------------------------------- table of contents
  const flat = [];
  const flatten = (list, depth) => {
    for (const t of list) {
      const idx = secs.findIndex((s) => s.it.path === t.path);
      if (idx >= 0) flat.push({ ...t, depth, idx });
      flatten(t.children ?? [], depth + 1);
    }
  };
  flatten(meta.toc, 0);

  const tocList = h('div', { class: 'epub-toc-list' });
  const tocEntries = flat.map((t) => {
    const b = h('button', { class: 'epub-toc-item', style: { paddingLeft: `${12 + t.depth * 16}px` }, title: t.title, onClick: () => { jumpTo(t.idx, t.frag, true); if (innerWidth < 900) toggleToc(false); } }, t.title);
    tocList.append(b);
    return b;
  });
  const tocPanel = h('aside', { class: 'epub-toc hidden' },
    h('div', { class: 'epub-toc-head' }, h('b', null, 'Contents'), h('span', { class: 'grow' }), h('button', { class: 'icon-btn', title: 'Close (T)', onClick: () => toggleToc(false) }, icon('x', 16))),
    tocList,
  );
  let tocOpen = false;
  function toggleToc(force) {
    tocOpen = force ?? !tocOpen;
    tocPanel.classList.toggle('hidden', !tocOpen);
    root.classList.toggle('has-drawer', tocOpen);
    tocBtn.classList.toggle('on', tocOpen);
    if (tocOpen) {
      markToc(here().i, true);
      schedule();
    }
  }
  let lastMarked = -1;
  function markToc(i, force = false) {
    if (!tocOpen && !force) return;
    let cur = -1;
    flat.forEach((t, k) => { if (t.idx <= i) cur = k; });
    if (cur === lastMarked && !force) return;
    lastMarked = cur;
    tocEntries.forEach((b, k) => b.classList.toggle('current', k === cur));
    if (tocOpen) tocEntries[cur]?.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------------- text settings popover
  const step = (key, dir, lo, hi, delta, digits = 0) => {
    const v = clamp(Math.round((settings[key] + dir * delta) * 100) / 100, lo, hi);
    setSetting(key, Number(v.toFixed(digits)));
  };
  const textPanel = h('div', { class: 'epub-text hidden' });
  function renderText() {
    const row = (label, ...ctl) => h('div', { class: 'epub-text-row' }, h('span', { class: 'muted' }, label), h('div', { class: 'epub-text-ctl' }, ...ctl));
    const stepper = (key, lo, hi, delta, fmt, digits) => [
      h('button', { class: 'icon-btn', onClick: () => step(key, -1, lo, hi, delta, digits) }, '−'),
      h('span', { class: 'epub-text-val' }, fmt(settings[key])),
      h('button', { class: 'icon-btn', onClick: () => step(key, 1, lo, hi, delta, digits) }, '+'),
    ];
    const seg = (key, opts) => opts.map(([v, label]) => h('button', { class: `btn small${settings[key] === v ? ' primary' : ''}`, onClick: () => setSetting(key, v) }, label));
    textPanel.replaceChildren(
      row('Text size', ...stepper('epubFontSize', 12, 36, 1, (v) => `${v}px`, 0)),
      row('Line spacing', ...stepper('epubLine', 1.2, 2.2, 0.1, (v) => v.toFixed(1), 1)),
      row('Font', ...seg('epubFont', [['serif', 'Serif'], ['sans', 'Sans'], ['book', 'Book’s own']])),
      h('div', { class: 'muted small' }, 'Colours follow Settings > Reader background. Keys: [ ] text size, + − width.'),
    );
  }
  function toggleText(force) {
    const open = force ?? textPanel.classList.contains('hidden');
    textPanel.classList.toggle('hidden', !open);
    textBtn.classList.toggle('on', open);
    if (open) renderText();
  }
  const outside = (e) => {
    if (!textPanel.classList.contains('hidden') && !textPanel.contains(e.target) && !textBtn.contains(e.target)) toggleText(false);
  };
  document.addEventListener('mousedown', outside);

  const tocBtn = h('button', { class: 'icon-btn', title: 'Contents (T)', onClick: () => toggleToc() }, icon('menu', 18));
  const textBtn = h('button', { class: 'icon-btn epub-aa', title: 'Text size and font', onClick: () => toggleText() }, 'Aa');
  const info = bar.querySelector('[title^="File info"]');
  bar.insertBefore(tocBtn, info);
  bar.insertBefore(textBtn, info);
  root.append(tocPanel, textPanel, backBtn);

  // ---------------------------------------------------------------- settings changes
  let restyleTimer = 0;
  function reflow(apply) {
    // Keep the reader on the same sentence while the text reflows.
    const p = restoring ? null : here();
    apply();
    clearTimeout(restyleTimer);
    restyleTimer = setTimeout(() => {
      if (dead) return;
      if (paged) measureGeo();
      for (const s of secs) if (s.frame?.contentDocument?.documentElement) { if (paged) s.k = 1; styleDoc(s.frame.contentDocument, s); measure(s); }
      if (p) setTimeout(() => !dead && scrollToPos(p.i, p.pos), 200);
    }, 60);
  }
  const unsub = onSettings((k) => {
    if (['epubFontSize', 'epubFont', 'epubLine', 'readerBg', 'theme', 'accent', '*'].includes(k)) {
      reflow(() => {});
      if (!textPanel.classList.contains('hidden')) renderText();
    }
  });

  // ---------------------------------------------------------------- interface for the shell
  // ---------------------------------------------------------------- search
  let sx = null; // { regex, cur: {unit, ord} | null } while a search is shown
  const texts = new Map();
  /** Mark the hits in a loaded section; returns the current hit's mark, if it is in this section. */
  function markSec(sec) {
    const body = sec.frame?.contentDocument?.body;
    if (!body) return null;
    if (!sx?.regex) {
      clearMarks(body);
      return null;
    }
    return markMatches(body, sx.regex, sx.cur && sx.cur.unit === sec.i ? sx.cur.ord : -1);
  }
  const searchSource = {
    count: N,
    label: (i) => `Section ${i + 1}`,
    /** The text of the section's body, the same text the marks are found in. */
    async text(i) {
      if (!texts.has(i)) {
        const it = secs[i].it;
        let t = '';
        if (it.kind !== 'image') {
          const r = await fetch(fileUrl(it.path, '&html=1'));
          if (r.ok) t = new DOMParser().parseFromString(await r.text(), 'text/html').body?.textContent ?? '';
        }
        texts.set(i, t);
      }
      return texts.get(i);
    },
    setMarks(regex, cur) {
      sx = regex ? { regex, cur } : null;
      for (const sec of secs) if (sec.frame) markSec(sec);
    },
    /** Go to a hit: load its section, then put the marked text a third of the way down. */
    async show({ unit, ord }) {
      restoring = false;
      if (!backStack.length) pushBack(); // one way back, however many hits you step through
      const mine = ++jumpSeq;
      const stamp = userStamp;
      pendingIdx = unit;
      layout();
      setOff(tops[unit]);
      await mount(secs[unit]);
      if (mine !== jumpSeq || dead) return;
      const settle = () => {
        const mk = markSec(secs[unit]);
        layout();
        if (paged) setOff(Math.max(0, offsetFor(unit, { el: mk }))); // the page the hit is on
        else scroller.scrollTop = Math.max(0, tops[unit] + (mk ? mk.getBoundingClientRect().top - scroller.clientHeight * 0.3 : 0));
      };
      settle();
      setTimeout(() => {
        if (dead || mine !== jumpSeq || stamp !== userStamp) return;
        pendingIdx = -1;
        settle();
      }, 350);
    },
  };

  const impl = {
    searchSource,
    setWidth(px) {
      colW = px;
      reflow(() => pagesEl.style.setProperty('--page-w', `${px}px`));
    },
    goTo(n) {
      restoring = false;
      jumpTo(n - 1, '', false);
    },
    /** Jump to a spot in a section (from "go to page"); the Back button returns to where you were. */
    async goToPos(n, pos) {
      restoring = false;
      const i = clamp(n - 1, 0, N - 1);
      pushBack();
      const mine = ++jumpSeq;
      const stamp = userStamp;
      pendingIdx = i;
      layout();
      setOff(tops[i]);
      await mount(secs[i]);
      if (mine !== jumpSeq || dead) return;
      scrollToPos(i, clamp(pos ?? 0, 0, 1));
      anchorTo(i, clamp(pos ?? 0, 0, 1));
      setTimeout(() => {
        if (dead || mine !== jumpSeq || stamp !== userStamp) return;
        pendingIdx = -1;
        scrollToPos(i, clamp(pos ?? 0, 0, 1));
      }, 350);
    },
    /** Resume at a saved position. */
    async restore(page, pos) {
      const i = clamp((page || 1) - 1, 0, N - 1);
      const stamp = userStamp;
      const mine = ++jumpSeq;
      layout();
      setOff(tops[i]);
      await mount(secs[i]);
      if (mine !== jumpSeq || dead) return restoring = false;
      scrollToPos(i, clamp(pos ?? 0, 0, 1));
      anchorTo(i, clamp(pos ?? 0, 0, 1));
      setTimeout(() => {
        if (dead) return;
        if (mine === jumpSeq && stamp === userStamp) scrollToPos(i, clamp(pos ?? 0, 0, 1));
        restoring = false;
        update();
      }, 450);
    },
    /** Section forward/back (arrow keys). Back first returns to the top of the current section. */
    step(dir) {
      if (paged) return turnPage(dir);
      const { i, pos } = pendingIdx >= 0 ? { i: pendingIdx, pos: 0 } : here();
      restoring = false;
      const target = dir < 0 && pos > 0.02 ? i : i + dir;
      if (target >= 0 && target < N) jumpTo(target, '', false);
    },
    /** Scrolling <-> flipping, staying on the same sentence. */
    setMode(m) {
      const want = m === 'paged';
      if (want === paged) return;
      const p = restoring ? null : here(); // before anything moves
      paged = want;
      measureGeo();
      for (const s of secs) {
        s.k = 1;
        s.sheetVw = 0;
        s.h = estimateExtent(s.it);
        if (s.frame) s.frame.style.width = '';
        applyExtent(s);
      }
      for (const s of secs) if (s.frame?.contentDocument?.documentElement) { styleDoc(s.frame.contentDocument, s); measure(s); }
      if (!p) return schedule();
      // The shell flips its own layout right after this returns, which resets the scroll; so put the place back once it has,
      // and don't report positions in the meantime.
      restoring = true;
      const mine = ++jumpSeq;
      const back = () => { if (dead || paged !== want || mine !== jumpSeq) return; scrollToPos(p.i, p.pos); anchorTo(p.i, p.pos, 1500); };
      for (const t of [30, 150, 400]) setTimeout(back, t);
      setTimeout(() => {
        if (dead || mine !== jumpSeq) return;
        back();
        restoring = false;
        schedule();
      }, 700);
    },
    fontStep: (dir) => step('epubFontSize', dir, 12, 36, 1, 0),
    toggleToc,
    selectionCollapsed() {
      try {
        return secs.every((s) => !s.frame?.contentDocument || s.frame.contentDocument.getSelection().isCollapsed);
      } catch {
        return true;
      }
    },
    consumeEscape() {
      if (!textPanel.classList.contains('hidden')) return toggleText(false), true;
      if (tocOpen) return toggleToc(false), true;
      return false;
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      clearTimeout(restyleTimer);
      clearTimeout(backTimer);
      scroller.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      scroller.removeEventListener('wheel', onWheel);
      ro.disconnect();
      clearTimeout(relayoutTimer);
      document.removeEventListener('mousedown', outside);
      unsub();
      for (const s of secs) {
        try { s.ro?.disconnect(); } catch { /* ignore */ }
        unmount(s);
      }
      tocBtn.remove();
      textBtn.remove();
      tocPanel.remove();
      textPanel.remove();
      backBtn.remove();
      root.classList.remove('has-drawer');
      pagesEl.classList.remove('epub');
    },
  };
  // Show something sensible even before the shell asks to restore.
  mount(secs[0]);
  return impl;
}
