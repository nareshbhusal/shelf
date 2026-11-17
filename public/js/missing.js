import { api } from './api.js';
import { booksChanged, refreshInfo, refreshMeta } from './store.js';
import { confirmDialog, modal, toast } from './ui.js';
import { ago, dirSegments, fmtBytes, h, hashFor, plural } from './util.js';

/** The plain-language account of how Shelf tells books apart. Shown in Settings, in File info and here. */
export function identityHelp({ open = false } = {}) {
  const li = (...kids) => h('li', null, ...kids);
  return h(
    'details',
    { class: 'help-box', open },
    h('summary', null, 'How does Shelf recognise a book?'),
    h(
      'div',
      { class: 'help-body' },
      h('p', null, 'Shelf never writes an ID into your books. What it remembers (tags, reading lists, progress, covers, your programs) is kept in its own database, ', h('code', null, 'shelf.db'), ', one entry per book, holding the book’s path and a ', h('b', null, 'fingerprint'), '. Nothing is ever merged or matched behind your back unless the file is a byte-for-byte match.'),
      h(
        'ul',
        null,
        li(h('b', null, 'Fingerprint'), ': a SHA-1 of the file’s size plus three 64 KB samples of its content (start, middle, end; files up to 192 KB are hashed whole). It is computed while scanning, reading the file only. For a comic that is a folder of loose images it is made from the image names and sizes. Because it follows the content, ', h('b', null, 'any'), ' edit to the file changes it, including annotations added by another program. It recognises a file only while that file is unchanged.'),
        li(h('b', null, 'Renamed or moved, content untouched'), ': at each scan, if a remembered path has vanished and a new file has the same fingerprint and size, it is the same book and everything attached to it follows. This is the only automatic match. Renaming inside Shelf updates the entry at once.'),
        li(h('b', null, 'Edited in place'), ' (same path, new content, for example annotations saved by Okular or qpdfview): Shelf sees the size or time change, refreshes the fingerprint and keeps the book, because the path is the same. Highlights made in Shelf are written into the PDF and the entry is updated right then.'),
        li(h('b', null, 'Moved or renamed and edited before the next scan'), ': nothing about the content still matches, so the new file looks like a new book and the old one shows as missing. This is what the ', h('b', null, 'missing list'), ' is for. It suggests the likely file (same PDF ID, same title and page count, same name or size) and you confirm with ', h('b', null, 'Merge'), ', which moves the tags, lists and progress over.'),
        li(h('b', null, 'PDF ID'), ': most PDFs carry a permanent document ID in their own trailer (', h('code', null, '/ID'), '), put there by the program that made them. It is read, never written, and is kept when annotations are added by common viewers. Shelf stores it and uses it only to rank suggestions. PDFs without one fall back to title, page count, name and size.'),
        li(h('b', null, 'Missing'), ': a remembered file that is gone and unmatched. Its data is kept (a book on an unplugged drive comes back untouched) until you merge or forget it.'),
        li(h('b', null, 'Copies'), ' have the same fingerprint, but while the original is still there each file is its own book. A “Save as” copy with annotations is simply another book.'),
        li(h('b', null, 'Title, author, pages'), ' come from the file itself (PDF document info, EPUB package metadata, CBZ ', h('code', null, 'ComicInfo.xml'), ') or from the file name. They are for display and suggestions, never for automatic matching.'),
      ),
    ),
  );
}

