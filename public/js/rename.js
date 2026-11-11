import { api } from './api.js';
import { modal, toast } from './ui.js';
import { h } from './util.js';

// Renaming files. One book: type a new name. Several: rules (find & replace, clean-up, case, a name
// pattern with a counter) with a live preview; the server checks every name before anything is touched.
// Only the name changes: same folder, same extension. Tags, lists and reading progress stay with the book.

const extOf = (filename) => filename.match(/\.[^./\\]+$/)?.[0] ?? '';
const baseOf = (filename) => filename.slice(0, filename.length - extOf(filename).length);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);

function titleCase(s) {
  let first = true;
  return s.toLowerCase().replace(/[^\s\-–—_]+/g, (w) => {
    const keep = !first && SMALL.has(w);
    first = false;
    return keep ? w : w.charAt(0).toUpperCase() + w.slice(1);
  });
}

const DEFAULT_RULES = {
  find: '',
  replace: '',
  regex: false,
  matchCase: false,
  underscores: false,
  dots: false,
  brackets: false,
  spaces: true,
  letterCase: 'keep',
  pattern: '{name}',
  start: 1,
  step: 1,
  digits: 2,
};

/** The new name (without extension) a book gets under the rules. `index` is its place in the batch. */
export function applyRules(book, index, r) {
  let n = baseOf(book.filename);
  if (r.find) {
    const re = new RegExp(r.regex ? r.find : escapeRe(r.find), r.matchCase ? 'g' : 'gi');
    n = n.replace(re, r.regex ? r.replace : r.replace.replace(/\$/g, '$$$$'));
  }
  if (r.brackets) n = n.replace(/\s*\[[^\]]*\]/g, '');
  if (r.underscores) n = n.replace(/_+/g, ' ');
  if (r.dots) n = n.replace(/\./g, ' ');
  if (r.spaces) n = n.replace(/\s+/g, ' ').trim();
  if (r.letterCase === 'lower') n = n.toLowerCase();
  else if (r.letterCase === 'upper') n = n.toUpperCase();
  else if (r.letterCase === 'title') n = titleCase(n);
  else if (r.letterCase === 'sentence') n = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
  const num = String(Math.max(0, Number(r.start) || 0) + index * (Number(r.step) || 1)).padStart(Math.max(0, Number(r.digits) || 0), '0');
  const folder = book.dir ? book.dir.split('/').pop() : '';
  const out = (r.pattern || '{name}').replace(/\{(name|n|title|author|series|folder)\}/g, (_, k) => {
    switch (k) {
      case 'name': return n;
      case 'n': return num;
      case 'title': return book.title ?? '';
      case 'author': return book.author ?? '';
      case 'series': return book.series ?? '';
      default: return folder;
    }
  });
  // Spaces left over from an empty token, and ones at the edges, are never wanted.
  return out.replace(/\s+/g, ' ').trim();
}

async function check(items) {
  if (!items.length) return [];
  return (await api.post('/rename', { items, dryRun: true })).plans;
}

/** Renames and offers Undo. Resolves true when something was renamed. */
async function perform(books, names, onDone) {
  const items = books.map((b, i) => ({ id: b.id, name: names[i] })).filter((_, i) => names[i] !== baseOf(books[i].filename));
  const { renamed } = await api.post('/rename', { items });
  const back = items.map((it) => ({ id: it.id, name: baseOf(books.find((b) => b.id === it.id).filename) }));
  toast(renamed === 1 ? 'Renamed.' : `Renamed ${renamed} files.`, '', {
    action: {
      label: 'Undo',
      onClick: async () => {
        try {
          await api.post('/rename', { items: back });
          toast('Names restored.', 'quiet');
        } catch (e) {
          toast(`Could not undo: ${e.message}`, 'error');
        }
        onDone?.();
      },
    },
  });
  onDone?.();
  return renamed;
}

/** Entry point: one book gets the simple dialog, several get the mass-rename dialog. */
export function openRename(books, { onDone } = {}) {
  if (!books.length) return;
  if (books.length === 1) openSingle(books[0], onDone);
  else openMass(books, onDone);
}

