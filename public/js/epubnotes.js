import { api } from './api.js';
import { toast } from './ui.js';
import { h, icon, clamp } from './util.js';
import { COLORS, copyText, toastCopied } from './annotations.js';

/**
 * Highlights and notes for the EPUB reader.
 *
 * A PDF carries its highlights inside the file; an EPUB has no place for them and Shelf never writes to the library, so these live in Shelf's database
 * (table epub_notes, routes /annotations) and are drawn over the text here. A highlight is a piece of one section's text:
 *   sec    the section (spine item, 0-based)
 *   start, end   where it is, as character offsets into the text of that section (body.textContent)
 *   quote, prefix, suffix   the words themselves and a little around them, to find the place again if the offsets no longer fit (or were never known,
 *          as for a highlight made in the flip-through viewer, which has pages, not sections)
 *   frac   how far through the book it starts
 * It is painted with the CSS Custom Highlight API (no change to the book's markup, so nothing else in the reader is disturbed).
 */

const COLOR_KEY = 'shelf.annColor';
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const flat = (s) => s.replace(/\s+/g, ' ').trim();
const KEEP = /[\p{L}\p{N}]/u;

/** The letters and digits of a text, lower case, without accents (what two copies of a text agree on), and where in the original each one is. */
export function boilMap(text) {
  let b = '';
  const idx = [];
  for (let i = 0; i < text.length; ) {
    const ch = String.fromCodePoint(text.codePointAt(i));
    for (const c of ch.normalize('NFD')) {
      for (const lc of c.toLowerCase()) {
        if (!KEEP.test(lc)) continue;
        b += lc;
        for (let k = 0; k < lc.length; k++) idx.push(i);
      }
    }
    i += ch.length;
  }
  return { b, idx };
}
const boil = (s) => boilMap(s).b;

/** The text nodes of a document, with where each starts in the whole text. */
function nodeMap(doc) {
  const out = [];
  if (!doc.body) return out;
  const walker = doc.createTreeWalker(doc.body, 4);
  let at = 0;
  for (let n; (n = walker.nextNode()); ) {
    out.push({ n, at, len: n.nodeValue.length });
    at += n.nodeValue.length;
  }
  return out;
}
function rangeFor(doc, map, start, end) {
  if (!map.length || end <= start) return null;
  const find = (off, endSide) => {
    let lo = 0;
    let hi = map.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (map[mid].at + map[mid].len < off || (endSide ? false : map[mid].at + map[mid].len === off)) lo = mid + 1;
      else hi = mid;
    }
    return map[lo];
  };
  const a = find(start, false);
  const b = find(end, true);
  const rg = doc.createRange();
  try {
    rg.setStart(a.n, clamp(start - a.at, 0, a.len));
    rg.setEnd(b.n, clamp(end - b.at, 0, b.len));
  } catch { return null; }
  return rg;
}
/** Where in the section's text a point of the document is. */
function offsetOf(doc, node, off) {
  const r = doc.createRange();
  r.setStart(doc.body, 0);
  r.setEnd(node, off);
  return r.toString().length;
}

const tailLen = (hay, at, want) => { let n = 0; while (n < want.length && at - 1 - n >= 0 && hay[at - 1 - n] === want[want.length - 1 - n]) n++; return n; };
const headLen = (hay, at, want) => { let n = 0; while (n < want.length && hay[at + n] === want[n]) n++; return n; };

/**
 * Where a highlight is in a section's text: [start, end], or null if its words are not there. The saved offsets are used when the words are still where they were;
 * otherwise the words are looked for (the one with the same words around it, else the one nearest the old place or the guess `near`).
 */
export function resolveNote(a, text, holder = {}, near = null) {
  const q = boil(a.quote);
  if (!q) return null;
  if (a.start != null && a.end != null && a.end <= text.length && boil(text.slice(a.start, a.end)) === q) return [a.start, a.end];
  const bm = (holder.bm ||= boilMap(text));
  const pre = boil(a.prefix ?? '').slice(-24);
  const suf = boil(a.suffix ?? '').slice(0, 24);
  const ref = a.start ?? near;
  let best = null;
  let from = 0;
  for (let k, seen = 0; (k = bm.b.indexOf(q, from)) >= 0 && seen < 400; from = k + 1, seen++) {
    const score = tailLen(bm.b, k, pre) + headLen(bm.b, k + q.length, suf);
    const dist = ref == null ? 0 : Math.abs(bm.idx[k] - ref);
    if (!best || score > best.score || (score === best.score && dist < best.dist)) best = { k, score, dist };
  }
  if (!best) return null;
  const s = bm.idx[best.k];
  const e = bm.idx[best.k + q.length - 1] + 1;
  return e > s ? [s, e] : null;
}

