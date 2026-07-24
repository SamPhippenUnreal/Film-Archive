# Archive — Architecture Reference

*The authoritative description of how the application is actually built and
behaves **today**, as of this writing. It is a companion to
[`CONCEPT.md`](CONCEPT.md), which owns intent and ethos. Where the two disagree,
CONCEPT.md governs "what kind of app this is" and this document governs "what the
code currently does." Read both completely before any significant architectural
change.*

This document records the implemented state after the storage and Writing
architecture redevelopment. Historical compatibility paths are called out only
where they still affect reads or migration.

---

## 1. High-level overview

Archive is a **local desktop application**. It is not a web service and never
talks to a backend server over the network (the only network use is an optional,
fail-safe GitHub self-update at launch).

It is built as three layers running on one machine:

1. **A native window** — `pywebview` hosts the UI in the platform web view
   (WebView2 on Windows, WKWebView on macOS). If no web view is available the
   app falls back to the user's default browser.
2. **A local HTTP + JSON server** — Flask, bound to `127.0.0.1` on an ephemeral
   port, serves the static UI, a JSON API, and image/thumbnail/preview bytes.
3. **A static vanilla-JS frontend** — no framework, no build step, no
   dependencies. Plain ES modules-as-IIFEs (`Wall`, `Detail`, `Writing`,
   `Projects`, `About`, `PixelBrushes`, `API`) attached to `window`, drawing to
   `<canvas>` and (for Writing) `contentEditable`.

A thin **native bridge** (`window.pywebview.api`, class `JsApi` in
`app/main.py`) exposes only the few operations that must be native: OS folder
pickers, a multi-file picker, a native Save dialog, and a real screen-pixel grab
of the visible web view.

### The three contexts

The product presents **three independent "contexts"**, each linked to its own
folder chosen by the user at runtime and remembered separately:

| Context  | Purpose | Backend holder | Store | Linked-folder state key |
|----------|---------|----------------|-------|--------------------------|
| Pictures | The photo wall + inspection table | `Archive` | `Store` + `MetaStore` + `Scanner` | `root` |
| Writing  | A paginated document editor | `WritingArchive` | `DocxStore` | `writing_root` |
| Projects | A folder-backed project canvas | `ProjectArchive` | `ProjectStore` | `project_root` |

The three folders are fully independent — a user may link none, one, or all
three, and each is switched without disturbing the others. The frontend
`ContextNav` pill (in `main.js`) cross-fades between them.

---

## 2. Backend layers and modules

All backend code is under `app/`. Line counts are approximate and indicate
relative weight.

### 2.1 `app/main.py` — entry point, window, native bridge (~700 lines)

- **`main()`** parses args (`--root`, `--data`, `--meta`, `--port`, `--browser`,
  `--no-window`), loads per-machine config (`archive.config.json`), constructs
  the three archive holders, restores each remembered folder from
  `data/state.json`, builds the Flask app via `create_app`, picks a free port,
  and either serves headless, opens a browser, or opens a `pywebview` window.
- **`normalize_path(raw)`** is the canonicalisation routine every linked folder
  passes through: it strips quotes, `file://` URLs, `~`, env vars, trailing
  slashes, mixed separators, escaped spaces, then `os.path.realpath` to a single
  canonical identity (true case, resolved symlinks). This is what guarantees the
  same physical folder always maps to the same cache and metadata locations.
- **`_load_state` / `_save_state`** persist the three linked folders into one
  shared `data/state.json`, each under its own key, so the contexts remember
  their folders independently.
- **`Archive`, `WritingArchive`, `ProjectArchive`** are three small holder
  classes. Each owns a lock, the currently-linked root, and lazily constructs
  its store(s) in `set_root()`. Each linked folder gets a machine-local cache
  directory keyed by `sha1(canonical_path)[:16]` under `data/caches/<hash>/`.
- **Windows native integration** (`_set_windows_app_id`, `_find_own_window`,
  `_set_windows_relaunch`, `_dress_windows_window`) uses `ctypes` to give the
  window its own taskbar identity, the Archive icon, and pinnable relaunch
  properties that route through the safe updater. All best-effort and never
  fatal.
- **`JsApi`** (the `window.pywebview.api` bridge): `pick_folder`, `pick_files`
  (Project imports), `pick_save_file` (Writing PDF destination), and
  `capture_visible_region` (a native `PIL.ImageGrab` of the window's client
  rect, used by the Project canvas "save" — a true pixel capture, not an HTML
  re-render).

### 2.2 `app/server.py` — HTTP + JSON API (~1120 lines)

`create_app(archive, project_archive, writing_archive)` builds one Flask app and
registers every route. Key characteristics:

- **Read-only toward originals.** Photo bytes and Project files are only ever
  read and streamed (`send_file`); writes go only to caches and sidecars.
- **Caching headers** (`_no_store_api`): `/api/*` responses are `no-store`;
  HTML/JS/CSS are `no-cache` (so a self-updated app never runs stale UI against
  a newer backend); images/thumbnails stay cacheable.
