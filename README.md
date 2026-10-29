# archive

A quiet local archive wall for film photographs.

It reads every image inside a folder you choose (and all of its subfolders),
arranges each folder as a justified cluster of prints on a large zoomable white
wall, and lets you open any photograph onto an inspection table — to look
closely, title it, date it, write about it, and draw over and around it.

Everything you add is stored beside the photographs (never inside the image
files). **Your original photo files are never touched, moved, renamed, or
written to.**

---

## installing and launching

Archive uses the same Git checkout on Windows and macOS. Install
[Python 3](https://www.python.org/downloads/) and
[Git](https://git-scm.com/downloads), then clone this repository.

### Windows

Run the one-time setup:

```bat
setup.cmd
```

Then double-click `launch.bat`, or open a new terminal and run:

```bat
archive
```

### macOS

In Terminal, run the one-time setup:

```sh
chmod +x setup.sh launch.sh launch.command
./setup.sh
```

After setup, double-click `launch.command` in Finder or run:

```sh
./launch.sh
```

macOS may ask you to confirm the first launch of a downloaded `.command`
file. If needed, Control-click `launch.command`, choose **Open**, and confirm.

The launchers run `update_and_launch.py`, which checks the trusted GitHub
repository for a clean fast-forward update before opening the app. If the
computer is offline, Git fails, or local source changes are present, the
checkout is left untouched and the installed version opens normally. Details
are written to `data/update.log`.

The setup scripts create `.venv` and install Flask, Pillow, and pywebview.
The environment, local cache, remembered photo path, and update log are
machine-local and excluded from Git.

### Taskbar / Dock app icons

Each platform gets a clickable Archive icon you can keep on your
taskbar (Windows) or Dock (macOS). Both open the app through the same safe
updater — they are just built the platform-native way, so they are two
different files:

| Platform | Icon file | How to use it |
|---|---|---|
| **macOS** | `Archive.app` | committed in the repo. After `./setup.sh`, drag **Archive.app** onto your Dock and click it. |
| **Windows** | `Archive.lnk` | created for you by `setup.cmd` (it is **not** in Git — a Windows shortcut stores absolute paths). Right-click it and choose **Pin to taskbar**. |

Why they differ: macOS needs a real `.app` bundle to show a Dock icon, and
that bundle is portable, so it lives in the repo. A Windows shortcut must
contain machine-specific absolute paths, so it cannot be committed — it is
generated locally during setup instead. If you ever delete it, just run
`setup.cmd` again (or `scripts\make_shortcut.ps1`) to recreate it.

Both the pinned icon and the running window show the Archive icon. On
Windows they share one taskbar button (the app and the shortcut use a
matching AppUserModelID); on macOS the `.app` bundle carries the icon
directly. If the Windows shortcut ever shows a generic icon, re-run
`setup.cmd` after the environment exists so `img/Icon.ico` is applied.

On Windows you can also pin straight from the running app: right-click its
taskbar button and choose **Pin to taskbar**. The window carries relaunch
properties (name, icon, command), so a pin made this way keeps the film
icon and starts the app through the safe updater. If you pinned it before
these properties existed and see a Python icon, unpin that entry and pin
again — either from the running app or from `Archive.lnk`.

### Linking photographs

On first launch no folder is linked — the app
shows a quiet message in the centre. Click **folder** in the top-left corner
and paste the path to the folder that holds your photographs (or the
subfolders of them). It accepts Windows or macOS paths and is forgiving about
quotes, trailing slashes, and `/` vs `\`. Your choice is remembered, so the
next launch opens straight to it. Click **folder** any time to switch.

The app opens in its own window. Useful variations:

| command | effect |
|---|---|
| `archive` / `./launch.sh` | update safely, then open in its own window |
| `archive --browser` / `./launch.sh --browser` | open in your default browser |
| `archive_debug` | Windows troubleshooting console |
| `archive --root "C:\some\folder"` | link a folder from the command line |

If the window ever fails to open (e.g. WebView2 missing), the app falls
back to your default browser automatically.

**How folders become clusters:** images sitting directly in the linked folder
form one justified cluster; each subfolder becomes its own cluster; anything
nested deeper than one level is gathered into its top-level subfolder's
cluster (clustering only goes one level deep).

## using it

Archive opens directly onto the photo wall. Writing, Projects, and the bottom
context switcher have been removed. Existing documents and project folders
remain on disk.

Clusters use equal-size photo frames in aligned rows with the original spacing.
Four rows is the default, with occasional three- or five-row shapes. Large
collections gain rows so they stay compact, and shorter rows are allowed.
Frames stay the same size when reordering; images fit inside without cropping
or distortion. Every occupied row and column has at least two photos wherever possible.
All rows share one left edge, with slightly shorter rows at the bottom.
The two longest rows match to avoid a lone right-edge print wherever possible.
Collections of 1–3, 5 or 7 photos cannot satisfy both limits with contiguous,
left-aligned rows;
all photographs remain visible in those cases.

**tag arrangements** — filter by one or more tags, then drag a photograph over
another to swap their places. The other print glides into its new position;
release to save, or press Escape to cancel. Matching photos from different rolls
are gathered together. Each archive and tag combination keeps its own order
in the local archive database, including after restarting the app. Additional
star, camera, film or search filters only rearrange their visible subset.
Choosing a tag exits Chronological and opens the editable tag layout.
Left-drag swaps photos, right-drag moves the cluster, middle-drag pans, and
the wheel zooms. The unfiltered archive keeps its folder layout. Click without dragging to
inspect or Shift-click to select. Drag anywhere inside a cluster (including
the empty space between prints) to move the group; in a tag filter, dragging
a print still swaps that print. Drag outside clusters or middle-drag to pan.

**top-right menus** — Filter starts with Search, followed by stars, tags,
camera, film, layouts and Clear. With a filter active, **save layout** beside
the rows slider reveals a small name field above the button. Type a name and
press Enter or click **save layout** again to remember the visible photos, their order
across the rows, and the row count. **Filter → layouts → name** smoothly restores
that snapshot. Layouts persist locally for each archive on Windows and macOS;
the newest ten are kept, with each further save replacing the oldest. Saving an
existing name (ignoring case) replaces that layout immediately. The row slider
keeps your chosen count when switching filters; recalling a saved layout restores
its saved count. Right-click
a layout name and choose **delete layout** to remove it. Changes to a recalled
layout can be saved as another named snapshot. Missing photos are skipped.
**add images**, to the left of the row controls, opens the full gallery for
selection. Click prints to select or deselect them; selected prints have a 40%
white overlay. Prints already in the layout stay selected and are never duplicated.
Overview, Filter, and View remain available while choosing. **done**, bottom centre,
returns smoothly to the layout. New prints go to the right end of the shortest
row, breaking ties from the top, so existing row membership and order stay intact.
Named layouts are updated immediately; expanded filter arrangements can be named
with **save layout**. Escape cancels the selection and returns to the layout.
Right-click a print within a layout and choose **remove from layout** to leave
it out of that arrangement. Named layouts update immediately; original image
files, metadata, and other layouts are unaffected.
Right-click a tag and choose **delete tag** to remove
it from every tagged photo, including photos outside the active filter.
Escape clears all active filters and search and fits the full archive.
View starts with Chronological, then Gradient and Ambient. Chronological
clears filters and gathers the full archive into one animated group, oldest
file creation date first. Where creation dates are unavailable, the embedded
original date or last-modified date is used; undated photos go last. Escape or
Overview restores the folder clusters. Search shortcuts
(`/` and Ctrl/Cmd+F) remain available. Ambient starts automatically after four
minutes without input while the app is visible and focused; background time
does not count. Click or press Escape to return to your prior view.

Across photo inspection, the light table and gradient, Escape and a click on
blank paper return one level. A drag on inspection paper still pans; drawing
on paper remains available with an annotation tool.

**the wall** — drag blank paper outside clusters to pan (middle-drag pans everywhere),
scroll to zoom. Each subfolder of your archive is one cluster, labelled
quietly in grey. Click a
photograph to open it. `overview` re-frames the whole archive; `rescan`
picks up new photos. Beneath a print: a small grey dot means it carries
notes or marks, and each of its tags adds a tiny dot in that tag's own
colour. **Right-click and drag any print to carry its whole cluster** to a
new place on the wall (holding Control or Option/Alt with an ordinary drag
works too — handy on a Mac trackpad) — the arrangement is yours, and it is
remembered across launches.

**filtering** — `filter` (top right) opens Search and four folded
groups: `stars`, `tags`, `camera`, `film`. Click a group name to reveal its
options; an active choice stays visible beside the name even when folded.
Stars filter to that rating **and up** (the label says so); tags, camera
and film each filter to photos carrying that value. Everything else gently
fades away and the remaining prints glide into justified clusters, settling
with a soft recoil. `clear` brings the whole archive drifting back.

**the inspection table** — scroll to zoom deep into grain and dust, drag to
pan (in `view` mode, or hold space / use middle-drag while a drawing tool is
active). Press `0` to re-frame the photo, `Esc` to go back. Move between
photographs with the on-screen arrows, `←` / `→`, or `A` / `D`.

**notes** — title, date, location, a five-star rating, free notes, and tags
live in the right-hand column. Everything autosaves as you type ("saved"
appears briefly). A long title wraps and eases down in size to stay on-screen
rather than running off the edge. The date is prefilled from the photo's
metadata when it exists; film scans often have none, and that is fine — it
stays editable or blank. Location sits just beneath the date. The free notes
take word-processor bullet lists: start a line with `- `, press enter to carry
the bullet down, tab / shift-tab to nest, and enter on an empty bullet to end
the list. `notes` in the top corner tucks the column away.

* **stars** — quiet dark-grey stars, Lightroom-style: click the third star
  for three stars, click the current rating again to clear it.
* **camera & film** — two quiet lines beneath the roll name. Each has a
  small scope switch: `roll` writes the value for the whole folder at once
  (every photo in the collection inherits it), `photo` overrides it for
  just this frame — the inherited roll value stays visible as a hint. Set
  a roll's camera and film once, from any photo in it.
* **tags** — type a tag and press enter; add as many as you like, click one
  to remove it. Every tag automatically receives its own muted pastel/earthy
  colour, derived from its name — so the same tag keeps the same colour
  everywhere, forever. Tags already in use elsewhere in the archive appear
  as faint suggestions beneath the field — typing filters them, one click
  adds them — so a tag vocabulary stays consistent across photos.

**drawing** — from the toolbar or keyboard:

* `future` (F) — the Future Brush: bright blue pixelated marks that hold for
  a few seconds, then dissolve pixel by pixel. Temporary by nature; they are
  not saved.
* `ink` (I) — the permanent pen: same pixelated character, but it stays,
  saves automatically, and is there when you come back.
* `wiggly` (W) — the playful pen: permanent like ink, but the line never
  sits entirely still. Each pixel gently boils around its home at a low,
  hand-drawn frame rate — the stroke keeps its shape, it just wiggles
  forever, like a doodle being redrawn over and over.
* `text` (T) — click anywhere on the photo or the table around it and type a
  short note in place; on enter the serif letters (Times) crystallise into
  the same pixel grid as the brushes. Brush size sets the letter size. Once
  placed, just grab a text and drag it to move it — no handles, no boxes —
  and its new position saves. The eraser lifts a whole text it touches.
* `erase` (E) — removes ink, wiggly marks and text (and any lingering
  future marks) under the brush.
* `view` (V) — no drawing; drag pans.
* **colours** live folded inside the small colour wheel on the toolbar —
  click it and the palette unfolds: the future blue, dark grey, white, and
  a quiet earthy row (clay, sage, ochre, slate, rose). All of them work for
  every brush and for text; the size dot carries the chosen colour. With
  any drawing tool in hand the **scroll wheel sizes the brush** (up =
  bigger; a small square previews the size at the cursor) — hold space to
  zoom instead. `[` and `]` (or − / +) also work. The smallest setting
  makes a single fine pixel for delicate marks. `undo` (Ctrl+Z) steps
  back; `clear` clears at once — undo brings everything back if you
  change your mind.
* `b/w` — quietly toggles the photograph between black & white and colour
  while you look. A viewing aid only: nothing is saved or changed.

You can draw on the photograph and on the white table around it — both are
part of the same saved layer.

## where things live

Your notes and marks live **beside the photographs**, so they follow the
archive across machines. When you link a folder, the app creates a `cache`
folder inside it and writes everything you type or draw there as small JSON
files, one pair per photo:

```
<the folder you linked>\cache\
  photos\
    <photo id>.meta.json    title, notes, date, location, tags, stars,
                            camera / film
    <photo id>.anno.json    drawings, text, rotation, black-and-white state
  folders\
    <roll>.json             per-roll camera / film + wall position
  README.txt
```

Because this `cache` folder lives with your photographs and not in the app's
source, your notes and tags are yours — they are never part of the code you
publish. If that folder lives in a cloud drive (iCloud, Dropbox, OneDrive…),
**any
number of copies of the app pointed at the same folder share the same notes,
tags, stars and drawings** — edit on one machine, and the others see it.
Files are written atomically and one-per-photo, which is what makes cloud
sync safe (a single shared database would corrupt). Deleting this folder
resets all annotations but never touches the photographs.

Every committed edit is also written first to a genuinely local `backup`
folder (in the app's own `data\` cache, never in the cloud) as a write-ahead
copy, *before* the shared `cache` is touched. If the cloud folder is offline,
slow to propagate, locked, or the app crashes mid-write, the edit is safe and
is replayed automatically — immediately, on the next launch, and on a light
periodic sweep. Each copy carries a revision so an older change can never
overwrite a newer one, genuine divergences are preserved rather than
discarded, and verified copies self-prune so the folder stays small. This is
belt-and-braces on top of the atomic cache writes; you never interact with it.

Only rebuildable *caches* stay local to each machine, in the app folder:

```
Film_Archive_App\
  app\            application code (Python backend + web UI)
  concept\        design-philosophy notes that guide future changes
  img\            application icon art
  scripts\        helpers run by setup (user PATH, taskbar shortcut)
  tests\          test suite
  data\           local cache only — safe to delete, rebuilds itself
    archive.db      the photo index + dominant-colour cache
    thumbs\         cached thumbnails
    previews\       browser-friendly copies of TIFFs (originals untouched)
    caches\<id>\backup\   local write-ahead safety copy of your latest edits
  .venv\          local Python environment
  setup.cmd / launch.bat / archive.cmd / archive_debug.cmd
```

The launchers stay in the folder root on purpose: pinned taskbar shortcuts,
the `archive` PATH command and the Dock app all point at them by
absolute path, so moving them would break existing installs.

The archive it reads is whatever you linked with the **folder** button. You
can also override per launch:

```
archive --root "D:\some\other\archive"
archive --meta "E:\shared\film_metadata"   (default: <linked folder>\cache)
```

## how originals are protected

* the archive folder is opened read-only for images: the app only ever
  *reads* your photographs
* thumbnails and TIFF previews are written only inside `Film_Archive_App\data\`;
  notes and drawings are written only inside the linked folder's `cache\`
  folder, never into the image files
* drawings are stored as coordinate data in JSON — never rendered into the
  originals

## formats

`.jpg` `.jpeg` `.png` `.tif` `.tiff` `.bmp` `.webp`

TIFFs are shown via automatically cached JPEG previews (browsers cannot
display TIFF directly). **HEIC is not supported** — free, reliable HEIC
support on Windows/Python is patchy, so it was left out rather than left
fragile.

## behavior worth knowing

* the first scan builds thumbnails and can take a while on a large archive;
  the wall appears as soon as the first prints are ready and fills in
  quietly behind the scenes
* layout is deterministic — the same folders and files land in the same
  places every launch
* if you rename or move a photo file, its notes follow it as long as the
  filename and file size still match; otherwise the notes are kept in the
  database but the print disappears from the wall until the file returns
* future-brush marks are session-only by design; ink, notes, titles, dates,
  tags and favorites all persist

## limitations / later ideas

* HEIC is unsupported (see above)
* future-brush marks do not survive closing the photo — intentional, but a
  "persist with decay state" mode could be added
* thumbnails on the wall are held in memory without an eviction limit; very
  large archives (10k+ photos) may benefit from smarter cache eviction
* no search yet — tags are saved and could power a quiet search later
* export (photo + annotations as a flattened image) could be a gentle
  addition


## Photo navigation and filtered layouts

Inspection stays opaque when switching photos, so the overview does not flash
behind the next image. All four arrow keys navigate photographs even with a
text field focused: left/up go back and right/down go forward.

Click Location to see previously saved locations. Typing narrows the list,
Tab cycles the highlight (Shift-Tab goes back), and Enter confirms it. Clicking
a suggestion also selects it. Escape dismisses suggestions.

Any active tag, stars, camera, film or search filter gathers matches into one
editable group. The floating bottom-center rows control selects 1–5 rows,
with animated reflow. Left-dragging a photo swaps it with the hovered target;
photos passed over on the way return to their original slots. Orders are
saved separately for each filter combination. Clearing filters returns to the
ordinary folder wall. The original restoration tag remains available.
