import { api } from './api.js';
import { copyText, toastCopied } from './annotations.js';
import { bookName } from './settings.js';
import { modal, toast } from './ui.js';
import { fmtBytes, h, hashFor, dirSegments, icon, progressText } from './util.js';

const when = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

/** The "file info" panel of the reader. `ann` (optional) says what is known about annotations. */
export async function openFileInfo(book, ann) {
  let info;
  try {
    info = await api.get(`/books/${book.id}/info`);
  } catch (e) {
    toast(e.message, 'error');
    return;
  }
  const a = ann?.summary?.();
  const rows = [];
  const add = (label, value, opts = {}) => {
    if (value === undefined || value === null || value === '') return;
    rows.push(h('dt', null, label), h('dd', { class: opts.mono ? 'mono' : '' }, value));
  };

  const copyBtn = (text, label) =>
    h('button', { class: 'btn small', onClick: async () => toastCopied(await copyText(text)) }, icon('note', 13), label);

  add('File name', info.filename);
  add('Location', h('span', null, info.location, ' ', copyBtn(info.location, 'Copy path')), { mono: true });
  add('Folder', info.dir ? h('a', { href: hashFor('files', dirSegments(info.dir)), onClick: () => m.close() }, info.dir) : h('a', { href: hashFor('files', []), onClick: () => m.close() }, '(top of the library)'));
  add('Format', info.format.toUpperCase());
  add('Size', `${fmtBytes(info.size)} (${info.size.toLocaleString()} bytes)`);
  add(info.format === 'epub' ? 'Pages (estimated)' : 'Pages', info.pages && info.format === 'epub' ? `~${info.pages}` : info.pages);
  add('Modified', when(info.modifiedAt));
  add('Added to Shelf', when(info.addedAt));
  add('Shown as', bookName(info));
  if (info.metaTitle && info.metaTitle !== info.filename) add('Title in the file', info.metaTitle);
  add('Author', info.author);
  add('Series', info.series ? `${info.series}${info.number ? ` #${info.number}` : ''}` : '');
  if (info.progress?.page) {
    add('Progress', `${progressText(info)}${info.progress.at ? `, last read ${when(info.progress.at)}` : ''}`);
  }
  add('Tags', info.tags.length ? h('span', { class: 'chips' }, info.tags.map((t) => h('span', { class: 'chip plain' }, t))) : 'none');
  add(
    'Reading lists',
    info.lists.length
      ? h('span', { class: 'chips' }, info.lists.map((l) => h('a', { class: 'chip plain', href: hashFor('list', [l.id]), onClick: () => m.close() }, l.name)))
      : 'none',
  );
  if (info.format === 'pdf' && a?.supported) {
    add('Highlights, notes, drawings', `${a.count} in the file${a.canWrite ? '' : ` (can't be saved here: ${a.reason ?? 'read-only'})`}`);
  }
  add('Fingerprint', info.fingerprint, { mono: true });

  const body = [];
  if (!info.exists) body.push(h('div', { class: 'info-warn' }, 'This file is missing from the library folder right now.'));
  body.push(h('dl', { class: 'info-grid' }, rows));
  if (info.pdf?.length) {
    body.push(h('h3', { class: 'info-sub' }, 'PDF details'), h('dl', { class: 'info-grid' }, info.pdf.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }
  body.push(h('p', { class: 'muted small' }, 'Fingerprint: file size plus a hash of three samples of its content. It is how Shelf keeps tags, lists and progress attached when you move or rename a file.'));
  const m = modal({ title: 'File info', body, wide: true, footer: [h('button', { class: 'btn primary', onClick: () => m.close() }, 'Close')] });
}