- **Route groups:**
  - Pictures: `/api/status`, `/api/rescan`, `/api/root`, `/api/wall`,
    `/api/gradient`, `/api/tags`, `/api/photo/<id>`, `/api/photo/<id>/meta`,
    `/api/photo/<id>/annotations`, `/api/folder/offset`, `/api/folder/meta`,
    `/thumb/<id>.jpg`, `/image/<id>`.
  - Projects: `/api/project/*` — status, root, projects list/detail, create,
    rename, delete, layout, positions, cover, annotations, trash/restore,
    per-file delete, import (pictures/writing/files), documents (get/save/
    rename), snapshot, and the `/project/file` + `/project/preview` byte routes.
  - Writing: `/api/writing/*` — status, root, documents list/get/create/save/
    rename/duplicate/delete, and `/api/writing/export-pdf`.
  - The orphaned `/api/documents*` route family is retired. `DocStore` remains
    importable only as a compatibility/migration module and is not constructed
    by the live application.
- **`_prepare_writing_fields`** shapes an editor payload for the shared TXT/DOCX
  store: it keeps the editor's clean HTML model, and only for a legacy `.docx`
  does it inject real `<img>` tags (resolving `/image/<id>` to photo bytes) so
  python-docx can embed pixels. New `.txt` documents never read photo bytes on
  save.
- **`_pdf_bytes`** builds a visual-fidelity multipage PDF from client-rendered
  page images (US-Letter MediaBox derived from the rendered width).
- **PDF export and snapshot** use durable exclusive/atomic file creation. The
  snapshot route verifies JPEG validity and writes a unique filename into the
  active project's `project canvas/` folder.

### 2.3 `app/store.py` — local derived cache (~180 lines)

`Store` wraps a per-machine SQLite database (`data/caches/<hash>/archive.db`)
holding the **rebuildable** photo index, a dominant-colour cache, and a settings
table. It **delegates all user-authored metadata to `MetaStore`** (it never
stores notes/tags/etc. itself). This is the tier-2 "disposable local cache"
boundary. Nothing here ever writes to photo files.

### 2.4 `app/metastore.py` — shared per-photo metadata (~435 lines)

`MetaStore` is the tier-3 "irreplaceable, travels-with-the-photos" store. It
writes small JSON sidecars into `<linked photo folder>/cache/`:

```
cache/
  photos/  <photo_id>.meta.json   title, notes, date, location, tags, rating, camera, film
  photos/  <photo_id>.anno.json   drawings, text, rotation, black-and-white state
  folders/ <roll_key>.json        per-roll camera/film + wall offset
```

Photo id = `sha1(rel_path)[:16]` (stable across machines). Reads are cached by
mtime so concurrent instances pick up each other's edits. Every commit goes
through `_write_json`, which is **backup-first** via a `BackupJournal`. It also
performs a one-time migration from the pre-rename `film_archive_app_metadata`
folder name.

### 2.5 `app/backup.py` — write-ahead safety journal (~520 lines)

`BackupJournal` is the crash-/cloud-resilient safety layer for **JSON sidecars**.
It moves opaque JSON payloads between a machine-local `backup/` copy and the
shared cache, both addressed by a stable `sub/name` relative key. Per commit:
stamp a monotonic `rev`, stage a durable local copy + journal entry (`pending`),
apply to the cache, read back and verify (`verified`), keep briefly then prune.
Failures stay `pending` and replay (immediately, on launch, on a light periodic
sweep) with bounded exponential backoff. Same-revision divergences are preserved
as conflicts; unreadable records are quarantined; verified recovery copies
self-prune by age/count/size. It is injected with the owning store's atomic-write
and read-json primitives. Those primitives delegate to `app/safeio.py`, the
single shared durable byte/JSON write and canonical path boundary.

**Shared by the live app:** `MetaStore` (photos/folders) and `ProjectStore`
(projects). `DocxStore` retains its binary source-file journal for `.txt`/`.docx`
recovery, but uses `safeio` for the underlying durable writes.

### 2.6 `app/scanner.py` — read-only photo scan (~290 lines)

