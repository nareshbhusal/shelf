import { api } from './api.js';
import { askText, confirmDialog, modal, popMenu, toast } from './ui.js';
import { refreshMeta, refreshSessions, store, subscribe } from './store.js';
import { ago, h, hashFor, icon, plural } from './util.js';

// Sessions: the document sets kept by docsessions (a separate program for PDF viewers). Shelf reads them
// and changes them only through its command line (see src/sessions.ts), so docsessions keeps owning the
// files, the locking and the rules for sessions that are open in a viewer.

const STATE = { stopped: 'Not open', starting: 'Opening…', running: 'Open in viewer' };
const sessionById = (id) => store.sessions?.sessions.find((s) => s.uuid === id) ?? null;
const sessionName = (s) => s.display_name || s.name || 'Session';

/** A short sentence for what an add did. */
function addedText(name, r) {
  const c = r.changes ?? {};
  const bits = [];
  if (c.added?.length) bits.push(`${plural(c.added.length, 'document')} added`);
  if (c.queued?.length) bits.push(`${c.queued.length} queued for the next start`);
  if (c.lost?.length) bits.push(`${c.lost.length} waiting for the file to appear`);
  if (c.unchanged?.length) bits.push(`${c.unchanged.length} already there`);
  if (r.skipped) bits.push(`${r.skipped} left out (the viewer opens PDF, EPUB and CBZ)`);
  return `“${name}”: ${bits.join(', ') || 'nothing to do'}`;
}

/** Runs a session change; a conflict means someone else changed the session since it was shown. */
async function change(fn, onStale) {
  try {
    return await fn();
  } catch (e) {
    if (e.code === 'conflict') {
      toast('That session was changed somewhere else. It has been reloaded; try again.', 'error');
      onStale?.();
    } else toast(e.message, 'error');
    return null;
  }
}

// ---------------------------------------------------------------- "Add to session" picker

/**
 * Add books (or a whole reading list) to a session, or start a new one.
 * `target` is {bookIds} or {listId, listName}.
 */
export async function openSessionPicker(target) {
  await refreshSessions();
  const sessions = store.sessions?.sessions ?? [];
  const input = h('input', { type: 'text', class: 'text-input', placeholder: 'Find or create a session…', autocomplete: 'off' });
  const listEl = h('div', { class: 'picker-list' });
  const m = modal({ title: target.listId ? `Send “${target.listName}” to a session` : 'Add to session', body: [input, listEl] });
  const ids = async () => target.bookIds ?? (await api.get(`/books?list=${target.listId}`)).map((b) => b.id);

  async function addTo(s) {
    const bookIds = await ids();
    const r = await change(() => api.post(`/sessions/${s.uuid}/files`, { bookIds, rev: s.rev }), () => refreshSessions());
    if (!r) return;
    m.close();
    toast(addedText(sessionName(r.session), r));
    await refreshSessions();
  }
  async function create(name) {
    const r = await change(() => api.post('/sessions', target.listId ? { listId: target.listId, name } : { bookIds: target.bookIds, name }));
    if (!r) return;
    m.close();
    toast(`Created “${sessionName(r.session)}” with ${plural(r.session.files.length, 'document')}${r.skipped ? ` (${r.skipped} left out: the viewer opens PDF, EPUB and CBZ)` : ''}`, '', {
      action: { label: 'Open it', onClick: () => (location.hash = hashFor('session', [r.session.uuid])) },
    });
    await Promise.all([refreshSessions(), refreshMeta()]);
  }
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const rows = sessions
      .filter((s) => sessionName(s).toLowerCase().includes(q))
      .map((s) => h('button', { class: 'picker-row', onClick: () => addTo(s) }, icon('session', 15), h('span', { class: 'grow' }, sessionName(s)), h('span', { class: 'muted' }, s.state === 'stopped' ? plural(s.total, 'doc') : `${STATE[s.state]}: new ones are queued`)));
    const name = input.value.trim();
    if (name || !sessions.length) rows.push(h('button', { class: 'picker-row create', onClick: () => create(name) }, icon('plus', 14), h('span', { class: 'grow' }, name ? `New session “${name}”` : 'New session')));
    listEl.replaceChildren(...rows);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && listEl.querySelector('.picker-row')?.click());
  render();
  input.focus();
}

// ---------------------------------------------------------------- one session

