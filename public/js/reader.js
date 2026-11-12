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
  let total = isEpub ? 0 : book.pages ?? 0; // (EPUB: number of sections; its pages are an estimate, see `estPages`)
  let weights = null; // EPUB: text length of each section, so a position can be told as a fraction of the book
  let estPages = book.pages ?? 0;
  let saveTimer = null;
  let currentPos = 0; // EPUB only: how far into the current section (0..1)
  let lastSaved = book.progress.page || 0;
  let lastSavedPos = book.progress.pos ?? null;
  let impl = null;
  let dead = false;
  // A folder with 2+ comics is a series: its parts are read one after another, without leaving the reader.
  let parts = null; // the series' parts in reading order (book records), or null for a lone book
  let partIdx = 0;
  let partSince = Date.now(); // when the current part became the one being read
  let startIdx = 0;
  // Reading mode: a column you scroll (default), or one page at a time side by side (PDF and comics).
  const modeKey = book.format === 'pdf' ? 'modePdf' : 'modeComic';
  const wantMode = () => (!isEpub && settings[modeKey] === 'paged' ? 'paged' : 'scroll');
  const wantRtl = () => book.format === 'cbz' && settings.rtlComic === 'rtl';
  let mode = wantMode();
  let rtl = wantRtl();

  const titleEl = h('div', { class: 'reader-title' });
  const widthKey = book.format === 'pdf' ? 'pdfWidth' : isEpub ? 'epubWidth' : 'comicWidth';
  const pageInput = h('input', { class: 'page-input', type: 'text', inputMode: 'numeric', value: '1', 'aria-label': 'Page number' });
  const pageTotal = h('span', { class: 'muted' }, total ? `/ ${total}` : '');
  const bar = h(
    'div',
    { class: 'reader-bar' },
    h('a', { class: 'icon-btn', href: backHref, title: 'Back to library (Esc)' }, icon('back')),
    titleEl,
    h('div', { class: 'series-nav hidden' },
      h('button', { class: 'icon-btn', title: 'Previous part (<)', onClick: () => goPart(-1) }, icon('prev', 16)),
      h('span', { class: 'muted part-where' }),
      h('button', { class: 'icon-btn', title: 'Next part (>)', onClick: () => goPart(1) }, icon('next', 16)),
    ),
    h('div', { class: 'reader-page' }, pageInput, pageTotal),
    isEpub ? h('div', { class: 'epub-where muted', title: 'Estimated page (about 1800 characters each) and how far through the book' }) : null,
    ann ? ann.toolbar : null,
    h('button', { class: 'icon-btn', title: 'File info (I)', onClick: () => openFileInfo(book, ann) }, icon('info', 18)),
    isEpub ? null : h('button', { class: 'icon-btn mode-btn', title: 'Reading mode (M)', onClick: () => toggleMode() }, icon('paged', 18)),
    book.format === 'cbz' ? h('button', { class: 'icon-btn dir-btn', title: 'Page order: left to right or right to left (D)', onClick: () => setSetting('rtlComic', settings.rtlComic === 'rtl' ? 'ltr' : 'rtl') }) : null,
    h('div', { class: 'reader-zoom' },
      h('button', { class: 'icon-btn', title: 'Narrower (−)', onClick: () => zoom(-1) }, '−'),
      h('span', { class: 'muted zoom-val' }, `${settings[widthKey]}px`),
      h('button', { class: 'icon-btn', title: 'Wider (+)', onClick: () => zoom(1) }, '+'),
      h('button', { class: 'icon-btn', title: 'Fit to window (0)', onClick: fitWidth }, icon('fullscreen', 16)),
    ),
  );
  const zoomVal = bar.querySelector('.zoom-val');
  const seriesNav = bar.querySelector('.series-nav');
  const modeBtn = bar.querySelector('.mode-btn');
  const dirBtn = bar.querySelector('.dir-btn');
  const partWhere = bar.querySelector('.part-where');
  // A small, quiet page counter in the corner; it stays when the toolbar is hidden.
  const countEl = h('div', { class: 'reader-count' });
  // The browser tab says what you are reading, and where you are in it.
  function setTitles() {
    const name = bookName(book);
    titleEl.textContent = name;
    titleEl.title = `${name}\n${book.path}`;
    const where = isEpub ? (total ? ` · ${bookPercent()}%` : '') : total ? ` · p. ${currentPage}/${total}` : '';
    document.title = `${name}${where} — ${appName()}`;
    updateCount();
  }
  function epubWhere() {
    return estPages ? `p. ~${clamp(Math.ceil(bookFraction() * estPages), 1, estPages)}/~${estPages} · ${bookPercent()}%` : `${bookPercent()}%`;
  }
  function updateCount() {
    let t = '';
    if (isEpub) t = weights ? epubWhere() : '';
    else if (total && currentPage > 0) t = `${currentPage} / ${total}`;
    countEl.textContent = t && parts ? `${bookName(book)} · ${t}` : t;
    countEl.classList.toggle('hidden', !t);
  }
  setTitles();
  const unsubName = onSettings((k) => k === 'nameSource' && setTitles());
  const progressLine = h('div', { class: 'reader-progress' }, h('i'));
  root.append(bar, scroller, progressLine, countEl);
  if (ann) root.append(ann.drawer);

  // ---------------------------------------------------------------- shared behaviour
  /** How far through the whole series the reading line is (parts of unknown length count as an average one). */
  function seriesFraction() {
    const known = parts.filter((p) => p.pages > 0);
    const avg = known.length ? known.reduce((a, p) => a + p.pages, 0) / known.length : 1;
    const len = (p) => (p.pages > 0 ? p.pages : avg);
    const all = parts.reduce((a, p) => a + len(p), 0);
    const before = parts.slice(0, partIdx).reduce((a, p) => a + len(p), 0);
    return all ? clamp((before + currentPage - 1 + currentPos) / all, 0, 1) : 0;
  }
  /** Part boundaries on the progress line, so you can see how the series is divided. */
  function drawTicks() {
    progressLine.querySelectorAll('.tick').forEach((t) => t.remove());
    if (!parts) return;
    const known = parts.filter((p) => p.pages > 0);
    const avg = known.length ? known.reduce((a, p) => a + p.pages, 0) / known.length : 1;
    const len = (p) => (p.pages > 0 ? p.pages : avg);
    const all = parts.reduce((a, p) => a + len(p), 0);
    let acc = 0;
    parts.forEach((p, i) => {
      if (i) progressLine.append(h('b', { class: 'tick', style: { left: `${(acc / all) * 100}%` } }));
      acc += len(p);
    });
  }
  function paintProgress() {
    if (parts) progressLine.firstChild.style.width = `${seriesFraction() * 100}%`;
    else if (!isEpub) progressLine.firstChild.style.width = total ? `${(currentPage / total) * 100}%` : '0';
  }
  function showPart() {
    if (!parts) return;
    seriesNav.classList.remove('hidden');
    progressLine.classList.add('series');
    partWhere.textContent = `Part ${partIdx + 1}/${parts.length} · ${bookName(book)}`;
    partWhere.title = `${bookName(book)}\n${parts.length} parts. ${Math.floor(seriesFraction() * 100)}% through the series`;
  }
  /** Jump to the start of the previous / next part. */
  function goPart(delta) {
    const i = partIdx + delta;
    if (!parts || i < 0 || i >= parts.length) {
      toast(delta < 0 ? 'This is the first part' : 'This is the last part', 'quiet');
      return;
    }
    impl?.goToPart?.(parts[i].id, 1, true);
  }
  /**
   * The reading line moved into another part. Leaving a part you read to its end marks it finished;
   * leaving one you only passed through (a fast scroll, a jump) saves nothing for it.
   */
  function switchPart(id) {
    const i = parts.findIndex((p) => p.id === id);
    if (i < 0 || i === partIdx) return;
    const old = book;
    const dwelled = Date.now() - partSince > 1500 || partIdx === startIdx;
    clearTimeout(saveTimer);
    if (dwelled) {
      if (i > partIdx && old.pages && currentPage >= old.pages) {
        old.progress = { page: old.pages, pos: 0, at: Date.now() };
        lastSaved = old.pages;
        fetch(`/api/books/${old.id}/progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: old.pages, pos: 0 }), keepalive: true }).catch(() => {});
      } else flush();
    }
    partIdx = i;
    partSince = Date.now();
    book = parts[i];
    toast(bookName(book), 'quiet'); // say which part this is, whatever the reading mode
    total = book.pages ?? 0;
    currentPage = 0; // let the first page of this part through
    currentPos = 0;
    lastSaved = book.progress.page || 0;
    lastSavedPos = book.progress.pos ?? null;
    impl?.setPart?.(id);
    pageTotal.textContent = total ? `/ ${total}` : '';
    history.replaceState(history.state, '', hashFor('read', [String(id)]));
    setTitles();
    showPart();
  }
  /** How far through the whole book a (section, spot in section) is, by amount of text. */
  function fractionAt(sec, pos) {
    if (!weights) return total ? clamp((sec - 1 + pos) / total, 0, 1) : 0;
    const i = clamp(sec, 1, weights.length) - 1;
    let before = 0;
    for (let k = 0; k < i; k++) before += weights[k];
    return clamp((before + pos * weights[i]) / weights.total, 0, 1);
  }
  function bookFraction() { return fractionAt(currentPage, currentPos); }
  function bookPercent() { return Math.floor(bookFraction() * 100); }
  const whereEl = bar.querySelector('.epub-where');

  /** EPUB: the reader reports (section, fraction of section) as you scroll. */
  function setPosition(page, pos) {
    pos = clamp(pos, 0, 1);
    if (page === currentPage && Math.abs(pos - currentPos) < 0.002) return;
    const sectionChanged = page !== currentPage;
    currentPage = page;
    currentPos = pos;
    if (whereEl) whereEl.textContent = epubWhere();
    updateCount();
    if (sectionChanged || bookPercent() !== lastPct) setTitles();
    lastPct = bookPercent();
    progressLine.firstChild.style.width = `${bookFraction() * 100}%`;
    queueSave();
  }
  let lastPct = -1;

  function setCurrent(n, partId) {
    if (partId != null && parts && partId !== book.id) switchPart(partId);
    n = clamp(n, 1, total || 1);
    if (n === currentPage) return;
    currentPage = n;
    if (!settling) currentPos = readingPos();
    pageInput.value = String(n);
    setTitles();
    paintProgress();
    showPart();
    queueSave();
  }

  /** PDF/CBZ: how far down the current page the reading line is (0..1), so reopening lands on the same spot. */
  let settling = true; // ignore scroll events caused by the initial jump to the saved position
  function readingPos() {
    if (mode === 'paged') return 0; // a whole page is on screen: the position within it means nothing
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
        if (settling || mode === 'paged') return;
        clearTimeout(posTimer);
        posTimer = setTimeout(() => {
          const pos = readingPos();
          if (Math.abs(pos - currentPos) < 0.02) return;
          currentPos = pos;
          if (parts) paintProgress();
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
    const frac = isEpub ? Math.round(bookFraction() * 10000) / 10000 : undefined;
    book.progress = { ...book.progress, page: currentPage, pos, at: Date.now(), ...(isEpub ? { frac } : {}) };
    // keepalive so it still goes through while the tab is closing
    fetch(`/api/books/${book.id}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: currentPage, pos, frac }),
      keepalive: true,
    }).catch(() => {});
  }

  /** Switch between the two layouts, staying on the same page. */
  function showMode() {
    root.classList.toggle('paged', mode === 'paged');
    root.classList.toggle('rtl', mode === 'paged' && rtl);
    if (modeBtn) {
      modeBtn.classList.toggle('on', mode === 'paged');
      modeBtn.title = mode === 'paged' ? 'One page at a time: switch to continuous scroll (M)' : 'Continuous scroll: switch to one page at a time (M)';
    }
    if (dirBtn) {
      dirBtn.classList.toggle('hidden', mode !== 'paged');
      dirBtn.textContent = rtl ? 'RTL' : 'LTR';
      dirBtn.title = rtl ? 'Right to left (manga): click for left to right (D)' : 'Left to right: click for right to left (manga) (D)';
    }
  }
  function toggleMode() {
    if (isEpub) return;
    setSetting(modeKey, mode === 'paged' ? 'scroll' : 'paged');
  }
  function applyMode(k) {
    if (k !== modeKey && k !== 'rtlComic' && k !== '*') return;
    const m = wantMode();
    const r = wantRtl();
    if (m === mode && r === rtl) return;
    const changed = m !== mode;
    mode = m;
    rtl = r;
    showMode();
    if (!impl) return;
    settling = true; // the layout is about to move under us; don't read that as the reader scrolling
    impl.setMode?.(mode, rtl);
    const pos = changed && mode === 'scroll' ? currentPos : 0;
    impl.goTo(currentPage || 1, false, pos);
    setTimeout(() => (settling = false), 900);
  }
  const unsubMode = onSettings(applyMode);
  showMode();

  /** Paged mode: turn n pages forward (negative: back), in reading order. */
  function turn(n) {
    impl?.step?.(n);
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
    // One page at a time: the outer thirds of the screen turn the page, the middle third toggles the bar.
    if (mode === 'paged' && getSelection()?.isCollapsed !== false) {
      const r = scroller.getBoundingClientRect();
      const x = (e.clientX - r.left) / Math.max(1, r.width);
      if (x < 0.3 || x > 0.7) {
        const forward = (x > 0.7) !== rtl; // on the right, a left-to-right book goes forward; a manga goes back
        clickTimer = setTimeout(() => !dead && turn(forward ? 1 : -1), book.format === 'pdf' ? 230 : 0);
        return;
      }
    }
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
      case 'ArrowLeft': if (isEpub) impl?.step(-1); else if (mode === 'paged') { turn(rtl ? 1 : -1); e.preventDefault(); } break;
      case 'ArrowRight': if (isEpub) impl?.step(1); else if (mode === 'paged') { turn(rtl ? -1 : 1); e.preventDefault(); } break;
      case 'm': case 'M': toggleMode(); break;
      case 'd': case 'D': if (dirBtn && mode === 'paged') setSetting('rtlComic', rtl ? 'ltr' : 'rtl'); break;
      case '<': goPart(-1); break;
      case '>': goPart(1); break;
      case '[': impl?.fontStep?.(-1); break;
      case ']': impl?.fontStep?.(1); break;
      case 't': case 'T': impl?.toggleToc?.(); break;
      case 'n': case 'N': ann?.toggleDrawer(); break;
      case 'i': case 'I': openFileInfo(book, ann); break;
      case '+': case '=': zoom(1); break;
      case '-': case '_': zoom(-1); break;
      case '0': fitWidth(); break;
      case 'Home': if (mode === 'paged') impl?.goTo(1, false); else scroller.scrollTo({ top: 0 }); e.preventDefault(); break;
      case 'End': if (mode === 'paged') impl?.goTo(total || 1, false); else scroller.scrollTo({ top: scroller.scrollHeight }); e.preventDefault(); break;
      case 'f': case 'F':
        if (document.fullscreenElement) document.exitFullscreen();
        else document.documentElement.requestFullscreen?.().catch(() => {});
        break;
      case ' ': case 'PageDown': case 'PageUp': case 'ArrowDown': case 'ArrowUp':
        if (mode === 'paged') {
          if (e.key === ' ' || e.key === 'PageDown') turn(e.shiftKey && e.key === ' ' ? -1 : 1);
          else if (e.key === 'PageUp') turn(-1);
          e.preventDefault();
          break;
        }
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
        if (mode === 'paged') return; // there the page is read from the horizontal position (see the impls)
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const at = getIndex(en.target);
          if (typeof at === 'number') setCurrent(at);
          else setCurrent(at.page, at.id);
        }
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
  const epubDone = (book.progress.frac ?? 0) >= 0.98;

  // What the page impls need to know about the shell. `mode`/`rtl` are read when they are created and again on every change.
  const env = {
    get mode() { return mode; },
    get rtl() { return rtl; },
    report: (n, partId) => (partId != null ? setCurrent(n, partId) : setCurrent(n)),
    toast: (m) => toast(m, 'quiet'),
  };
  const status = h('div', { class: 'empty' }, 'Opening…');
  pagesEl.append(status);

  (async () => {
    try {
      if (book.format === 'pdf') impl = await pdfImpl(book, scroller, pagesEl, makeTracker, (n) => (total = n, pageTotal.textContent = `/ ${n}`, setTitles()), ann, env);
      else if (book.format === 'cbz') {
        if (book.dir) {
          const s = await api.get(`/series?dir=${encodeURIComponent(book.dir)}`).catch(() => null);
          const at = s?.parts.findIndex((p) => p.id === book.id) ?? -1;
          if (at >= 0 && s.parts.length >= 2) {
            parts = s.parts;
            parts[at] = book; // the freshly loaded record
            partIdx = startIdx = at;
            drawTicks();
          }
        }
        impl = await comicImpl(book, scroller, pagesEl, makeTracker, (id, n) => {
          const part = parts?.find((p) => p.id === id) ?? (id === book.id ? book : null);
          if (part) part.pages = n;
          if (id === book.id) (total = n, pageTotal.textContent = `/ ${n}`, setTitles());
          if (parts) (drawTicks(), paintProgress(), showPart());
        }, parts, env);
        showPart();
      }
      else if (isEpub) {
        impl = await epubImpl(book, {
          root, scroller, pagesEl, bar, report: setPosition, onKey, onClick: onReadClick,
          setTotal: (n, chars, pages) => {
            total = n;
            weights = chars;
            weights.total = chars.reduce((a, b) => a + b, 0) || 1;
            if (pages) estPages = pages;
            setTitles();
          },
        });
      } else throw new Error(`${book.format.toUpperCase()} files can't be read here yet`);
      if (dead) return impl.destroy();
      status.remove();
      impl.setWidth(settings[widthKey]);
      impl.setMode?.(mode, rtl);
      scroller.focus({ preventScroll: true });
      if (isEpub) {
        const at = explicit || (epubDone ? 1 : book.progress.page || 1);
        const pos = explicit || epubDone ? 0 : savedPos;
        currentPage = 0; // force the first report through
        await impl.restore(at, pos);
        if (!explicit && (at > 1 || pos > 0.02)) toast(`Resumed at ${Math.floor(fractionAt(at, pos) * 100)}%`, 'quiet');
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
      unsubMode();
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

// ====================================================================== paged layout
/**
 * Shared by the PDF and comic readers. In "one page at a time" mode every page owns a slot exactly as
 * wide as the viewport and the pages sit side by side in a horizontally scrolling, snapping strip, so
 * which page you are on is simply how far across you have scrolled. (The CSS is under `.reader.paged`.)
 * In right-to-left mode the strip runs the other way and scrollLeft is negative.
 */
function pagedStrip(scroller, pagesEl, { getCount, getRtl, report, onResize }) {
  let vw = 0;
  let vh = 0;
  const measure = () => {
    vw = scroller.clientWidth;
    vh = scroller.clientHeight;
    pagesEl.style.setProperty('--vw', `${vw}px`);
    pagesEl.style.setProperty('--vh', `${vh}px`);
  };
  measure();
  let on = false;
  let scrollTimer = 0;
  let resizeTimer = 0;
  const index = () => clamp(Math.round(Math.abs(scroller.scrollLeft) / Math.max(1, vw)), 0, Math.max(0, getCount() - 1));
  const reportNow = () => report(index() + 1);
  // Pressing → twice quickly must move two pages, so while a turn is still animating, count from where it is heading.
  let heading = null;
  const current = () => (heading && Date.now() - heading.t < 700 ? heading.i : index());
  const onScroll = () => {
    if (!on) return;
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(reportNow, 60); // wait until the swipe has settled on a page
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    if (!on) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const keep = index();
      measure();
      onResize?.(keep + 1);
    }, 100);
  });
  ro.observe(scroller);
  return {
    get vw() { return vw; },
    get vh() { return vh; },
    get on() { return on; },
    set(v) { on = v; if (v) measure(); },
    index,
    current,
    reportNow,
    goTo(n, smooth) {
      measure();
      heading = { i: n - 1, t: Date.now() };
      scroller.scrollTo({ left: (getRtl() ? -1 : 1) * (n - 1) * vw, top: 0, behavior: smooth ? 'smooth' : 'instant' });
    },
    destroy() {
      clearTimeout(scrollTimer);
      clearTimeout(resizeTimer);
      scroller.removeEventListener('scroll', onScroll);
      ro.disconnect();
    },
  };
}

// ====================================================================== CBZ
/**
 * Comics. A lone comic is a column of page images. A comic that is one part of a series (`parts`) is the
 * same column with the neighbouring parts attached above and below it: the next part is added as you
 * approach the end, the previous one as you approach the start, so reading simply carries on.
 * Page numbers (goTo, pageEl) always mean pages of the part being read; the shell says which with setPart.
 */
async function comicImpl(book, scroller, pagesEl, makeTracker, setCount, parts = null, env = null) {
  const list = parts ?? [book];
  const multi = !!parts;
  let cur = Math.max(0, list.findIndex((p) => p.id === book.id));
  const tracker = makeTracker((el) => ({ id: Number(el.dataset.part), page: Number(el.dataset.page) }));
  const mounted = new Map(); // index in list -> { nodes, imgs }
  let paged = env?.mode === 'paged';
  const strip = pagedStrip(scroller, pagesEl, {
    getCount: () => imgsOf().length,
    getRtl: () => !!env?.rtl,
    report: (n) => env?.report(n, list[cur].id),
  });
  strip.set(paged);

  /** Builds the page images of one part (not yet in the document). */
  async function build(i, required) {
    const part = list[i];
    let count = 0;
    try {
      count = (await api.get(`/books/${part.id}/pages`)).count;
    } catch (e) {
      if (required) throw e;
    }
    if (required && !count) throw new Error('This archive has no readable pages');
    setCount(part.id, count);
    const imgs = [];
    for (let n = 1; n <= count; n++) {
      const img = h('img', { class: 'comic-page', alt: `Page ${n}`, loading: 'lazy', decoding: 'async', draggable: false, dataset: { page: n, part: part.id } });
      img.style.aspectRatio = '2 / 3'; // placeholder until we know the real shape
      img.addEventListener('load', () => (img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`));
      img.addEventListener('error', () => img.classList.add('broken'));
      img.src = pageUrl(part, n);
      imgs.push(img);
      tracker.observe(img);
    }
    const head = multi ? h('div', { class: 'part-head' }, h('span', null, bookName(part)), h('small', null, `Part ${i + 1} of ${list.length}`)) : null;
    if (multi && !count) imgs.push(h('div', { class: 'part-head' }, 'This part could not be read'));
    const nodes = head ? [head, ...imgs] : imgs;
    mounted.set(i, { nodes, imgs: imgs.filter((x) => x.tagName === 'IMG') });
    return nodes;
  }

  const top = multi ? h('div', { class: 'part-edge' }) : null;
  const bottom = multi ? h('div', { class: 'part-edge' }) : null;
  const first = await build(cur, true);
  if (multi) pagesEl.append(top, ...first, bottom);
  else pagesEl.append(...first);

  let busy = false;
  const lo = () => Math.min(...mounted.keys());
  const hi = () => Math.max(...mounted.keys());
  const endNote = () => {
    const last = hi() >= list.length - 1;
    bottom.className = last ? 'part-edge end' : 'part-edge';
    bottom.textContent = last ? 'End of the series' : '';
  };
  async function loadAfter() {
    if (paged || busy || hi() >= list.length - 1) return;
    busy = true;
    try {
      bottom.before(...(await build(hi() + 1, false)));
    } finally {
      busy = false;
      endNote();
      edges?.unobserve(bottom); // look again: a short part may not have pushed the edge out of range
      edges?.observe(bottom);
    }
  }
  async function loadBefore() {
    if (paged || busy || lo() <= 0) return;
    busy = true;
    try {
      const nodes = await build(lo() - 1, false);
      // Keep what is on screen where it is: the new part goes above it, so scroll down by its height.
      const h0 = scroller.scrollHeight;
      const t0 = scroller.scrollTop;
      scroller.style.overflowAnchor = 'none';
      top.after(...nodes);
      scroller.scrollTop = t0 + (scroller.scrollHeight - h0);
      requestAnimationFrame(() => (scroller.style.overflowAnchor = ''));
    } finally {
      busy = false;
      edges?.unobserve(top);
      edges?.observe(top);
    }
  }
  const edges = multi
    ? new IntersectionObserver(
        (entries) => {
          if (paged) return;
          for (const en of entries) if (en.isIntersecting) (en.target === bottom ? loadAfter() : loadBefore());
        },
        { root: scroller, rootMargin: '150% 0px 150% 0px' },
      )
    : null;
  if (multi) {
    endNote();
    edges.observe(top);
    edges.observe(bottom);
  }

  const imgsOf = (i = cur) => mounted.get(i)?.imgs ?? [];
  function goTo(n, smooth, pos = 0, i = cur) {
    const img = imgsOf(i)[n - 1];
    if (!img) return;
    if (paged) {
      strip.goTo(n, smooth);
      return;
    }
    scrollToPage(scroller, img, smooth, pos);
    // Pages above us finish loading and change height; settle onto the target once more afterwards.
    if (!smooth) setTimeout(() => scrollToPage(scroller, img, false, pos), 400);
  }

  return {
    setWidth(px) {
      pagesEl.style.setProperty('--page-w', `${px}px`);
    },
    pageEl: (n) => imgsOf()[n - 1],
    setPart(id) {
      const i = list.findIndex((p) => p.id === id);
      if (i >= 0) cur = i;
    },
    goTo,
    /** To a page of any part of the series; a part that isn't attached yet replaces what is shown. */
    async goToPart(id, page = 1, smooth = false) {
      const i = list.findIndex((p) => p.id === id);
      if (i < 0) return;
      if (!mounted.has(i)) {
        if (busy) return;
        busy = true;
        try {
          for (const [, m] of mounted) for (const img of m.imgs) tracker.unobserve(img);
          mounted.clear();
          const nodes = await build(i, false);
          pagesEl.replaceChildren(top, ...nodes, bottom);
          scroller.scrollTop = 0;
          scroller.scrollLeft = 0;
        } finally {
          busy = false;
          endNote();
          if (!paged) { edges.unobserve(top); edges.observe(top); edges.unobserve(bottom); edges.observe(bottom); }
        }
        smooth = false;
        cur = i; // from here on the new part is the one being read
      }
      const n = page === 'last' ? imgsOf(i).length : page;
      goTo(n, smooth, 0, i);
      if (paged) setTimeout(() => (cur === i ? strip.reportNow() : null), 80);
    },
    /** Paged mode: n pages forward (negative: back), carrying on into the next / previous part at the ends. */
    step(n) {
      if (!paged) return;
      const at = strip.current() + 1 + n;
      const count = imgsOf().length;
      if (at >= 1 && at <= count) return goTo(at, true);
      const j = cur + (n > 0 ? 1 : -1);
      if (multi && list[j]) return this.goToPart(list[j].id, n > 0 ? 1 : 'last', false);
      if (!multi || !list[j]) env?.toast?.(n > 0 ? 'End of the last page' : 'This is the first page');
    },
    setMode(mode, rtl) {
      const want = mode === 'paged';
      if (want === paged) return;
      paged = want;
      strip.set(paged);
      if (paged && multi) {
        // One part at a time here: drop the others (the next one is opened when you turn past the end).
        for (const [i, m] of [...mounted]) {
          if (i === cur) continue;
          for (const img of m.imgs) tracker.unobserve(img);
          m.nodes.forEach((n) => n.remove());
          mounted.delete(i);
        }
      } else if (!paged && multi) {
        endNote();
        edges.unobserve(top); edges.observe(top);
        edges.unobserve(bottom); edges.observe(bottom);
      }
    },
    destroy() {
      strip.destroy();
      tracker.disconnect();
      edges?.disconnect();
      for (const [, m] of mounted) for (const img of m.imgs) img.removeAttribute('src');
    },
  };
}

// ====================================================================== PDF
async function pdfImpl(book, scroller, pagesEl, makeTracker, setTotal, ann = null, env = null) {
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
  let paged = env?.mode === 'paged';
  let strip = null; // created once the pages exist (needs their count)
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2.5);

  const pages = [];
  const tracker = makeTracker((el) => Number(el.dataset.page));

  // Scrolling: every page is `width` wide. One at a time: each page is as large as fits the window.
  const widthOf = (p) => (paged ? Math.max(80, Math.floor(Math.min(strip.vw, strip.vh / (ratios[p.n - 1] ?? aspect)))) : width);
  const sizeEl = (p) => {
    const w = widthOf(p);
    p.el.style.width = `${w}px`;
    p.el.style.height = `${Math.round(w * (ratios[p.n - 1] ?? aspect))}px`;
    p.el.style.margin = paged ? `0 ${Math.max(0, (strip.vw - w) / 2)}px` : ''; // the slot is exactly one window wide
  };

  for (let n = 1; n <= count; n++) {
    const el = h('div', { class: 'pdf-page', dataset: { page: n } });
    const p = { n, el, canvas: null, textDiv: null, rendering: null, renderedWidth: 0, visible: false, token: 0 };
    pages.push(p);
    tracker.observe(el);
  }
  pagesEl.append(...pages.map((p) => p.el));
  strip = pagedStrip(scroller, pagesEl, {
    getCount: () => count,
    getRtl: () => !!env?.rtl,
    report: (n) => env?.report(n),
    onResize: (n) => {
      pages.forEach(sizeEl);
      pages.filter((p) => p.visible).forEach(render);
      strip.goTo(n, false);
    },
  });
  strip.set(paged);
  if (paged) pages.forEach(sizeEl);

  async function render(p) {
    const w = widthOf(p);
    if (p.renderedWidth === w && p.canvas) return;
    const token = ++p.token;
    p.rendering?.cancel?.();
    try {
      const page = await doc.getPage(p.n);
      if (token !== p.token || !p.visible) return;
      const base = page.getViewport({ scale: 1 });
      ratios[p.n - 1] = base.height / base.width;
      const scale = w / base.width;
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
      p.renderedWidth = w;
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
  let lifecycle = null;
  function watchVisibility() {
    lifecycle?.disconnect();
    lifecycle = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const p = pages[Number(en.target.dataset.page) - 1];
          p.visible = en.isIntersecting;
          if (p.visible) render(p);
          else release(p);
        }
      },
      { root: scroller, rootMargin: paged ? '0px 150% 0px 150%' : '200% 0px 200% 0px' },
    );
    pages.forEach((p) => lifecycle.observe(p.el));
  }
  watchVisibility();

  // Learn real page sizes in the background so placeholders (and the scrollbar) become accurate.
  let sizing = true;
  (async () => {
    for (let i = 2; i <= count && sizing; i++) {
      try {
        const pg = await doc.getPage(i);
        const v = pg.getViewport({ scale: 1 }); // includes /Rotate and the crop box, like the real render
        ratios[i - 1] = v.height / v.width;
        const pg2 = pages[i - 1];
        if (!pg2.canvas) sizeEl(pg2);
        else if (paged && pg2.renderedWidth !== widthOf(pg2)) render(pg2);
        pg.cleanup();
      } catch {
        /* keep placeholder */
      }
      if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
    }
  })();

  return {
    setWidth(px) {
      if (paged) {
        width = px; // used again when you go back to scrolling
        return;
      }
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
      if (paged) {
        strip.goTo(n, smooth);
        return;
      }
      scrollToPage(scroller, p.el, smooth, pos);
      if (!smooth) setTimeout(() => scrollToPage(scroller, p.el, false, pos), 500);
    },
    /** Paged mode: n pages forward (negative: back). */
    step(n) {
      if (!paged) return;
      const at = strip.current() + 1 + n;
      if (at < 1 || at > count) return env?.toast?.(n > 0 ? 'End of the last page' : 'This is the first page');
      this.goTo(at, true);
    },
    setMode(mode) {
      const want = mode === 'paged';
      if (want === paged) return;
      paged = want;
      strip.set(paged);
      pages.forEach(sizeEl);
      watchVisibility(); // a different distance counts as "near" in each layout
      pages.filter((p) => p.visible).forEach(render);
    },
    destroy() {
      strip.destroy();
      sizing = false;
      tracker.disconnect();
      lifecycle?.disconnect();
      pages.forEach(release);
      task.destroy().catch(() => {});
    },
  };
}