`Scanner` recursively walks the linked photo folder (skipping `cache` and the
legacy metadata dir), builds thumbnails (512px) and TIFF previews into the local
cache, extracts EXIF dates and a dominant colour, and upserts rows into `Store`.
Clustering is **one folder-level deep** (everything under a top-level subfolder
belongs to that subfolder's cluster). A background `watch()` loop re-scans when a
cheap tree signature changes. `_reconcile_moves` carries a renamed/moved photo's
metadata to its new id by filename+size match, else marks it missing. Strictly
read-only toward originals.

### 2.7 `app/layout.py` — deterministic wall layout (~120 lines)

`build_wall(photos, offsets)` places each folder as a loosely-jittered cluster on
a golden-angle spiral, seeded deterministically from folder/filename hashes so
the wall is identical every launch. User cluster offsets (from right-drag) are
applied on top.

### 2.8 `app/docstore.py` — retired compatibility module (~310 lines)

`DocStore` is the **older** document system: each document is one JSON file
(`content` HTML, `groups`, `annotations`, `rating`, `tags`) under
`<linked photo folder>/cache/documents/<id>.json`, backed up via `BackupJournal`.
The current frontend does not call this system and the Flask app exposes no
routes for it. `Archive` no longer constructs it. The module and its tests remain
only to read/migrate older installations safely.

### 2.9 `app/docxstore.py` — the current Writing store (~935 lines)

`DocxStore` backs the live Writing context. It manages a linked folder of
**plain `.txt` files** (the portable source of the words) plus **legacy `.docx`**
for compatibility. Archive-only editing state (formatting HTML, placed image
groups, annotations, rating, tags) lives in a companion `.archive-writing/`
sidecar folder as `<name>.json` (schema `version: 2`, keyed to the source file's
checksum and stat, so external edits invalidate stale state).

Notable internals:
- **HTML ⇆ text / docx conversion:** `html_to_plain_text`, `plain_text_to_html`,
  `_HtmlToDocx` / `html_to_docx_bytes`, `docx_bytes_to_html`. Only `.docx` saves
  build a Word package and embed images (downscaled to `EMBED_MAX_DIM = 1600`).
  `.txt` saves are a fast path that writes UTF-8 text and the sidecar only.
- **`_DocxBackup`** — a **second, independent** write-ahead journal, purpose-built
  for **binary** `.docx` bytes (stage → write folder → verify → purge, replay on
  launch). It duplicates the *concept* of `BackupJournal` in a parallel
  implementation (§5.2).
- **Recursive, flat discovery:** `_scan` walks the linked folder recursively,
  skips reserved app folders, and presents every supported document in one flat
  UI. Root documents keep their historical stem ids; nested documents use a
  deterministic relative-path hash suffix so duplicate stems remain distinct.
  Renames preserve the document's containing subfolder.
- A memoised `_shape_cache` avoids re-converting unchanged files; `save_doc`
  returns light metadata to skip re-reading the just-written file.

### 2.10 `app/projectstore.py` — the Projects store (~1075 lines)

`ProjectStore` presents a linked folder as projects and persists their
user-created state without rewriting project files unless the user explicitly
edits a document.

- **Discovery:** each immediate subfolder of the linked root is a project (id =
  `sha1(rel)[:16]`). Compatibility rule: a root that contains files but no
  subfolders is presented as a single project.
- **File walk:** `_walk_files` recursively lists a project's files (skipping
  `cache`, `.archive-writing`, `trash`, and `project canvas`), classifying each by extension
  (`image`/`text`/`document`/`audio`/`video`/`file`).
- **Project-owned state** lives inside each project at `cache/project.json`,
  `cache/annotations.json`, and `cache/writing/<relative document>.json`.
  Cover-grid layout remains a root-level index because it describes relations
  between projects. Writes are backup-first via `BackupJournal`. Reads migrate
  the former `<projects root>/cache/projects/<id>.*` layout on demand.
- **Covers:** `set_cover` records a chosen image's rel-path; a project has no
  photographic cover until one is explicitly chosen (uncovered projects use the
  animated About-style gradient field).
- **File safety / trash:** `remove_file` atomically moves material into the real
  per-project `trash/` tree while preserving its relative path. `restore_files`
  moves it back and refuses to overwrite an existing destination. Legacy
  hidden-in-place `removed` entries are still understood and are migrated by
  normal use.
- **Imports** (`import_files_with_errors`): always **copy** (never move) into the
  project folder, using exclusive `open(dst,"xb")` for a no-overwrite guarantee
  and appending ` 2`, ` 3`… on name collisions. Picture/Writing imports resolve
  ids server-side (client-supplied paths are rejected except from the native
  picker). Writing imports also copy their editor state into project `cache/`.
- **Document editing:** `get_document`/`save_document` share the authoritative
  `writing_state.py` sidecar validation and shaping helpers with `DocxStore`.
- **Previews:** `preview_for` renders image/PDF thumbnails (PDF via `pypdfium2`)
  into the machine-local cache. **Delete project** (`delete_project`) is the one
  genuinely destructive operation and is scoped to an exact immediate child, gated
  by explicit two-value confirmation at the HTTP layer.
- **Snapshot** is saved by the HTTP layer into the project's reserved
  `project canvas/` folder with a collision-safe filename.

---

## 3. Frontend layers and modules

All under `app/static/`. `index.html` is the single shell; `style.css`
(~2190 lines) holds all styling; JS is loaded as plain scripts.

### 3.1 `js/api.js` — the fetch layer (~265 lines)

Thin async wrappers around every endpoint, plus `tagColor(name)` — the stable,
name-derived pastel/earthy tag colour used everywhere. **Note:** the `documents*`
methods target `/api/writing/*` (the `DocxStore`), confirming `DocStore` is
orphaned.

### 3.2 `js/main.js` — app shell (~970 lines)

