import { api } from './api.js';
import { h, icon, clamp } from './util.js';
import { toast } from './ui.js';
const toastError = (e) => toast(e.message, 'error');
import { COLORS, copyText, mergeLines, toastCopied } from './annotations.js';
import { locateOnPages } from './epubnotes.js';
import { fracOf, pageOf } from './epubpages.js';

// Selecting, highlighting and noting in the flip-through viewer (PDFs). It uses the same annotations the reader does: they are written inside the PDF by the
// server's existing routes, so nothing new is stored and other PDF programs show them too. What it adds here is small:
//  - each page picture is wrapped in a ".fa-page" box the exact shape of the picture, holding the highlights, note pins and drawings of that page, and, once
//    the spread has come to rest, an invisible layer of the page's words (from the server) so the text can be selected;
//  - selecting text shows a small pill with the colours, a note button and copy; clicking a highlight shows its note and lets you change or remove it.
// Drawing with the pen and notes dropped on empty paper stay in the reader; drawings that are already there are shown.

const SVG = 'http://www.w3.org/2000/svg';
const pct = (v) => `${(v * 100).toFixed(3)}%`;
const COLOR_KEY = 'shelf.annColor';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

/**
 * @param {{ book: object, pane: HTMLElement, layer: HTMLElement, changed?: () => void }} o
 *   pane: the open book (the pages are in it); layer: where popovers go (in front of everything, inside the viewer)
 */
