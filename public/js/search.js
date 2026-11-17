import { h, icon } from './util.js';

/**
 * Search inside a book (PDF and EPUB). The browser's own find only sees what is on screen, and these readers
 * draw only the pages or sections near the viewport, so the book's text is searched here, unit by unit
 * (a PDF page, an EPUB section), and the viewer is asked to show and mark the hits.
 *
 * A `source` (what the reader provides) is:
 *   count               number of units
 *   label(i)            "p. 12" / "Section 3"
 *   text(i)             the unit's text (a promise; the source caches it)
 *   show({unit, ord})   bring that hit into view (ord = which hit within the unit, counting from 0)
 *   setMarks(re, cur)   mark hits in whatever is drawn now (re = null clears); cur = {unit, ord} gets the strong mark
 * and the text it returns must be the text of the DOM the viewer marks (see markMatches).
 */

const MAX = 500; // hits listed; a search that matches more says so
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A regex for what was typed: words in order, with any whitespace (or none, across a line break) between. */
export function buildRegex(q, matchCase) {
  const words = q.trim().split(/\s+/).filter(Boolean);
  if (words.join('').length < 2) return null;
  return new RegExp(words.map(esc).join('\\s*'), matchCase ? 'g' : 'gi');
}

export function clearMarks(container) {
  const marks = container.querySelectorAll('mark.srch');
  if (!marks.length) return;
  for (const m of marks) m.replaceWith(...m.childNodes);
  container.normalize();
}

/**
 * Wraps every match in the text of `container` in <mark class="srch">; the `cur`-th also gets "cur".
 * The text searched is the text nodes joined in document order. Returns the first piece of the current mark.
 */
export function markMatches(container, regex, cur = -1) {
  clearMarks(container);
  const doc = container.ownerDocument;
  const walker = doc.createTreeWalker(container, 4); // text nodes
  const nodes = [];
  let text = '';
  for (let n; (n = walker.nextNode()); ) {
    nodes.push({ n, at: text.length, len: n.nodeValue.length });
    text += n.nodeValue;
  }
  const re = new RegExp(regex.source, regex.flags);
  const found = [];
  for (let m; (m = re.exec(text)); ) {
    found.push([m.index, m.index + m[0].length]);
    if (!m[0].length) re.lastIndex++;
  }
  let curMark = null;
  // Last to first, so splitting a text node never moves a position still to be used.
  for (let k = found.length - 1; k >= 0; k--) {
    const [s, e] = found[k];
    for (let i = nodes.length - 1; i >= 0; i--) {
      const { n, at, len } = nodes[i];
      if (at >= e || at + len <= s) continue;
      const range = doc.createRange();
      range.setStart(n, Math.max(s, at) - at);
      range.setEnd(n, Math.min(e, at + len) - at);
      const mk = doc.createElement('mark');
      mk.className = k === cur ? 'srch cur' : 'srch';
      try {
        range.surroundContents(mk);
        if (k === cur) curMark = mk;
      } catch { /* a range that cuts through an element: skip that piece */ }
    }
  }
  return curMark;
}

const snippet = (text, s, e) => {
  const flat = (x) => x.replace(/\s+/g, ' ');
  return { before: flat(text.slice(Math.max(0, s - 36), s)).trimStart(), hit: flat(text.slice(s, e)), after: flat(text.slice(e, e + 60)).trimEnd() };
};