Owns boot and everything on the Pictures side that is not the wall itself:
- **`Splash`** — the noise-driven logo "developing" animation on boot.
- **Scan polling** (`poll`) — reads `/api/status`, shows progress, reveals the
  wall as soon as the first prints are ready, keeps listening for new rolls.
- **Folder linking** — native picker or paste-a-path fallback (`chooseFolder`,
  `linkFolder`, `submitFolder`), plus the empty-state messaging.
- **Filtering** — stars/tags/camera/film + free-text search, folded groups,
  active-choice hints.
- **Secondary views** — light table (`openTable`, capped at 4), gradient shelf
  (`openGradient`), and **`Ambient`** (a self-contained crossfade drift with a
  temporary star filter).
- **`ContextNav`** — the pill that names the active context and drives
  `Writing.enter/leave`, `Projects.enter/leave`, and wall intro/outro; plus
  `refreshNav`, which hides the pill whenever a focused view is open (read from
  the DOM via a `MutationObserver`, deliberately not rAF).

### 3.3 `js/wall.js` — the photo wall (~640 lines)

A single `<canvas>` renders every print. A `nodes` map holds each print's
position/target/alpha; `draw()` eases the camera toward a goal and floats each
node toward its target with an **eased-exponential approach, no spring**
(`FLOAT_K`). Intro/outro animate prints landing/lifting from z-space. Thumbnails
and full-resolution images are cached with bounded parallelism and LRU eviction.
Interaction: drag-pan, wheel-zoom-at-cursor, click-to-open, shift-click for the
light table, and **right/Ctrl/Alt-drag to carry a whole cluster** (with elaborate
cross-stream handling for macOS WebKit quirks). `setPick` highlights prints while
Writing is choosing pictures. Exposes `step()` for frame-stepped testing.

### 3.4 `js/detail.js` — the inspection table (~1190 lines)

The single-photo workspace and the **canonical** annotation/notes implementation:
- A `<canvas>` draws the photo (with a manual pre-desaturated grey copy for b/w —
  never `ctx.filter`, which no-ops on WKWebView), rotation, and marks.
- **Annotation model:** `ink`/`wig` maps (`"x,y" → colour`), a `future` map
  (session-only), a `texts` array of movable rasterised notes, and an
  `undoStack`. Rendering is delegated to `PixelBrushes`.
- **Notes panel:** title (auto-sizing), date (auto-formatting), location, notes
  (with plain-text bullet handling), five-star rating, tags (with suggestions),
  and per-roll/per-photo camera & film scope switch.
- **Persistence:** meta and annotations autosave on a debounce; a `sendBeacon`
  flush covers window close. Colour is chosen through the shared HSL picker.
- Full single-key toolbox (`v/f/i/w/t/e`, rotate, sizing, undo, nav) and
  `step()` for testing.

### 3.5 `js/writing.js` — the Writing editor (~3150 lines) ⚠ **priority**

The largest and least stable module. It implements a paginated word processor on
top of `contentEditable` + `document.execCommand` + a bespoke DOM-mutating
pagination engine. See §6 for the full weakness analysis. Structure:
- **Document archive** — a horizontal strip of first-page preview cards
  (`buildCard`, `hydrateCard`, `renderDocInto`), lazy-hydrated via an
  `IntersectionObserver`, scaled to fit via a `ResizeObserver`, plus an overview
  grid, filtering, and document search.
- **Editor** — `flow` (`#doc-flow`, contentEditable) inside `paper`, with:
  - **Pagination** (`paginate`, `resetPagination`, `lineBoxes`, `splitBlockAtLine`,
    `hoistGroups`, `insertSpacer`) — a synchronous pass that measures line boxes
    via `Range.getClientRects`, splits paragraphs at page boundaries into
    `.doc-cont` continuations, inserts `.page-spacer` furniture, and moves image
    groups as indivisible blocks. Runs on a 320 ms debounce
    (`scheduleRepaginate`) and again synchronously on open/insert/resize.
  - **Selection preservation** (`captureFlowSelection`, `restoreFlowSelection`,
    `withCaret`) — saves/restores the caret across pagination by text offset and a
    physical `.caret-marker` node.
  - **Formatting** — bold/italic/underline via `execCommand` (with a `probe-bold`
    trick), bullet lists (`convertDashLine` + `execCommand('insertUnorderedList')`
    + indent/outdent), point sizes (`applyFontSize` via `execCommand('fontSize','7')`
    → rewrite to `<span>` + `relineFontSpans`), and greyscale text colour.
  - **Image groups** — `renderGroups`, `applyGroupLayout` (grid/stagger/two-page
    split), selection, layout slider, b/w, edit, and **drag-between-lines**
    (`groupDrag`, `dropSlotAt`, `showDropLine`). **This feature is considered
    complete and correct and must be preserved exactly.**
  - **Annotations** — a full second copy of the `ink`/`wig`/`future` brush model
    and pointer handling over an overlay canvas (§5.4).
  - **PDF export** — rasterises each paginated page (SVG `foreignObject`, with a
    manual canvas-layout fallback for tainted-canvas web views) and posts to
    `/api/writing/export-pdf`.
  - **Saving** — `serializeContent` strips pagination furniture; `flushSave`
    serialises a revision-ordered save chain; `flushSaveBeacon` covers close.
  - **Project bridge** — `openProjectDocument`, `WritingPreview`, and the
    project-writing multi-pick session.

