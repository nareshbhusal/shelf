import { api, fileUrl, pageUrl } from './api.js';
import { createAnnotations } from './annotations.js';
import { bookName, onSettings, setSetting, settings } from './settings.js';
import { h, hashFor, icon, clamp, dirSegments } from './util.js';
import { appName } from './store.js';
import { openFileInfo } from './fileinfo.js';
import { epubImpl } from './epubreader.js';
import { toast } from './ui.js';

const PDFJS = '/vendor/pdfjs';
let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= import(`${PDFJS}/build/pdf.min.mjs`).then((m) => {
    m.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
    return m;
  });
  return pdfjsPromise;
}

/**
 * Vertical-scroll reader shared by PDF, CBZ and EPUB. Format-specific code supplies an `impl`:
 *   setWidth(px), goTo(n), destroy() (+ restore/step/... for EPUB, whose position is section + fraction)
 * This shell handles the toolbar, current-page tracking, progress saving, zoom and keys.
 */
export async function createReader(bookId, { page: startPage = 0 } = {}) {
  let book;
  try {
    book = await api.get(`/books/${bookId}`);
  } catch (e) {
    return { el: h('div', { class: 'empty' }, `Book not found: ${e.message}`), destroy() {} };
  }

  const isEpub = book.format === 'epub';
  const root = h('div', { class: isEpub ? 'reader epub' : 'reader' });
  const scroller = h('div', { class: 'reader-scroll' });
  const pagesEl = h('div', { class: 'reader-pages' });
  scroller.append(pagesEl);
  // Highlights and notes are stored in the PDF itself, so only PDFs get them.
  const ann = book.format === 'pdf'
    ? createAnnotations({ book, root, scroller, pagesEl, bookName, goTo: (n, smooth) => impl?.goTo(n, smooth) })
    : null;

  const backHref = hashFor('files', dirSegments(book.dir));
  let currentPage = 1;
  let total = book.pages ?? 0;
  let saveTimer = null;
  let currentPos = 0; // EPUB only: how far into the current section (0..1)
  let lastSaved = book.progress.page || 0;
  let lastSavedPos = book.progress.pos ?? null;
  let impl = null;
  let dead = false;

  const titleEl = h('div', { class: 'reader-title' });
  const widthKey = book.format === 'pdf' ? 'pdfWidth' : isEpub ? 'epubWidth' : 'comicWidth';
  const pageInput = h('input', { class: 'page-input', type: 'text', inputMode: 'numeric', value: '1', 'aria-label': 'Page number' });
  const pageTotal = h('span', { class: 'muted' }, total ? `/ ${total}` : '');
  const bar = h(
    'div',
    { class: 'reader-bar' },
    h('a', { class: 'icon-btn', href: backHref, title: 'Back to library (Esc)' }, icon('back')),
    titleEl,
    h('div', { class: 'reader-page' }, pageInput, pageTotal),
    isEpub ? h('div', { class: 'epub-where muted', title: 'Section / how far through the book' }) : null,
    ann ? ann.toolbar : null,
    h('button', { class: 'icon-btn', title: 'File info (I)', onClick: () => openFileInfo(book, ann) }, icon('info', 18)),
    h('div', { class: 'reader-zoom' },
      h('button', { class: 'icon-btn', title: 'Narrower (−)', onClick: () => zoom(-1) }, '−'),
      h('span', { class: 'muted zoom-val' }, `${settings[widthKey]}px`),
      h('button', { class: 'icon-btn', title: 'Wider (+)', onClick: () => zoom(1) }, '+'),
      h('button', { class: 'icon-btn', title: 'Fit to window (0)', onClick: fitWidth }, icon('fullscreen', 16)),
    ),
  );
  const zoomVal = bar.querySelector('.zoom-val');
  // The browser tab says what you are reading, and where you are in it.
  function setTitles() {
    const name = bookName(book);
    titleEl.textContent = name;
    titleEl.title = `${name}\n${book.path}`;
    const where = isEpub ? (total ? ` · ${bookPercent()}%` : '') : total ? ` · p. ${currentPage}/${total}` : '';
    document.title = `${name}${where} — ${appName()}`;
  }
  setTitles();
  const unsubName = onSettings((k) => k === 'nameSource' && setTitles());
  const progressLine = h('div', { class: 'reader-progress' }, h('i'));
  root.append(bar, scroller, progressLine);
  if (ann) root.append(ann.drawer);

  // ---------------------------------------------------------------- shared behaviour
  function bookFraction() { return total ? clamp((currentPage - 1 + currentPos) / total, 0, 1) : 0; }
  function bookPercent() { return Math.floor(bookFraction() * 100); }
  const whereEl = bar.querySelector('.epub-where');

  /** EPUB: the reader reports (section, fraction of section) as you scroll. */
  function setPosition(page, pos) {
    pos = clamp(pos, 0, 1);
    if (page === currentPage && Math.abs(pos - currentPos) < 0.002) return;
    const sectionChanged = page !== currentPage;
    currentPage = page;
    currentPos = pos;
    if (whereEl) whereEl.textContent = `${currentPage}/${total} · ${bookPercent()}%`;
    if (sectionChanged || bookPercent() !== lastPct) setTitles();
    lastPct = bookPercent();
    progressLine.firstChild.style.width = `${bookFraction() * 100}%`;
    queueSave();
  }
  let lastPct = -1;

  function setCurrent(n) {
    n = clamp(n, 1, total || 1);
    if (n === currentPage) return;
    currentPage = n;
    if (!settling) currentPos = readingPos();
    pageInput.value = String(n);
    setTitles();
    progressLine.firstChild.style.width = total ? `${(n / total) * 100}%` : '0';
    queueSave();
  }

  /** PDF/CBZ: how far down the current page the reading line is (0..1), so reopening lands on the same spot. */
  let settling = true; // ignore scroll events caused by the initial jump to the saved position
  function readingPos() {
    const el = impl?.pageEl?.(currentPage);
    if (!el) return currentPos;
    const sr = scroller.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return clamp((sr.top + sr.height * READ_LINE - r.top) / Math.max(1, r.height), 0, 1);
  }
  let posTimer = null;
  if (!isEpub) {
    scroller.addEventListener(
      'scroll',
      () => {
        if (settling) return;
        clearTimeout(posTimer);
        posTimer = setTimeout(() => {
          const pos = readingPos();
          if (Math.abs(pos - currentPos) < 0.02) return;
          currentPos = pos;
          queueSave();
        }, 250);
      },
      { passive: true },
    );
  }

  function queueSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }
  function flush() {
    clearTimeout(saveTimer);
    if (!isEpub && !settling) currentPos = readingPos(); // catch a scroll that hasn't been picked up yet
    const pos = Math.round(currentPos * 1000) / 1000;
    if (currentPage === lastSaved && (pos === lastSavedPos || (!isEpub && Math.abs(pos - (lastSavedPos ?? 0)) < 0.02))) return;
    lastSaved = currentPage;
    lastSavedPos = pos;
    // keepalive so it still goes through while the tab is closing
    fetch(`/api/books/${book.id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: currentPage, pos }),
      keepalive: true,
    }).catch(() => {});
  }

  function setWidthSetting(px) {
    px = clamp(Math.round(px / 10) * 10, 200, 3000);
    setSetting(widthKey, px);
  }
  function zoom(dir) {
    const w = settings[widthKey];
    setWidthSetting(w + dir * Math.max(50, Math.round(w * 0.1)));
  }
  function fitWidth() {
    setWidthSetting(scroller.clientWidth - 32);
  }

  const applyWidth = (key) => {
    if (key !== widthKey && key !== '*') return;
    zoomVal.textContent = `${settings[widthKey]}px`;
    impl?.setWidth(settings[widthKey]);
  };
  const unsubWidth = onSettings(applyWidth);

  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(pageInput.value, 10);
      if (Number.isFinite(n)) impl?.goTo(clamp(n, 1, total || 1), true);
      pageInput.blur();
    }
    e.stopPropagation();
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  pageInput.addEventListener('blur', () => (pageInput.value = String(currentPage)));

  // A click (tap) anywhere on the reading area shows or hides the toolbar; the choice is remembered.
  const BAR_KEY = 'shelf.readerBar';
  const setBar = (on) => {
    bar.classList.toggle('away', !on);
    root.classList.toggle('bar-off', !on);
    try { localStorage.setItem(BAR_KEY, on ? '1' : '0'); } catch { /* ignore */ }
  };
  let barOn = true;
  try { barOn = localStorage.getItem(BAR_KEY) !== '0'; } catch { /* ignore */ }
  setBar(barOn);
  let clickTimer = 0;
  const onReadClick = (e) => {
    clearTimeout(clickTimer);
    // Not for: double/triple clicks (selecting words), clicks that belong to a note/pen action or a
    // popover, links and buttons, or the end of a text selection.
    if (e.detail > 1 || e.annHandled || ann?.busy() || e.target.closest('a, button, input, textarea, .ann-pop, .ann-pin')) return;
    clickTimer = setTimeout(() => {
      if (dead || !(impl?.selectionCollapsed?.() ?? getSelection()?.isCollapsed) || !getSelection()?.isCollapsed) return;
      barOn = bar.classList.contains('away');
      setBar(barOn);
    }, 230);
  };
  scroller.addEventListener('click', onReadClick);

  const onKey = (e) => {
    if (e.target?.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.getElementById('modal-root').childElementCount) return;
    switch (e.key) {
      case 'Escape': if (!ann?.consumeEscape() && !impl?.consumeEscape?.()) location.hash = backHref; break;
      case 'ArrowLeft': if (isEpub) impl?.step(-1); break;
      case 'ArrowRight': if (isEpub) impl?.step(1); break;
      case '[': impl?.fontStep?.(-1); break;
      case ']': impl?.fontStep?.(1); break;
      case 't': case 'T': impl?.toggleToc?.(); break;
      case 'n': case 'N': ann?.toggleDrawer(); break;
      case 'i': case 'I': openFileInfo(book, ann); break;
      case '+': case '=': zoom(1); break;
      case '-': case '_': zoom(-1); break;
      case '0': fitWidth(); break;
      case 'Home': scroller.scrollTo({ top: 0 }); e.preventDefault(); break;
      case 'End': scroller.scrollTo({ top: scroller.scrollHeight }); e.preventDefault(); break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
        break;
      case ' ': case 'PageDown': case 'PageUp': case 'ArrowDown': case 'ArrowUp':
        // Let the scroller handle these even if it isn't focused.
        if (document.activeElement === document.body) {
          scroller.focus({ preventScroll: true });
        }
        break;
      default: return;
    }
  };
  document.addEventListener('keydown', onKey);
  const onHide = () => document.visibilityState === 'hidden' && flush();
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  scroller.tabIndex = 0;

  /** Tracks which page crosses a thin line 35% down the viewport. */
  function makeTracker(getIndex) {
    const obs = new IntersectionObserver(
      (entries) => {
        for (const en of entries) if (en.isIntersecting) setCurrent(getIndex(en.target));
      },
      { root: scroller, rootMargin: '-35% 0px -64.5% 0px', threshold: 0 },
    );
    return obs;
  }

  // ---------------------------------------------------------------- start
  const explicit = Number(startPage) > 0 ? Number(startPage) : 0; // ?page=N in the link beats the saved position
  const resumeAt = explicit || (book.progress.page > 1 && (!book.pages || book.progress.page < book.pages) ? book.progress.page : 1);
  // EPUB: resume at section + fraction, unless the last section was already read to its end.
  const savedPos = book.progress.pos ?? 0;
  const epubDone = book.pages && book.progress.page >= book.pages && savedPos >= 0.95;

  const status = h('div', { class: 'empty' }, 'Opening…');
  pagesEl.append(status);

  (async () => {
    try {
      if (book.format === 'pdf') impl = await pdfImpl(book, scroller, pagesEl, makeTracker, (n) => (total = n, pageTotal.textContent = `/ ${n}`, setTitles()), ann);
      else if (book.format === 'cbz') impl = await comicImpl(book, scroller, pagesEl, makeTracker, (n) => (total = n, pageTotal.textContent = `/ ${n}`, setTitles()));
      else if (isEpub) {
        impl = await epubImpl(book, {
          root, scroller, pagesEl, bar, report: setPosition, onKey, onClick: onReadClick,
          setTotal: (n) => (total = n, setTitles()),
        });
      } else throw new Error(`${book.format.toUpperCase()} files can't be read here yet`);
      if (dead) return impl.destroy();
      status.remove();
      impl.setWidth(settings[widthKey]);
      scroller.focus({ preventScroll: true });
      if (isEpub) {
        const at = explicit || (epubDone ? 1 : book.progress.page || 1);
        const pos = explicit || epubDone ? 0 : savedPos;
        currentPage = 0; // force the first report through
        await impl.restore(at, pos);
        if (!explicit && (at > 1 || pos > 0.02)) toast(`Resumed at ${Math.floor(((at - 1 + pos) / total) * 100)}%`, 'quiet');
      } else if (resumeAt > 1 || (!explicit && savedPos > 0.02 && !(book.pages && book.progress.page >= book.pages))) {
        // Back to the page you were on, and to the spot within it when we know that (older saves have only the page).
        const within = !explicit && book.progress.page === resumeAt ? savedPos : 0;
        currentPage = resumeAt;
        currentPos = within;
        pageInput.value = String(resumeAt);
        impl.goTo(resumeAt, false, within);
        if (!explicit) toast(`Resumed at page ${resumeAt}`, 'quiet');
      } else {
        setCurrent(1);
      }
      setTimeout(() => (settling = false), 900); // after the jump (and its re-settle) has finished
    } catch (e) {
      console.error(e);
      status.replaceChildren(h('h2', null, 'Could not open this book'), h('p', { class: 'err' }, e.message), h('a', { class: 'btn', href: backHref }, 'Back'));
    }
  })();

  return {
    el: root,
    destroy() {
      dead = true;
      flush();
      clearTimeout(saveTimer);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      impl?.destroy();
      ann?.destroy();
      unsubName();
      unsubWidth();
    },
  };
}

