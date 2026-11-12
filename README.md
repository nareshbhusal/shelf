# Shelf

A small, local book and manga server. Point it at a folder; browse your tree of folders, tag
books, build reading lists, search, highlight and take notes in PDFs, open books in your own
programs, and read PDFs, EPUBs and comics (CBZ / ZIP) in the browser.

No user accounts, one optional pass key, one process, one SQLite file. **Your books are never copied** (unlike Calibre,
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
./shelf.sh start --readonly            # Shelf may never write to your books (no saving of highlights, no renaming)
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

- `shelf.db`: tags, reading lists, reading progress, your saved "Open with" programs, your display
  settings, the index.
  **This is the file to back up.** `./shelf.sh backup` (instance running) or Settings > "Download
  backup" makes a consistent copy; `./shelf.sh restore FILE` puts it back. Books are matched by content
  fingerprint, so a restore onto moved or renamed files still reattaches tags, lists and progress.
- `thumbs/`: cover cache. Rebuilt on demand, no need to back it up.
- Highlights, notes and drawings are **not** in there: they live inside the PDFs themselves.
- Display settings (theme, card size, reader widths, EPUB text size, ...) are saved in `shelf.db` too, so
  every browser and device opening this shelf uses the same ones, and they are in the backup. A browser
  keeps a copy only so the page paints right before the server answers; the first time a shelf has no
  saved settings, what your browser already had is uploaded. Small per-browser conveniences (pen colour,
  reader-bar state) stay in the browser.

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
  "passkey": "a long phrase", "host": "0.0.0.0", "requireMount": ["/home/you/mounted_decrypted"],
  "ignore": ["Samples"] }