/** Books whose files have gone: what Shelf still remembers about them, and a way to forget them. */
export async function openMissing({ onChange } = {}) {
  let rows;
  try {
    rows = await api.get('/missing');
  } catch (e) {
    return toast(e.message, 'error');
  }
  const list = h('div', { class: 'missing-list' });
  const head = h('p', { class: 'muted small' });
  const forgetAll = h('button', { class: 'btn danger', onClick: () => rows.length && forget(rows.map((r) => r.id), `all ${plural(rows.length, 'missing book')}`) }, 'Forget all');
  const m = modal({
    title: 'Missing books',
    wide: true,
    body: [head, list, identityHelp()],
    footer: [forgetAll, h('span', { class: 'grow' }), h('button', { class: 'btn primary', onClick: () => m.close() }, 'Close')],
  });

  async function forget(ids, what) {
    if (!(await confirmDialog(`Forget ${what}? Their tags, list memberships and reading progress are dropped. Files on disk are never touched.`, { okLabel: 'Forget', danger: true }))) return;
    try {
      const { removed } = await api.post('/purge-missing', { ids });
      rows = rows.filter((r) => !ids.includes(r.id));
      await Promise.all([refreshMeta(), refreshInfo()]);
      booksChanged();
      onChange?.();
      toast(`Forgot ${plural(removed, 'book')}`);
      draw();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  /** Search the library by hand for the book this one turned into (a PDF with no ID, say, that was moved and edited). */
  function openFinder(row, r) {
    const old = row.querySelector('.finder');
    if (old) return old.remove();
    const out = h('div', { class: 'finder-results' });
    let seq = 0;
    const input = h('input', { type: 'search', class: 'input', placeholder: 'Search by title, author or path…', value: r.title });
    const run = async () => {
      const mine = ++seq;
      const q = input.value.trim();
      if (!q) return out.replaceChildren();
      try {
        const found = (await api.get(`/books?q=${encodeURIComponent(q)}&limit=8`)).filter((b) => !b.seriesCard);
        if (mine !== seq) return;
        out.replaceChildren(
          ...(found.length
            ? found.map((b) => h('div', { class: 'cand' }, h('span', { class: 'grow' }, h('b', null, b.title), ' ', h('span', { class: 'muted small' }, b.path)), h('button', { class: 'btn small', onClick: () => merge(r, b) }, 'Merge')))
            : [h('div', { class: 'muted small' }, 'Nothing found.')]),
        );
      } catch (e) {
        out.replaceChildren(h('div', { class: 'err small' }, e.message));
      }
    };
    let t = 0;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
    row.append(h('div', { class: 'finder' }, input, out));
    run();
    input.focus();
  }

  async function merge(r, c) {
    const ok = await confirmDialog(
      `Merge “${r.title}” into ${c.path}? Its tags${r.lists.length ? ', list places' : ''}${r.progress ? ' and reading progress' : ''} move to that file (nothing there is overwritten), and the missing entry is dropped. No file is touched.`,
      { okLabel: 'Merge' },
    );
    if (!ok) return;
    try {
      await api.post(`/missing/${r.id}/merge`, { into: c.id });
      rows = rows.filter((x) => x.id !== r.id);
      await Promise.all([refreshMeta(), refreshInfo()]);
      booksChanged();
      onChange?.();
      toast('Merged');
      draw();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function draw() {
    forgetAll.disabled = !rows.length;
    head.textContent = rows.length
      ? `${plural(rows.length, 'book')} whose file is not at its remembered path and has not turned up elsewhere. If a drive is unplugged they come back by themselves when it returns; a rescan also re-finds renamed or moved files.`
      : 'Nothing is missing.';
    list.replaceChildren(
      ...rows.map((r) =>
        h(
          'div',
          { class: 'missing-row' },
          h(
            'div',
            { class: 'grow' },
            h('div', { class: 'mtitle' }, r.title, h('span', { class: 'chip-mini' }, r.format.toUpperCase()), h('span', { class: 'muted small' }, fmtBytes(r.size))),
            h('code', { class: 'mpath' }, r.path),
            h(
              'div',
              { class: 'muted small' },
              (r.missingAt ? `Noticed missing ${ago(r.missingAt)}` : 'Noticed missing some time ago') +
                (r.progress ? ` · read to page ${r.progress.page}${r.progress.pages ? ` of ${r.progress.pages}` : ''}` : '') +
                (r.tags.length ? ` · tags: ${r.tags.join(', ')}` : '') +
                (r.lists.length ? ` · in ${r.lists.length === 1 ? 'list' : 'lists'}: ${r.lists.map((l) => l.name).join(', ')}` : ''),
            ),
            r.maybe.length
              ? h(
                  'div',
                  { class: 'cands' },
                  h('div', { class: 'muted small' }, r.maybe.length === 1 ? 'A present book may be this one:' : 'Present books that may be this one:'),
                  ...r.maybe.map((c) =>
                    h(
                      'div',
                      { class: 'cand' },
                      h('a', { class: 'grow', href: hashFor('files', dirSegments(c.path.split('/').slice(0, -1).join('/'))), onClick: () => m.close() }, c.path),
                      h('span', { class: 'muted small' }, c.reasons.join(', ')),
                      h('button', { class: 'btn small', title: 'They are the same book: move the tags, lists and progress here, and drop the missing entry', onClick: () => merge(r, c) }, 'Merge'),
                    ),
                  ),
                )
              : null,
          ),
          h(
            'div',
            { class: 'missing-actions' },
            h('button', { class: 'btn small', title: 'Search the library for the file this book became, and merge into it', onClick: (e) => openFinder(e.currentTarget.closest('.missing-row'), r) }, 'Find…'),
            h('button', { class: 'btn small danger', onClick: () => forget([r.id], `“${r.title}”`) }, 'Forget'),
          ),
        ),
      ),
    );
  }
  draw();
}
