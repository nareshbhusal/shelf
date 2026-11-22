import { api } from './api.js';
import { h, icon, clamp } from './util.js';
import { COLORS, copyText, mergeLines, toastCopied } from './annotations.js';

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
  const ready = api.get(base).then(
    (r) => { items = r.items; canWrite = r.canWrite; reason = r.reason ?? ''; supported = r.supported; },
    () => { supported = false; },
  );

  // ------------------------------------------------------------ what a page shows
  const pageItems = (n) => items.filter((a) => a.page === n);

  function annLayer(n, ratio) {
    const box = h('div', { class: 'fa-ann' });
    if (!supported) return box;
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
    return box;
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
  /** Lays the page's words, invisible, over its picture. Called for the two halves once a spread has come to rest. */
  async function attachText(half) {
    const n = Number(half.dataset.page);
    const box = half.querySelector('.fa-page');
    if (!n || !box || box.querySelector(':scope > .fa-text')) return;
    const words = await wordsOf(n);
    if (!words.length || !box.isConnected || box.querySelector(':scope > .fa-text')) return;
    const text = h('div', { class: 'fa-text' });
    for (const [x, y, w, hh, t] of words) {
      const s = h('span', null, t);
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
    return attempt(info.page, api.post(base, { kind: 'highlight', page: info.page, color, rects: info.rects, note: note || undefined }));
  };
  const patch = (a, body) => attempt(a.page, api.patch(`${base}/${a.ref}`, { page: a.page, ...body }));
  const remove = (a) => attempt(a.page, api.del(`${base}/${a.ref}?page=${a.page}`));

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
    return { page: Number(box.dataset.n), rects: mergeLines(raw), text: r.toString().replace(/\s+/g, ' ').trim(), anchor: r.getBoundingClientRect() };
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
    const del = tool('trash', canWrite ? 'Remove from the PDF' : reason, () => {
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