### 3.6 `js/projects.js` — the Projects context (~2200 lines)

The project index (cover grid with drag-arrange, animated gradient covers for
uncovered projects, create/rename/delete flows) and the project **canvas**: files
are positioned DOM tiles (images, PDFs-as-raster, audio player, quiet
filename tiles), pannable/zoomable, with per-file position/size/z persistence.
It carries a **third** copy of the pixel-annotation model (ink/wig/future/text +
undo + HSL picker over a `<canvas>`), a trash view (same move/resize
interactions), an import menu (pictures via the wall, writing via the Writing
archive, files via the native picker), and the "save" action that captures the
visible canvas via `capture_visible_region` and posts it to the snapshot route.
Reuses `WritingPreview`/`Writing.openProjectDocument` for in-project documents.

### 3.7 `js/pixel-brushes.js` — the shared brush engine (~270 lines) ✅

`PixelBrushes` is the one piece of **successful consolidation**: the shared
vocabulary and rendering for ink/wiggly/future marks and rasterised text, plus
the `createHslPicker` interaction model, colour resolution (hex or legacy palette
index), and serialize/deserialize helpers. All three annotation surfaces render
through it — but each still owns its own *stroke capture, undo, pointer handling,
and persistence* (§5.4).

### 3.8 `js/about.js` — the About field (~300 lines)

A self-contained animated 3D-value-noise pastel light field, masked through the
wordmark's bracket stencil. Also exposes `mountNoise(surface)`, which drives the
seeded gradient fields used by uncovered Project covers.

---

## 4. Data flow & the three-tier model

The app's governing data model (see CONCEPT.md §7) has three tiers:

1. **Originals — read-only, sacred.** Photo files and Project files. Never
   modified, moved, renamed, or written. Enforced by `Scanner` (read-only),
   `is_within` scope checks, copy-only imports, and read-only byte routes.
2. **Local rebuildable cache — disposable, machine-specific.** `data/caches/<hash>/`:
   `archive.db`, thumbnails, previews, project previews, and the machine-local
   `backup/` write-ahead copies. Keyed by canonical linked-folder path. Safe to
   delete.
3. **Shared user metadata — irreplaceable, travels with the content.** Sidecars
   beside the user's own files:
   - Pictures: `<photo folder>/cache/` (MetaStore).
   - Writing: `<writing folder>/.archive-writing/` (DocxStore) + the `.txt`
     itself as portable source.
   - Projects: per-project `cache/`, `trash/`, and `project canvas/` directories;
     only the cross-project cover-grid index is root-scoped.

**Typical write path (metadata):** frontend autosave → `API` → Flask route →
store `set_*` → `_write_json` → `BackupJournal.stage` (local, durable) → atomic
write to shared cache → read-back verify → prune. This backup-first ordering is
the app's core durability guarantee.

**Typical read path (wall):** `main.js` polls `/api/status`; `refreshWall` calls
`/api/wall` → `Store.all_photos` + `MetaStore.meta_flags` + `layout.build_wall`
→ `Wall.setData` animates the canvas.

---

## 5. Consolidated systems and retained compatibility

The redevelopment removed live duplication at the persistence and editor-model
boundaries while preserving compatibility readers where removing them would make
older archives harder to recover.

### 5.1 One live Writing persistence model

`DocxStore` is the live Writing store. Project document editing consumes the
same `writing_state.py` helpers for editor-field selection, stat signatures,
checksum validation, and version-2 sidecar construction. The shared schema
(`version: 2`, `source_checksum`,
`source_format`, `source_stat`, `content`, `groups`, `annotations`, `rating`,
`tags`) therefore has one definition. `DocStore` is retired from runtime wiring
and routes but retained as a compatibility module.

### 5.2 Backup journals

- **`BackupJournal`** (`backup.py`) — the full-featured JSON journal (rev,
  checksum, conflict, quarantine, prune). Used by `MetaStore` and
  `ProjectStore`; its path mapping supports nested per-project caches.
- **`_DocxBackup`** (inside `docxstore.py`) — a **parallel, simpler**
  reimplementation for binary `.docx` bytes.

The binary journal remains deliberately separate because it protects the source
document bytes rather than JSON metadata. Both journals now share `safeio`'s
durable write guarantees.

### 5.3 Shared atomic IO

`safeio.py` owns canonical path comparison, containment checks, SHA-256 helpers,
JSON reads, and sibling-temp + `fsync` + `os.replace` atomic byte/JSON writes.
`DocxStore`, `DocStore`, `ProjectStore`, `MetaStore`, and application state
persistence delegate to it. Small store-level wrappers remain only where tests
and journals inject the operation.

### 5.4 Context-specific annotation surfaces

