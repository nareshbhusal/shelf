import { api } from './api.js';
import { refreshMeta, store } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';
import { h, icon } from './util.js';

const PRESETS = {
  books: [
    ['Okular', 'okular {file}'],
    ['Evince', 'evince {file}'],
    ['Zathura', 'zathura {file}'],
    ['System default', 'xdg-open {file}'],
  ],
  lists: [
    ['Okular (tabs)', 'okular {files}'],
    ['Zathura', 'zathura {files}'],
    ['Evince', 'evince {files}'],
  ],
};
const SECTIONS = [
  ['books', 'For books', 'Used by "Open with" on one or several selected books. {file} is the book.'],
  ['lists', 'For reading lists', 'Used by "Open list with…". {files} passes every book of the list, in order.'],
];

/** Manage the "Open with ..." programs. Programs for books and for reading lists are separate sets. */
export function openReadersManager(focusScope = 'books') {
  const info = store.info;
  const listEls = Object.fromEntries(SECTIONS.map(([k]) => [k, h('div', { class: 'reader-list' })]));
  const formEl = h('div', { class: 'reader-form hidden' });
  let editingId = null;

  function renderList() {
    for (const [scope] of SECTIONS) {
      const mine = store.readers.filter((r) => r.scope === scope);
      if (!mine.length) {
        listEls[scope].replaceChildren(h('div', { class: 'muted pad' }, 'None yet.'));
        continue;
      }
      listEls[scope].replaceChildren(
        ...mine.map((r) =>
          h(
            'div',
            { class: 'reader-row' },
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'rname' }, r.name, r.takesMany ? h('span', { class: 'chip plain' }, 'takes many files') : null),
              h('code', null, r.command),
            ),
            h('button', { class: 'icon-btn', title: 'Edit', onClick: () => showForm(scope, r) }, icon('edit', 16)),
            h('button', {
              class: 'icon-btn',
              title: 'Delete',
              onClick: async () => {
                if (!(await confirmDialog(`Remove “${r.name}” from your programs?`, { okLabel: 'Remove', danger: true }))) return;
                await api.del(`/readers/${r.id}`).catch((e) => toast(e.message, 'error'));
                await refreshMeta();
                renderList();
              },
            }, icon('trash', 16)),
          ),
        ),
      );
    }
  }

  function showForm(scope, reader) {
    editingId = reader?.id ?? null;
    const name = h('input', { class: 'text-input', placeholder: 'Name, e.g. Okular', value: reader?.name ?? '', maxLength: 60 });
    const command = h('input', { class: 'text-input mono', placeholder: `Command, e.g. ${scope === 'lists' ? 'zathura {files}' : 'okular {file}'}`, value: reader?.command ?? '', spellcheck: false, autocomplete: 'off' });
    const save = async () => {
      try {
        const body = { name: name.value, command: command.value };
        if (editingId) await api.patch(`/readers/${editingId}`, body);
        else await api.post('/readers', { ...body, scope });
        await refreshMeta();
        formEl.classList.add('hidden');
        renderList();
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    formEl.classList.remove('hidden');
    formEl.replaceChildren(
      h('h3', null, `${editingId ? 'Edit program' : 'Add a program'} ${scope === 'lists' ? 'for reading lists' : 'for books'}`),
      name,
      command,
      !editingId
        ? h(
            'div',
            { class: 'chips' },
            h('span', { class: 'muted small' }, 'Start from:'),
            PRESETS[scope].map(([n, c]) =>
              h('button', { class: 'chip plain preset', onClick: () => { name.value = n; command.value = c; command.focus(); } }, n),
            ),
          )
        : null,
      h(
        'div',
        { class: 'muted small help' },
        h('code', null, '{file}'), ' the book  ·  ',
        h('code', null, '{files}'), ' every selected book, or a whole reading list, one argument each  ·  ',
        h('code', null, '{dir}'), ' its folder  ·  ',
        h('code', null, '{name}'), ' its file name. With none of these the file is added at the end. Quotes work. Pipes and ',
        h('code', null, '&&'), " don't: put those in your own script and use that as the command.",
      ),
      h('div', { class: 'btn-row' }, h('button', { class: 'btn primary', onClick: save }, 'Save'), h('button', { class: 'btn', onClick: () => formEl.classList.add('hidden') }, 'Cancel')),
    );
    for (const el of [name, command]) el.addEventListener('keydown', (e) => e.key === 'Enter' && save());
    name.focus();
  }

  const m = modal({
    title: 'Open with: your programs',
    wide: true,
    body: [
      info?.docker && !info?.opener
        ? h('div', { class: 'callout warn' }, "Shelf is in Docker and the desktop helper isn't running, so it can't start programs on your computer yet. Run ", h('code', null, './shelf.sh start'), ' on your computer (it starts the helper too).')
        : !info?.docker && !info?.display
          ? h('div', { class: 'callout warn' }, 'The Shelf server has no desktop session (DISPLAY is not set), so graphical programs may fail to open. Start Shelf from a terminal inside your desktop session.')
          : null,
      ...SECTIONS.map(([scope, title, blurb]) =>
        h('section', { class: 'reader-section', dataset: { scope } },
          h('div', { class: 'reader-section-head' },
            h('div', { class: 'grow' }, h('h3', null, title), h('div', { class: 'muted small' }, blurb)),
            h('button', { class: 'btn small', onClick: () => showForm(scope, null) }, icon('plus', 13), 'Add'),
          ),
          listEls[scope],
        ),
      ),
      formEl,
    ],
    footer: [h('button', { class: 'btn primary', onClick: () => m.close() }, 'Done')],
  });
  renderList();
  m.el?.querySelector?.(`.reader-section[data-scope="${focusScope}"]`)?.scrollIntoView?.({ block: 'nearest' });
}