export function createSessionView(route) {
  const uuid = route.rest[0] ?? '';
  const root = h('div', { class: 'session-page' });
  let s = null;
  let dead = false;
  let loaded = false;
  let busy = false;
  let markReady;
  const ready = new Promise((r) => (markReady = r));

  async function reload() {
    await refreshSessions();
    s = sessionById(uuid);
    loaded = true;
    render();
  }
  const take = (r) => {
    if (!r?.session) return r;
    s = r.session;
    if (store.sessions) store.sessions.sessions = store.sessions.sessions.map((x) => (x.uuid === s.uuid ? s : x));
    render();
    return r;
  };
  const edit = async (fn) => {
    if (busy) return null;
    busy = true;
    render();
    const r = await change(fn, reload);
    busy = false;
    take(r);
    if (!r) render();
    refreshSessions();
    return r;
  };

  const rev = () => ({ rev: s.rev });
  const act = (action, body = {}) => edit(() => api.post(`/sessions/${uuid}/${action}`, { ...body, rev: s.rev }));
  const post = (path, body) => edit(() => api.post(`/sessions/${uuid}/${path}`, { ...body, ...rev() }));

  async function open(action) {
    const r = await edit(() => api.post(`/sessions/${uuid}/${action}`, {}));
    if (r && r.applied?.length) toast(`${plural(r.applied.length, 'queued document')} opened`);
    if (r && r.bound === false) toast('The viewer was started, but its window was not seen yet.', 'quiet');
  }
  async function close() {
    const r = await edit(() => api.post(`/sessions/${uuid}/close`, {}));
    if (r === null) {
      if (await confirmDialog('The viewer did not close. Force it to quit? Its documents are saved as they were.', { okLabel: 'Force close', danger: true })) await edit(() => api.post(`/sessions/${uuid}/close`, { force: true }));
    }
  }
  async function rename() {
    const name = await askText({ title: 'Rename session', value: s.name || sessionName(s), okLabel: 'Rename' });
    if (name && name !== s.name) await act('rename', { name });
  }
  async function del() {
    if (!(await confirmDialog(`Delete the session “${sessionName(s)}”? Only the session is removed: the documents stay where they are${s.listId ? ", and the reading list imported from it stays too" : ''}.`, { okLabel: 'Delete', danger: true }))) return;
    if (await act('delete')) {
      await Promise.all([refreshSessions(), refreshMeta()]);
      location.hash = '#/files';
    }
  }
  async function importList(mode) {
    const r = await change(() => api.post(`/sessions/${uuid}/import`, { mode }), reload);
    if (!r) return;
    await Promise.all([refreshMeta(), refreshSessions()]);
    s = sessionById(uuid);
    render();
    toast(`${mode === 'update' ? 'Updated' : 'Created'} the reading list with ${plural(r.imported, 'book')}${r.unmatched ? `; ${r.unmatched} not in this library were left out` : ''}`, '', {
      action: { label: 'Show', onClick: () => (location.hash = hashFor('list', [String(r.listId)])) },
    });
  }

  const hint = (m) => (m.how === 'exact' ? '' : m.how === 'folders' ? 'Found in this library by its folder names (the session reaches it by another route).' : 'Found in this library by its file name only.');

  function row(m, i, kind, count) {
    const locked = kind === 'files' && s.state !== 'stopped';
    const where = m.bookId ? m.dir || 'Library root' : m.path;
    const btn = (label, ic, fn, disabled, danger) =>
      h('button', { class: 'icon-btn' + (danger ? ' danger' : ''), title: disabled ? 'Open in the viewer right now: close the session first' : label, disabled: disabled || busy, onClick: fn }, icon(ic, 15));
    return h(
      'div',
      { class: 'srow' + (m.bookId ? '' : ' unmatched') },
      h('span', { class: 'snum' }, String(i + 1)),
      m.bookId ? h('img', { class: 'sthumb', src: `/api/books/${m.bookId}/cover`, alt: '', loading: 'lazy', onError: (e) => e.target.replaceWith(h('span', { class: 'sthumb blank' }, icon('book', 16))) }) : h('span', { class: 'sthumb blank' }, icon('book', 16)),
      h(
        'div',
        { class: 'sinfo' },
        m.bookId ? h('a', { class: 'stitle', href: hashFor('read', [String(m.bookId)]), title: hint(m) }, m.title || m.name) : h('span', { class: 'stitle', title: m.path }, m.name),
        h('div', { class: 'ssub ellipsis', title: m.bookId ? where : m.path }, m.bookId ? where : `Not in this library · ${m.path}`),
      ),
      m.bookId && m.how !== 'exact' ? h('span', { class: 'chip-mini', title: hint(m) }, m.how === 'folders' ? 'matched by folders' : 'matched by name') : null,
      h(
        'div',
        { class: 'sact' },
        btn('Move up', 'up', () => post('move', { path: m.path, position: i }), locked || i === 0),
        btn('Move down', 'down', () => post('move', { path: m.path, position: i + 2 }), locked || i === count - 1),
        btn('Remove from session', 'x', () => post('remove', { paths: [m.path] }), locked, true),
      ),
    );
  }

  function section(title, note, list, kind) {
    if (!list.length) return null;
    return h('section', { class: 'ssection' }, h('h3', null, title, h('small', null, ` ${list.length}`)), note ? h('p', { class: 'muted snote' }, note) : null, h('div', { class: 'slist' }, ...list.map((m, i) => row(m, i, kind, list.length))));
  }

  function render() {
    if (dead) return;
    if (!loaded) return root.replaceChildren(h('div', { class: 'muted pad' }, 'Loading…'));
    if (!s) {
      return root.replaceChildren(
        h('div', { class: 'lib-head' }, h('div', { class: 'crumbs' }, icon('session', 18), h('span', { class: 'cur' }, 'Session'))),
        h('div', { class: 'empty' }, store.sessionsError ? h('p', null, store.sessionsError) : h('p', null, 'This session does not exist (any more).'), h('a', { class: 'btn', href: '#/files' }, 'Back to the library')),
      );
    }
    const running = s.state !== 'stopped';
    const unmatched = s.total - s.matched;
    root.replaceChildren(
      ...[
      h(
        'div',
        { class: 'lib-head' },
        h('div', { class: 'crumbs' }, icon('session', 18), h('span', { class: 'cur' }, sessionName(s)), h('span', { class: 'spill ' + s.state }, STATE[s.state])),
        h(
          'div',
          { class: 'controls' },
          running
            ? [
                h('button', { class: 'btn', disabled: busy, onClick: () => open('restart'), title: s.pending.length ? `Close and open again so the ${s.pending.length} queued document${s.pending.length === 1 ? '' : 's'} appear` : 'Close and open again' }, 'Restart'),
                h('button', { class: 'btn', disabled: busy, onClick: close }, 'Close'),
              ]
            : h('button', { class: 'btn primary', disabled: busy || !s.total, onClick: () => open('open') }, icon('play', 14), 'Open in ' + s.viewer),
          s.listId
            ? h('button', { class: 'btn', disabled: busy, onClick: () => importList('update'), title: 'Replace the linked reading list with this session’s documents, in order' }, 'Update reading list')
            : h('button', { class: 'btn', disabled: busy || !s.matched, onClick: () => importList('new'), title: 'Make a reading list from the documents of this session that are in the library' }, 'Import as reading list'),
          h('button', { class: 'icon-btn', title: 'More', 'aria-label': 'Session options', onClick: (e) => popMenu(e.currentTarget, [{ label: 'Rename…', onClick: rename }, s.listId ? { label: 'Open reading list', onClick: () => (location.hash = hashFor('list', [String(s.listId)])) } : null, '-', { label: 'Delete session…', danger: true, disabled: running, onClick: del }].filter(Boolean)) }, icon('more', 18)),
          h('button', { class: 'icon-btn', title: 'Reload from docsessions', onClick: reload }, icon('refresh', 18)),
        ),
      ),
      h('p', { class: 'muted sline' }, `${s.viewer} · ${plural(s.total, 'document')} · changed ${s.last_update ? ago(new Date(s.last_update).getTime()) : ''}${unmatched ? ` · ${unmatched} not in this library` : ''}`),
      running ? h('p', { class: 'muted snote' }, 'This session is open in the viewer, so its documents follow what the viewer has open. Documents you add now are queued and appear at the next start; Restart applies them.') : null,
      section('Documents', null, s.files, 'files') ?? h('div', { class: 'muted pad' }, 'No documents yet. Use “Add to session” on books, or send a reading list here.'),
      section('Queued', 'Added while the session was open; they open at the next start.', s.pending, 'pending'),
      section('Waiting for the file', 'These paths did not exist when last tried. They are retried every time the session starts.', s.lost, 'lost'),
    ].filter(Boolean));
  }

  const unsub = subscribe(() => {});
  const onVis = () => document.visibilityState === 'visible' && !busy && reload();
  document.addEventListener('visibilitychange', onVis);
  render();
  reload().then(markReady, markReady);

  return {
    el: root,
    get title() {
      return s ? sessionName(s) : 'Session';
    },
    ready,
    destroy() {
      dead = true;
      unsub();
      document.removeEventListener('visibilitychange', onVis);
    },
  };
}