```

```bash
./shelf.sh init ~/mounted_decrypted/shelf.json --library ~/mounted_decrypted/books   # writes it, then checks it
./shelf.sh check  ~/mounted_decrypted/shelf.json     # report only
./shelf.sh native ~/mounted_decrypted/shelf.json     # check, then run
```

- Paths may be absolute, start with `~/`, or be relative to the folder holding the file, so the whole
  folder can be mounted somewhere else and still work. `init` writes a full path (or `~/...`) exactly
  as you typed it; only a relative path you give it is stored relative to the file's folder (when it is
  inside it). Only `library` is required. If `data` is left
  out it is `shelf-data` next to the file, never a global folder. `name` is shown in the sidebar and tab
  title (handy with several instances); `requireMount` lists mount points that must really be mounted;
  `passkey` and `host` are described under "Pass key" below (`init` takes `--passkey` and `--host`).
- `ignore` (one folder, or a list) keeps folders out of the library: `"ignore": ["Samples", "Manga/Old scans",
  "@eaDir"]`. A bare name skips every folder with that name at any depth; a path is relative to the
  library (an absolute or `~/` path must lie inside it) and skips just that folder and everything below
  it. Names are case-sensitive. `init` takes `--ignore FOLDER` (repeat it); outside a shelf file,
  `SHELF_IGNORE` takes the same entries separated by `:`. Books already indexed from a folder you then
  ignore are treated like deleted files (they show as missing and go on the next cleanup, taking their
  tags and progress with them); take the folder off the list before cleaning up and they come back
  with everything intact. `check` prints what is ignored and warns about a path that doesn't exist.
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
| `HOST`            | `127.0.0.1`   | Bind address. `0.0.0.0` opens it to your network: set a pass key |
| `SHELF_PASSKEY`   | none          | Require this pass key to open Shelf (see "Pass key")      |
| `SHELF_READONLY`  | off           | `1`: never write into the library (no saving highlights, no renaming) |
| `SHELF_ALLOWED_HOSTS` | none      | Extra host names allowed in the Host header (reverse proxies) |

## Pass key

Set one and nobody who can reach the port gets anything (pages, scripts, covers, books, the API) without
it. It is one shared secret, not accounts.

```bash
SHELF_PASSKEY='a long phrase' HOST=0.0.0.0 ./shelf.sh native     # or "passkey" / "host" in a shelf file
```

- Visitors get a login page; a correct key sets a cookie (HttpOnly, SameSite=Strict, 30 days) that
  survives restarts. Changing the pass key logs everyone out. Settings > "Lock Shelf" signs out this browser.
- After 8 wrong guesses from one address in 10 minutes, further tries wait.
- It travels over plain HTTP unless you put HTTPS in front (a reverse proxy such as Caddy or nginx; add its
  host name to `SHELF_ALLOWED_HOSTS`). On a home network that is the usual trade-off; on anything wider, use HTTPS.
- Shelf warns at start when it listens beyond localhost without a pass key, and `check` does too.
- In a shelf file the key sits in the file: keep that file where only you can read it (on an encrypted
  drive that is already true). The key is never printed, logged or put in the data export.

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
  The sidebar list is A–Z by default; the clock button next to "Folders" (or Settings > Sorting) puts the
  folders you read most recently first (a folder counts as read when anything inside it, at any depth, was).
  Folders you never read stay at the bottom, A–Z. The choice is saved with the shelf.
- **Comic folders.** A comic (a *unit*) is a `.cbz` / `.zip`, or a folder of loose images (see below). A
  folder with two or more units directly inside is shown as one card (a stacked cover from its first
  unit, the folder's name, a ×N badge, "2 comics · 340 pages", "n read"); opening it lists its units
  alphabetically. Series and collections of one-shots are treated alike. A folder whose only content is a
  single unit (the layout Kavita requires) disappears from the listing and that comic is shown itself,
  **named after the folder** ("Mushishi", not "Official_Volume 1"). Opening it shows the same series page
  as a bigger series (Read / Continue, rename, trash); add a second volume and the volumes take their own names. Everything else stays an ordinary folder, and "Subfolders" shows the flat list. The
  card's menu can tag, or add to a reading list, all of its units at once. Settings > Library > "Folders
  with several comics as one card" turns this off.
- **Folders of loose images.** Manga kept as plain image files (jpg, png, webp, gif, avif, bmp) work too:
  a folder with three or more images directly inside, and no PDF / EPUB / CBZ next to them, is one comic
  named after the folder, read in natural order (`2.jpg` before `10.jpg`). Put each volume or chapter in
  its own folder, or put the images straight into the series folder. The images are never touched; a
  renamed or moved folder is recognised by its page list, so progress and tags stay. These comics can't be
  downloaded as one file or renamed from Shelf (rename the folder on disk).
- **Reading a series.** Open such a folder and the panel at the top has a **Read** button (**Continue**
  once you've started, **Read again** when everything is read). It opens the part you left off at (the
  last-read part if unfinished, otherwise the next unfinished one). In the reader the parts run on
  without a break: the next part is attached below as you approach the end of one, the previous part above
  you as you approach its start, each introduced by a small heading. The top bar shows "Part 3/12" with
  previous/next-part buttons (`<` `>` keys), and the thin progress line at the bottom is the progress
  through the *whole series*, with a tick where each part begins. Every part keeps its own reading
  progress (so the library, "continue" and the folder card keep working): reading a part to its end
  marks it finished; passing through one quickly (scrolling fast, jumping) saves nothing for it. The
  card and panel percentage counts pages across the whole series. Parts are ordered by file name
  (natural order: `v2` before `v10`).
- **Recently added** (sidebar) lists books Shelf first found in the last 7 / 30 / 90 days or year (your
  choice, saved). The date is when Shelf first indexed the file, not the file's modified date; the first
  scan of a library is the starting point and doesn't count; moving, renaming or editing a file keeps its
  original date. The same rules are written at the top of that page.
- **Names**: cards show the file name by default; Settings > "Show names from" switches to the
  title found inside the file. Sorting follows the choice. The browser tab title says what you are
  reading and on which page.
- **Select** books (checkbox on hover, shift-click for ranges, Ctrl+A) then **Tag**, **Add to list**,
  **Open with** or **Rename…**. Type a new name to create a tag or list on the spot.
- **Rename** (card menu, Details, the selection bar, or "Rename parts…" on a series page). This is the
  narrow on purpose: the file stays in its folder and keeps its extension, nothing is ever
  overwritten, and it is refused in read-only mode. One book: type the new name. Several: find &
  replace (optionally a regular expression), clean-up (underscores or dots to spaces, remove
  `[bracketed]` tags, tidy spaces), letter case, and a name pattern with `{name}` `{n}` (a counter with
  start, step and digits) `{title}` `{author}` `{series}` `{folder}`, with a live preview of every file;
  untick files you want to leave alone. Every name is checked first (characters Windows-style
  drives reject, length, clashes with other books, with files not yet indexed, or within the batch)
  and if anything is wrong nothing is renamed. Swapping names works. The book keeps its identity, so tags,
  lists, reading progress and covers stay with it; a toast offers **Undo** afterwards.
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
- **Rename a folder** (the ⋯ on a folder or series card, or the ⋯ in the header while you are inside one).
  Same place, new name; everything in it keeps its tags, lists and progress. Names starting with a dot are
  refused (the scan skips those), as are existing names.
- **Delete = move to the trash.** "Move to trash…" (book or folder menus, the selection bar) moves the item into
  a `.shelf-trash` folder inside your library, under a dated sub-folder that keeps its original path
  (`.shelf-trash/2026-11-12_21-05-00-ab12/manga/Series/Vol 1.cbz`). Nothing is erased, and the scan
  skips the trash. To undo, move it back out and rescan: Shelf recognises the book by its content, and its tags,
  lists and progress come back. Empty the trash yourself when you want the space. A single-volume series card
  deletes its folder with it. Refused in read-only mode.
- **Export data** (Settings > Storage & backup): a readable JSON file with your tags (colours, counts),
  reading lists in order, per-book tags/lists/progress, programs, display settings and the book index.
  (Progress for EPUBs is the section, the position inside it, and the fraction of the whole book.)
  Books carry path and content fingerprint. It is for reading, diffing and moving data around; the
  backup is for restoring. Highlights, notes and drawings aren't in it (they are in the PDFs).
- **Settings** (gear at the bottom of the sidebar, or press `,`) controls layout, card size, cover fit, what each card shows, theme, accent
  colour, UI size, reader widths and EPUB text. It all lives in one table in `public/js/settings.js`.
- **Reader**: continuous vertical scroll by default, or **one page at a time (horizontal)** for PDFs and
  comics: the `M` key or the button in the top bar switches, and Settings sets the default for PDFs and
  comics separately. Each page is fitted to the window and the pages sit side by side, so you can swipe
  on a touch screen; `←` `→`, space, `PageDown`/`PageUp`, `Home`/`End`, or a click on the left or right
  third of the page turn it (the middle third still shows or hides the top bar). For comics there is a
  **LTR / RTL** button (`D`) for manga that read right to left: pages, arrow keys and click zones all flip.
  Turning past the end of a part of a series opens the next part (and back from the start, the
  previous one). EPUBs always scroll. The reader's background follows your theme (Settings > "Reader
  background" has fixed colours too). Click (or tap) in the middle of the page to hide or show the top bar; it
  stays as you left it. Keys: `+` `-` width, `0` fit window, `n` notes panel, `p` pen, `Ctrl+Z` /
  `Ctrl+Shift+Z` undo and redo, `i` file info, `Esc` back, `f` fullscreen; type a page number to jump. Progress is
  saved and resumed automatically, to the spot within the page (PDF, CBZ) or section (EPUB), not just the page.
  A small page counter sits in the bottom-right corner (it stays when the toolbar is hidden); in a series it also
  names the part, and a brief note appears when you cross into the next part.
  EPUB-only keys: `t` contents, `[` `]` smaller/larger text, `←` `→` previous/next section. The (i) button shows everything about the file: location (copyable),
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
- Comics and EPUBs have no standard place for annotations, so they don't get this (yet, for EPUB).
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
| CBZ / ZIP of images, or a folder of images | yes | first page | `ComicInfo.xml` if present; pages | yes | no |
| EPUB            | yes | cover image | title, author, series (Calibre/EPUB3), estimated pages | yes (own, see below) | no |

Progress stores the page plus how far down it you were (measured at a reading line 35% down the window).
Reopening scrolls to that spot; a book saved by an older version, or opened with `?page=N`, opens at the page top.

Junk metadata such as "Microsoft Word - foo.docx" is ignored and the filename used instead. A `.zip`
(any case: `.ZIP`, `.Cbz`) is treated exactly like a `.cbz`; one with no images is not indexed. Images may sit in subfolders inside the archive. Pages in comics sort naturally (`page2` before `page10`). Rotated and
cropped PDF pages are laid out correctly, including their selectable text.

### The EPUB reader

Continuous scroll through the whole book, like the other readers. Each section (chapter file) is shown in
its own sandboxed frame and loaded only when you get near it, so large books open quickly.

- Contents (EPUB3 nav or EPUB2 NCX) in a side panel (`t`); internal links, footnotes and cross-references
  work, with a Back button after a link jump. External links open in a new tab.
- Text size, line spacing and font (serif, sans, or the book's own) from the **Aa** button or `[` `]`; text
  width like the other readers. Colours follow your theme and "reader background" (the book's own text
  and background colours are overridden so dark mode stays readable).
- Progress is the section plus how far into it, so reopening lands where you stopped. **Pages are an
  estimate**: the amount of text divided by about 1800 characters (a paperback page; a section made of a
  picture counts as one page), counted once when the book is scanned. Cards show "~312 p", the reader's corner
  counter shows "p. ~87/~312 · 28%", and the progress bar is the fraction of the book by text, not by sections.
- **Scripts in books never run**, nothing loads from outside the book, and the frames can't submit forms or
  open windows (sandbox plus a strict Content-Security-Policy on every file served from inside an EPUB).
- Sloppy XHTML that isn't well-formed XML is shown through the forgiving HTML parser instead.
- Not there yet: highlights/notes in EPUBs, search inside a book, paged mode, fixed-layout books (shown as
  flowing text), DRM-protected books (can't be read at all).

## Not built yet

CBR/RAR, a paged mode for EPUB, reading series of PDFs or EPUBs straight through, smart lists,
renaming folders, metadata editing, a file watcher, per-user accounts.

## Layout

```
src/config.ts   paths, ports, formats        src/scanner.ts  walk, fingerprint, moves, cleanup trigger
src/db.ts       SQLite (node:sqlite)               src/meta.ts     PDF / EPUB / CBZ metadata
src/zip.ts      single entries from zips     src/covers.ts   lazy cover cache (by fingerprint)
src/shelffile.ts shelf-file checks (+ shelfcli.ts)   src/auth.ts  pass key login
src/epub.ts     EPUB structure/resources     public/js/epubreader.js  EPUB reader
src/rename.ts   checked, undoable renames    public/js/rename.js      rename dialogs
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

Shelf writes to your library in exactly these cases, all only when you ask and never in read-only mode:
saving highlights, notes and drawings into a PDF; renaming a book file or a folder (same place, no
overwriting); and moving books or folders into the `.shelf-trash` folder inside the library. It never copies
books and never erases anything.

By default it binds to localhost; with a pass key it can be opened to your network (see "Pass key").
Cross-origin write requests (e.g. from a web
page you have open) are rejected, as are requests with an unexpected Host header (DNS rebinding).
"Open with" only ever runs commands you saved in Settings, never anything supplied by a request.
Don't expose the port beyond a network you trust: the pass key is a gate, not a hardened login, and without
HTTPS it travels in the clear.
