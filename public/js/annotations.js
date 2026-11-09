import { api } from './api.js';
import { confirmDialog, toast } from './ui.js';
import { h, icon, clamp } from './util.js';

/**
 * Highlights and notes for the PDF reader. They are stored INSIDE the PDF file (standard
 * annotations, written by the server), so other PDF programs show the same ones. This module only
 * draws them and turns clicks and selections into requests.
 *
 * Coordinates are fractions (0..1) of the displayed page, origin top-left, so they survive zooming.
 */

export const COLORS = [
  ['Yellow', '#ffd84d'],
  ['Green', '#7bd88f'],
  ['Blue', '#6cb4ff'],
  ['Pink', '#ff8fb8'],
  ['Orange', '#ffa94d'],
];
export const PEN_COLORS = [
  ['Red', '#e03131'],
  ['Black', '#212529'],
  ['Blue', '#1971c2'],
  ['Green', '#2f9e44'],
  ['Orange', '#f08c00'],
];
const PEN_WIDTHS = [
  ['Thin', 0.0022],
  ['Medium', 0.0045],
  ['Thick', 0.009],
];
const SVG = 'http://www.w3.org/2000/svg';
const PEN_KEY = 'shelf.pen';
const COLOR_KEY = 'shelf.annColor';
const DRAWER_KEY = 'shelf.annDrawer';
const pct = (v) => `${(v * 100).toFixed(3)}%`;

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export const toastCopied = (ok) => (ok ? toast('Copied', 'quiet') : toast('Could not copy', 'error'));
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

/** One merged box per text line (a selection reports many overlapping boxes). */
function mergeLines(rects) {
  const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out.at(-1);
    const hMax = last ? Math.max(last[3], r[3]) : 0;
    if (last && Math.abs(last[1] - r[1]) < hMax * 0.5 && Math.abs(last[3] - r[3]) < hMax * 0.6 && r[0] <= last[0] + last[2] + 0.01) {
      const x0 = Math.min(last[0], r[0]), y0 = Math.min(last[1], r[1]);
      const x1 = Math.max(last[0] + last[2], r[0] + r[2]), y1 = Math.max(last[1] + last[3], r[1] + r[3]);
      out[out.length - 1] = [x0, y0, x1 - x0, y1 - y0];
    } else out.push([...r]);
  }
  return out;
}

