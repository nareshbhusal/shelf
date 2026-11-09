# Shelf

A small, local book and manga server. Point it at a folder; browse your tree of folders, tag
books, build reading lists, search, highlight and take notes in PDFs, open books in your own
programs, and read PDFs and CBZ comics in the browser.

No users, no login, one process, one SQLite file. **Your books are never copied** (unlike Calibre,
Shelf has no library of its own: your folders stay exactly as you keep them). The library is only
read, with one deliberate exception: highlights and notes you add are saved inside that PDF
(see "Highlights and notes").

## Run it

**Docker** (nothing to install on the host except Docker). `shelf.sh` uses plain `docker` only, no
compose plugin:

```bash
./shelf.sh start ~/Documents/Books     # builds, starts, remembers the folder
# open http://localhost:4321
./shelf.sh stop | restart | logs | status | list
./shelf.sh start --readonly            # Shelf may never write to your books (no saving of highlights)
```

Docker needs `sudo apt install docker.io` once. If your user isn't in the `docker` group the script
falls back to `sudo` by itself.

**Without Docker** (needs Node 22.13 or newer; there is no native add-on to compile or to trip over
an old glibc, so it runs on Ubuntu 20.04 as long as Node itself does):

```bash
sudo apt install poppler-utils          # PDF titles, page counts and covers
./shelf.sh native ~/Documents/Books     # installs dependencies the first time, then runs
```

Shelf's index uses the SQLite built into Node (`node:sqlite`), so the old `GLIBC_2.33 not found`
error from a prebuilt database add-on is gone.

### Where the data lives, and what to back up

Everything Shelf knows beyond your files is in one folder, `~/.local/share/shelf` by default:

- `shelf.db`: tags, reading lists, reading progress, your saved "Open with" programs, the index.
  **This is the file to back up.** `./shelf.sh backup` (instance running) or Settings > "Download
  backup" makes a consistent copy; `./shelf.sh restore FILE` puts it back. Books are matched by content
  fingerprint, so a restore onto moved or renamed files still reattaches tags, lists and progress.
- `thumbs/`: cover cache. Rebuilt on demand, no need to back it up.
- Highlights, notes and drawings are **not** in there: they live inside the PDFs themselves.
- Display settings (theme, card size, ...) are kept by the browser, not backed up.

### Several libraries at once

Each library is an *instance* with its own name, port, data folder and container. Everything is
remembered per name, so afterwards `./shelf.sh restart --name private` is enough.

```bash
./shelf.sh start ~/Documents/Books                       # the default instance, port 4321
./shelf.sh start ~/mounted_decrypted/books --name private \
    --data ~/mounted_decrypted/shelf-data \
    --require-mount ~/mounted_decrypted --port 4322
./shelf.sh list                                          # all instances and whether they run
./shelf.sh stop --name private
```

### Shelf files: one file says where a library and its data live (native)

For a library you don't want mentioned anywhere outside it (an encrypted drive, say), skip the
registered-instance route above. It remembers things in `~/.config/shelf`. Describe the library in a
small JSON file that sits inside the drive, and nothing else remembers it:

```json
{ "name": "private", "library": "books", "data": "shelf-data", "port": 4322, "readonly": false,
  "requireMount": ["/home/you/mounted_decrypted"] }
```

```bash
./shelf.sh init ~/mounted_decrypted/shelf.json --library ~/mounted_decrypted/books   # writes it, then checks it
./shelf.sh check  ~/mounted_decrypted/shelf.json     # report only
./shelf.sh native ~/mounted_decrypted/shelf.json     # check, then run
```

- Paths may be absolute, start with `~/`, or be relative to the folder holding the file, so the whole
  folder can be mounted somewhere else and still work. Only `library` is required. If `data` is left
  out it is `shelf-data` next to the file, never a global folder. `name` is shown in the sidebar and tab
  title (handy with several instances); `requireMount` lists mount points that must really be mounted.
- Before anything starts, the file is checked: valid JSON and known keys (typos are flagged), the library
  exists, is readable, is writable (unless `readonly`) and contains books, mounts are real mounts, the data
  folder is usable (a missing *parent* is refused, because creating it would write to the wrong disk), the
  library and data folders don't overlap, both lie inside the required mounts, the port is free, and the
  existing data **belongs to this library** (a sample of the books it knows must exist in the library).
  The server runs the same checks itself, so starting it by other means can't skip them. Any error means
  nothing is started and nothing is created.
- A shelf file is the only description: no instance is registered, nothing goes in `~/.config`, and
  nothing is written outside the two folders it names (scratch files are under the data folder too).
- Not for Docker yet, and options can't be mixed with a shelf file (edit the file instead).

For a library on an encrypted drive, keep the data folder on the drive too (as above), so tags, lists
and covers of that library exist only while it is unlocked, and stop that instance before you lock
the drive. `--require-mount` refuses to start (and creates nothing) unless the drive is mounted, and
stops Docker from auto-restarting the container after a reboot. If the drive is a FUSE mount made by
your own user (gocryptfs, EncFS, ...), the Docker daemon usually can't see into it: either add
`user_allow_other` to `/etc/fuse.conf` and mount with `-o allow_other`, or run that instance with
`./shelf.sh native ...` (same options).

