import { api } from './api.js';
import { toast } from './ui.js';
import { h, icon } from './util.js';

/**
 * Bookmarks of one book, for the reader and for the flip-through viewer: a button that opens a small list, where a bookmark is added for the page you are on,
 * jumped to, named or removed. They are kept in Shelf's database, never in the book. The host says what "here" is and how to describe and reach a bookmark:
 *   host: the element the list is drawn inside (or a function giving it)
 *   place()            -> what to save for here ({page, pos, frac}), or null while that isn't known
 *   same(mark, place)  -> whether a saved bookmark is the place on show
 *   describe(mark)     -> "Page 12", "p. ~120 · 34%"
 *   jump(mark)         -> take the host there
 */
export function createBookmarks({ host, bookId, place, same, describe, jump, className = 'icon-btn', size = 18, below = true, dark = false }) {
  let marks = [];
  let panel = null;
  let editing = 0; // id of the bookmark being named
  let seq = 0;
  let gone = false;
  const hostEl = () => (typeof host === 'function' ? host() : host); // (the viewer's layer is made after its bar, which holds the button)

  const button = h('button', { class: className, 'aria-haspopup': 'true', onClick: () => (panel ? close() : open()) }, icon('bookmark', size));
  const order = () => marks.sort((a, b) => (a.frac ?? 0) - (b.frac ?? 0) || a.page - b.page || (a.pos ?? 0) - (b.pos ?? 0) || a.id - b.id);
  const here = () => {
    const p = place();
    return p ? marks.find((m) => same(m, p)) : undefined;
  };

  function paintButton() {
    const on = !!here();
    button.classList.toggle('bm-on', on);
    button.title = on ? 'Bookmarks: there is one here (B removes it)' : 'Bookmarks (B adds one here)';
    button.setAttribute('aria-label', 'Bookmarks');
  }

  async function reload() {
    const mine = ++seq;
    let list = [];
    try {
      list = await api.get(`/books/${bookId()}/bookmarks`);
    } catch { /* none shown */ }
    if (mine !== seq || gone) return;
    marks = list;
    paintButton();
    draw();
  }

  async function add() {
    const p = place();
    if (!p) return;
    try {
      const r = await api.post(`/books/${bookId()}/bookmarks`, p);
      if (r.existing) toast('There is a bookmark here already', 'quiet');
      else {
        marks.push(r);
        order();
        toast(`Bookmarked ${describe(r)}`, 'quiet');
      }
    } catch (e) {
      toast(`Couldn’t add the bookmark: ${e.message}`, 'error');
    }
    paintButton();
    draw();
  }

  async function remove(m) {
    try {
      await api.del(`/bookmarks/${m.id}`);
    } catch (e) {
      return toast(`Couldn’t remove it: ${e.message}`, 'error');
    }
    marks = marks.filter((x) => x.id !== m.id);
    paintButton();
    draw();
    const id = bookId();
    toast('Bookmark removed', '', {
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            const r = await api.post(`/books/${id}/bookmarks`, { page: m.page, pos: m.pos, frac: m.frac, label: m.label });
            if (id === bookId() && !r.existing) { marks.push(r); order(); }
          } catch { /* it stays removed */ }
          paintButton();
          draw();
        },
      },
    });
  }

  async function rename(m, text) {
    editing = 0;
    const label = text.replace(/\s+/g, ' ').trim() || null;
    if (label !== (m.label ?? null)) {
      try {
        const r = await api.patch(`/bookmarks/${m.id}`, { label });
        m.label = r.label;
      } catch (e) {
        toast(`Couldn’t rename it: ${e.message}`, 'error');
      }
    }
    draw();
  }

  const toggleHere = () => {
    const m = here();
    return m ? remove(m) : add();
  };

  function draw() {
    if (!panel) return;
    const cur = place();
    const here_ = here();
    const list = h('div', { class: 'bm-list' });
    for (const m of marks) {
      const isHere = !!cur && same(m, cur);
      if (editing === m.id) {
        const input = h('input', { class: 'bm-edit', type: 'text', value: m.label ?? '', maxLength: 120, placeholder: describe(m), 'aria-label': 'Name for this bookmark' });
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
          else if (e.key === 'Escape') { e.preventDefault(); input.value = m.label ?? ''; input.blur(); }
        });
        input.addEventListener('blur', () => editing === m.id && rename(m, input.value));
        list.append(h('div', { class: 'bm-row editing' }, input));
        queueMicrotask(() => input.focus());
        continue;
      }
      list.append(
        h(
          'div',
          { class: 'bm-row' + (isHere ? ' here' : '') },
          h('button', { class: 'bm-go', title: `Go to ${describe(m)}`, onClick: () => { jump(m); close(); } },
            h('span', { class: 'bm-name' }, m.label || describe(m)),
            m.label ? h('span', { class: 'bm-sub' }, describe(m)) : null),
          h('button', { class: 'bm-ic', title: 'Name it', 'aria-label': `Name the bookmark at ${describe(m)}`, onClick: () => { editing = m.id; draw(); } }, icon('edit', 14)),
          h('button', { class: 'bm-ic', title: 'Remove it', 'aria-label': `Remove the bookmark at ${describe(m)}`, onClick: () => remove(m) }, icon('x', 14)),
        ),
      );
    }
    panel.replaceChildren(
      h('div', { class: 'bm-head' },
        h('b', null, 'Bookmarks'),
        h('span', { class: 'grow' }),
        h('button', { class: 'bm-add', disabled: !cur, onClick: () => (here_ ? remove(here_) : add()) }, here_ ? 'Remove here' : 'Add here')),
      marks.length ? list : h('div', { class: 'bm-empty' }, 'None yet. “Add here” keeps the place you are at, so you can come back to it.'),
      h('div', { class: 'bm-note' }, 'Kept in Shelf, not in the book.'),
    );
    position();
  }

  function position() {
    if (!panel) return;
    const hr = hostEl().getBoundingClientRect();
    const br = button.getBoundingClientRect();
    const w = panel.offsetWidth;
    panel.style.left = `${Math.max(8, Math.min(br.right - hr.left - w, hr.width - w - 8))}px`;
    if (below) {
      panel.style.top = `${br.bottom - hr.top + 6}px`;
      panel.style.bottom = '';
      panel.style.maxHeight = `${Math.max(160, hr.bottom - br.bottom - 20)}px`;
    } else {
      panel.style.bottom = `${hr.bottom - br.top + 6}px`;
      panel.style.top = '';
      panel.style.maxHeight = `${Math.max(160, br.top - hr.top - 16)}px`;
    }
  }

  const outside = (e) => {
    if (panel && !panel.contains(e.target) && !button.contains(e.target)) close();
  };
  function open() {
    panel = h('div', { class: 'bm-panel' + (dark ? ' dark' : ''), role: 'dialog', 'aria-label': 'Bookmarks' });
    hostEl().append(panel);
    draw();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', position);
    button.classList.add('on');
  }
  function close() {
    if (!panel) return;
    panel.remove();
    panel = null;
    editing = 0;
    document.removeEventListener('pointerdown', outside, true);
    window.removeEventListener('resize', position);
    button.classList.remove('on');
  }

  paintButton();
  reload();
  return {
    button,
    reload,
    toggleHere,
    /** The place on show changed: the button says whether there is a bookmark here. */
    refresh() {
      paintButton();
      if (panel && !editing) draw();
    },
    /** For Esc: closes the list if it is open (and says so). */
    consumeEscape() {
      if (!panel) return false;
      close();
      return true;
    },
    destroy() {
      gone = true;
      close();
      button.remove();
    },
  };
}