`detail.js`, `writing.js`, and `projects.js` maintain their own
`ink`/`wig`/`future` maps, `texts` array, `undoStack`, pointer/stroke capture,
brush-size/preview handling, save scheduling, and HSL-picker wiring. They share
only the **rendering** (`PixelBrushes`). The stroke-capture + undo + pointer +
persistence layer. They continue sharing the rendering primitives in
`PixelBrushes`; their controllers remain context-specific because the coordinate
systems and persistence timing differ, and Writing's image placement/dragging
must remain pixel-identical.

### 5.5 Smaller duplications

- **Bullet-list logic** exists twice: plain-text bullets in `detail.js` notes
  (`bulletLine`/`notesLine`) and contentEditable bullets in `writing.js`.
- **Tag chip + suggestion rendering** is repeated in `main.js`, `detail.js`, and
  `writing.js`.
- **Folder-linking UI** (native picker + paste-path bar + error handling) is
  repeated in `main.js`, `writing.js`, and `projects.js`.
- **Grey/desaturation** logic and **canvas camera/ease** loops recur across
  `wall.js`, `detail.js`, and `projects.js`.

---

## 6. The Writing context — deep weakness analysis (priority)

The Writing editor is the app's most unstable area. Its defects share a single
structural root cause, so they should be addressed by re-architecting the editor
core rather than by more local patches.

### 6.1 Structural root cause

The editor combines three fragile mechanisms that fight each other:

1. **`contentEditable` as the source of truth.** The live editable DOM *is* the
   document model. There is no separate, authoritative data model; the HTML the
   browser produces is serialized directly.
2. **`document.execCommand` for all formatting.** Deprecated and
   browser-divergent. Bold uses a `probe-bold` weight hack because the rendered
   "bold" weight is 400; sizing abuses `execCommand('fontSize','7')` then rewrites
   `<font>` to `<span>`; pending (caret-only) formatting is represented as
   ephemeral DOM — a zero-width-space `<span>` or a transient execCommand state.
3. **A synchronous DOM-mutating pagination pass over the editable tree.**
   `paginate()` measures line boxes and then **inserts/removes spacer and
   continuation nodes inside the very tree the user is typing into and that holds
   the selection.** It runs on a 320 ms debounce and again synchronously on many
   events.

Because pagination and block-normalisation constantly rewrite the editable tree,
any state stored *in* that tree — pending formatting spans, the caret marker, the
selection offsets — is fragile and frequently lost or mis-mapped. That single
fact explains almost every reported defect.

### 6.2 Reported defects and their likely causes

1. **Bullet points are buggy.** `convertDashLine` + `execCommand`
   `insertUnorderedList`/`indent`/`outdent`, mediated by `normalizeBlocks`
   (which re-wraps bare inline content into `<div>`s) and then reflowed by
   pagination. List item boundaries, empty items, and nested indents interact
   badly with the block-normalisation and continuation-splitting passes.
2. **Pagination is slow and unreliable.** Every pass walks the whole flow,
   measures each block with `getClientRects`/`getBoundingClientRect` (forced
   synchronous layout), mutates the DOM (spacers/continuations), and re-measures.
   This is O(n) layout thrash on the main thread on every settle, competing with
   typing. Reliability suffers because the measured geometry is taken from a tree
   that is simultaneously being edited and re-normalised.
3. **Poor page-membership decisions.** `splitBlockAtLine`/`splitPointAtY` use
   binary-searched caret geometry and a line-box heuristic; image groups use a
   separate `pageSpan`/spacer path. The two mechanisms are independent and
   fragile at boundaries.
4. **Decreasing text size does not work.** `applyFontSize` relies on
   `execCommand('fontSize','7')` then rewrites every `font[size="7"]` in the whole
   flow to a sized `<span>`, and `relineFontSpans` strips/rewrites line-heights on
   every repaginate. Shrinking is unreliable because the nearest-size read
   (`syncSizeControl` via computed style) and the nested-span accumulation don't
   round-trip; existing larger spans are not reliably reduced.
5. **Writing "copies or introduces words that exist elsewhere."** Most likely
   causes to investigate: (a) selection save/restore by text offset
   (`captureFlowSelection`/`flowBoundaryAt`) mis-mapping offsets across pagination
   furniture (spacers/continuations/markers) and re-inserting or duplicating a
   run; (b) `doc-cont` continuation blocks not being merged back cleanly in
   `serializeContent`/`resetPagination`, leaving duplicated tail text; (c) the
   platform web view's own `contentEditable` autocomplete/autofill/spellcheck
   suggestions inserting text. A redesigned model-based editor removes (a) and (b)
   structurally; (c) should be explicitly disabled on the editable element.
6. **Formatting changes do not always carry forward.** Pending inline formatting
   is stored as ephemeral DOM (ZWSP spans / execCommand state). `normalizeBlocks`
   and `paginate`/`withCaret` rewrite the tree and can discard the empty styled
   span or move the caret out of it before the next character is typed.