### While developing: do I need to clean Docker each time?

No. `./shelf.sh start` rebuilds the image (cached layers, so seconds when only code changed),
replaces the old container, and your data is a normal folder outside Docker, so nothing is lost.
Rebuilds leave untagged old images behind; `./shelf.sh clean` removes them. If you work on the
frontend, `./shelf.sh native` is faster: edit, refresh the browser, no rebuild.

| Variable          | Default       | Meaning                                                   |
|-------------------|---------------|-----------------------------------------------------------|
| `LIBRARY_DIR`     | `./library`   | Folder to index                                           |
| `DATA_DIR`        | `./data`      | SQLite database and cover cache                           |
| `PORT`            | `4321`        | Port                                                      |
| `HOST`            | `127.0.0.1`   | Bind address. Only change it if you add auth.             |
| `SHELF_READONLY`  | off           | `1`: never write into the library (no saving highlights)  |
| `SHELF_ALLOWED_HOSTS` | none      | Extra host names allowed in the Host header (reverse proxies) |

## Does it find new files by itself?

Yes, in three ways: it scans when the server starts; it rescans quietly whenever you come back to
the browser tab (at most every 30 seconds, without moving what you're looking at); and the circular
arrow in the top bar rescans on demand (Shift-click re-reads every file's metadata). A rescan of
1,500 books that haven't changed takes about a tenth of a second. There is no always-on file watcher.

## What it stores, and cleaning up after itself

- Index, tags, lists, progress: one SQLite file. Covers: one small JPEG per book (about 60 KB), made
  lazily and keyed by the book's fingerprint.
- After every successful scan, covers that no book refers to any more (book deleted, or edited so
  its fingerprint changed), and stale temp files, are removed, and the database's write-ahead log is
  folded back in. Files that vanished are only hidden at first; "Forget missing books" in settings
  drops them and their covers for good. A scan that finds nothing while the index has books is refused,
  so an unmounted drive can't wipe your tags.
- Settings shows how much space the index and covers use.

## Using it

- **Folders** mirror the directory tree. "Subfolders" shows everything below the current folder.
- **Names**: cards show the file name by default; Settings > "Show names from" switches to the
  title found inside the file. Sorting follows the choice. The browser tab title says what you are
  reading and on which page.
- **Select** books (checkbox on hover, shift-click for ranges, Ctrl+A) then **Tag**, **Add to list**
  or **Open with**. Type a new name to create a tag or list on the spot.
- **Search** (press `/`) matches title, author, series, file name, path and tag names.
- **Reading lists** keep a manual order; drag cards to reorder. "Open list with…" in a list's header
  sends the whole list, in order, to one of your programs.
- **Open with your own programs** (Settings > Programs): two separate sets, one for books (the
  "Open with" menu on books and selections) and one for reading lists ("Open list with…"). Give each a
  name and a command, for example
  `okular {file}` or `zathura {files}`. `{file}` is the book, `{files}` every selected book or a whole
  reading list (one argument each), `{dir}` its folder, `{name}` its file name; with none of those the
  path is appended. Quotes work, pipes and `&&` don't (no shell is involved, which is why a strange
  file name can't do anything funny): point the command at your own script for anything fancy.
  A container can't start apps on your desktop by itself, so with Docker `./shelf.sh start` also runs
  a tiny helper on the host (`tools/shelf-opener.py`, Python 3, listens on a private unix socket
  that only your user can open, and only launches the commands you saved in Settings). After a reboot
  `./shelf.sh start` (or `./shelf.sh opener`) brings it back. Settings > Programs says whether it is
  reachable. Running natively needs no helper.
- **Export data** (Settings > Storage & backup): a readable JSON file with your tags (colours, counts),
  reading lists in order, per-book tags/lists/progress, programs, display settings and the book index.
  Books carry path and content fingerprint. It is for reading, diffing and moving data around; the
  backup is for restoring. Highlights, notes and drawings aren't in it (they are in the PDFs).
- **Settings** (gear at the bottom of the sidebar, or press `,`) controls layout, card size, cover fit, what each card shows, theme, accent
  colour, UI size and reader widths. It all lives in one table in `public/js/settings.js`.
- **Reader**: vertical scroll. Click (or tap) anywhere on the page to hide or show the top bar; it
  stays as you left it. Keys: `+` `-` width, `0` fit window, `n` notes panel, `p` pen, `Ctrl+Z` /
  `Ctrl+Shift+Z` undo and redo, `i` file info, `Esc` back, `f` fullscreen; type a page number to jump. Progress is
  saved and resumed automatically. The (i) button shows everything about the file: location (copyable),
  size, dates, pages, tags, reading lists, progress, number of annotations, fingerprint and, for PDFs,
  version, producer and page size.

## Highlights, notes and drawings

PDFs only. Three tools, all in the reader's top bar:

- **Highlight**: select text and pick a colour (or press `h` for your last colour); "Highlight + note"
  adds text. Click a highlight to edit its note, recolour or delete it.
- **Note** (note icon with a plus): click anywhere on a page to put a sticky note there. It needs no
  text selection, so it works on scanned pages too.
- **Pen** (`p`): draw freehand with a few colours and three thicknesses. Strokes are saved as one
  drawing per pause (or when you press Done / Esc / leave the page); Undo removes the last stroke or
  the last saved drawing. Click a drawing later to recolour or delete it. It is a basic pen on
  purpose: no eraser, shapes or pressure.

**Undo / redo** (the arrows in the top bar, `Ctrl+Z`, `Ctrl+Shift+Z` or `Ctrl+Y`) cover every change above:
adding, editing, recolouring and deleting. Each step is a real edit of the PDF; undoing a delete writes
the annotation back. While drawing, Undo first takes back unsaved strokes one at a time. The history
lasts for the visit to the book.

The panel (`n`) lists everything and "Copy all" gives highlights and notes as Markdown.

They are written into the PDF itself as ordinary PDF annotations, the way Okular or Evince do it,
so those programs (and phones, Acrobat, and so on) show and edit the same ones. Nothing is kept in
Shelf's database. How it writes, because this is the only place Shelf touches your files:

- It **appends** an incremental update; the original bytes stay exactly as they were. Before
  replacing the file it checks the new file starts with the old one byte for byte, still opens with
  the same page count, and that nobody changed the file meanwhile. Then it writes a temp file next to
  it and renames it over the original (atomic). Any failed check changes nothing.
- It refuses to write to PDFs that are encrypted or have a damaged structure (they'd need a full
  rewrite, which Shelf won't do to your files).
- Saving changes the file's size and fingerprint. Shelf updates its index at once, so tags, lists and
  progress stay attached. If you annotate in another program, Shelf treats it like any edit of a file.
- Annotation types made elsewhere that Shelf doesn't know (text boxes, stamps, shapes) are left untouched
  in the file but aren't drawn in Shelf's reader.
- Comics and EPUBs have no standard place for annotations, so they don't get this.
- The library folder must be writable by the user running Shelf. `--readonly` / `SHELF_READONLY=1`
  turns saving off (existing highlights are still shown).
- No cross-book "all my notes" page yet: it would mean opening every PDF to look for annotations.

## How tags survive moving files

Books are identified by a content fingerprint (file size plus a hash of three 64 KB samples), not by
path. When you move or rename a file in Nautilus and rescan, the scanner sees a "new" path whose
fingerprint matches a vanished one and treats it as a move: same book, same tags, lists, progress.

Limits:

- A file that is **moved and edited** in the same scan can't be matched, so it appears as a new book
  and the old one as missing. Move first, scan, then edit.
- **Identical duplicate files** share a fingerprint. They are tracked as separate books, but if you
  delete one and move the other in the same scan, the tags may attach to either.

## Formats

| Format          | Browse / tag / search | Cover | Metadata                       | Reader | Notes |
|-----------------|:---------------------:|:-----:|--------------------------------|:------:|:-----:|
| PDF             | yes | page 1 | title, author, pages (poppler) | yes (pdf.js) | yes |
| CBZ / ZIP of images | yes | first page | `ComicInfo.xml` if present; pages | yes | no |
| EPUB            | yes | cover image | title, author, series (Calibre/EPUB3) | **not yet** (download or Open with) | no |

Junk metadata such as "Microsoft Word - foo.docx" is ignored and the filename used instead. A `.zip`
with no images is not indexed. Pages in comics sort naturally (`page2` before `page10`). Rotated and
cropped PDF pages are laid out correctly, including their selectable text.

## Not built yet

EPUB reader, CBR/RAR, paged and right-to-left reader modes, click zones, next-volume button,
smart lists, bulk rename, metadata editing, a file watcher, authentication.

## Layout

```
src/config.ts   paths, ports, formats        src/scanner.ts  walk, fingerprint, moves, cleanup trigger
src/db.ts       SQLite (node:sqlite)               src/meta.ts     PDF / EPUB / CBZ metadata
src/zip.ts      single entries from zips     src/covers.ts   lazy cover cache (by fingerprint)
src/shelffile.ts shelf-file checks (+ shelfcli.ts)
src/pdfnotes.ts highlights/notes inside PDFs src/launch.ts   "Open with" (no shell, argv only)
src/hygiene.ts  orphan cleanup, storage stats
src/server.ts   REST API + static files
tools/          shelf-opener.py (host helper for Docker)
public/         no-build frontend (plain ES modules): library.js, reader.js, annotations.js, ...
```

The frontend only talks to the REST API in `src/server.ts`, so the backend could be rewritten in
another language later without touching the UI (the PDF writing is the part that would need a
substitute for mupdf).

## Safety notes

There is no authentication, so it binds to localhost. Cross-origin write requests (e.g. from a web
page you have open) are rejected, as are requests with an unexpected Host header (DNS rebinding).
"Open with" only ever runs commands you saved in Settings, never anything supplied by a request.
Don't expose the port to a network without putting a login in front of it.
