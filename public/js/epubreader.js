import { api } from './api.js';
import { onSettings, setSetting, settings } from './settings.js';
import { toast } from './ui.js';
import { clamp, h, icon } from './util.js';

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

const SERIF = 'Georgia, "Iowan Old Style", "Palatino Linotype", "Times New Roman", serif';
const SANS = 'system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** Resolve an href found inside section `from` (a zip entry path) to { path, frag }. */
function resolveHref(from, href) {
  const u = new URL(href, `http://epub.local/${encodePath(from)}`);
  const dec = (s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  };
  return { path: dec(u.pathname.slice(1)), frag: dec(u.hash.slice(1)) };
}

export async function epubImpl(book, { root, scroller, pagesEl, bar, setTotal, report, onKey, onClick }) {
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

  const secs = meta.spine.map((it, i) => {
    const wrap = h('section', { class: `epub-sec${it.kind === 'image' ? ' img' : ''}`, dataset: { page: i + 1 } });
    const sec = { i, it, wrap, frame: null, img: null, h: estimate(it), tried: 0, ready: null, resolve: null };
    wrap.style.height = `${sec.h}px`;
    return sec;
  });
  pagesEl.classList.add('epub');
  pagesEl.append(...secs.map((s) => s.wrap));

  // ---------------------------------------------------------------- layout helpers
  let tops = [];
  function layout() {
    const sr = scroller.getBoundingClientRect();
    let y = secs[0].wrap.getBoundingClientRect().top - sr.top + scroller.scrollTop;
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
  const here = () => {
    layout();
    const i = sectionAt(scroller.scrollTop + 1);
    return { i, pos: clamp((scroller.scrollTop - tops[i]) / secs[i].h, 0, 1) };
  };
  const scrollToPos = (i, pos) => {
    layout();
    scroller.scrollTop = tops[i] + pos * secs[i].h;
  };

  /** A section changed height. If it lies wholly above the viewport, shift the scroll to keep the text still. */
  function setH(sec, hh) {
    hh = Math.max(40, Math.ceil(hh));
    if (hh === sec.h) return;
    const sr = scroller.getBoundingClientRect();
    const above = sec.wrap.getBoundingClientRect().bottom - sr.top <= 0;
    const delta = hh - sec.h;
    sec.h = hh;
    sec.wrap.style.height = `${hh}px`;
    if (above) scroller.scrollTop += delta;
    schedule();
  }

  // ---------------------------------------------------------------- styling of the book's pages
  function css() {
    const ds = document.documentElement.dataset;
    const paper = ds.readerBg === 'paper' || (ds.readerBg === 'theme' && (ds.theme === 'light' || ds.theme === 'sepia'));
    const fg = paper ? '#26231d' : '#d8dbe2';
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c8cff';
    const link = paper ? '#2b57c9' : accent;
    const fam = settings.epubFont === 'sans' ? SANS : settings.epubFont === 'serif' ? SERIF : '';
    return `
html { height: auto !important; min-height: 0 !important; overflow: hidden !important; background: transparent !important; color-scheme: ${paper ? 'light' : 'dark'}; }
body { display: flow-root !important; box-sizing: border-box !important; width: auto !important; max-width: none !important; min-height: 0 !important; margin: 0 !important; padding: 32px 28px 44px !important;
  background: transparent !important; color: ${fg} !important; font-size: ${settings.epubFontSize}px !important; line-height: ${settings.epubLine} !important; overflow-wrap: break-word; position: static !important; }
body * { color: inherit !important; background-color: transparent !important; ${fam ? `font-family: ${fam} !important;` : ''} }
${fam ? `pre, pre *, code, kbd, samp, tt { font-family: ui-monospace, Menlo, Consolas, monospace !important; }` : ''}
a, a * { color: ${link} !important; }
img, svg, video, canvas, table { max-width: 100% !important; }
img, video { height: auto !important; }
pre { white-space: pre-wrap !important; }
::selection { background: ${accent}66; }
`;
  }
  const styleDoc = (doc) => {
    let st = doc.getElementById('shelf-epub-style');
    if (!st) {
      st = doc.createElement('style');
      st.id = 'shelf-epub-style';
      (doc.head ?? doc.documentElement).append(st);
    }
    st.textContent = css();
  };

  // ---------------------------------------------------------------- loading and unloading sections
  function mount(sec) {
    if (sec.frame || sec.img || dead) return sec.ready;
    sec.ready = new Promise((res) => (sec.resolve = res));
    if (sec.it.kind === 'image') {
      const img = h('img', { class: 'epub-img', alt: '', src: fileUrl(sec.it.path) });
      const fit = () => {
        setH(sec, img.getBoundingClientRect().height + 24);
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
    setH(sec, doc.documentElement.getBoundingClientRect().height);
    // The frame is exactly as tall as its text; if focus ever scrolled it internally, put it back.
    const se = doc.scrollingElement;
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
    styleDoc(doc);
    doc.addEventListener('click', (e) => frameClick(sec, e));
    doc.addEventListener('keydown', frameKey);
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
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
    onClick({ detail: e.detail, target: scroller });
  }

  const backStack = [];
  const backBtn = h('button', { class: 'epub-back hidden', onClick: () => goBack() }, icon('back', 14), 'Back to where you were');
  let backTimer = 0;
  function pushBack() {
    backStack.push(scroller.scrollTop);
    backBtn.classList.remove('hidden');
    clearTimeout(backTimer);
    backTimer = setTimeout(() => { backStack.length = 0; backBtn.classList.add('hidden'); }, 25000);
  }
  function goBack() {
    const y = backStack.pop();
    if (y !== undefined) scroller.scrollTop = y;
    if (!backStack.length) backBtn.classList.add('hidden');
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
  async function jumpTo(idx, frag = '', remember = false) {
    idx = clamp(idx, 0, N - 1);
    if (remember) pushBack();
    const mine = ++jumpSeq;
    const stamp = userStamp;
    pendingIdx = idx;
    layout();
    scroller.scrollTop = tops[idx]; // land near it right away; heights settle once it loads
    await mount(secs[idx]);
    if (mine !== jumpSeq || dead) return;
    layout();
    let y = tops[idx];
    if (frag) {
      const doc = secs[idx].frame?.contentDocument;
      const el = doc && (doc.getElementById(frag) ?? doc.getElementsByName?.(frag)?.[0]);
      if (el) y += el.getBoundingClientRect().top - 16;
    }
    scroller.scrollTop = y;
    setTimeout(() => {
      if (dead || mine !== jumpSeq || stamp !== userStamp) return;
      pendingIdx = -1;
      layout();
      const doc = secs[idx].frame?.contentDocument;
      const el = frag && doc && (doc.getElementById(frag) ?? doc.getElementsByName?.(frag)?.[0]);
      scroller.scrollTop = tops[idx] + (el ? el.getBoundingClientRect().top - 16 : 0);
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
    const t = scroller.scrollTop;
    const vh = scroller.clientHeight || 800;
    for (const s of secs) {
      const top = tops[s.i], bot = top + s.h;
      if (bot > t - vh * 1.5 && top < t + vh * 2.5) mount(s);
      else if ((bot < t - vh * 5 || top > t + vh * 6) && (s.frame || s.img)) unmount(s);
    }
    if (restoring) return;
    const i = sectionAt(t + 1);
    const pos = clamp((t - tops[i]) / secs[i].h, 0, 1);
    report(i + 1, pos);
    markToc(i);
  }
  scroller.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

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
      for (const s of secs) if (s.frame?.contentDocument?.documentElement) { styleDoc(s.frame.contentDocument); measure(s); }
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
  const impl = {
    setWidth(px) {
      colW = px;
      reflow(() => pagesEl.style.setProperty('--page-w', `${px}px`));
    },
    goTo(n) {
      restoring = false;
      jumpTo(n - 1, '', false);
    },
    /** Resume at a saved position. */
    async restore(page, pos) {
      const i = clamp((page || 1) - 1, 0, N - 1);
      const stamp = userStamp;
      const mine = ++jumpSeq;
      layout();
      scroller.scrollTop = tops[i];
      await mount(secs[i]);
      if (mine !== jumpSeq || dead) return restoring = false;
      scrollToPos(i, clamp(pos ?? 0, 0, 1));
      setTimeout(() => {
        if (dead) return;
        if (mine === jumpSeq && stamp === userStamp) scrollToPos(i, clamp(pos ?? 0, 0, 1));
        restoring = false;
        update();
      }, 450);
    },
    /** Section forward/back (arrow keys). Back first returns to the top of the current section. */
    step(dir) {
      const { i, pos } = pendingIdx >= 0 ? { i: pendingIdx, pos: 0 } : here();
      restoring = false;
      const target = dir < 0 && pos > 0.02 ? i : i + dir;
      if (target >= 0 && target < N) jumpTo(target, '', false);
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