7. **Size-then-type must keep the new size.** The pending-size `<span>` with a
   ZWSP and caret-inside technique is destroyed by the next repaginate/normalise.
8. **Underline-off-then-type must stay non-underlined.** Same class of bug: the
   pending "underline off" state is execCommand-transient and not preserved across
   the tree rewrite.
9. **Other active formatting must persist likewise.** Same root cause.

### 6.3 Direction for the redesign (behaviour-preserving)

Separate the three concerns the current design fuses:

- **An authoritative document model** — an explicit structure of block nodes
  (paragraph / list-item / image-group) each carrying inline runs with marks
  (bold/italic/underline/colour) and an explicit size. The DOM becomes a *render
  target* of this model, not the model itself.
- **Explicit selection + pending-marks state** — a first-class "active formatting
  at the caret" that survives re-renders because it lives in the model/state, not
  in throwaway DOM. Typing applies pending marks to newly inserted runs.
- **A pure layout/pagination pass** — computes page breaks from *measured* block
  heights and positions page backgrounds/offsets, **without editing the
  content-bearing nodes**. Continuations/spacers become layout output, not edits
  to the document tree. This removes the feedback loop that currently corrupts
  selection and formatting and causes the thrash.
- **Image groups as atomic model nodes** — preserving the exact current
  appearance, interaction, and drag-between-lines behaviour, which is complete and
  must not change.

Whether this is a hand-written model/editor or a carefully scoped adoption of an
established editor *pattern*, it must add **no paid dependency**, keep the same
visual output, keep the `.txt`-plus-sidecar storage model, and preserve every
existing Writing feature (including annotations, ratings, tags, search, PDF
export, and image placement) without adding new ones.

---

## 7. Animation & transition architecture

Motion is deliberately calm — **eased-exponential decay, no spring overshoot**
(CONCEPT.md §4, §9). Current implementations:

- **Wall** (`wall.js`): camera and node float via per-frame exponential approach
  (`FLOAT_K`, `k`); intro/outro land/lift prints from z-space; rAF-driven with a
  `requestDraw` coalescer and a `step()` test hook.
- **Detail** (`detail.js`): camera ease `k = 0.18`; wiggly marks wake on a 125 ms
  boil timer; future marks animate while alive.
- **Projects** (`projects.js`): DOM-positioned tiles with CSS transitions; a
  canvas annotation draw loop with the same 125 ms boil cadence; seeded gradient
  covers via `About.mountNoise`.
- **About** (`about.js`): a continuous rAF noise field.
- **Context transitions** (`main.js` `ContextNav`, plus each context's
  `enter`/`leave`): whole-view veil cross-fades, timed with `setTimeout` (not rAF)
  precisely because rAF is suspended while the window is hidden.

**Consistency note / minor risk:** `writing.js`'s horizontal strip uses a
`glideStrip` **damped spring** (`stripScrollVelocity … * 0.78`), described in-code
as "a sense of weight." This is the one place a spring-like model is used, which
sits in mild tension with the app-wide "no spring" motion principle. Consolidating
motion should reconcile this toward the shared eased-exponential feel.

Recurring hazard the code already guards against: **rAF is suspended when the
window is hidden / in the test harness.** The app uses `setTimeout` for anything
that must complete off-screen, and exposes `step()` methods (`Wall`, `Detail`,
`About`) for frame-stepped testing. Any redesign must keep this discipline.

---

## 8. Storage model — implemented

The three contexts follow the intended local-first storage model.

### 8.1 Pictures — largely conformant ✅

- Images live in the linked folder and are **read-only** — conformant.
- A `cache/` folder is created inside the linked folder holding all per-photo
  isolated-mode state (tags, notes, annotations, text, b/w, rotation, date,
  title, location, camera/film, rating) as JSON sidecars — conformant.
- Underlying image files are never modified — conformant.

### 8.2 Writing

- Linked via the folder button; `.txt` is the portable source; Archive-only state
  (formatting, image placement, annotations, rating, tags) lives in
  `.archive-writing/` sidecars and is **not** embedded in the `.txt` — conformant.
- Create/modify/delete map to real disk operations; autosave on close and app
  close — conformant.
- `.txt` and compatible legacy `.docx` files are discovered **recursively** and
  presented at the **same visual level**. Stable root ids are preserved; nested
  paths receive deterministic suffixes to prevent collisions. Rename, delete,
  backup, and sidecar lookup remain scoped to the real nested file.

### 8.3 Projects

- Immediate subfolders are projects; covers, cover-promotion, thumbnails, and
  canvas file listing are conformant; imports are copy-only.
- Removing material creates and moves it into the project's real `trash/`
  directory, preserving the relative path. Restore moves it back without
  overwriting an existing file.
- Generated state is project-owned in `cache/`; central legacy state is imported
  on read. The root retains only state that genuinely spans projects.
- Visible-canvas screenshots are validated and stored in `project canvas/`,
  never Downloads.
- `cache`, `.archive-writing`, `trash`, and `project canvas` are reserved,
  excluded from material discovery, and protected by canonical containment
  checks.