export function createFlipNotes({ book, pane, layer, changed }) {
  let items = [];
  let canWrite = false;
  let reason = '';
  let supported = false;
  let pop = null;
  let lastColor = COLORS.some((c) => c[1] === store.get(COLOR_KEY)) ? store.get(COLOR_KEY) : COLORS[0][1];
  const base = `/books/${book.id}/annotations`;
  // An EPUB's highlights are kept by Shelf, not in the file, and told by their words and how far through the book they are (see epubnotes.js); here they are
  // found on the viewer's pages by those words.
  const isEpub = book.format === 'epub';
  const table = book.table;
  const located = new Map(); // highlight -> where its words are on the pages
  const shown = new Map(); // page -> promise of [{ a, rects, first }]
  const shownVals = new Map(); // ... and the list itself, once there
  const wordVals = new Map(); // page -> its words, once they are here
  const ready = api.get(base).then(
    (r) => { items = r.items; canWrite = r.canWrite; reason = r.reason ?? ''; supported = r.supported; if (isEpub && !table?.exact) supported = false; },
    () => { supported = false; },
  );

  // ------------------------------------------------------------ what a page shows
  const pageItems = (n) => items.filter((a) => a.page === n);

  function annLayer(n, ratio) {
    const box = h('div', { class: 'fa-ann' });
    if (!supported) return box;
    if (isEpub) {
      shownOn(n).then((list) => {
        for (const { a, rects, first } of list) {
          for (const [x, y, w, hh] of rects) {
            const r = h('i', { class: 'fa-hl' });
            Object.assign(r.style, { left: pct(x), top: pct(y), width: pct(w), height: pct(hh), background: a.color });
            box.append(r);
          }
          if (a.note && first && rects[0]) {
            const pin = h('button', { class: 'fa-pin', title: a.note, 'aria-label': 'Note', onClick: (e) => { e.stopPropagation(); showItem(a, pin.getBoundingClientRect()); } }, icon('note', 11));
            Object.assign(pin.style, { left: pct(rects[0][0] + rects[0][2]), top: pct(rects[0][1]), background: a.color });
            box.append(pin);
          }
        }
      });
      return box;
    }
    const its = pageItems(n);
    const inks = its.filter((a) => a.kind === 'ink');
    if (inks.length) {
      const svg = document.createElementNS(SVG, 'svg');
      svg.setAttribute('class', 'fa-ink');
      svg.setAttribute('viewBox', `0 0 1 ${ratio}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      for (const a of inks) for (const st of a.strokes) {
        const p = document.createElementNS(SVG, 'path');
        p.setAttribute('d', 'M' + st.map(([x, y]) => `${x.toFixed(4)} ${(y * ratio).toFixed(4)}`).join('L'));
        p.setAttribute('stroke', a.color);
        p.setAttribute('stroke-width', String(a.width ?? 0.004));
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        svg.append(p);
      }
      box.append(svg);
    }
    for (const a of its) {
      if (a.kind === 'highlight') {
        for (const [x, y, w, hh] of a.rects) {
          const r = h('i', { class: 'fa-hl' });
          Object.assign(r.style, { left: pct(x), top: pct(y), width: pct(w), height: pct(hh), background: a.color });
          box.append(r);
        }
      }
      const at = a.kind === 'highlight' ? (a.note && a.rects[0] ? [a.rects[0][0] + a.rects[0][2], a.rects[0][1]] : null) : a.kind === 'note' ? a.point : null;
      if (at) {
        const pin = h('button', { class: 'fa-pin', title: a.note ?? '', 'aria-label': 'Note', onClick: (e) => { e.stopPropagation(); showItem(a, pin.getBoundingClientRect()); } }, icon('note', 11));
        Object.assign(pin.style, { left: pct(at[0]), top: pct(at[1]), background: a.color });
        box.append(pin);
      }
    }
    return box;
  }

  /** The box for one page picture: exactly the picture's shape, centred in the half it sits in. */
  function pageBox(n, img) {
    const nw = img.naturalWidth || 1;
    const nh = img.naturalHeight || 1;
    const box = h('div', { class: 'fa-page', dataset: { n } }, annLayer(n, nh / nw));
    box.style.setProperty('--r', String(nw / nh));
    return h('div', { class: 'fa-fit' }, box); // (the fitting box is the one that measures its parent; the half itself is left alone so its size never depends on it)
  }
  function refresh(n) {
    for (const box of pane.querySelectorAll(`.fa-page[data-n="${n}"]`)) {
      const ratio = 1 / Number(box.style.getPropertyValue('--r') || 0.7);
      box.querySelector(':scope > .fa-ann')?.replaceWith(annLayer(n, ratio));
    }
  }

  // ------------------------------------------------------------ the words, for selecting
  const wordCache = new Map();
  const wordsOf = (n) => {
    let p = wordCache.get(n);
    if (!p) {
      p = api.get(`/books/${book.id}/peek/${n}/text`).then((r) => r.words, () => []);
      wordCache.set(n, p);
      if (wordCache.size > 40) wordCache.delete(wordCache.keys().next().value);
    }
    return p;
  };
  /** The highlights on a page of an EPUB, with the boxes of their words. */
  function shownOn(n) {
    let p = shown.get(n);
    if (!p) {
      p = (async () => {
        const out = [];
        for (const a of items) {
          const home = pageOf(table, a.frac);
          if (Math.abs(home - n) > 7) continue;
          let loc = located.get(a.ref);
          if (!loc) located.set(a.ref, (loc = locateOnPages(a, home, book.pages, wordsOf)));
          const segs = await loc;
          const seg = segs.find((x) => x.page === n);
          if (!seg) continue;
          const words = await wordsOf(n);
          out.push({ a, rects: mergeLines(words.slice(seg.i0, seg.i1 + 1).map((w) => w.slice(0, 4))), first: seg === segs[0] });
        }
        shownVals.set(n, out);
        return out;
      })();
      shown.set(n, p);
    }
    return p;
  }
  /** Pages already on show are drawn again (after a highlight was made, changed or removed). */
  function refreshAll() {
    shown.clear();
    shownVals.clear();
    for (const box of pane.querySelectorAll('.fa-page[data-n]')) refresh(Number(box.dataset.n));
  }

  /** Lays the page's words, invisible, over its picture. Called for the two halves once a spread has come to rest. */
  async function attachText(half) {
    const n = Number(half.dataset.page);
    const box = half.querySelector('.fa-page');
    if (!n || !box || box.querySelector(':scope > .fa-text')) return;
    const words = await wordsOf(n);
    wordVals.set(n, words);
    if (!words.length || !box.isConnected || box.querySelector(':scope > .fa-text')) return;
    const text = h('div', { class: 'fa-text' });
    for (const [x, y, w, hh, t] of words) {
      const s = h('span', { dataset: { i: String(text.children.length) } }, t);
      s.style.cssText = `left:${pct(x)};top:${pct(y)};height:${pct(hh)};font-size:calc(${(hh * 0.8).toFixed(4)} * 100cqh)`;
      s.dataset.w = String(w);
      text.append(s, document.createTextNode(' '));
    }
    box.append(text);
    // each word is stretched or squeezed to exactly the room it has on the page, so the selection follows the printed text
    requestAnimationFrame(() => {
      if (!text.isConnected) return;
      const width = box.clientWidth;
      const spans = [...text.children];
      const natural = spans.map((s) => s.getBoundingClientRect().width);
      spans.forEach((s, i) => {
        const k = natural[i] > 0 ? clamp((Number(s.dataset.w) * width) / natural[i], 0.2, 4) : 1;
        s.style.transform = `scaleX(${k.toFixed(3)})`;
      });
    });
  }

  // ------------------------------------------------------------ popovers
  let dismissedAt = 0;
  const outside = (e) => { if (pop && !pop.contains(e.target)) close(); };
  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    dismissedAt = Date.now();
    document.removeEventListener('mousedown', outside, true);
  }
  function show(kind, content, anchor, card = false) {
    close();
    pop = h('div', { class: 'fa-pop' + (card ? ' card' : ''), dataset: { kind } }, content);
    pop.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'TEXTAREA') e.preventDefault(); }); // clicking a button keeps the selection
    pop.addEventListener('click', (e) => e.stopPropagation());
    layer.append(pop);
    const w = pop.offsetWidth;
    const hh = pop.offsetHeight;
    const left = clamp((anchor.left + (anchor.right ?? anchor.left)) / 2 - w / 2, 8, innerWidth - w - 8);
    let top = (anchor.top - hh - 8);
    if (top < 8) top = Math.min(innerHeight - hh - 8, (anchor.bottom ?? anchor.top) + 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    document.addEventListener('mousedown', outside, true);
    return pop;
  }
  const dots = (current, onPick) => COLORS.map(([name, hex]) => {
    const b = h('button', { class: 'fa-dot' + (hex === current ? ' on' : ''), title: canWrite ? name : reason, 'aria-label': name, disabled: !canWrite, onClick: () => onPick(hex) });
    b.style.background = hex;
    return b;
  });
  const tool = (ic, title, onClick, disabled = false) => h('button', { class: 'fa-tool', title, 'aria-label': title, disabled, onClick }, icon(ic, 14));

  // ------------------------------------------------------------ talking to the server
  function apply(n, r) {
    const before = new Set(pageItems(n).map((a) => a.ref));
    items = items.filter((a) => a.page !== n).concat(r.page);
    book.size = r.size;
    book.fingerprint = r.fingerprint;
    refresh(n);
    changed?.();
    return r.page.filter((a) => !before.has(a.ref));
  }
  const attempt = async (n, request) => {
    try {
      return apply(n, await request);
    } catch (e) {
      if (pop) pop.replaceChildren(h('div', { class: 'fa-err' }, e.message));
      return null;
    }
  };
  const create = (info, color, note) => {
    lastColor = color;
    store.set(COLOR_KEY, color);
    getSelection()?.removeAllRanges();
    close();
    if (isEpub) return epubWrite(() => api.post(base, { quote: info.text, prefix: info.prefix, suffix: info.suffix, frac: info.frac, color, note: note || undefined }).then((a) => { items.push(a); items.sort((x, y) => x.frac - y.frac || x.ref - y.ref); }));
    return attempt(info.page, api.post(base, { kind: 'highlight', page: info.page, color, rects: info.rects, note: note || undefined }));
  };
  const patch = (a, body) => isEpub
    ? epubWrite(async () => { Object.assign(a, await api.patch(`${base}/${a.ref}`, body)); })
    : attempt(a.page, api.patch(`${base}/${a.ref}`, { page: a.page, ...body }));
  const remove = (a) => isEpub
    ? epubWrite(async () => { await api.del(`${base}/${a.ref}`); items = items.filter((x) => x !== a); located.delete(a.ref); })
    : attempt(a.page, api.del(`${base}/${a.ref}?page=${a.page}`));
  async function epubWrite(fn) {
    try {
      await fn();
      refreshAll();
    } catch (e) {
      if (pop) pop.replaceChildren(h('div', { class: 'fa-err' }, e.message));
      else toastError(e);
    }
  }

  // ------------------------------------------------------------ a selection
  function selectionInfo() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const text = startEl?.closest?.('.fa-text');
    if (!text || !pane.contains(text)) return null;
    const box = text.parentElement;
    const r = range.cloneRange();
    if (!text.contains(range.endContainer)) r.setEnd(text, text.childNodes.length); // a selection that runs on to the other page is cut at this one
    const b = box.getBoundingClientRect();
    const raw = [...r.getClientRects()]
      .filter((q) => q.width > 1 && q.height > 1 && !(q.width > b.width * 0.5 && q.height > b.height * 0.5))
      .map((q) => [(q.left - b.left) / b.width, (q.top - b.top) / b.height, q.width / b.width, q.height / b.height]);
    if (!raw.length) return null;
    const out = { page: Number(box.dataset.n), rects: mergeLines(raw), text: r.toString().replace(/\s+/g, ' ').trim(), anchor: r.getBoundingClientRect() };
    if (isEpub) {
      // which words it covers: the words around them tell the reader where it is, and how far through the page it starts tells how far through the book
      const words = wordVals.get(out.page) ?? [];
      const spans = [...text.children];
      const hit = spans.map((s, i) => (r.intersectsNode(s) ? i : -1)).filter((i) => i >= 0);
      if (!hit.length || !words.length) return null;
      const i0 = hit[0];
      const around = (from, to) => words.slice(Math.max(0, from), Math.max(0, to)).map((w) => w[4]).join(' ');
      const chars = words.reduce((acc, w) => acc + String(w[4]).length + 1, 0) || 1;
      const before = words.slice(0, i0).reduce((acc, w) => acc + String(w[4]).length + 1, 0);
      const next = out.page < table.total ? fracOf(table, out.page + 1) : 1;
      out.prefix = around(i0 - 6, i0);
      out.suffix = around(hit.at(-1) + 1, hit.at(-1) + 7);
      out.frac = fracOf(table, out.page) + (before / chars) * Math.max(0, next - fracOf(table, out.page));
    }
    return out;
  }

  function showSelection(info) {
    const pill = [
      ...(supported ? dots(null, (c) => create(info, c, null)) : []),
      supported ? tool('note', canWrite ? 'Highlight with a note' : reason, () => noteEditor({ title: 'Note for this highlight', color: lastColor, onSave: (text, color) => create(info, color ?? lastColor, text) }, info.anchor), !canWrite) : null,
      tool('copy', 'Copy', async () => { close(); toastCopied(await copyText(info.text)); }),
    ];
    show('sel', pill, info.anchor);
  }

  function noteEditor({ title, value = '', color = null, onSave }, anchor) {
    const ta = h('textarea', { class: 'fa-text-in', rows: 3, placeholder: 'Write a note…', value, maxLength: 20000 });
    let chosen = color;
    const row = color ? h('div', { class: 'fa-row' }, dots(color, (c) => { chosen = c; [...row.children].forEach((d, i) => d.classList.toggle('on', COLORS[i][1] === c)); })) : null;
    const save = () => { const t = ta.value.trim(); close(); onSave(t, chosen); };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
      e.stopPropagation(); // typing is not a shortcut
    });
    show('edit', [
      h('div', { class: 'fa-title' }, title),
      ta,
      row,
      h('div', { class: 'fa-row' }, h('button', { class: 'fa-btn', onClick: save, title: 'Ctrl+Enter' }, 'Save'), h('button', { class: 'fa-btn', onClick: close }, 'Cancel')),
    ], anchor, true);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** A click on an existing highlight or note pin: its note, its colour, and what can be done with it. */
  function showItem(a, anchor) {
    let sure = false;
    const del = tool('trash', canWrite ? (isEpub ? 'Remove' : 'Remove from the PDF') : reason, () => {
      if (a.note && !sure) { // a note is not thrown away by one stray click
        sure = true;
        del.title = 'Click again to remove it and its note';
        del.classList.add('danger');
        return;
      }
      close();
      remove(a);
    }, !canWrite);
    show('item', [
      a.quote ? h('div', { class: 'fa-quote' }, a.quote) : null,
      a.note ? h('div', { class: 'fa-note' }, a.note) : null,
      h('div', { class: 'fa-row' },
        ...dots(a.color, (c) => { close(); patch(a, { color: c }); }),
        h('span', { class: 'fa-sp' }),
        tool('edit', a.note ? 'Edit the note' : 'Add a note', () => noteEditor({ title: a.note ? 'Note' : 'Add a note', value: a.note ?? '', onSave: (t) => { if (t !== (a.note ?? '')) patch(a, { note: t || null }); } }, anchor), !canWrite),
        tool('copy', 'Copy', async () => { close(); toastCopied(await copyText([a.quote, a.note].filter(Boolean).join('\n\n'))); }),
        del,
      ),
    ], anchor, true);
  }

  /** The page box (and its page's fractions) under a point, if any. */
  const boxAt = (x, y) => [...pane.querySelectorAll('.flip-pg .fa-page')].find((b) => { const r = b.getBoundingClientRect(); return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom; });
  /** True when the click landed on a highlight and its popover opened (so the click does not also turn the page). */
  function clickAt(e) {
    if (!supported || (getSelection() && !getSelection().isCollapsed)) return false;
    const box = boxAt(e.clientX, e.clientY);
    if (!box) return false;
    const r = box.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (isEpub) {
      const on = (shownVals.get(Number(box.dataset.n)) ?? []).find(({ rects }) => rects.some(([rx, ry, rw, rh]) => x >= rx - 0.002 && x <= rx + rw + 0.002 && y >= ry - 0.002 && y <= ry + rh + 0.002));
      if (!on) return false;
      showItem(on.a, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
      return true;
    }
    const hit = pageItems(Number(box.dataset.n)).find((a) => a.kind === 'highlight' && a.rects.some(([rx, ry, rw, rh]) => x >= rx - 0.002 && x <= rx + rw + 0.002 && y >= ry - 0.002 && y <= ry + rh + 0.002));
    if (!hit) return false;
    showItem(hit, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY });
    return true;
  }

  // Check for a selection when the pointer lets go, or (touch: no pointer release to wait for) shortly after the selection settles.
  let down = false;
  let timer = 0;
  const look = () => {
    const info = selectionInfo();
    if (info) showSelection(info);
    else if (pop?.dataset.kind === 'sel') close();
  };
  layer.addEventListener('pointerdown', (e) => { if (!e.target.closest('.fa-pop')) down = true; });
  layer.addEventListener('pointerup', (e) => { down = false; if (!e.target.closest?.('.fa-pop')) { clearTimeout(timer); timer = setTimeout(look, 12); } });
  layer.addEventListener('pointercancel', () => { down = false; });
  const onSelChange = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!down && !pop?.matches?.('[data-kind="edit"]')) look(); }, 320);
  };
  document.addEventListener('selectionchange', onSelChange);
  // Ctrl+C on the selection: the words are separate boxes, so the browser would run them together; the range keeps the spaces.
  const onCopy = (e) => {
    const sel = getSelection();
    const el = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null;
    const inside = el && (el.nodeType === 3 ? el.parentElement : el)?.closest?.('.fa-text');
    if (!inside || sel.isCollapsed) return;
    e.clipboardData?.setData('text/plain', sel.getRangeAt(0).toString().replace(/\s+/g, ' ').trim());
    e.preventDefault();
  };
  document.addEventListener('copy', onCopy);

  return {
    ready,
    get supported() { return supported; },
    pageBox,
    attachText,
    clickAt,
    /** The H key: highlight the selection in the last colour used. */
    highlightSelection() {
      const info = selectionInfo();
      if (!info || !supported || !canWrite) return false;
      create(info, lastColor, null);
      return true;
    },
    /** True if a popover was open (Esc closes it instead of the viewer). */
    consumeEscape() { if (!pop) return false; close(); return true; },
    /** A popover was dismissed a moment ago: a click that did it should not also turn the page. */
    justClosed: () => Date.now() - dismissedAt < 250,
    dismiss() { close(); getSelection()?.removeAllRanges(); },
    destroy() {
      close();
      clearTimeout(timer);
      document.removeEventListener('selectionchange', onSelChange);
      document.removeEventListener('copy', onCopy);
    },
  };
}