/** The page's words (the viewer's [x, y, w, h, text]) boiled into one string, and which word each letter belongs to. */
function boilWords(words) {
  let b = '';
  const wi = [];
  words.forEach((w, i) => {
    const x = boil(String(w[4] ?? ''));
    b += x;
    for (let k = 0; k < x.length; k++) wi.push(i);
  });
  return { b, wi };
}

/**
 * Where a highlight is on the flip-through viewer's pages, as [{ page, i0, i1 }] (the first and last word on each page it covers; it can run over a page
 * end). Its page is only roughly known (how far through the book it starts), so the pages around it are tried in turn.
 * @param {(page: number) => Promise<Array<[number, number, number, number, string]>>} wordsOf
 */
export async function locateOnPages(a, startPage, total, wordsOf) {
  const q = boil(a.quote ?? '');
  if (!q) return [];
  const pre = boil(a.prefix ?? '').slice(-24);
  const suf = boil(a.suffix ?? '').slice(0, 24);
  const order = [0, -1, 1, -2, 2].map((d) => startPage + d).filter((p) => p >= 1 && p <= total);
  for (const p of order) {
    const pw = await wordsOf(p);
    if (!pw.length) continue;
    const pb = boilWords(pw);
    // all of it on this page (the one with the same words around it, if the words occur more than once)
    let best = null;
    for (let from = 0, k, seen = 0; (k = pb.b.indexOf(q, from)) >= 0 && seen < 200; from = k + 1, seen++) {
      const score = tailLen(pb.b, k, pre) + headLen(pb.b, k + q.length, suf);
      if (!best || score > best.score) best = { k, score };
    }
    if (best) return [{ page: p, i0: pb.wi[best.k], i1: pb.wi[best.k + q.length - 1] }];
    // the start of it at the end of this page, and the rest on the next ones
    const most = Math.min(q.length - 1, pb.b.length);
    for (let len = most; len >= Math.min(8, q.length - 1); len--) {
      if (!pb.b.endsWith(q.slice(0, len))) continue;
      const segs = [{ page: p, i0: pb.wi[pb.b.length - len], i1: pw.length - 1 }];
      let used = len;
      for (let np = p + 1; used < q.length && np <= total && segs.length < 8; np++) {
        const nw = await wordsOf(np);
        const nb = boilWords(nw);
        const take = Math.min(q.length - used, nb.b.length);
        if (!take || !nb.b.startsWith(q.slice(used, used + take))) break;
        segs.push({ page: np, i0: 0, i1: nb.wi[take - 1] });
        used += take;
      }
      if (used >= q.length * 0.9) return segs;
      break;
    }
  }
  return [];
}

const nameOf = (a) => `shelf-${a.note ? 'n' : 'h'}${Math.max(0, COLORS.findIndex((c) => c[1] === a.color))}`;
const styleText = () =>
  COLORS.map(([, hex], i) => `::highlight(shelf-h${i}) { background-color: ${hex}; color: #1b1b1b; }
::highlight(shelf-n${i}) { background-color: ${hex}; color: #1b1b1b; text-decoration: underline dotted #1b1b1b; text-decoration-thickness: 2px; }`).join('\n') +
  '\n::highlight(shelf-flash) { background-color: #ff922b; color: #1b1b1b; }';

/**
 * @param {{ book: object, root: HTMLElement, bookName: (b: object) => string,
 *   fractionAt: (section: number, pos: number) => number,  how far through the book a spot (section from 1, how far into it) is
 *   hintPos: (section: number, frac: number) => number | null,  how far into the section a spot `frac` through the book is, if known
 *   pageLabel: (frac: number) => string,  "p. 123" or ""
 *   reveal: (sec: number, target: (doc: Document) => Range | null) => void,
 *   toc: (open: boolean) => void }} o  (toc: close the contents panel, which sits in the same place)
 */
