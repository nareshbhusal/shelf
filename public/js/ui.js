import { h, icon } from './util.js';

const modalRoot = () => document.getElementById('modal-root');

/**
 * A message that stays long enough to read, can be selected and copied, and doesn't vanish while
 * the pointer is over it or text inside it is selected.
 */
export function toast(msg, kind = '') {
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  };
  const el = h('div', { class: `toast ${kind}` }, h('span', { class: 'toast-text' }, msg), h('button', { class: 'toast-x', title: 'Dismiss', onClick: dismiss }, '×'));
  const holding = () => {
    if (el.matches(':hover')) return true;
    const sel = getSelection();
    return !!sel && !sel.isCollapsed && el.contains(sel.anchorNode);
  };
  // 'quiet': a brief confirmation (Undid, Copied) that never gets in the way of clicks.
  const ms = kind === 'quiet' ? 1600 : Math.max(3000, kind === 'error' ? 6000 : 0, String(msg).length * 60);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => (holding() ? arm() : dismiss()), ms);
  };
  document.getElementById('toast-root').append(el);
  arm();
}

/** Generic modal. Esc or a click on the backdrop closes the topmost one. */
export function modal({ title, body, footer, wide = false, onClose }) {
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && modalRoot().lastElementChild === backdrop) {
      e.stopPropagation();
      close();
    }
  };
  const bodyEl = h('div', { class: 'modal-body' }, body);
  const dlg = h(
    'div',
    { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h(
      'header',
      { class: 'modal-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', title: 'Close', onClick: close }, icon('x')),
    ),
    bodyEl,
    footer ? h('footer', { class: 'modal-foot' }, footer) : null,
  );
  const backdrop = h('div', { class: 'backdrop', onMousedown: (e) => e.target === backdrop && close() }, dlg);
  document.addEventListener('keydown', onKey, true);
  modalRoot().append(backdrop);
  return { close, el: dlg, body: bodyEl };
}

export function askText({ title, label, value = '', placeholder = '', okLabel = 'OK' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const input = h('input', { type: 'text', class: 'text-input', value, placeholder });
    const form = h(
      'form',
      {
        class: 'stack',
        onSubmit: (e) => {
          e.preventDefault();
          finish(input.value.trim() || null);
        },
      },
      label ? h('label', null, label) : null,
      input,
    );
    const m = modal({
      title,
      body: form,
      footer: [
        h('button', { class: 'btn', onClick: () => finish(null) }, 'Cancel'),
        h('button', { class: 'btn primary', onClick: () => form.requestSubmit() }, okLabel),
      ],
      onClose: () => finish(null),
    });
    input.focus();
    input.select();
  });
}

export function confirmDialog(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const m = modal({
      title: 'Are you sure?',
      body: h('p', null, message),
      footer: [
        h('button', { class: 'btn', onClick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onClick: () => finish(true) }, okLabel),
      ],
      onClose: () => finish(false),
    });
  });
}

const SWATCHES = ['#e5534b', '#e8833a', '#e3b341', '#57ab5a', '#39a8a0', '#4c8dff', '#8b6cef', '#d6609a', '#8b949e'];

/** Resolves to a hex string, '' for "automatic", or null if cancelled. */
export function pickColor(current) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      m.close();
      resolve(v);
    };
    const custom = h('input', { type: 'color', value: current || '#4c8dff', class: 'color-input' });
    const body = h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'swatches' },
        SWATCHES.map((c) =>
          h('button', { class: 'swatch', style: { background: c }, title: c, onClick: () => finish(c) }),
        ),
      ),
      h('div', { class: 'row-between' }, h('label', null, 'Custom'), custom),
    );
    const m = modal({
      title: 'Tag color',
      body,
      footer: [
        h('button', { class: 'btn', onClick: () => finish('') }, 'Automatic'),
        h('button', { class: 'btn primary', onClick: () => finish(custom.value) }, 'Use custom'),
      ],
      onClose: () => finish(null),
    });
  });
}

// ---- small popover menu anchored to a button
let openMenu = null;
export function closeMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  document.removeEventListener('mousedown', outside, true);
  document.removeEventListener('keydown', menuKey, true);
}
const outside = (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
};
const menuKey = (e) => {
  if (e.key === 'Escape') closeMenu();
};

export function popMenu(anchor, items) {
  closeMenu();
  const menu = h(
    'div',
    { class: 'popmenu', role: 'menu' },
    items.map((it) =>
      it === '-'
        ? h('hr')
        : h(
            'button',
            {
              class: 'pm-item' + (it.danger ? ' danger' : ''),
              role: 'menuitem',
              disabled: !!it.disabled,
              title: it.title,
              onClick: () => {
                closeMenu();
                it.onClick();
              },
            },
            it.label,
          ),
    ),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const hgt = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 4 + hgt > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4}px`;
  openMenu = menu;
  document.addEventListener('mousedown', outside, true);
  document.addEventListener('keydown', menuKey, true);
}
