import { api, fileUrl, pageUrl } from './api.js';
import { createAnnotations } from './annotations.js';
import { bookName, onSettings, setSetting, settings } from './settings.js';
import { h, hashFor, icon, clamp, dirSegments, goBack } from './util.js';
import { appName } from './store.js';
import { openFileInfo } from './fileinfo.js';
import { openWithMenu } from './openwith.js';
import { epubImpl } from './epubreader.js';
import { toast } from './ui.js';
import { clearMarks, createSearch, markMatches } from './search.js';

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

  // Searching the text: PDFs and EPUBs (comics are pictures).
  const search = isEpub || book.format === 'pdf' ? createSearch({ source: () => impl?.searchSource ?? null, getUnit: () => currentPage - 1 }) : null;

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
  const modeKey = book.format === 'pdf' ? 'modePdf' : isEpub ? 'modeEpub' : 'modeComic';
  const wantMode = () => (settings[modeKey] === 'paged' ? 'paged' : 'scroll');
  const wantRtl = () => book.format === 'cbz' && settings.rtlComic === 'rtl';
  // Two pages side by side (PDF and comics), in either mode; the first page can stay on its own, like a cover.
  const spreadKey = book.format === 'pdf' ? 'spreadPdf' : 'spreadComic';
  const wantSpread = () => !isEpub && settings[spreadKey] === 'double';
  const wantCover = () => settings.spreadCover !== false;
  let mode = wantMode();
  let rtl = wantRtl();
  let spread = wantSpread();
  let cover = wantCover();

  const titleEl = h('div', { class: 'reader-title' });
  const widthKey = book.format === 'pdf' ? 'pdfWidth' : isEpub ? 'epubWidth' : 'comicWidth';
  const pageInput = h('input', { class: 'page-input', type: 'text', inputMode: 'numeric', value: '1', 'aria-label': 'Page number' });
  const pageTotal = h('span', { class: 'muted' }, total ? `/ ${total}` : '');
  /** EPUB: the page number is an estimate (about 1800 characters a page), so it is shown and typed as one. */
  const estPage = () => clamp(Math.ceil(bookFraction() * estPages), 1, Math.max(1, estPages));
  function epubBox() {
    if (!isEpub) return;
    pageBox.classList.toggle('hidden', !estPages);
    pageTotal.textContent = estPages ? `/ ~${estPages}` : '';
    pageTotal.title = 'Estimated pages, about 1800 characters each';
    if (document.activeElement !== pageInput) pageInput.value = String(estPage());
  }
  const bar = h(
    'div',
    { class: 'reader-bar' },
    h('a', { class: 'icon-btn', href: backHref, title: 'Back to library (Esc)', onClick: (e) => { e.preventDefault(); goBack(backHref); } }, icon('back')),
    titleEl,
    h('div', { class: 'series-nav hidden' },
      h('button', { class: 'icon-btn', title: 'Previous part (<)', onClick: () => goPart(-1) }, icon('prev', 16)),
      h('span', { class: 'muted part-where' }),
      h('button', { class: 'icon-btn', title: 'Next part (>)', onClick: () => goPart(1) }, icon('next', 16)),
    ),
    h('div', { class: 'reader-page' }, pageInput, pageTotal),
    isEpub ? h('div', { class: 'epub-where muted', title: 'How far through the book' }) : null,
    ann ? h('span', { class: 'bar-sep' }) : null,
    ann ? ann.toolbar : null,
    h('span', { class: 'bar-sep' }),
    h('button', { class: 'icon-btn', title: 'Open this book in one of your programs, at this page', onClick: (e) => { const n = isEpub ? (estPages ? estPage() : 0) : parseInt(pageInput.value, 10); openWithMenu(e.currentTarget, { bookIds: [book.id], ...(n > 0 ? { page: n } : {}) }, 1); } }, icon('external', 18)),
    search ? search.button : null,
    h('button', { class: 'icon-btn', title: 'File info (I)', onClick: () => openFileInfo(book, ann, { coverFromPage }) }, icon('info', 18)),
    h('span', { class: 'bar-sep' }),
    h('button', { class: 'icon-btn mode-btn', title: 'Reading mode (M)', onClick: () => toggleMode() }, icon('paged', 18)),
    isEpub ? null : h('button', { class: 'icon-btn spread-btn', title: 'Two pages side by side (S)', onClick: () => toggleSpread() }, icon('spread', 18)),
    book.format === 'cbz' ? h('button', { class: 'icon-btn dir-btn', title: 'Page order: left to right or right to left (D)', onClick: () => setSetting('rtlComic', settings.rtlComic === 'rtl' ? 'ltr' : 'rtl') }) : null,
    h('div', { class: 'reader-zoom' },
      h('span', { class: 'bar-sep' }),
      h('button', { class: 'icon-btn', title: 'Narrower (−)', onClick: () => zoom(-1) }, '−'),
      h('span', { class: 'muted zoom-val' }, `${settings[widthKey]}px`),
      h('button', { class: 'icon-btn', title: 'Wider (+)', onClick: () => zoom(1) }, '+'),
      h('button', { class: 'icon-btn', title: 'Fit to window (0)', onClick: fitWidth }, icon('fullscreen', 16)),
    ),
  );
  const zoomVal = bar.querySelector('.zoom-val');
  const seriesNav = bar.querySelector('.series-nav');
  const modeBtn = bar.querySelector('.mode-btn');
  const spreadBtn = bar.querySelector('.spread-btn');
  const pageBox = bar.querySelector('.reader-page');
  if (isEpub) pageBox.classList.add('hidden'); // until the book says how long it is
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
    return estPages ? `p. ~${estPage()}/~${estPages} · ${bookPercent()}%` : `${bookPercent()}%`;
  }
  function updateCount() {
    let t = '';
    if (isEpub) t = weights ? epubWhere() : '';
    else if (total && currentPage > 0) {
      const g = spread ? impl?.spreadOf?.(currentPage) : null;
      t = `${g && g.length > 1 ? `${g[0]}–${g[g.length - 1]}` : currentPage} / ${total}`;
    }
    countEl.textContent = t;
    countEl.classList.toggle('hidden', !t);
  }
  setTitles();
  const unsubName = onSettings((k) => k === 'nameSource' && setTitles());
  const progressLine = h('div', { class: 'reader-progress' }, h('i'));
  root.append(bar, scroller, progressLine, countEl);
  if (ann) root.append(ann.drawer);
  if (search) root.append(search.panel);

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
    partWhere.replaceChildren(h('span', null, `Part ${partIdx + 1}/${parts.length}`), h('small', { class: 'part-name' }, bookName(book)));
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
    if (root.classList.contains('bar-off')) toast(`Part ${i + 1} of ${parts.length}: ${bookName(book)}`, 'quiet'); // the toolbar says it otherwise
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
    if (whereEl) whereEl.textContent = `${bookPercent()}%`;
    epubBox();
    updateCount();
    if (sectionChanged || bookPercent() !== lastPct) setTitles();
    lastPct = bookPercent();
    progressLine.firstChild.style.width = `${bookFraction() * 100}%`;
    paintEdges();
    queueSave();
  }
  let lastPct = -1;
  /**
   * An open book has a stack of pages on either side. Mostly the thickness fills in quickly, so a book looks substantial
   * after a fifth of it (at most 40 pages) and thins out again over the last stretch; the rest stays in proportion to the
   * pages on that side, so the two stacks still tell you how far through you are. On the final spread the unread side is
   * flat and all the volume is on the left.
   */
  function paintEdges() {
    if (isEpub || !(total > 1)) return;
    const g = spread ? impl?.spreadOf?.(currentPage) : null;
    const behind = Math.max(0, (g ? Math.min(...g) : currentPage) - 1);
    const ahead = Math.max(0, total - (g ? Math.max(...g) : currentPage));
    const ref = Math.max(1, Math.min(40, total * 0.2));
    const full = clamp(total / 14, 2, 14); // a long book is a thick one
    const side = (n) => {
      const quick = 1 - (1 - Math.min(1, n / ref)) ** 2;
      return n <= 0 ? 1 : 1 + full * (0.6 * quick + 0.4 * (n / total));
    };
    root.style.setProperty('--edge-read', `${side(behind).toFixed(2)}px`);
    root.style.setProperty('--edge-rest', `${side(ahead).toFixed(2)}px`);
  }

  function setCurrent(n, partId) {
    if (partId != null && parts && partId !== book.id) switchPart(partId);
    n = clamp(n, 1, total || 1);
    if (n === currentPage) return;
    currentPage = n;
    if (!settling) currentPos = readingPos();
    pageInput.value = String(n);
    setTitles();
    paintProgress();
    paintEdges();
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
    root.classList.toggle('double', spread);
    root.classList.toggle('rtl', (mode === 'paged' || spread) && rtl);
    if (spreadBtn) {
      spreadBtn.classList.toggle('on', spread);
      spreadBtn.title = spread ? 'Two pages side by side: switch to single pages (S)' : 'Single pages: switch to two pages side by side (S)';
    }
    if (modeBtn) {
      modeBtn.classList.toggle('on', mode === 'paged');
      modeBtn.title = mode === 'paged' ? 'One page at a time: switch to continuous scroll (M)' : 'Continuous scroll: switch to one page at a time (M)';
    }
    if (dirBtn) {
      dirBtn.classList.toggle('hidden', mode !== 'paged' && !spread);
      dirBtn.textContent = rtl ? 'RTL' : 'LTR';
      dirBtn.title = rtl ? 'Right to left (manga): click for left to right (D)' : 'Left to right: click for right to left (manga) (D)';
    }
  }
  function toggleMode() {
    setSetting(modeKey, mode === 'paged' ? 'scroll' : 'paged');
  }
  function toggleSpread() {
    if (isEpub) return;
    setSetting(spreadKey, spread ? 'single' : 'double');
  }
  function applyMode(k) {
    if (k !== modeKey && k !== 'rtlComic' && k !== spreadKey && k !== 'spreadCover' && k !== '*') return;
    const m = wantMode();
    const r = wantRtl();
    const sp = wantSpread();
    const cv = wantCover();
    if (m === mode && r === rtl && sp === spread && cv === cover) return;
    mode = m;
    rtl = r;
    spread = sp;
    cover = cv;
    if (isEpub && impl) impl.setMode?.(mode, rtl); // first: it notes where you are before the layout changes under it
    showMode();
    if (!impl || isEpub) return;
    settling = true; // the layout is about to move under us; don't read that as the reader scrolling
    impl.setMode?.(mode, rtl);
    updateCount();
    const pos = mode === 'scroll' ? currentPos : 0;
    impl.goTo(currentPage || 1, false, pos);
    setTimeout(() => (settling = false), 900);
  }
  const unsubMode = onSettings(applyMode);
  showMode();

  /** Paged mode: turn n pages forward (negative: back), in reading order. */
  function turn(n) {
    impl?.step?.(n);
  }
  /**
   * ← / → while scrolling: no animation, so it is as quick as the key repeats. A page wider than the window moves
   * sideways; otherwise it is the previous / next page (or spread, or EPUB section).
   */
  /** A small JPEG of the page being read, as the reader drew it, to use as the book's cover (null for EPUB / not drawn yet). */
  async function coverFromPage() {
    if (isEpub) return null;
    const sel = book.format === 'pdf' ? `.pdf-page[data-page="${currentPage}"] canvas` : `.comic-page[data-page="${currentPage}"][data-part="${parts?.[partIdx]?.id ?? ''}"]`;
    const src = pagesEl.querySelector(sel) ?? (book.format === 'pdf' ? null : pagesEl.querySelector(`.comic-page[data-page="${currentPage}"]`));
    const w = src?.naturalWidth || src?.width;
    if (!src || !w || (src.complete === false)) return null;
    const out = document.createElement('canvas');
    out.width = Math.min(800, w);
    out.height = Math.round(((src.naturalHeight || src.height) * out.width) / w);
    out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
    const blob = await new Promise((ok) => out.toBlob(ok, 'image/jpeg', 0.9));
    return blob ? { blob, bookId: parts?.[partIdx]?.id ?? book.id } : null;
  }

  function sideStep(dir) {
    if (isEpub) return impl?.step(dir);
    if (scroller.scrollWidth > scroller.clientWidth + 2) return scroller.scrollBy({ left: dir * Math.max(160, scroller.clientWidth * 0.15), behavior: 'instant' });
    // The page counter lags a moment behind a jump, so quick presses (or a held key) count from where the last one went.
    const from = Date.now() - sideAt.t < 700 ? sideAt.n : currentPage;
    const g = spread ? impl?.spreadOf?.(from) : null;
    const to = dir > 0 ? (g ? Math.max(...g) : from) + 1 : (g ? Math.min(...g) : from) - 1;
    if (to < 1 || to > (total || 1)) return;
    sideAt = { n: to, t: Date.now() };
    impl?.goTo(to, false);
  }
  let sideAt = { n: 0, t: 0 };

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
      const txt = pageInput.value.trim();
      const n = parseInt(txt, 10);
      if (isEpub) {
        // A page of the estimate ("120"), or a share of the book ("45%").
        if (Number.isFinite(n) && weights && impl?.goToPos) {
          const frac = txt.endsWith('%') ? clamp(n / 100, 0, 1) : clamp((clamp(n, 1, Math.max(1, estPages)) - 0.5) / Math.max(1, estPages), 0, 1);
          const at = locate(frac);
          impl.goToPos(at.sec, at.pos);
        }
      } else if (Number.isFinite(n)) impl?.goTo(clamp(n, 1, total || 1), true);
      pageInput.blur();
    }
    e.stopPropagation();
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  pageInput.addEventListener('blur', () => (pageInput.value = String(isEpub ? estPage() : currentPage)));
  /** EPUB: which section, and how far into it, a share of the whole book falls on (by amount of text). */
  function locate(frac) {
    const target = clamp(frac, 0, 1) * weights.total;
    let acc = 0;
    for (let k = 0; k < weights.length; k++) {
      if (target < acc + weights[k] || k === weights.length - 1) return { sec: k + 1, pos: weights[k] ? clamp((target - acc) / weights[k], 0, 1) : 0 };
      acc += weights[k];
    }
    return { sec: 1, pos: 0 };
  }

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
    // Ctrl+F: ours, because the browser's find can't see pages and sections that aren't drawn right now.
    if (search && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      search.open();
      return;
    }
    if (e.target?.tagName === 'INPUT' || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.getElementById('modal-root').childElementCount) return;
    switch (e.key) {
      case 'Escape': if (!search?.consumeEscape() && !ann?.consumeEscape() && !impl?.consumeEscape?.()) goBack(backHref); break;
      case '/': if (search) { search.open(); e.preventDefault(); } break;
      case 'ArrowLeft': if (mode === 'paged') turn(rtl ? 1 : -1); else sideStep(-1); e.preventDefault(); break;
      case 'ArrowRight': if (mode === 'paged') turn(rtl ? -1 : 1); else sideStep(1); e.preventDefault(); break;
      case 'm': case 'M': toggleMode(); break;
      case 'd': case 'D': if (dirBtn && (mode === 'paged' || spread)) setSetting('rtlComic', rtl ? 'ltr' : 'rtl'); break;
      case 's': case 'S': toggleSpread(); break;
      case 'g': case 'G': pageInput.focus(); e.preventDefault(); break;
      case '<': goPart(-1); break;
      case '>': goPart(1); break;
      case '[': impl?.fontStep?.(-1); break;
      case ']': impl?.fontStep?.(1); break;
      case 't': case 'T': impl?.toggleToc?.(); break;
      case 'n': case 'N': ann?.toggleDrawer(); break;
      case 'i': case 'I': openFileInfo(book, ann, { coverFromPage }); break;
      case '+': case '=': zoom(1); break;
      case '-': case '_': zoom(-1); break;
      case '0': fitWidth(); break;
      case 'Home': if (isEpub && mode === 'paged') impl?.goTo(1); else if (mode === 'paged') impl?.goTo(1, false); else scroller.scrollTo({ top: 0 }); e.preventDefault(); break;
      case 'End': if (isEpub && mode === 'paged') impl?.goToPos?.(Math.max(1, total), 1); else if (mode === 'paged') impl?.goTo(total || 1, false); else scroller.scrollTo({ top: scroller.scrollHeight }); e.preventDefault(); break;
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
          // Two pages side by side count as one place: the first of the two.
          const row = en.target.parentElement?.classList.contains('spread') ? en.target.parentElement.firstElementChild : en.target;
          const at = getIndex(row);
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
    get spread() { return spread; },
    get cover() { return cover; },
    get page() { return currentPage; },
    report: (n, partId) => (partId != null ? setCurrent(n, partId) : setCurrent(n)),
    toast: (m) => toast(m, 'quiet'),
  };
  const status = h('div', { class: 'empty' }, 'Opening…');
  pagesEl.append(status);

  (async () => {
    try {
      if (book.format === 'pdf') impl = await pdfImpl(book, scroller, pagesEl, makeTracker, (n) => (total = n, pageTotal.textContent = `/ ${n}`, setTitles(), paintEdges()), ann, env);
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
          root, scroller, pagesEl, bar, report: setPosition, onKey, onClick: onReadClick, onFind: () => search?.open(), getMode: () => mode,
          setTotal: (n, chars, pages) => {
            total = n;
            weights = chars;
            weights.total = chars.reduce((a, b) => a + b, 0) || 1;
            if (pages) estPages = pages;
            epubBox();
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
        updateCount(); // the counter and the page block's edges say where you are from the start, not after the first scroll
        paintEdges();
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
      search?.destroy();
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

// ====================================================================== two pages side by side
/**
 * Which pages are shown together. The first page stands alone (a cover) when `cover` is set, a page that is
 * already a spread (wider than tall) stands alone, and the rest pair up in order. Returns [[1], [2, 3], ...].
 */
/** The number written under a row of pages: "12", or "12–13". */
const folioOf = (g) => (g.length > 1 ? `${g[0]}–${g[g.length - 1]}` : String(g[0]));

function groupSpreads(count, { cover, wide }) {
  const groups = [];
  let n = 1;
  while (n <= count) {
    if ((n === 1 && cover) || wide(n) || n === count || wide(n + 1)) groups.push([n++]);
    else groups.push([n, (n += 2) - 1]);
  }
  return groups;
}

// ====================================================================== paged layout
/**
 * Shared by the PDF and comic readers. In "one page at a time" mode every page owns a slot exactly as
 * wide as the viewport and the pages sit side by side in a horizontally scrolling, snapping strip, so
 * which page you are on is simply how far across you have scrolled. (The CSS is under `.reader.paged`.)
 * In right-to-left mode the strip runs the other way and scrollLeft is negative.
 */
function pagedStrip(scroller, pagesEl, { getCount, slotOf = (n) => n - 1, pageOf = (i) => i + 1, getRtl, report, onResize }) {
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
  const reportNow = () => report(pageOf(index()));
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
      onResize?.(pageOf(keep));
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
    /** To the slot (one page, or two side by side) with this index. */
    goSlot(i, smooth) {
      measure();
      heading = { i, t: Date.now() };
      scroller.scrollTo({ left: (getRtl() ? -1 : 1) * i * vw, top: 0, behavior: smooth && settings.pagedAnimation !== false ? 'smooth' : 'instant' });
    },
    /** To the slot that shows page n. */
    goTo(n, smooth) {
      this.goSlot(slotOf(n), smooth);
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
  let spread = !!env?.spread;
  let cover = env?.cover !== false;
  // Two-page view groups a part's pages into rows of two (see groupSpreads); `groups` is kept per mounted part.
  const slotsOf = (i = cur) => { const m = mounted.get(i); return m?.groups ? m.groups.length : m?.imgs.length ?? 0; };
  const strip = pagedStrip(scroller, pagesEl, {
    getCount: () => slotsOf(),
    slotOf: (n) => { const g = mounted.get(cur)?.groups; return g ? Math.max(0, g.findIndex((x) => x.includes(n))) : n - 1; },
    pageOf: (i) => { const g = mounted.get(cur)?.groups; return g ? g[Math.min(i, g.length - 1)][0] : i + 1; },
    getRtl: () => !!env?.rtl,
    report: (n) => env?.report(n, list[cur].id),
  });
  strip.set(paged);

  /** The nodes that hold a part's pages: the images themselves, or rows of two. */
  function layoutOf(m) {
    if (!spread) {
      m.groups = null;
      return m.imgs;
    }
    const wide = (n) => m.imgs[n - 1].classList.contains('wide');
    m.groups = groupSpreads(m.imgs.length, { cover, wide });
    return m.groups.map((g) => h('div', { class: `spread comic-spread${g.length === 1 ? ' lone' : ''}${g.length === 1 && wide(g[0]) ? ' wide' : ''}`, dataset: { folio: folioOf(g) } }, ...g.map((n) => m.imgs[n - 1])));
  }
  const nodesOf = (m) => [...(m.head ? [m.head] : []), ...m.body, ...(m.extra ?? [])];
  /** Lay a part out again (one page or two, a different pairing) where it already is in the document. */
  function rearrange(i) {
    const m = mounted.get(i);
    if (!m?.body.length) return;
    const mark = document.createComment('');
    m.body[0].before(mark);
    const old = m.body;
    m.body = layoutOf(m);
    mark.before(...m.body);
    mark.remove();
    for (const n of old) if (!m.body.includes(n)) n.remove(); // the old rows (their pages have moved)
    m.nodes = nodesOf(m);
  }
  /** A page turned out to be a double-page spread: pair the others around it, keeping what is on screen in place. */
  let regroupTimer = 0;
  function regroupSoon(i) {
    clearTimeout(regroupTimer);
    regroupTimer = setTimeout(() => {
      const m = mounted.get(i);
      if (!m || !spread) return;
      const wide = (n) => m.imgs[n - 1].classList.contains('wide');
      if (JSON.stringify(groupSpreads(m.imgs.length, { cover, wide })) === JSON.stringify(m.groups)) return;
      const keep = env?.page || 1;
      const el = imgsOf()[keep - 1];
      const before = el?.getBoundingClientRect().top ?? 0;
      rearrange(i);
      if (paged) strip.goTo(keep, false);
      else if (el) scroller.scrollTop += el.getBoundingClientRect().top - before;
    }, 150);
  }

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
      img.addEventListener('load', () => {
        img.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`;
        const wide = img.naturalWidth > img.naturalHeight * 1.05; // a double-page spread in one image
        if (wide !== img.classList.contains('wide')) {
          img.classList.toggle('wide', wide);
          if (spread) regroupSoon(i);
        }
      });
      img.addEventListener('error', () => img.classList.add('broken'));
      img.src = pageUrl(part, n);
      imgs.push(img);
      tracker.observe(img);
    }
    const head = multi ? h('div', { class: 'part-head' }, h('small', null, `Part ${i + 1} of ${list.length}`), h('span', null, bookName(part))) : null;
    const extra = multi && !count ? [h('div', { class: 'part-head' }, 'This part could not be read')] : [];
    const m = { imgs, head, extra, groups: null, body: imgs, nodes: [] };
    mounted.set(i, m);
    m.body = layoutOf(m);
    m.nodes = nodesOf(m);
    return m.nodes;
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
  let settleTimer = 0;
  function goTo(n, smooth, pos = 0, i = cur) {
    const img = imgsOf(i)[n - 1];
    if (!img) return;
    if (paged) {
      strip.goTo(n, smooth);
      return;
    }
    scrollToPage(scroller, img, smooth, pos);
    // Pages above us finish loading and change height; settle onto the target once more afterwards.
    clearTimeout(settleTimer); // a newer jump replaces the settling of an older one
    if (!smooth) settleTimer = setTimeout(() => scrollToPage(scroller, img, false, pos), 400);
  }

  return {
    setWidth(px) {
      pagesEl.style.setProperty('--page-w', `${px}px`);
    },
    pageEl: (n) => imgsOf()[n - 1],
    spreadOf: (n) => mounted.get(cur)?.groups?.find((g) => g.includes(n)) ?? null,
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
      const at = strip.current() + n;
      if (at >= 0 && at < slotsOf()) return strip.goSlot(at, true);
      const j = cur + (n > 0 ? 1 : -1);
      if (multi && list[j]) return this.goToPart(list[j].id, n > 0 ? 1 : 'last', false);
      if (!multi || !list[j]) env?.toast?.(n > 0 ? 'End of the last page' : 'This is the first page');
    },
    setMode() {
      const wantPaged = env?.mode === 'paged';
      const wantSpread = !!env?.spread;
      const wantCover = env?.cover !== false;
      if (wantPaged === paged && wantSpread === spread && wantCover === cover) return;
      const wasPaged = paged;
      paged = wantPaged;
      spread = wantSpread;
      cover = wantCover;
      strip.set(paged);
      if (paged && multi) {
        // One part at a time here: drop the others (the next one is opened when you turn past the end).
        for (const [i, m] of [...mounted]) {
          if (i === cur) continue;
          for (const img of m.imgs) tracker.unobserve(img);
          m.nodes.forEach((n) => n.remove());
          mounted.delete(i);
        }
      } else if (!paged && multi && wasPaged) {
        endNote();
        edges.unobserve(top); edges.observe(top);
        edges.unobserve(bottom); edges.observe(bottom);
      }
      for (const i of mounted.keys()) rearrange(i);
    },
    destroy() {
      clearTimeout(regroupTimer);
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
  let spread = !!env?.spread;
  let cover = env?.cover !== false;
  let groups = null; // two-page view: [[1], [2, 3], ...], what is shown together
  let slotOfPage = [];
  let strip = null; // created once the pages exist (needs their count)
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2.5);

  const pages = [];
  const tracker = makeTracker((el) => Number(el.dataset.page));

  // Scrolling: every page is `width` wide (two side by side share it). One at a time: each page is as large as
  // fits the window (two side by side: as fits half of it). A page that is already a spread keeps the whole room.
  const isWide = (n) => (ratios[n - 1] ?? 9) < 0.95;
  const share = (p) => (spread && !p.wide ? 2 : 1);
  const widthOf = (p) => (paged ? Math.max(80, Math.floor(Math.min(strip.vw / share(p), strip.vh / (ratios[p.n - 1] ?? aspect)))) : Math.max(80, Math.floor(width / share(p))));
  const sizeEl = (p) => {
    const w = widthOf(p);
    p.el.style.width = `${w}px`;
    p.el.style.height = `${Math.round(w * (ratios[p.n - 1] ?? aspect))}px`;
    p.el.style.margin = paged && !spread ? `0 ${Math.max(0, (strip.vw - w) / 2)}px` : ''; // the slot is exactly one window wide
  };
  /** Works out what is shown together (two-page view), without touching the document. */
  function plan() {
    groups = spread ? groupSpreads(count, { cover, wide: isWide }) : null;
    slotOfPage = [];
    (groups ?? []).forEach((g, i) => g.forEach((n) => (slotOfPage[n - 1] = i)));
    for (const p of pages) p.wide = !!groups && isWide(p.n) && groups[slotOfPage[p.n - 1]].length === 1;
  }
  /** Puts the pages in the document: one after another, or in rows of two. */
  function place() {
    // Scrolling, each page (or row of two) is followed by its number on the desk; turning pages, they are slots in a strip.
    pagesEl.replaceChildren(
      ...(groups
        ? groups.map((g) => h('div', { class: `spread${g.length === 1 ? ' lone' : ''}${pages[g[0] - 1].wide ? ' wide' : ''}`, dataset: { folio: folioOf(g) } }, ...g.map((n) => pages[n - 1].el)))
        : paged
          ? pages.map((p) => p.el)
          : pages.flatMap((p) => [p.el, h('div', { class: 'folio', 'aria-hidden': 'true' }, String(p.n))])),
    );
  }

  for (let n = 1; n <= count; n++) {
    const el = h('div', { class: 'pdf-page', dataset: { page: n } });
    const p = { n, el, canvas: null, textDiv: null, rendering: null, renderedWidth: 0, visible: false, token: 0 };
    pages.push(p);
    tracker.observe(el);
  }
  plan();
  place();
  strip = pagedStrip(scroller, pagesEl, {
    getCount: () => (groups ? groups.length : count),
    slotOf: (n) => (groups ? slotOfPage[n - 1] ?? 0 : n - 1),
    pageOf: (i) => (groups ? groups[Math.min(i, groups.length - 1)][0] : i + 1),
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

  /** The layout changed (paged or not, one page or two): rebuild what is on screen. */
  function relayout() {
    plan();
    place();
    pages.forEach(sizeEl);
    watchVisibility(); // a different distance counts as "near" in each layout
    pages.filter((p) => p.visible).forEach(render);
  }

  // ---- search: what the pages say, and the marks drawn over the text layers
  let sx = null; // { regex, cur: {unit, ord} | null } while a search is shown
  const texts = new Map();
  function applyMarks(p) {
    if (!p.textDiv) return null;
    if (!sx?.regex) {
      clearMarks(p.textDiv);
      return null;
    }
    return markMatches(p.textDiv, sx.regex, sx.cur && sx.cur.unit === p.n - 1 ? sx.cur.ord : -1);
  }
  const searchSource = {
    count,
    label: (i) => `p. ${i + 1}`,
    /** Same text the text layer will hold: its items' strings, one after another. */
    async text(i) {
      if (!texts.has(i)) {
        const page = await doc.getPage(i + 1);
        const tc = await page.getTextContent();
        texts.set(i, tc.items.map((it) => it.str ?? '').join(''));
        page.cleanup();
      }
      return texts.get(i);
    },
    setMarks(regex, cur) {
      sx = regex ? { regex, cur } : null;
      for (const p of pages) if (p.textDiv) applyMarks(p);
    },
    async show({ unit }) {
      self.goTo(unit + 1, false);
      if (paged) return;
      // Scrolling: put the hit in the middle once its page has drawn.
      for (let k = 0; k < 30; k++) {
        const mk = pages[unit]?.el.querySelector('mark.srch.cur');
        if (mk) return mk.scrollIntoView({ block: 'center', inline: 'nearest' });
        await new Promise((r) => setTimeout(r, 100));
      }
    },
  };

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
      page.getTextContent().then(async (tc) => {
        if (token !== p.token) return;
        await new pdfjs.TextLayer({ textContentSource: tc, container: textDiv, viewport }).render();
        if (token === p.token) applyMarks(p);
      }).catch(() => {}).finally(() => page.cleanup()); // let go of the page's parsed operators and decoded images; they are rebuilt if it's drawn again
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

  // Render pages within ~1.3 screens of the viewport; free the rest so 1000-page PDFs don't eat RAM.
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
      { root: scroller, rootMargin: paged ? '0px 150% 0px 150%' : '130% 0px 130% 0px' },
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
    // Now every page's shape is known: a landscape page that was taken for a portrait one changes the pairing.
    if (spread && sizing && JSON.stringify(groupSpreads(count, { cover, wide: isWide })) !== JSON.stringify(groups)) {
      const keep = env?.page || 1;
      const el = pages[keep - 1]?.el;
      const before = el?.getBoundingClientRect().top ?? 0;
      relayout();
      if (paged) strip.goTo(keep, false);
      else if (el) scroller.scrollTop += el.getBoundingClientRect().top - before;
    }
  })();

  let settleTimer = 0;
  const self = {
    searchSource,
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
      clearTimeout(settleTimer); // a newer jump replaces the settling of an older one
      if (!smooth) settleTimer = setTimeout(() => scrollToPage(scroller, p.el, false, pos), 500);
    },
    /** Paged mode: n turns forward (negative: back); a turn is one page, or two side by side. */
    step(n) {
      if (!paged) return;
      const at = strip.current() + n;
      if (at < 0 || at >= (groups ? groups.length : count)) return env?.toast?.(n > 0 ? 'End of the last page' : 'This is the first page');
      strip.goSlot(at, true);
    },
    /** The pages shown together with page n (two-page view), or null. */
    spreadOf: (n) => groups?.[slotOfPage[n - 1]] ?? null,
    setMode() {
      const wantPaged = env?.mode === 'paged';
      const wantSpread = !!env?.spread;
      const wantCover = env?.cover !== false;
      if (wantPaged === paged && wantSpread === spread && wantCover === cover) return;
      paged = wantPaged;
      spread = wantSpread;
      cover = wantCover;
      strip.set(paged);
      relayout();
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
  return self;
}