// ------------------------------------------------------------------ one book
function openSingle(book, onDone) {
  const ext = extOf(book.filename);
  const input = h('input', { type: 'text', class: 'text-input', value: baseOf(book.filename), spellcheck: 'false', autocomplete: 'off' });
  const msg = h('div', { class: 'rename-msg small' });
  const ok = h('button', { class: 'btn primary', disabled: true, onClick: () => form.requestSubmit() }, 'Rename');
  // Someone typing the extension themselves shouldn't end up with ".pdf.pdf".
  const nameNow = () => (ext && input.value.toLowerCase().endsWith(ext.toLowerCase()) ? input.value.slice(0, -ext.length) : input.value);
  let seq = 0;
  let valid = false;
  const validate = async () => {
    const name = nameNow();
    const mine = ++seq;
    const unchanged = name === baseOf(book.filename);
    let plan;
    try {
      [plan] = await check([{ id: book.id, name }]);
    } catch (e) {
      plan = { error: e.message };
    }
    if (mine !== seq) return;
    valid = !plan.error && !unchanged;
    msg.textContent = plan.error ?? (unchanged ? 'That is the current name.' : '');
    msg.classList.toggle('bad', !!plan.error);
    ok.disabled = !valid;
  };
  let t;
  input.addEventListener('input', () => {
    valid = false;
    ok.disabled = true;
    clearTimeout(t);
    t = setTimeout(validate, 200);
  });
  const form = h(
    'form',
    {
      class: 'stack',
      onSubmit: async (e) => {
        e.preventDefault();
        clearTimeout(t);
        await validate();
        if (!valid) return;
        ok.disabled = true;
        try {
          await perform([book], [nameNow()], onDone);
          m.close();
        } catch (err) {
          msg.textContent = err.message;
          msg.classList.add('bad');
        }
      },
    },
    h('label', null, 'File name'),
    h('div', { class: 'rename-field' }, input, ext ? h('span', { class: 'muted rename-ext' }, ext) : null),
    msg,
    h('div', { class: 'muted small' }, 'Only the name changes: the file stays in its folder and keeps its extension. Tags, lists and reading progress stay with the book.'),
  );
  const m = modal({ title: 'Rename', body: form, footer: [h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'), ok] });
  input.focus();
  input.setSelectionRange(0, input.value.length);
}

// ------------------------------------------------------------------ several books
function openMass(books, onDone) {
  const rules = { ...DEFAULT_RULES };
  const included = new Set(books.map((b) => b.id));
  let plans = new Map(); // id -> server verdict
  let proposed = []; // new base names, parallel to `books`
  let ruleError = '';
  let seq = 0;

  const preview = h('div', { class: 'rename-preview' });
  const summary = h('div', { class: 'small muted' });
  const go = h('button', { class: 'btn primary' }, 'Rename');

  const bind = (key, el, kind = 'text') => {
    if (kind === 'check') {
      el.checked = !!rules[key];
      el.addEventListener('change', () => ((rules[key] = el.checked), refresh()));
    } else {
      el.value = rules[key];
      el.addEventListener('input', () => ((rules[key] = kind === 'number' ? Number(el.value) : el.value), refresh()));
    }
    return el;
  };
  const text = (key, ph = '', cls = '') => bind(key, h('input', { type: 'text', class: `text-input ${cls}`, placeholder: ph, spellcheck: 'false', autocomplete: 'off' }));
  const num = (key, width = '64px') => {
    const el = bind(key, h('input', { type: 'number', class: 'text-input', min: '0', style: { width } }), 'number');
    return el;
  };
  const chk = (key, label) => h('label', { class: 'rename-check' }, bind(key, h('input', { type: 'checkbox' }), 'check'), label);
  const caseSel = h('select', { class: 'sel', onChange: (e) => ((rules.letterCase = e.target.value), refresh()) }, [
    ['keep', 'Keep as is'],
    ['lower', 'lower case'],
    ['upper', 'UPPER CASE'],
    ['title', 'Title Case'],
    ['sentence', 'Sentence case'],
  ].map(([v, l]) => h('option', { value: v }, l)));

  const controls = h(
    'div',
    { class: 'rename-rules' },
    h('fieldset', null, h('legend', null, '1 · Find and replace'),
      h('div', { class: 'rename-row' }, text('find', 'Find'), text('replace', 'Replace with')),
      h('div', { class: 'rename-row' }, chk('regex', 'Regular expression'), chk('matchCase', 'Match case'))),
    h('fieldset', null, h('legend', null, '2 · Clean up'),
      h('div', { class: 'rename-row wrap' }, chk('underscores', 'Underscores → spaces'), chk('dots', 'Dots → spaces'), chk('brackets', 'Remove [bracketed] text'), chk('spaces', 'Tidy spaces'))),
    h('fieldset', null, h('legend', null, '3 · Letter case'), caseSel),
    h('fieldset', null, h('legend', null, '4 · Name pattern'),
      text('pattern', '{name}'),
      h('div', { class: 'muted small' }, h('code', null, '{name}'), ' the name after the steps above, ', h('code', null, '{n}'), ' a counter, ', h('code', null, '{title}'), ' ', h('code', null, '{author}'), ' ', h('code', null, '{series}'), ' ', h('code', null, '{folder}')),
      h('div', { class: 'rename-row' }, h('label', { class: 'rename-check' }, 'Counter starts at', num('start')), h('label', { class: 'rename-check' }, 'steps by', num('step')), h('label', { class: 'rename-check' }, 'digits', num('digits')))),
  );

  function compute() {
    ruleError = '';
    try {
      proposed = books.map((b, i) => applyRules(b, i, rules));
    } catch (e) {
      ruleError = `Not a valid expression: ${e.message}`;
      proposed = books.map((b) => baseOf(b.filename));
    }
  }

  function render() {
    const rows = books.map((b, i) => {
      const changed = proposed[i] !== baseOf(b.filename);
      const plan = plans.get(b.id);
      const err = included.has(b.id) && changed ? plan?.error : '';
      return h(
        'div',
        { class: 'rename-line' + (changed ? '' : ' same') + (err ? ' bad' : '') },
        h('input', { type: 'checkbox', checked: included.has(b.id), title: 'Include this file', onChange: (e) => ((e.target.checked ? included.add(b.id) : included.delete(b.id)), refresh()) }),
        h('span', { class: 'old', title: b.filename }, b.filename),
        h('span', { class: 'arrow' }, changed ? '→' : '='),
        h('span', { class: 'new', title: proposed[i] + extOf(b.filename) }, changed ? proposed[i] + extOf(b.filename) : 'unchanged'),
        err ? h('span', { class: 'why' }, err) : null,
      );
    });
    preview.replaceChildren(...rows);
    const changing = books.filter((b, i) => included.has(b.id) && proposed[i] !== baseOf(b.filename));
    const problems = changing.filter((b) => plans.get(b.id)?.error).length;
    const pending = changing.some((b) => !plans.has(b.id));
    summary.textContent = ruleError || (problems ? `${problems} name${problems === 1 ? '' : 's'} can't be used. Fix the rules or untick those files.` : changing.length ? `${changing.length} of ${books.length} files will be renamed.` : 'Nothing would change yet.');
    summary.classList.toggle('bad', !!ruleError || !!problems);
    go.disabled = !!ruleError || !!problems || pending || !changing.length;
    go.textContent = changing.length ? `Rename ${changing.length} file${changing.length === 1 ? '' : 's'}` : 'Rename';
  }

  let timer;
  function refresh() {
    compute();
    plans = new Map([...plans].filter(([id]) => false)); // verdicts belong to the names they were asked about
    render();
    clearTimeout(timer);
    const mine = ++seq;
    timer = setTimeout(async () => {
      const items = books.map((b, i) => ({ id: b.id, name: proposed[i], i })).filter((x) => included.has(x.id) && x.name !== baseOf(books[x.i].filename));
      try {
        const res = await check(items.map(({ id, name }) => ({ id, name })));
        if (mine !== seq) return;
        plans = new Map(res.map((p) => [p.id, p]));
      } catch (e) {
        if (mine !== seq) return;
        plans = new Map(items.map((x) => [x.id, { error: e.message }]));
      }
      render();
    }, 250);
  }

  go.addEventListener('click', async () => {
    go.disabled = true;
    const idx = books.map((_, i) => i).filter((i) => included.has(books[i].id));
    try {
      await perform(idx.map((i) => books[i]), idx.map((i) => proposed[i]), onDone);
      m.close();
    } catch (e) {
      summary.textContent = e.message;
      summary.classList.add('bad');
    }
  });

  const body = h(
    'div',
    { class: 'rename-mass' },
    h('div', { class: 'muted small' }, `${books.length} files, numbered in the order shown below (the order of your library view). Only names change: files stay in their folders and keep their extensions.`),
    controls,
    summary,
    preview,
  );
  const m = modal({ title: `Rename ${books.length} files`, body, wide: true, footer: [h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'), go] });
  refresh();
}