export function createEpubNotes({ book, root, bookName, fractionAt, hintPos, pageLabel, reveal, toc }) {
  let items = [];
  let supported = false;
  let canWrite = true;
  let pop = null;
  let dead = false;
  let dismissedAt = 0;
  let lastColor = COLORS.some((c) => c[1] === store.get(COLOR_KEY)) ? store.get(COLOR_KEY) : COLORS[0][1];
  const base = `/books/${book.id}/annotations`;
  const frames = new Map(); // section -> { doc, win, frame }
  const sortItems = () => items.sort((a, b) => a.frac - b.frac || a.ref - b.ref);

  const ready = api.get(base).then(
    (r) => { items = r.items ?? []; supported = !!r.supported; sortItems(); refreshUi(); for (const i of frames.keys()) settle(i); },
    () => { supported = false; },
  );

  // ---------------------------------------------------------------- finding and painting
  /** Work out where each highlight of a section is (now that its text is here) and draw them. */
  function settle(i) {
    const st = frames.get(i);
    if (!st || !st.doc.body) return;
    const mine = items.filter((a) => a.sec === i);
    if (mine.length) {
      const text = st.doc.body.textContent ?? '';
      const holder = {};
      for (const a of mine) {
        const stored = a.start != null && a.end != null;
        const at = resolveNote(a, text, holder, (() => { const p = hintPos(i + 1, a.frac); return p == null ? null : p * text.length; })());
        if (!at) { a.orphan = true; continue; }
        a.orphan = false;
        if (!stored || a.start !== at[0] || a.end !== at[1]) {
          a.start = at[0];
          a.end = at[1];
          if (canWrite) api.patch(`${base}/${a.ref}`, { start: at[0], end: at[1] }).catch(() => {});
        }
      }
      refreshUi();
    }
    paint(i);
  }
  function paint(i) {
    const st = frames.get(i);
    if (!st) return;
    const { doc, win } = st;
    if (!win?.CSS?.highlights || !win.Highlight || !doc.head) return;
    if (!doc.getElementById('shelf-hl-style')) {
      const el = doc.createElement('style');
      el.id = 'shelf-hl-style';
      el.textContent = styleText();
      doc.head.append(el);
    }
    const map = nodeMap(doc);
    const groups = new Map();
    for (const a of items) {
      if (a.sec !== i || a.orphan || a.start == null) continue;
      const rg = rangeFor(doc, map, a.start, a.end);
      if (!rg) continue;
      const nm = nameOf(a);
      (groups.get(nm) ?? groups.set(nm, []).get(nm)).push(rg);
    }
    COLORS.forEach((_, k) => { win.CSS.highlights.delete(`shelf-h${k}`); win.CSS.highlights.delete(`shelf-n${k}`); });
    for (const [nm, ranges] of groups) win.CSS.highlights.set(nm, new win.Highlight(...ranges));
  }
  
  /** The Range of a highlight in a loaded section's document (finds it first if it was never placed). */
  function rangeIn(doc, a) {
    if (a.start == null || a.end == null) {
      const at = resolveNote(a, doc.body?.textContent ?? '', null, null);
      if (!at) return null;
      [a.start, a.end] = at;
    }
    return rangeFor(doc, nodeMap(doc), a.start, a.end);
  }
  function flash(a) {
    const st = frames.get(a.sec);
    if (!st?.win?.CSS?.highlights) return;
    const rg = rangeIn(st.doc, a);
    if (!rg) return;
    st.win.CSS.highlights.set('shelf-flash', new st.win.Highlight(rg));
    setTimeout(() => st.win.CSS.highlights.delete('shelf-flash'), 1400);
  }

  // ---------------------------------------------------------------- changes
  async function create(info, color, note) {
    lastColor = color;
    store.set(COLOR_KEY, color);
    try {
      const a = await api.post(base, { sec: info.sec, start: info.start, end: info.end, quote: info.quote, prefix: info.prefix, suffix: info.suffix, frac: info.frac, color, note });
      items.push(a);
      sortItems();
      info.win.getSelection()?.removeAllRanges();
      settle(info.sec);
      refreshUi();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function patch(a, body) {
    try {
      Object.assign(a, await api.patch(`${base}/${a.ref}`, body));
      paint(a.sec);
      refreshUi();
    } catch (e) {
      toast(e.message, 'error');
    }
  }
  async function remove(a) {
    try {
      await api.del(`${base}/${a.ref}`);
    } catch (e) {
      return toast(e.message, 'error');
    }
    items = items.filter((x) => x !== a);
    paint(a.sec);
    refreshUi();
    toast(a.note ? 'Highlight and note removed' : 'Highlight removed', '', {
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const back = await api.post(base, { sec: a.sec, start: a.start, end: a.end, quote: a.quote, prefix: a.prefix, suffix: a.suffix, frac: a.frac, color: a.color, note: a.note });
            items.push(back);
            sortItems();
            settle(back.sec);
            refreshUi();
          } catch (e) {
            toast(e.message, 'error');
          }
        },
      },
    });
  }

  // ---------------------------------------------------------------- popovers (same look as the PDF reader's)
  const outside = (e) => { if (pop && !pop.contains(e.target)) { dismissedAt = Date.now(); closePop(); } };
  function closePop() {
    pop?.remove();
    pop = null;
    document.removeEventListener('mousedown', outside, true);
  }
  function showPop(kind, content, anchor) {
    closePop();
    pop = h('div', { class: 'ann-pop', dataset: { kind } }, content);
    pop.addEventListener('mousedown', (e) => { if (e.target.tagName !== 'TEXTAREA') e.preventDefault(); }); // (keeps the text selected while you click)
    document.body.append(pop);
    const w = pop.offsetWidth;
    const hh = pop.offsetHeight;
    pop.style.left = `${clamp((anchor.left + (anchor.right ?? anchor.left)) / 2 - w / 2, 8, innerWidth - w - 8)}px`;
    let top = (anchor.bottom ?? anchor.top) + 8;
    if (top + hh > innerHeight - 8) top = Math.max(8, anchor.top - hh - 8);
    pop.style.top = `${top}px`;
    document.addEventListener('mousedown', outside, true);
    return pop;
  }
  const colorRow = (current, onPick) =>
    h('div', { class: 'ann-colors' }, COLORS.map(([name, hex]) => {
      const b = h('button', { class: 'ann-dot' + (hex === current ? ' on' : ''), title: name, onClick: () => onPick(hex) });
      b.style.background = hex;
      return b;
    }));
  const miniBtn = (label, onClick, extra = {}) => h('button', { class: 'ann-btn' + (extra.danger ? ' danger' : ''), title: extra.title, onClick }, label);

  function openEditor({ heading, value = '', color = null, canDelete = false, onSave, onDelete }, anchor) {
    const ta = h('textarea', { class: 'ann-text', rows: 4, placeholder: 'Write a note…', value, maxLength: 20000 });
    let chosen = color;
    const dots = color ? colorRow(color, (c) => { chosen = c; [...dots.children].forEach((d, i) => d.classList.toggle('on', COLORS[i][1] === c)); }) : null;
    const save = async () => { const text = ta.value.trim(); closePop(); await onSave(text, chosen); };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
      e.stopPropagation();
    });
    showPop('edit', [
      heading ? h('div', { class: 'ann-head' }, heading) : null,
      ta,
      dots,
      h('div', { class: 'ann-row' },
        miniBtn('Save', save, { title: 'Ctrl+Enter' }),
        miniBtn('Cancel', closePop),
        canDelete ? h('span', { class: 'grow' }) : null,
        canDelete ? miniBtn('Delete', () => { closePop(); onDelete(); }, { danger: true }) : null,
      ),
    ], anchor);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  function editItem(a, anchor) {
    openEditor({
      heading: 'Note for this highlight',
      value: a.note ?? '',
      color: a.color,
      canDelete: true,
      onSave: async (text, color) => {
        const body = {};
        if (text !== (a.note ?? '')) body.note = text || null;
        if (color && color !== a.color) body.color = color;
        if (Object.keys(body).length) await patch(a, body);
      },
      onDelete: () => remove(a),
    }, anchor);
  }
  function openViewer(a, anchor) {
    showPop('view', [
      a.quote ? h('div', { class: 'ann-quote' }, a.quote) : null,
      a.note ? h('div', { class: 'ann-notetext' }, a.note) : null,
      colorRow(a.color, (c) => { closePop(); patch(a, { color: c }); }),
      h('div', { class: 'ann-row' },
        miniBtn(a.note ? 'Edit note' : 'Add note', () => editItem(a, anchor)),
        miniBtn('Copy', async () => { closePop(); toastCopied(await copyText([a.quote, a.note].filter(Boolean).join('\n\n'))); }),
        h('span', { class: 'grow' }),
        miniBtn('Delete', () => { closePop(); remove(a); }, { danger: true }),
      ),
    ], anchor);
  }

  // ---------------------------------------------------------------- selecting and clicking inside a section
  const frameBox = (st) => st.frame.getBoundingClientRect();
  function selectionInfo(i) {
    const st = frames.get(i);
    const sel = st?.win.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount || !st.doc.body) return null;
    const rg = sel.getRangeAt(0);
    if (!st.doc.body.contains(rg.commonAncestorContainer)) return null;
    let start = offsetOf(st.doc, rg.startContainer, rg.startOffset);
    let end = offsetOf(st.doc, rg.endContainer, rg.endOffset);
    const text = st.doc.body.textContent ?? '';
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end <= start) return null;
    const quote = flat(text.slice(start, end));
    if (!quote) return null;
    const len = Math.max(1, text.length);
    const box = rg.getBoundingClientRect();
    const fb = frameBox(st);
    return {
      sec: i, start, end, quote,
      prefix: flat(text.slice(Math.max(0, start - 48), start)).slice(-40),
      suffix: flat(text.slice(end, end + 48)).slice(0, 40),
      frac: fractionAt(i + 1, start / len),
      win: st.win,
      anchor: { left: fb.left + box.left, right: fb.left + box.right, top: fb.top + box.top, bottom: fb.top + box.bottom },
    };
  }
  function showSelection(info) {
    showPop('sel', [
      colorRow(null, (c) => { closePop(); create(info, c, null); }),
      h('div', { class: 'ann-row' },
        miniBtn('Highlight + note', () => openEditor({ heading: 'Note for this highlight', color: lastColor, onSave: (text, color) => create(info, color ?? lastColor, text || null) }, info.anchor)),
        miniBtn('Copy', async () => { closePop(); toastCopied(await copyText(info.quote)); }),
      ),
    ], info.anchor);
  }

  function onFrame({ i, doc, win, frame }) {
    frames.set(i, { doc, win, frame });
    const end = (e) => {
      if (!supported) return;
      setTimeout(() => {
        if (dead || !frames.has(i)) return;
        const info = selectionInfo(i);
        if (info) showSelection(info);
        else if (pop?.dataset.kind === 'sel') closePop();
      }, 10);
    };
    doc.addEventListener('mouseup', end);
    doc.addEventListener('keyup', (e) => { if (e.key.startsWith('Arrow') || e.key === 'Shift') end(e); });
    settle(i);
  }
  /** A plain click on a highlight opens it (returns true so the reader doesn't treat it as a click on the page). */
  function onFrameClick(i, e) {
    const st = frames.get(i);
    if (!st || !supported || e.detail > 1 || !st.win.getSelection()?.isCollapsed) return false;
    const at = st.doc.caretPositionFromPoint?.(e.clientX, e.clientY) ?? null;
    let node;
    let off;
    if (at) ({ offsetNode: node, offset: off } = at);
    else {
      const r = st.doc.caretRangeFromPoint?.(e.clientX, e.clientY);
      if (!r) return false;
      node = r.startContainer;
      off = r.startOffset;
    }
    if (!node || !st.doc.body.contains(node)) return false;
    const pos = offsetOf(st.doc, node, off);
    const map = nodeMap(st.doc);
    let hit = null;
    for (const a of items) {
      if (a.sec !== i || a.orphan || a.start == null || pos < a.start || pos > a.end) continue;
      if (hit && a.end - a.start >= hit.end - hit.start) continue; // the smallest one under the click
      const rg = rangeFor(st.doc, map, a.start, a.end);
      const on = rg && [...rg.getClientRects()].find((q) => e.clientX >= q.left - 2 && e.clientX <= q.right + 2 && e.clientY >= q.top - 2 && e.clientY <= q.bottom + 2);
      if (on) hit = a, hit.__rect = on;
    }
    if (!hit) return false;
    const fb = frameBox(st);
    const q = hit.__rect;
    delete hit.__rect;
    openViewer(hit, { left: fb.left + q.left, right: fb.left + q.right, top: fb.top + q.top, bottom: fb.top + q.bottom });
    return true;
  }

  // ---------------------------------------------------------------- the button and the list
  const countEl = h('span', { class: 'ann-count' });
  const button = h('button', { class: 'icon-btn ann-toggle', title: 'Highlights and notes (N)', onClick: () => toggleDrawer() }, icon('note', 18), countEl);
  const toolbar = h('div', { class: 'ann-tools' }, button);
  const drawerBody = h('div', { class: 'ann-list' });
  const drawerHead = h('div', { class: 'ann-drawer-head' });
  const drawer = h('aside', { class: 'ann-drawer hidden' }, drawerHead, drawerBody);
  let drawerOpen = false;
  function toggleDrawer(force) {
    drawerOpen = force ?? !drawerOpen;
    if (drawerOpen) toc(false);
    drawer.classList.toggle('hidden', !drawerOpen);
    root.classList.toggle('has-drawer', drawerOpen);
    button.classList.toggle('on', drawerOpen);
  }
  function jump(a) {
    reveal(a.sec, (doc) => rangeIn(doc, a));
    setTimeout(() => flash(a), 900);
  }
  async function copyAll() {
    const lines = items.map((a) => {
      const pg = pageLabel(a.frac);
      return `- ${pg || `section ${a.sec + 1}`}: “${a.quote}”${a.note ? `\n  ${a.note.replace(/\n/g, '\n  ')}` : ''}`;
    });
    const ok = await copyText(`# ${bookName(book)}\n\n${lines.join('\n')}\n`);
    toast(ok ? 'Copied as Markdown' : 'Could not copy', ok ? '' : 'error');
  }
  function refreshUi() {
    if (dead) return;
    countEl.textContent = items.length ? String(items.length) : '';
    drawerHead.replaceChildren(
      h('div', { class: 'ann-title' }, 'Highlights & notes', items.length ? h('span', { class: 'muted' }, ` ${items.length}`) : null),
      h('div', { class: 'ann-actions' },
        h('button', { class: 'btn small', disabled: !items.length, onClick: copyAll, title: 'Copy everything as Markdown' }, 'Copy all'),
        h('button', { class: 'icon-btn', title: 'Close', onClick: () => toggleDrawer(false) }, icon('x', 16)),
      ),
    );
    const kids = [];
    if (!items.length) kids.push(h('div', { class: 'muted pad' }, 'Select text in the book to highlight it or add a note. They are kept in Shelf (not in the book file), and show in the flip-through view too.'));
    for (const a of items) {
      const edit = h('button', { class: 'icon-btn tiny', title: 'Edit the note', onClick: (e) => { e.stopPropagation(); editItem(a, e.currentTarget.getBoundingClientRect()); } }, icon('edit', 14));
      const del = h('button', { class: 'icon-btn tiny', title: 'Delete', onClick: (e) => { e.stopPropagation(); remove(a); } }, icon('trash', 14));
      const sw = h('i', { class: 'ann-sw' });
      sw.style.background = a.color;
      const pg = pageLabel(a.frac);
      kids.push(
        h('div', { class: 'ann-card', tabIndex: 0, onClick: () => jump(a), onKeydown: (e) => e.key === 'Enter' && jump(a) },
          h('div', { class: 'ann-card-top' }, sw, h('span', { class: 'muted small grow' }, pg || `Section ${a.sec + 1}`, a.orphan ? ' · text not found' : ''), edit, del),
          a.quote ? h('blockquote', null, a.quote) : null,
          a.note ? h('div', { class: 'ann-note' }, a.note) : null,
        ),
      );
    }
    drawerBody.replaceChildren(...kids);
  }
  refreshUi();

  return {
    button,
    toolbar,
    drawer,
    ready,
    get supported() { return supported; },
    hooks: {
      onFrame,
      onFrameClick,
      onMarked: (i) => paint(i),
      onToc: (open) => { if (open && drawerOpen) toggleDrawer(false); },
    },
    /** The page labels changed (the page table arrived): redraw the list. */
    relabel: refreshUi,
    toggleDrawer,
    summary: () => ({ supported, canWrite, reason: null, count: items.length, inShelf: true }),
    busy() { return !!pop || Date.now() - dismissedAt < 500; },
    consumeEscape() {
      if (pop) return closePop(), true;
      return false;
    },
    destroy() {
      dead = true;
      closePop();
      frames.clear();
    },
  };
}