export function createSearch({ source, getUnit }) {
  let open = false;
  let q = '';
  let matchCase = false;
  let regex = null;
  let results = [];
  let cur = -1;
  let runId = 0;
  let timer = 0;
  let busy = '';
  let capped = false;

  const input = h('input', { type: 'search', class: 'search-input', placeholder: 'Search in this book', 'aria-label': 'Search in this book', spellcheck: false, autocomplete: 'off' });
  const status = h('div', { class: 'search-status muted' });
  const list = h('div', { class: 'search-list' });
  const caseBtn = h('button', { class: 'icon-btn search-case', title: 'Match case', 'aria-label': 'Match case', onClick: () => { matchCase = !matchCase; caseBtn.classList.toggle('on', matchCase); run(); } }, 'Aa');
  const prevBtn = h('button', { class: 'icon-btn', title: 'Previous match (Shift+Enter)', 'aria-label': 'Previous match', onClick: () => step(-1) }, icon('up', 16));
  const nextBtn = h('button', { class: 'icon-btn', title: 'Next match (Enter)', 'aria-label': 'Next match', onClick: () => step(1) }, icon('down', 16));
  const panel = h(
    'div',
    { class: 'search-panel hidden', role: 'search' },
    h('div', { class: 'search-row' }, input, caseBtn, prevBtn, nextBtn, h('button', { class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close search', onClick: () => close() }, icon('x', 16))),
    status,
    list,
  );
  const button = h('button', { class: 'icon-btn search-btn', title: 'Search in this book (Ctrl+F or /)', 'aria-label': 'Search in this book', onClick: () => (open ? close() : openPanel()) }, icon('search', 18));

  function paintStatus() {
    const n = results.length;
    const more = capped ? '+' : '';
    let t = '';
    if (!q.trim()) t = '';
    else if (!regex) t = 'Type at least two characters';
    else if (n) t = `${cur >= 0 ? cur + 1 : 0} of ${n}${more}`;
    else if (!busy) t = 'No matches';
    status.textContent = busy ? `${t}${t ? ' · ' : ''}${busy}` : t;
    prevBtn.disabled = nextBtn.disabled = !n;
  }

  function addRow(r, i) {
    const row = h(
      'button',
      { class: 'search-hit', dataset: { i }, onClick: () => { select(i, true); input.focus(); } }, // keep Enter / Shift+Enter stepping from here
      h('span', { class: 'where' }, source().label(r.unit)),
      h('span', { class: 'snip' }, r.before, h('mark', null, r.hit), r.after),
    );
    list.append(row);
  }

  function select(i, show) {
    if (i < 0 || i >= results.length) return;
    list.querySelector('.search-hit.cur')?.classList.remove('cur');
    cur = i;
    const row = list.children[i];
    row?.classList.add('cur');
    row?.scrollIntoView({ block: 'nearest' });
    const r = results[i];
    const src = source();
    src?.setMarks(regex, { unit: r.unit, ord: r.ord });
    if (show) src?.show({ unit: r.unit, ord: r.ord });
    paintStatus();
  }

  function step(d) {
    if (!results.length) return;
    select((cur + d + results.length) % results.length, true);
  }

  async function run() {
    const mine = ++runId;
    const src = source();
    regex = buildRegex(q, matchCase);
    results = [];
    cur = -1;
    capped = false;
    busy = '';
    list.replaceChildren();
    src?.setMarks(null, null);
    paintStatus();
    if (!src || !regex) return;
    const startUnit = Math.max(0, getUnit());
    let picked = false;
    for (let u = 0; u < src.count; u++) {
      let text = '';
      try {
        text = await src.text(u);
      } catch { /* an unreadable unit has no text */ }
      if (mine !== runId) return;
      const re = new RegExp(regex.source, regex.flags);
      let ord = 0;
      for (let m; (m = re.exec(text)); ) {
        if (results.length >= MAX) { capped = true; break; }
        const r = { unit: u, ord: ord++, ...snippet(text, m.index, m.index + m[0].length) };
        results.push(r);
        addRow(r, results.length - 1);
        if (!m[0].length) re.lastIndex++;
      }
      // Start at the first hit from where you are reading; the ones before it are still listed.
      if (!picked && results.length && u >= startUnit) {
        picked = true;
        select(results.findIndex((r) => r.unit >= startUnit), true);
      }
      busy = u + 1 < src.count && !capped ? `searching ${u + 1} of ${src.count}` : '';
      if (u % 4 === 3 || busy === '') {
        paintStatus();
        await new Promise((r) => setTimeout(r, 0));
        if (mine !== runId) return;
      }
      if (capped) break;
    }
    busy = '';
    if (!picked && results.length) select(0, true); // every hit is before where you are
    paintStatus();
  }

  input.addEventListener('input', () => {
    q = input.value;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = 0; run(); }, 280);
  });
  input.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault(); // already here: just select the text again
      input.select();
    }
    e.stopPropagation(); // the reader's own keys (arrows, letters) are not for this box
    if (e.key === 'Enter') {
      e.preventDefault();
      if (timer) { clearTimeout(timer); timer = 0; q = input.value; run(); return; }
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });

  function openPanel() {
    if (!source()) return;
    open = true;
    panel.classList.remove('hidden');
    button.classList.add('on');
    input.focus();
    input.select();
    if (regex) source().setMarks(regex, cur >= 0 ? { unit: results[cur].unit, ord: results[cur].ord } : null); // marks come back with the panel
  }
  function close() {
    if (!open) return;
    open = false;
    runId++; // stops a search in progress
    clearTimeout(timer);
    panel.classList.add('hidden');
    button.classList.remove('on');
    source()?.setMarks(null, null);
    document.activeElement?.blur?.();
  }

  return {
    button,
    panel,
    open: openPanel,
    close,
    isOpen: () => open,
    /** Esc closes the panel first. */
    consumeEscape() {
      if (!open) return false;
      close();
      return true;
    },
    destroy() {
      runId++;
      clearTimeout(timer);
    },
  };
}