/**
 * Scroll so `el`'s top is at the top of the viewport (pos = 0), or so the point `pos` (0..1) of the way
 * down the page sits on the reading line (35% down the viewport), which is where progress is measured.
 */
const READ_LINE = 0.35;
function scrollToPage(scroller, el, smooth, pos = 0) {
  if (!(pos > 0)) {
    el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'instant' });
    return;
  }
  const sr = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  scroller.scrollTo({ top: scroller.scrollTop + (r.top - sr.top) + pos * r.height - sr.height * READ_LINE, behavior: smooth ? 'smooth' : 'instant' });
}

// ====================================================================== CBZ
async function comicImpl(book, scroller, pagesEl, makeTracker, setTotal) {
  const { count } = await api.get(`/books/${book.id}/pages`);
  if (!count) throw new Error('This archive has no readable pages');
  setTotal(count);

  const imgs = [];
  const tracker = makeTracker((el) => Number(el.dataset.page));
  for (let i = 1; i <= count; i++) {
    const img = h('img', {
      class: 'comic-page',
      alt: `Page ${i}`,
      loading: 'lazy',
      decoding: 'async',
      draggable: false,
      dataset: { page: i },
    });
    img.style.aspectRatio = '2 / 3'; // placeholder until we know the real shape
    img.addEventListener('load', () => (img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`));
    img.addEventListener('error', () => img.classList.add('broken'));
    img.src = pageUrl(book, i);
    imgs.push(img);
    tracker.observe(img);
  }
  pagesEl.append(...imgs);

  return {
    setWidth(px) {
      pagesEl.style.setProperty('--page-w', `${px}px`);
    },
    pageEl: (n) => imgs[n - 1],
    goTo(n, smooth, pos = 0) {
      const img = imgs[n - 1];
      if (!img) return;
      scrollToPage(scroller, img, smooth, pos);
      // Pages above us finish loading and change height; settle onto the target once more afterwards.
      if (!smooth) setTimeout(() => scrollToPage(scroller, img, false, pos), 400);
    },
    destroy() {
      tracker.disconnect();
      for (const img of imgs) img.removeAttribute('src');
    },
  };
}

// ====================================================================== PDF
async function pdfImpl(book, scroller, pagesEl, makeTracker, setTotal, ann = null) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    url: fileUrl(book),
    cMapUrl: `${PDFJS}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}/standard_fonts/`,
    wasmUrl: `${PDFJS}/wasm/`,
    iccUrl: `${PDFJS}/iccs/`,
    rangeChunkSize: 1 << 20,
  });
  const doc = await task.promise;
  const count = doc.numPages;
  setTotal(count);

  const first = await doc.getPage(1);
  const v1 = first.getViewport({ scale: 1 });
  let aspect = v1.height / v1.width; // placeholder shape until each page reports its own
  const ratios = new Array(count).fill(null);
  ratios[0] = aspect;

  let width = 900;
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2.5);

  const pages = [];
  const tracker = makeTracker((el) => Number(el.dataset.page));

  const sizeEl = (p) => {
    p.el.style.width = `${width}px`;
    p.el.style.height = `${Math.round(width * (ratios[p.n - 1] ?? aspect))}px`;
  };

  for (let n = 1; n <= count; n++) {
    const el = h('div', { class: 'pdf-page', dataset: { page: n } });
    const p = { n, el, canvas: null, textDiv: null, rendering: null, renderedWidth: 0, visible: false, token: 0 };
    pages.push(p);
    tracker.observe(el);
  }
  pagesEl.append(...pages.map((p) => p.el));

  async function render(p) {
    if (p.renderedWidth === width && p.canvas) return;
    const token = ++p.token;
    p.rendering?.cancel?.();
    try {
      const page = await doc.getPage(p.n);
      if (token !== p.token || !p.visible) return;
      const base = page.getViewport({ scale: 1 });
      ratios[p.n - 1] = base.height / base.width;
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const out = page.getViewport({ scale: scale * dpr() });
      sizeEl(p);

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(out.width);
      canvas.height = Math.floor(out.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext('2d', { alpha: false });

      // Highlights/notes are drawn by us from the file's own annotations (see annotations.js), so the
      // canvas must not paint them a second time.
      await ann?.ready;
      if (token !== p.token || !p.visible) return;
      const job = page.render({ canvas, canvasContext: ctx, viewport: out, annotationMode: ann?.supported ? pdfjs.AnnotationMode.DISABLE : pdfjs.AnnotationMode.ENABLE });
      p.rendering = job;
      await job.promise;
      if (token !== p.token || !p.visible) return;

      // Swap in the finished canvas (no blank flash on re-render at a new zoom).
      const textDiv = document.createElement('div');
      textDiv.className = 'textLayer';
      textDiv.style.setProperty('--total-scale-factor', String(scale));
      textDiv.style.setProperty('--scale-factor', String(scale));
      p.el.replaceChildren(canvas, textDiv);
      ann?.decorate(p.el, p.n);
      p.canvas = canvas;
      p.textDiv = textDiv;
      p.renderedWidth = width;
      // Text layer is best-effort; a failure here must not lose the page.
      page.getTextContent().then((tc) => {
        if (token !== p.token) return;
        return new pdfjs.TextLayer({ textContentSource: tc, container: textDiv, viewport }).render();
      }).catch(() => {});
    } catch (e) {
      if (e?.name === 'RenderingCancelledException') return;
      console.warn(`page ${p.n} failed`, e);
    } finally {
      if (p.rendering && token === p.token) p.rendering = null;
    }
  }

  function release(p) {
    p.token++;
    p.rendering?.cancel?.();
    p.rendering = null;
    if (p.canvas) {
      p.canvas.width = p.canvas.height = 0; // frees the bitmap immediately
      p.el.replaceChildren();
      p.canvas = p.textDiv = null;
      p.renderedWidth = 0;
    }
  }

  // Render pages within ~2 screens of the viewport; free the rest so 1000-page PDFs don't eat RAM.
  const lifecycle = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        const p = pages[Number(en.target.dataset.page) - 1];
        p.visible = en.isIntersecting;
        if (p.visible) render(p);
        else release(p);
      }
    },
    { root: scroller, rootMargin: '200% 0px 200% 0px' },
  );
  pages.forEach((p) => lifecycle.observe(p.el));

  // Learn real page sizes in the background so placeholders (and the scrollbar) become accurate.
  let sizing = true;
  (async () => {
    for (let i = 2; i <= count && sizing; i++) {
      try {
        const pg = await doc.getPage(i);
        const v = pg.getViewport({ scale: 1 }); // includes /Rotate and the crop box, like the real render
        ratios[i - 1] = v.height / v.width;
        if (!pages[i - 1].canvas) sizeEl(pages[i - 1]);
        pg.cleanup();
      } catch {
        /* keep placeholder */
      }
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  })();

  return {
    setWidth(px) {
      // Keep the reader on the same page when zoom changes.
      const anchor = pages.find((p) => p.el.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top + 1);
      const frac = anchor ? (scroller.getBoundingClientRect().top - anchor.el.getBoundingClientRect().top) / Math.max(1, anchor.el.offsetHeight) : 0;
      width = px;
      aspect = ratios[0] ?? aspect;
      pages.forEach(sizeEl);
      if (anchor) scroller.scrollTop += anchor.el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + frac * anchor.el.offsetHeight;
      pages.filter((p) => p.visible).forEach(render);
    },
    pageEl: (n) => pages[n - 1]?.el,
    goTo(n, smooth, pos = 0) {
      const p = pages[n - 1];
      if (!p) return;
      scrollToPage(scroller, p.el, smooth, pos);
      if (!smooth) setTimeout(() => scrollToPage(scroller, p.el, false, pos), 500);
    },
    destroy() {
      sizing = false;
      tracker.disconnect();
      lifecycle.disconnect();
      pages.forEach(release);
      task.destroy().catch(() => {});
    },
  };
}