---

## 9. Existing tests & coverage

Tests are under `tests/` (pytest), and are strong on the **backend storage and
safety** layers, thin on the **frontend editor**:

- `test_backup.py` — the write-ahead journal: durability, replay,
  idempotency, crash points, revision monotonicity, conflicts, quarantine,
  pruning, unicode.
- `test_metastore.py` — sidecar metadata, location field, backup-first,
  replay, mixed colour formats.
- `test_docstore.py` — the retired compatibility store.
- `test_docxstore.py` — the live Writing store: text/format round-trip,
  image embedding + capping/idempotency, create/save/delete/rename, external-edit
  invalidation, editor-state round-trip, binary backup/reconcile, recursive
  discovery, duplicate nested stems, and nested rename.
- `test_projectstore.py` & `test_server_projects.py` — project
  discovery, covers, positions/annotations persistence, safe rename/delete,
  copy-only imports, physical trash/restore, previews, project-canvas snapshots, PDF export,
  path-traversal/symlink safety.
- `test_server_tags.py` — tag discovery/dedup/filtering.
- `test_main_jsapi.py` — the native bridge (pickers, capture).
- `tests/js/writing-model.test.js` — explicit pending marks, immutable marked-run
  insertion/merging, and pure pagination decisions.

**Coverage gaps the redesign should close:** there is essentially **no automated
coverage of the Writing editor's pagination, formatting-state, bullets, sizing,
selection, or the image-group placement/drag** — exactly the areas that are most
unstable. Because the editor is frontend `contentEditable`, this needs a testable
editor core (a model that can be unit-tested without a browser) plus
frame-stepped/DOM-assertion checks in the harness (the `step()` pattern), which
is a strong additional reason to extract an authoritative model from the DOM.

---

## 10. Relationships between the major systems

```
                         pywebview window  ──(JsApi bridge)──►  native pickers / screen grab
                                │
                         Flask (server.py) ── static UI + JSON API + image bytes
             ┌──────────────────┼───────────────────────────┐
        Archive            WritingArchive               ProjectArchive
       (photos)             (documents)                  (projects)
        │   │  │                 │                            │
     Store MetaStore Scanner   DocxStore                 ProjectStore
        │     │                  │  │                     │   │   │
        │  BackupJournal      _DocxBackup                 │  BackupJournal
        │  (JSON WAL)         (binary WAL)  ◄─ parallel ─►│  (JSON WAL)
        │                        │                        │
   docstore.DocStore ── retained compatibility module; not runtime-wired

   Frontend contexts:
     Wall ─┐
     Detail├─ share PixelBrushes rendering; each keeps its context-specific
     Writing│  coordinate, undo, pointer, and persistence controller
     Projects┘
     main.js ContextNav orchestrates enter/leave + wall intro/outro
     About.mountNoise powers uncovered Project covers
```

Key cross-context couplings preserved by the implementation:
- Writing "insert picture" borrows the **Pictures wall** for selection
  (`Wall.setPick` / `onPickClick`).
- Projects import borrows both the **Pictures wall** (picture import) and the
  **Writing archive** (writing import, via the `archive:project-writing-picker`
  event and `Writing.openProjectDocument`).
- Projects in-canvas document editing reuses the **Writing editor** and
  `WritingPreview`.
- Tag colours (`tagColor`) and the tag vocabulary (`/api/tags`) are shared across
  Pictures and Writing.

---

## 11. Invariants future changes must respect

1. **Originals are sacred.** No feature may modify, move, rename, or rewrite a
   user's photo or project file, except the explicit trash move, import copy, and
   project-canvas screenshot operations (§8), which are non-destructive.
2. **The three-tier data model is inviolable.** Every piece of state must land in
   the correct tier (originals / rebuildable cache / irreplaceable sidecar).
3. **Backup-first durability** must be preserved: no commit path may write the
   shared/cloud copy before the durable local copy.
4. **Multi-instance & cross-machine.** Ids are path-derived and stable; sidecars
   are per-file and atomic (never a single shared DB in the synced folder). Keep
   it so.
5. **Behaviour and appearance must not change.** No new features, no visual
   redesign, no new bright/saturated
   colours, no modal confirmation dialogs, no springy motion.
6. **The Writing image-placement + drag feature is frozen** — preserve exactly.
7. **rAF-suspension discipline** — use timers for off-screen-critical transitions;
   keep `step()` test hooks.
8. **No paid tools, services, APIs, or dependencies.** Prefer the standard library
   and the existing dependency set (Flask, Pillow, pypdfium2, pywebview,
   python-docx).
9. **Cross-platform (Windows + macOS).** Respect the documented WKWebView
   pitfalls (`ctx.filter` no-ops; SVG-foreignObject canvas tainting; inconsistent
   Control-drag streams).

---

*This document reflects the codebase as traced end-to-end at the time of writing.
It should be updated whenever a significant architectural change lands, and it —
together with CONCEPT.md — is the governing reference for architectural and design
decisions in this project.*