export function createAnnotations({ book, root, scroller, pagesEl, goTo, bookName }) {
  let items = [];
  let canWrite = false;
  let reason = null;
  let supported = false;
  let pop = null;
  let tool = null; // null | 'note' (click to drop a sticky note) | 'pen'
  let pending = null; // pen strokes drawn but not yet saved into the file
  let flushing = null; // ... being saved right now
  let flushTimer = 0;
  let dead = false;
  let pen = { color: PEN_COLORS[0][1], width: PEN_WIDTHS[1][1] };
  try { Object.assign(pen, JSON.parse(store.get(PEN_KEY) || '{}')); } catch { /* defaults */ }
  let lastColor = store.get(COLOR_KEY) && COLORS.some((c) => c[1] === store.get(COLOR_KEY)) ? store.get(COLOR_KEY) : COLORS[0][1];
  const base = `/books/${book.id}/annotations`;

  const sortKey = (a) => (a.kind === 'highlight' ? a.rects[0]?.[1] ?? 0 : a.kind === 'ink' ? a.strokes[0]?.[0]?.[1] ?? 0 : a.point?.[1] ?? 0);
  const sortItems = () => items.sort((a, b) => a.page - b.page || sortKey(a) - sortKey(b) || a.ref - b.ref);
  const pageItems = (n) => items.filter((a) => a.page === n);

  // ---------------------------------------------------------------- loading
  async function load({ quiet = false } = {}) {
    try {
      const r = await api.get(base);
      const next = JSON.stringify(r.items);
      const changed = next !== JSON.stringify(items) || r.canWrite !== canWrite || r.supported !== supported;
      items = r.items;
      canWrite = r.canWrite;
      reason = r.reason;
      supported = r.supported;
      sortItems();
      if (changed) refreshUi();
      return changed;
    } catch (e) {
      if (!quiet) {
        supported = false;
        reason = e.message;
        refreshUi();
      }
      return false;
    }
  }
  const ready = load();

  // ---------------------------------------------------------------- drawing on pages
  function pinButton(a, x, y) {
    const b = h('button', { class: 'ann-pin' + (a.kind === 'note' ? ' sticky' : ''), title: a.note ?? '', dataset: { ref: a.ref }, onClick: (e) => { e.stopPropagation(); openViewer(a, b.getBoundingClientRect()); } }, icon('note', 13));
    b.style.left = pct(x);
    b.style.top = pct(y);
    b.style.background = a.color;
    return b;
  }

  /** Pen strokes as SVG: x is 0..1 of the page width, y is in the same unit, so line widths stay round. */
  function inkSvg(pageEl, list) {
    const ratio = pageEl.clientHeight / pageEl.clientWidth || 1.4;
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', 'ann-ink');
    svg.setAttribute('viewBox', `0 0 1 ${ratio}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    for (const a of list) {
      for (const st of a.strokes) {
        const p = document.createElementNS(SVG, 'path');
        p.setAttribute('d', 'M' + st.map(([x, y]) => `${x.toFixed(4)} ${(y * ratio).toFixed(4)}`).join('L'));
        p.setAttribute('stroke', a.color);
        p.setAttribute('stroke-width', String(a.width ?? 0.004));
        p.setAttribute('fill', 'none');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('stroke-linejoin', 'round');
        if (a.ref) p.dataset.ref = a.ref;
        svg.append(p);
      }
    }
    return svg;
  }

  /** Called whenever a page finishes rendering (and again when its annotations change). */
  function decorate(pageEl, n) {
    pageEl.querySelectorAll(':scope > .ann-hl-layer, :scope > .ann-pin-layer, :scope > .ann-ink').forEach((e) => e.remove());
    const its = pageItems(n);
    const inkExtra = [pending, flushing].filter((p) => p && p.page === n);
    const inks = [...its.filter((a) => a.kind === 'ink'), ...inkExtra];
    if (inks.length) pageEl.append(inkSvg(pageEl, inks));
    if (!its.length) return;
    const hl = h('div', { class: 'ann-hl-layer' });
    const pins = h('div', { class: 'ann-pin-layer' });
    for (const a of its) {
      if (a.kind === 'highlight') {
        for (const [x, y, w, hh] of a.rects) {
          const box = h('div', { class: 'ann-hl', dataset: { ref: a.ref } });
          Object.assign(box.style, { left: pct(x), top: pct(y), width: pct(w), height: pct(hh), background: a.color });
          hl.append(box);
        }
        if (a.note && a.rects[0]) pins.append(pinButton(a, a.rects[0][0] + a.rects[0][2], a.rects[0][1]));
      } else if (a.kind === 'note' && a.point) {
        pins.append(pinButton(a, a.point[0], a.point[1]));
      }
    }
    pageEl.append(hl, pins);
  }
  const pageElOf = (n) => pagesEl.querySelector(`.pdf-page[data-page="${n}"]`);
  function redecorate(n) {
    const el = pageElOf(n);
    if (el?.querySelector('.textLayer')) decorate(el, n);
  }
  function redecorateAll() {
    pagesEl.querySelectorAll('.pdf-page').forEach((el) => {
      if (el.querySelector('.textLayer')) decorate(el, Number(el.dataset.page));
    });
  }

  // ---------------------------------------------------------------- talking to the server
  /** Take the server's new list for page n. Returns the annotations that weren't there before. */
  function apply(n, r) {
    const before = new Set(pageItems(n).map((a) => a.ref));
    items = items.filter((a) => a.page !== n).concat(r.page);
    book.size = r.size;
    book.fingerprint = r.fingerprint;
    sortItems();
    redecorate(n);
    refreshUi();
    return r.page.filter((a) => !before.has(a.ref));
  }
  /** Returns the annotations that were added (an array, possibly empty) or null if the request failed. */
  let lastWrite = Promise.resolve();
  const settled = async () => { await lastWrite; await new Promise((r) => setTimeout(r)); }; // writes in flight are in the history before we look
  async function mutate(n, request) {
    lastWrite = Promise.all([lastWrite, Promise.resolve(request).then(() => {}, () => {})]);
    try {
      return apply(n, await request);
    } catch (e) {
      toast(e.message, 'error');
      if (/no longer in the file/.test(e.message)) load().then(redecorateAll);
      return null;
    }
  }
  const rememberColor = (c) => { lastColor = c; store.set(COLOR_KEY, c); };

  // ---- undo / redo: kept for this visit only (the PDF itself is the permanent record)
  const hist = { undo: [], redo: [] };
  const redoPending = []; // pen strokes taken back before they were saved
  let histP = Promise.resolve(); // undo/redo run one after another, so quick key presses all count
  const queued = (fn) => (histP = histP.then(fn).catch(() => {}));
  const KIND_NAME = { highlight: 'highlight', note: 'note', ink: 'drawing' };
  const snap = (a) => ({ kind: a.kind, page: a.page, color: a.color, note: a.note ?? null, rects: a.rects, point: a.point, strokes: a.strokes, width: a.width });
  const bodyOf = (s) =>
    s.kind === 'highlight' ? { kind: 'highlight', page: s.page, color: s.color, rects: s.rects, note: s.note ?? undefined }
    : s.kind === 'note' ? { kind: 'note', page: s.page, color: s.color, point: s.point, note: s.note }
    : { kind: 'ink', page: s.page, color: s.color, width: s.width, strokes: s.strokes };
  function record(entry) {
    hist.undo.push(entry);
    if (hist.undo.length > 100) hist.undo.shift();
    hist.redo.length = 0;
    redoPending.length = 0;
    refreshUi();
  }
  const labelOf = (e) => (e.op === 'patch' ? 'edit' : `${e.op === 'create' ? 'add' : 'delete'} ${KIND_NAME[e.snap.kind]}`);
  const nextUndo = () => (pending?.strokes.length ? 'pen stroke' : hist.undo.length ? labelOf(hist.undo.at(-1)) : null);
  const nextRedo = () => (hist.redo.length ? labelOf(hist.redo.at(-1)) : redoPending.length ? 'pen stroke' : null);

  const currentOf = (a) => items.find((x) => x.page === a.page && x.ref === a.ref) ?? a;
  const createHighlight = async (info, color, note) => {
    rememberColor(color);
    getSelection()?.removeAllRanges();
    const added = await mutate(info.page, api.post(base, { kind: 'highlight', page: info.page, color, rects: info.rects, note }));
    if (added?.[0]) record({ op: 'create', page: info.page, ref: added[0].ref, snap: snap(added[0]) });
    return !!added;
  };
  // ---- pen: strokes are collected, then saved as ONE ink annotation per page after a short pause
  let flushP = Promise.resolve();
  const simplify = (pts) => {
    const out = [pts[0]];
    for (const p of pts.slice(1, -1)) {
      const q = out.at(-1);
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) >= 0.0012) out.push(p);
    }
    out.push(pts.at(-1));
    return out;
  };
  const armFlush = () => { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 1200); };
  function flush() {
    clearTimeout(flushTimer);
    const batch = pending;
    pending = null;
    if (!batch || !batch.strokes.length) return flushP;
    flushP = flushP.then(async () => {
      flushing = batch;
      try {
        const r = await api.post(base, { kind: 'ink', page: batch.page, color: batch.color, width: batch.width, strokes: batch.strokes.map(simplify) });
        flushing = null;
        const made = apply(batch.page, r).find((a) => a.kind === 'ink');
        if (made) record({ op: 'create', page: made.page, ref: made.ref, snap: snap(made) });
      } catch (e) {
        flushing = null;
        redecorate(batch.page);
        toast(`Couldn't save the drawing: ${e.message}`, 'error');
      }
      refreshUi();
    });
    refreshUi();
    return flushP;
  }
  const penDown = (e) => {
    if (tool !== 'pen' || !supported || !canWrite || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const pageEl = e.target.closest?.('.pdf-page');
    if (!pageEl || !pagesEl.contains(pageEl) || e.target.closest('.ann-pop')) return;
    e.preventDefault();
    closePop();
    const n = Number(pageEl.dataset.page);
    if (pending && (pending.page !== n || pending.color !== pen.color || pending.width !== pen.width)) flush();
    clearTimeout(flushTimer);
    redoPending.length = 0;
    hist.redo.length = 0;
    pending ??= { page: n, color: pen.color, width: pen.width, strokes: [] };
    const box = pageEl.getBoundingClientRect();
    const ratio = box.height / box.width;
    const at = (ev) => [clamp((ev.clientX - box.left) / box.width, 0, 1), clamp((ev.clientY - box.top) / box.height, 0, 1)];
    const stroke = [at(e)];
    pending.strokes.push(stroke);
    // Live preview: a path on the page's drawing layer (made if this is the first mark on the page).
    let svg = pageEl.querySelector(':scope > .ann-ink');
    if (!svg) { svg = inkSvg(pageEl, [{ color: pen.color, width: pen.width, strokes: [] }]); pageEl.append(svg); }
    const path = document.createElementNS(SVG, 'path');
    for (const [k, v] of Object.entries({ stroke: pen.color, 'stroke-width': pen.width, fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) path.setAttribute(k, String(v));
    svg.append(path);
    const draw = () => path.setAttribute('d', 'M' + stroke.map(([x, y]) => `${x.toFixed(4)} ${(y * ratio).toFixed(4)}`).join('L') + (stroke.length === 1 ? `L${stroke[0][0].toFixed(4)} ${(stroke[0][1] * ratio + 0.0001).toFixed(4)}` : ''));
    draw();
    try { pageEl.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const move = (ev) => {
      for (const c of ev.getCoalescedEvents?.() ?? [ev]) stroke.push(at(c));
      draw();
    };
    const up = () => {
      pageEl.removeEventListener('pointermove', move);
      pageEl.removeEventListener('pointerup', up);
      pageEl.removeEventListener('pointercancel', up);
      if (stroke.length === 1) stroke.push([stroke[0][0] + 0.0001, stroke[0][1]]); // a dot
      armFlush();
      refreshUi();
    };
    pageEl.addEventListener('pointermove', move);
    pageEl.addEventListener('pointerup', up);
    pageEl.addEventListener('pointercancel', up);
  };

  /** Is (x, y) on or near this drawing? Distances are measured in page-width units. */
  function nearInk(a, x, y, ratio) {
    const tol = Math.max((a.width ?? 0.004) / 2 + 0.003, 0.006);
    for (const st of a.strokes) {
      for (let i = 0; i < st.length; i++) {
        const [x0, y0] = st[i];
        const [x1, y1] = st[Math.min(i + 1, st.length - 1)];
        const dx = x1 - x0, dy = (y1 - y0) * ratio;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? clamp(((x - x0) * dx + (y - y0) * ratio * dy) / len2, 0, 1) : 0;
        if (Math.hypot(x - (x0 + t * dx), (y - (y0 + (y1 - y0) * t)) * ratio) <= tol) return true;
      }
    }
    return false;
  }

  const createNote = async (n, point, color, note) => {
    const added = await mutate(n, api.post(base, { kind: 'note', page: n, color, point, note }));
    if (added?.[0]) record({ op: 'create', page: n, ref: added[0].ref, snap: snap(added[0]) });
    return !!added;
  };
  const patch = async (a, body) => {
    const cur = currentOf(a);
    const before = {};
    for (const k of Object.keys(body)) before[k] = cur[k] ?? null;
    const added = await mutate(cur.page, api.patch(`${base}/${cur.ref}`, { page: cur.page, ...body }));
    if (added) record({ op: 'patch', page: cur.page, ref: cur.ref, before, after: { ...body } });
    return !!added;
  };
  const remove = async (a) => {
    const cur = currentOf(a);
    const added = await mutate(cur.page, api.del(`${base}/${cur.ref}?page=${cur.page}`));
    if (added) record({ op: 'delete', page: cur.page, ref: cur.ref, snap: snap(cur) });
    return !!added;
  };

  /** Re-create an annotation from its snapshot. The new copy gets a new id: point every entry at it. */
  async function make(e) {
    const added = await mutate(e.page, api.post(base, bodyOf(e.snap)));
    if (!added?.length) return false;
    const fresh = added[0].ref;
    for (const x of [...hist.undo, ...hist.redo]) if (x.page === e.page && x.ref === e.ref) x.ref = fresh;
    e.ref = fresh;
    return true;
  }
  const destroy = async (e) => !!(await mutate(e.page, api.del(`${base}/${e.ref}?page=${e.page}`)));
  const setTo = async (e, values) => !!(await mutate(e.page, api.patch(`${base}/${e.ref}`, { page: e.page, ...values })));
  const replay = (e, dir) => {
    if (e.op === 'patch') return setTo(e, dir === 'undo' ? e.before : e.after);
    return (e.op === 'create') === (dir === 'undo') ? destroy(e) : make(e);
  };

  const undo = () => queued(doUndo);
  const redo = () => queued(doRedo);
  async function doUndo() {
    if (pending?.strokes.length) {
      const st = pending.strokes.pop();
      redoPending.push({ page: pending.page, color: pending.color, width: pending.width, stroke: st });
      const n = pending.page;
      if (!pending.strokes.length) { pending = null; clearTimeout(flushTimer); } else armFlush();
      redecorate(n);
      refreshUi();
      return;
    }
    await flushP;
    await settled();
    const e = hist.undo.pop();
    if (!e) return;
    try {
      if (await replay(e, 'undo')) { hist.redo.push(e); toast(`Undid: ${labelOf(e)} (page ${e.page})`, 'quiet'); }
    } finally { refreshUi(); }
  }
  async function doRedo() {
    if (!hist.redo.length) {
      const r = redoPending.pop();
      if (!r) return;
      if (pending && (pending.page !== r.page || pending.color !== r.color || pending.width !== r.width)) flush();
      pending ??= { page: r.page, color: r.color, width: r.width, strokes: [] };
      pending.strokes.push(r.stroke);
      armFlush();
      redecorate(r.page);
      refreshUi();
      return;
    }
    await flushP;
    await settled();
    const e = hist.redo.pop();
    if (!e) return;
    try {
      if (await replay(e, 'redo')) { hist.undo.push(e); toast(`Redid: ${labelOf(e)} (page ${e.page})`, 'quiet'); }
    } finally { refreshUi(); }
  }

  async function deleteWithConfirm(a) {
    if (a.note && !(await confirmDialog(`Delete this ${a.kind === 'note' ? 'note' : 'highlight and its note'}? It is removed from the PDF file.`, { okLabel: 'Delete', danger: true }))) return;
    remove(a);
  }

  // ---------------------------------------------------------------- popovers
  let dismissedAt = 0;
  const outside = (e) => {
    if (pop && !pop.contains(e.target)) { dismissedAt = Date.now(); closePop(); }
  };
  function closePop() {
    pop?.remove();
    pop = null;
    document.removeEventListener('mousedown', outside, true);
  }
  function showPop(kind, content, anchor) {
    closePop();
    pop = h('div', { class: 'ann-pop', dataset: { kind } }, content);
    // Keep the text selection alive while clicking buttons.
    pop.addEventListener('mousedown', (e) => {
      if (e.target.tagName !== 'TEXTAREA') e.preventDefault();
    });
    document.body.append(pop);
    const w = pop.offsetWidth;
    const hh = pop.offsetHeight;
    const left = clamp((anchor.left + (anchor.right ?? anchor.left)) / 2 - w / 2, 8, innerWidth - w - 8);
    let top = (anchor.bottom ?? anchor.top) + 8;
    if (top + hh > innerHeight - 8) top = Math.max(8, anchor.top - hh - 8);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    document.addEventListener('mousedown', outside, true);
    return pop;
  }

  function colorRow(current, onPick, palette = COLORS) {
    return h(
      'div',
      { class: 'ann-colors' },
      palette.map(([name, hex]) => {
        const b = h('button', { class: 'ann-dot' + (hex === current ? ' on' : ''), title: canWrite ? name : reason, disabled: !canWrite, onClick: () => onPick(hex) });
        b.style.background = hex;
        return b;
      }),
    );
  }
  const miniBtn = (label, onClick, extra = {}) => h('button', { class: 'ann-btn' + (extra.danger ? ' danger' : ''), title: extra.title, disabled: !!extra.disabled, onClick }, label);

  /** Small editor popover for a note's text. */
  function openEditor({ heading, value = '', color = null, canDelete = false, onSave, onDelete }, anchor) {
    const ta = h('textarea', { class: 'ann-text', rows: 4, placeholder: 'Write a note…', value, maxLength: 20000 });
    let chosen = color;
    const dots = color ? colorRow(color, (c) => { chosen = c; [...dots.children].forEach((d, i) => d.classList.toggle('on', COLORS[i][1] === c)); }) : null;
    const save = async () => {
      const text = ta.value.trim();
      closePop();
      await onSave(text, chosen);
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
      e.stopPropagation();
    });
    showPop('edit', [
      heading ? h('div', { class: 'ann-head' }, heading) : null,
      ta,
      dots,
      h('div', { class: 'ann-row' },
        miniBtn('Save', save, { disabled: !canWrite, title: canWrite ? 'Ctrl+Enter' : reason }),
        miniBtn('Cancel', closePop),
        canDelete ? h('span', { class: 'grow' }) : null,
        canDelete ? miniBtn('Delete', () => { closePop(); onDelete(); }, { danger: true, disabled: !canWrite }) : null,
      ),
    ], anchor);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }

  /** Click on an existing highlight or pin. */
  function openViewer(a, anchor) {
    if (a.kind === 'ink') {
      showPop('view', [
        h('div', { class: 'ann-head' }, `Drawing on page ${a.page}`),
        colorRow(a.color, (c) => { closePop(); patch(a, { color: c }); }, PEN_COLORS),
        h('div', { class: 'ann-row' },
          miniBtn('Close', closePop),
          h('span', { class: 'grow' }),
          miniBtn('Delete', () => { closePop(); remove(a); }, { danger: true, disabled: !canWrite, title: canWrite ? undefined : reason }),
        ),
      ], anchor);
      return;
    }
    const quote = a.quote ? h('div', { class: 'ann-quote' }, a.quote) : null;
    const note = a.note ? h('div', { class: 'ann-notetext' }, a.note) : null;
    showPop('view', [
      quote,
      note,
      colorRow(a.color, (c) => { closePop(); patch(a, { color: c }); }),
      h('div', { class: 'ann-row' },
        miniBtn(a.note ? 'Edit note' : a.kind === 'note' ? 'Edit' : 'Add note', () => editItem(a, anchor), { disabled: !canWrite, title: canWrite ? undefined : reason }),
        miniBtn('Copy', async () => { closePop(); toastCopied(await copyText([a.quote, a.note].filter(Boolean).join('\n\n'))); }),
        h('span', { class: 'grow' }),
        miniBtn('Delete', () => { closePop(); deleteWithConfirm(a); }, { danger: true, disabled: !canWrite, title: canWrite ? undefined : reason }),
      ),
    ], anchor);
  }

  function editItem(a, anchor) {
    openEditor({
      heading: a.kind === 'note' ? `Note on page ${a.page}` : `Highlight on page ${a.page}`,
      value: a.note ?? '',
      color: a.color,
      canDelete: true,
      onSave: async (text, color) => {
        if (a.kind === 'note' && !text) return remove(a);
        const body = {};
        if (text !== (a.note ?? '')) body.note = text || null;
        if (color && color !== a.color) body.color = color;
        if (Object.keys(body).length) await patch(a, body);
      },
      onDelete: () => deleteWithConfirm(a),
    }, anchor);
  }

  // ---------------------------------------------------------------- selecting text
  function selectionInfo() {
    const sel = getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    const startNode = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    const pageEl = startNode?.closest?.('.pdf-page');
    if (!pageEl || !pagesEl.contains(pageEl)) return null;
    const layer = pageEl.querySelector('.textLayer');
    if (!layer || !layer.contains(range.startContainer)) return null;
    const r = range.cloneRange();
    // A selection that runs on to later pages is clipped to the page it started on.
    if (!layer.contains(range.endContainer)) r.setEnd(layer, layer.childNodes.length);
    const box = pageEl.getBoundingClientRect();
    const raw = [...r.getClientRects()]
      .filter((q) => q.width > 1 && q.height > 1 && !(q.width > box.width * 0.5 && q.height > box.height * 0.5)) // drop container-sized boxes
      .map((q) => [(q.left - box.left) / box.width, (q.top - box.top) / box.height, q.width / box.width, q.height / box.height]);
    if (!raw.length) return null;
    const rects = mergeLines(raw);
    const end = r.getBoundingClientRect();
    return { page: Number(pageEl.dataset.page), rects, text: r.toString().replace(/\s+/g, ' ').trim(), anchor: end };
  }

  function showSelection(info) {
    showPop('sel', [
      colorRow(null, (c) => { closePop(); createHighlight(info, c, null); }),
      h('div', { class: 'ann-row' },
        miniBtn('Highlight + note', () => {
          const sel = info;
          openEditor({ heading: 'Note for this highlight', color: lastColor, onSave: (text, color) => createHighlight(sel, color ?? lastColor, text || null) }, info.anchor);
        }, { disabled: !canWrite, title: canWrite ? undefined : reason }),
        miniBtn('Copy', async () => { closePop(); toastCopied(await copyText(info.text)); }),
      ),
    ], info.anchor);
  }

  const onSelectionEnd = (e) => {
    if (!supported || e.target?.closest?.('.ann-pop')) return;
    setTimeout(() => {
      if (dead) return;
      const info = selectionInfo();
      if (info) showSelection(info);
      else if (pop?.dataset.kind === 'sel') closePop();
    }, 10);
  };

  // ---------------------------------------------------------------- clicks on the page
  function setTool(next) {
    if (next === tool) next = null;
    if (tool === 'pen' && next !== 'pen') flush();
    tool = next;
    root.classList.toggle('placing', tool === 'note');
    root.classList.toggle('pen-mode', tool === 'pen');
    penBar.classList.toggle('hidden', tool !== 'pen');
    if (tool) closePop();
    refreshUi();
    hint.classList.toggle('hidden', tool !== 'note');
  }
  const onPageClick = (e) => {
    if (!supported || tool === 'pen' || e.target.closest('.ann-pin')) return;
    const pageEl = e.target.closest('.pdf-page');
    if (!pageEl) return;
    const n = Number(pageEl.dataset.page);
    const box = pageEl.getBoundingClientRect();
    const x = (e.clientX - box.left) / box.width;
    const y = (e.clientY - box.top) / box.height;
    const here = { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY };
    if (tool === 'note') {
      e.annHandled = true;
      setTool(null);
      openEditor({ heading: `New note on page ${n}`, color: lastColor, onSave: async (text, color) => { if (text) await createNote(n, [x, y], color ?? lastColor, text); } }, here);
      return;
    }
    const sel = getSelection();
    if (sel && !sel.isCollapsed) return;
    const pad = 0.002;
    const hit = pageItems(n).find((a) => a.kind === 'highlight' && a.rects.some(([rx, ry, rw, rh]) => x >= rx - pad && x <= rx + rw + pad && y >= ry - pad && y <= ry + rh + pad));
    if (hit) { e.annHandled = true; return openViewer(hit, here); }
    const ratio = box.height / box.width;
    const ink = pageItems(n).find((a) => a.kind === 'ink' && nearInk(a, x, y, ratio));
    if (ink) { e.annHandled = true; openViewer(ink, here); }
  };

  const onKey = (e) => {
    if (!supported || !canWrite || e.altKey) return;
    if (e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    if (e.ctrlKey || e.metaKey) {
      const k = e.key.toLowerCase();
      if (k === 'z' || k === 'y') {
        e.preventDefault();
        if (k === 'y' || e.shiftKey) redo();
        else undo();
      }
      return;
    }
    if (e.key === 'p' || e.key === 'P') {
      e.preventDefault();
      setTool('pen');
      return;
    }
    if ((e.key === 'z' || e.key === 'Z') && tool === 'pen') {
      e.preventDefault();
      undo();
      return;
    }
    if (e.key === 'h' || e.key === 'H') {
      const info = selectionInfo();
      if (info) {
        e.preventDefault();
        closePop();
        createHighlight(info, lastColor, null);
      }
    }
  };

  scroller.addEventListener('mouseup', onSelectionEnd);
  scroller.addEventListener('keyup', onSelectionEnd);
  pagesEl.addEventListener('click', onPageClick);
  pagesEl.addEventListener('pointerdown', penDown);
  const onHide = () => { flush(); };
  addEventListener('pagehide', onHide);
  scroller.addEventListener('scroll', () => pop?.dataset.kind === 'sel' && closePop(), { passive: true });
  document.addEventListener('keydown', onKey);

  // Another program may have annotated the file while this tab was in the background.
  const onVisible = async () => {
    if (document.visibilityState !== 'visible' || pop || dead || pending || flushing) return;
    if (await load({ quiet: true })) redecorateAll();
  };
  document.addEventListener('visibilitychange', onVisible);

  // ---------------------------------------------------------------- toolbar button + side panel
  const countEl = h('span', { class: 'ann-count' });
  const button = h('button', { class: 'icon-btn ann-toggle', title: 'Highlights and notes (N)', onClick: () => toggleDrawer() }, icon('note', 18), countEl);
  const noteBtn = h('button', { class: 'icon-btn ann-tool', title: 'Add a note anywhere on a page', onClick: () => setTool('note') }, icon('notepin', 18));
  const penBtn = h('button', { class: 'icon-btn ann-tool', title: 'Pen: draw on the page (P)', onClick: () => setTool('pen') }, icon('pen', 18));
  const undoBtn = h('button', { class: 'icon-btn ann-tool', title: 'Undo (Ctrl+Z)', onClick: () => undo() }, icon('undo', 18));
  const redoBtn = h('button', { class: 'icon-btn ann-tool', title: 'Redo (Ctrl+Shift+Z)', onClick: () => redo() }, icon('redo', 18));
  const toolbar = h('div', { class: 'ann-tools' }, undoBtn, redoBtn, noteBtn, penBtn, button);

  const penBar = h('div', { class: 'pen-bar hidden' });
  // Not a toast: it must never sit on top of the page it asks you to click.
  const hint = h('div', { class: 'tool-hint hidden' }, 'Click anywhere on the page to put a note there. Esc cancels.');
  root.append(penBar, hint);
  function renderPenBar() {
    const dots = PEN_COLORS.map(([name, hex]) => {
      const b = h('button', { class: 'ann-dot' + (hex === pen.color ? ' on' : ''), title: name, onClick: () => { pen.color = hex; store.set(PEN_KEY, JSON.stringify(pen)); renderPenBar(); } });
      b.style.background = hex;
      return b;
    });
    const widths = PEN_WIDTHS.map(([name, w]) => {
      const b = h('button', { class: 'pen-w' + (w === pen.width ? ' on' : ''), title: name, onClick: () => { pen.width = w; store.set(PEN_KEY, JSON.stringify(pen)); renderPenBar(); } }, h('i'));
      b.firstChild.style.height = `${Math.max(2, Math.round(w * 700))}px`;
      return b;
    });
    const busy = !!(pending?.strokes.length || flushing);
    const u = nextUndo(), r = nextRedo();
    penBar.replaceChildren(
      h('span', { class: 'muted small' }, 'Pen'),
      h('div', { class: 'ann-colors' }, dots),
      h('div', { class: 'pen-widths' }, widths),
      h('button', { class: 'btn small', title: u ? `Undo ${u} (Z)` : 'Nothing to undo', disabled: !u, onClick: () => undo() }, 'Undo'),
      h('button', { class: 'btn small', title: r ? `Redo ${r}` : 'Nothing to redo', disabled: !r, onClick: () => redo() }, 'Redo'),
      h('button', { class: 'btn small primary', onClick: () => setTool(null) }, busy ? 'Save & done' : 'Done'),
    );
  }
  const drawerBody = h('div', { class: 'ann-list' });
  const drawerHead = h('div', { class: 'ann-drawer-head' });
  const drawer = h('aside', { class: 'ann-drawer hidden' }, drawerHead, drawerBody);
  let drawerOpen = false;

  function toggleDrawer(force) {
    drawerOpen = force ?? !drawerOpen;
    drawer.classList.toggle('hidden', !drawerOpen);
    root.classList.toggle('has-drawer', drawerOpen);
    button.classList.toggle('on', drawerOpen);
    store.set(DRAWER_KEY, drawerOpen ? '1' : '0');
  }

  function jump(a) {
    goTo(a.page, true);
    const flash = () => {
      pagesEl.querySelectorAll(`[data-ref="${a.ref}"]`).forEach((el) => {
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
      });
    };
    setTimeout(flash, 700);
  }

  async function copyAll() {
    const lines = items.filter((a) => a.kind !== 'ink').map((a) => {
      const head = `- p. ${a.page}${a.kind === 'note' ? ' (note)' : ''}`;
      const q = a.quote ? `: “${a.quote}”` : '';
      const n = a.note ? `\n  ${a.note.replace(/\n/g, '\n  ')}` : '';
      return head + q + n;
    });
    const ok = await copyText(`# ${bookName(book)}\n\n${lines.join('\n')}\n`);
    toast(ok ? 'Copied as Markdown' : 'Could not copy', ok ? '' : 'error');
  }

  function refreshUi() {
    if (dead) return;
    countEl.textContent = items.length ? String(items.length) : '';
    button.classList.toggle('hidden', !supported && !reason);
    for (const b of [noteBtn, penBtn]) {
      b.classList.toggle('hidden', !supported);
      b.disabled = !canWrite;
    }
    const u = nextUndo(), r = nextRedo();
    undoBtn.classList.toggle('hidden', !supported);
    redoBtn.classList.toggle('hidden', !supported);
    undoBtn.disabled = !canWrite || !u;
    redoBtn.disabled = !canWrite || !r;
    undoBtn.title = u ? `Undo ${u} (Ctrl+Z)` : 'Nothing to undo';
    redoBtn.title = r ? `Redo ${r} (Ctrl+Shift+Z)` : 'Nothing to redo';
    noteBtn.classList.toggle('on', tool === 'note');
    penBtn.classList.toggle('on', tool === 'pen');
    if (tool === 'pen') renderPenBar();
    drawerHead.replaceChildren(
      h('div', { class: 'ann-title' }, 'Highlights & notes', items.length ? h('span', { class: 'muted' }, ` ${items.length}`) : null),
      h('div', { class: 'ann-actions' },
        h('button', { class: 'btn small' + (tool === 'note' ? ' primary' : ''), disabled: !supported || !canWrite, title: canWrite ? 'Then click on the page' : reason ?? '', onClick: () => setTool('note') }, icon('plus', 13), tool === 'note' ? 'Click on page…' : 'Add note'),
        h('button', { class: 'btn small' + (tool === 'pen' ? ' primary' : ''), disabled: !supported || !canWrite, title: 'Draw on the page (P)', onClick: () => setTool('pen') }, icon('pen', 13), 'Pen'),
        h('button', { class: 'btn small', disabled: !items.length, onClick: copyAll, title: 'Copy everything as Markdown' }, 'Copy all'),
        h('button', { class: 'icon-btn', title: 'Close', onClick: () => toggleDrawer(false) }, icon('x', 16)),
      ),
    );
    const kids = [];
    if (!supported) kids.push(h('div', { class: 'callout warn' }, `Highlighting isn't available for this file: ${reason ?? 'unknown reason'}`));
    else if (!canWrite) kids.push(h('div', { class: 'callout warn' }, `Read-only: ${reason}. Existing highlights are shown, but you can't add or change any.`));
    if (supported && !items.length) kids.push(h('div', { class: 'muted pad' }, 'Select text on a page to highlight it, add a note anywhere, or draw with the pen. Everything is saved inside the PDF itself, so Okular, Evince and friends show it too.'));
    for (const a of items) {
      const edit = h('button', { class: 'icon-btn tiny', title: 'Edit', disabled: !canWrite, onClick: (e) => { e.stopPropagation(); editItem(a, e.currentTarget.getBoundingClientRect()); } }, icon('edit', 14));
      const del = h('button', { class: 'icon-btn tiny', title: 'Delete', disabled: !canWrite, onClick: (e) => { e.stopPropagation(); deleteWithConfirm(a); } }, icon('trash', 14));
      const sw = h('i', { class: 'ann-sw' });
      sw.style.background = a.color;
      kids.push(
        h('div', { class: 'ann-card', tabIndex: 0, onClick: () => jump(a), onKeydown: (e) => e.key === 'Enter' && jump(a) },
          h('div', { class: 'ann-card-top' }, sw, h('span', { class: 'muted small grow' }, `Page ${a.page}${a.kind === 'note' ? ' · note' : a.kind === 'ink' ? ' · drawing' : ''}`), a.kind === 'ink' ? null : edit, del),
          a.quote ? h('blockquote', null, a.quote) : null,
          a.note ? h('div', { class: 'ann-note' }, a.note) : null,
        ),
      );
    }
    drawerBody.replaceChildren(...kids);
  }
  refreshUi();
  if (store.get(DRAWER_KEY) === '1') toggleDrawer(true);

  return {
    button,
    toolbar,
    drawer,
    ready,
    get supported() { return supported; },
    decorate,
    toggleDrawer,
    /** What the file info panel shows. */
    summary: () => ({ supported, canWrite, reason, count: items.length }),
    /** True while a tool, popover or just-dismissed popover should keep a click from toggling the toolbar. */
    busy() { return !!tool || !!pop || Date.now() - dismissedAt < 500; },
    /** Esc closes a popover or cancels note placement first; returns true if it did. */
    consumeEscape() {
      if (pop) return closePop(), true;
      if (tool) return setTool(null), true;
      return false;
    },
    destroy() {
      flush();
      dead = true;
      closePop();
      penBar.remove();
      hint.remove();
      removeEventListener('pagehide', onHide);
      pagesEl.removeEventListener('pointerdown', penDown);
      scroller.removeEventListener('mouseup', onSelectionEnd);
      scroller.removeEventListener('keyup', onSelectionEnd);
      pagesEl.removeEventListener('click', onPageClick);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', onVisible);
    },
  };
}
