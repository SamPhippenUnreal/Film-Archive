# Film Archive — Concept & Design Philosophy

*A briefing for future AI coding agents (and humans) picking up this project.
Read this before making changes — it explains the intent behind decisions
that might otherwise look arbitrary, so new work stays in the spirit of the
app instead of quietly drifting away from it.*

For exact technical specifics (file layout, API routes, keyboard shortcuts,
current feature list), read `README.md` and the code itself — they are the
source of truth. This document is about *why* the app looks and behaves the
way it does, so decisions you make on top of it are consistent rather than
just plausible.

---

## 1. What this is

Film Archive is a quiet, personal desktop app for living with a scanned
film-photo collection: browsing it slowly, looking closely, and writing and
drawing on it over time. It is built for one specific feeling — standing in
front of a large wall of prints in a studio, able to walk right up to any one
of them, and free to leave a mark on the wall itself.

It is a **local desktop application** (Python + Flask + Pillow + pywebview),
not a web service. It runs on the user's own machine, reads photographs from
a folder the user chooses, and never requires an account, a server, or an
internet connection to function (only the optional GitHub auto-update needs
network access, and it fails silently-safe if there is none).

## 2. What this deliberately is not

This list matters as much as the "is" — most bad additions to this app come
from importing conventions from adjacent categories of software that this
app intentionally is not:

- **Not Lightroom / Capture One.** No develop modules, no non-destructive
  RAW pipeline, no export presets, no batch processing pipelines.
- **Not a digital asset manager.** No folders-as-database, no keyword
  taxonomies enforced top-down, no bulk metadata editing grids.
- **Not a file browser.** The wall is not Explorer/Finder with thumbnails;
  there is no list view, no sort-by-column, no multi-select-and-drag file
  operations.
- **Not a contact sheet generator or export tool.** There is no "export
  contact sheet," no watermarking, no print-layout tooling.
- **Not a dashboard.** No charts, no counters-as-KPIs, no admin-panel
  aesthetic anywhere.
- **Not a generic gallery/slideshow app** in the stock-photo-viewer sense —
  the ambient mode and gradient shelf exist as *contemplative* ways to
  revisit the collection, not as utilities.

If a feature request sounds like "give it an X like [industry photo tool]
has," the right first question is whether X actually belongs in a quiet
personal archive, or whether it's importing that other tool's assumptions
wholesale.

## 3. The core metaphor: a wall you tend, not a database you administer

Everything in the app maps back to a physical, tended space:

- **The wall** is the whole archive at once — an oversized, pannable,
  zoomable surface where every photo has a place. Subfolders become loose,
  organically-jittered clusters (not a grid), each labelled quietly. Cluster
  positions are **seeded deterministically** from folder/filename hashes, so
  the wall looks the same on every launch — like an actual wall, things stay
  where you left them. When the user **right-drags a whole cluster** to a
  new spot, that placement is remembered permanently. This is the wall
  behaving like furniture the user arranges, not a layout engine re-flowing
  content.
- **The inspection table** is what happens when you lift one print off the
  wall and hold it close — deep zoom into grain and dust, a notes column
  beside it, drawing tools at hand. Leaving it puts the print back on the
  wall exactly as it was.
- **The light table** is a small, deliberately-capped surface (at most four
  prints) for laying a few photos side by side to compare — a real
  light-table constraint, not an unbounded multi-select gallery.
- **The gradient shelf** re-sorts the entire archive by dominant colour, hue
  sweeping across a grid — a purely contemplative, non-functional way to see
  the collection as a field of colour rather than as folders.
- **Ambient mode** is the archive quietly showing itself to you: a slow,
  uninterruptible crossfade through the (filtered) collection with no
  interaction at all — closer to watching light move across a room than to
  a "slideshow feature."
- **The about screen** is the archive introducing itself: the logo behind a
  slow, imagined field of pastel light. A small poetic gesture, not a splash
  ad or a changelog.

When adding a new view or mode, ask what physical space or gesture it
corresponds to. If it doesn't map to something a person would actually do
with real prints on a real wall, reconsider the feature rather than the
metaphor.

## 4. Design language

Sam maintains a standing design-language reference
(`Quiet Digital Archive Design Language.pdf`, referenced from memory as
binding across all of his app projects, not a suggestion). Its governing
principles, as applied in this app:

- **Off-white, never pure white or black.** The app's actual paper colour is
  `#FAFAF7`. Pure black and pure white are avoided in UI chrome; where they
  do appear it's inside *content* (e.g. a drawn mark), never as interface
  background.
- **A grey hierarchy for type and structure**, not a black-and-white one —
  strong grey for primary text, mid grey for body, light grey for quiet/
  secondary information. Hairline borders, never heavy strokes.
- **One rare accent colour used to mean something specific.** The shipped
  "Future Brush Blue" is `#1E43FF` — reserved for the ephemeral brush and
  temporary/active-state accents. It is not a general-purpose UI colour. A
  small earthy accent row was added later for user-chosen marks and tags
  (clay `#A96A45`, sage `#8E9F72`, ochre `#C0A050`, slate `#7E93A8`, rose
  `#B08699`) — all muted, desaturated, non-neon. Any new colour must justify
  itself the same way: quiet, purposeful, and never bright/saturated/neon.
- **Light, quiet typography.** Titles lean serif/italic (Georgia); the rest
  of the interface is a light sans (Helvetica/Segoe UI Light-weight). Text
  is small by default. Nothing shouts.
- **Lowercase, quiet microcopy.** In-app language reads like a soft-spoken
  human, never like software: `reading archive…`, `no notes yet`,
  `no camera found`. Never "Error!", never exclamation points, never
  capitalised system-alert phrasing.
- **Calm, eased motion — deliberately not bouncy.** Wall nodes float toward
  their target with an eased exponential approach and **no spring
  overshoot**. This was a deliberate correction: an earlier version used a
  physical spring with a rebound recoil, and it was explicitly replaced
  because it felt too playful/bouncy for the app's tone. Filtering still
  reads as prints "gently fading" and "gliding" into new clusters, but the
  motion itself should decelerate smoothly into rest, not spring past it and
  settle back.
- **Generous space, soft shadows, minimal chrome.** Controls are folded away
  by default (the colour wheel, the filter groups) and expand only on
  request. The interface should feel almost absent; the photographs and the
  marks on them are what the eye should land on.

## 5. Interaction philosophy

- **Keyboard-first, single-letter mnemonics.** Tool switches are one key
  each (`V` view, `F` future, `I` ink, `W` wiggly, `T` text, `E` erase),
  navigation is arrows or `A`/`D`, `0` re-frames, `Esc` backs out one level
  at a time through a defined stack (ambient → gradient → table → selection
  → search). Shortcuts should be single, obvious keys — not chorded
  combinations — wherever the vocabulary allows it.
- **No confirmation dialogs. Undo is the safety net instead.** `clear` acts
  immediately with no "are you sure?" — because undo fully restores it. This
  is intentional: modal confirmation dialogs are exactly the kind of heavy,
  software-y interruption this app avoids. If a future action is
  irreversible enough that undo can't cover it, that is a signal to make it
  *not* irreversible (e.g. via versioned/soft state), not to add a dialog.
- **Direct manipulation over forms.** Dragging a cluster, dragging placed
  text, scroll-wheel brush sizing, middle-mouse panning everywhere — the app
  prefers "grab and move the thing" to "open a panel and set a value,"
  whenever both are plausible.
- **Palettes and options fold away until asked for.** The colour wheel
  unfolds only on click; filter groups (stars/tags/camera/film) start
  folded and show only a small hint of the active choice when collapsed.
  Density is earned by interaction, not shown by default.
- **The empty state is not an error.** No linked folder on first launch is
  an expected, designed-for state with its own quiet instruction — never
  treated as a failure path.

## 6. The marks: ink, future, wiggly, and text (a vocabulary, not just tools)

The four drawing tools are not interchangeable brush styles — each carries a
distinct *meaning*, and that meaning should guide any future brush work:

- **Ink** — a permanent archival mark. It behaves like writing directly on a
  physical print: it stays, it saves, it is there next time exactly as left.
- **Future** — an explicitly ephemeral, "message from the future" mark. It
  holds briefly then dissolves pixel by pixel. It is *never* persisted — its
  entire identity is that it doesn't last. Do not make it savable; that
  would erase the reason it exists.
- **Wiggly** — a permanent mark that is nonetheless never fully still: each
  pixel gently boils around its home position at a slow, hand-drawn frame
  rate (~8fps, not smooth 60fps interpolation — the low frame rate *is* the
  point, it should read as "redrawn by hand," not "animated smoothly").
  It sits emotionally between ink's permanence and future's impermanence —
  playful and alive, but not going anywhere.
- **Text** — typed words are rasterised into the *same pixel grid* as the
  brushes rather than kept as live vector text/DOM elements. This is
  deliberate: it keeps everything on the photograph — ink, wiggly marks,
  typed words — speaking the same visual/pixel language, so the archive
  never starts to look like it has "UI" sitting on top of the photograph.
  Placed text stays a movable object (drag to reposition, no handles/boxes)
  even after being pixelated, so it remains editable in position without
  ever looking like a form field.

All four share one restrained colour set (the accent blue, dark grey, white,
and the muted earthy row) and one adjustable pixel size — never smooth,
vector-perfect strokes. The pixel grid is a considered choice (currently 2
world-units per cell), not a technical limitation; "digital but handmade"
is the target texture for every mark in this app.

## 7. The three-tier data model (the most important architectural idea)

Everything the app touches falls into exactly one of three tiers. Confusing
them is the single easiest way to cause real user harm (data loss, orphaned
notes, or accidentally treating irreplaceable work as disposable). Keep them
separate in every future change.

1. **Original photographs — read-only, sacred.** The app only ever reads
   from the folder the user links. It never renames, moves, deletes,
   rewrites, or otherwise touches an original image file, under any
   circumstance, for any feature. This is a hard invariant, not a default.

2. **Local rebuildable cache — disposable, machine-specific.** Thumbnails,
   full-size preview renders (e.g. TIFF previews), the photo index, and the
   dominant-colour cache. This lives in the app's own local `data/` folder,
   keyed by a hash of the linked folder's canonical path. It is entirely
   safe to delete; the app regenerates it from the original photographs.
   Never treat anything in here as a place to store information that
   matters — if the user would be upset to lose it, it does not belong in
   this tier.

3. **Shared user metadata — irreplaceable, travels with the photographs.**
   Titles, notes, dates, ratings, tags, camera/film info, rotation,
   black-and-white state, and every drawing/annotation. This is stored as
   small per-photo JSON sidecar files inside a `cache` folder that lives
   **beside the photographs themselves** (inside the user's linked archive
   folder), not inside the git repository and not inside the app's local
   `data/` folder. This is the one genuinely clever piece of architecture in
   the app and it exists for a specific reason: if the linked folder is
   itself inside iCloud Drive, Dropbox, OneDrive, etc., the sidecar
   metadata travels with it automatically. Two installs of the app (e.g. a
   Windows machine and a Mac) pointed at the same cloud-synced photo folder
   converge on the *same* sidecar files and stay in sync with no server,
   because each photo's id is a stable hash of its path relative to the
   archive root — identical on every machine. Never move this metadata into
   the app repo, never fold it into the local cache tier, and never write
   application logs or local-only state into it.

When you add a new piece of information the user can set (a new field, a
new kind of annotation, a new setting), decide immediately which of these
three tiers it belongs to before writing any code. Almost everything the
user consciously created belongs in tier 3.

## 8. Designed for more than one machine, from day one

The app assumes the user may run it from more than one computer against the
same archive (this is why the macOS build exists as a full sibling, not an
afterthought):

- The linked folder is chosen at runtime via a "folder" button (native OS
  picker where available, paste-a-path fallback otherwise) — never
  hardcoded, never assumed from `--root` defaults baked into source.
- Photo identity is a hash of the relative path, so it is identical across
  machines and across OSes without any coordination.
- The path the user types or pastes is normalised (quotes, `file://` URLs,
  `~`, environment variables, trailing slashes, mixed `/`/`\`, escaped
  spaces) and then resolved to its true canonical form (real case, resolved
  symlinks, no 8.3 short-name artifacts) — so the *same* physical folder
  always produces the same cache and the same metadata folder, no matter how
  a user happens to type or select it.
- The app auto-updates its own code from GitHub via a conservative,
  fast-forward-only git fetch (`update_and_launch.py`), and fails
  silent-safe (just launches the current version) on any ambiguity —
  offline, diverged history, local edits present, git missing, etc. It
  never force-pulls, never discards local changes, never touches the
  photograph archive or its sidecar metadata.
- Both Windows and macOS get first-class, pinnable application icons
  (a Windows shortcut with a matching AppUserModelID and taskbar relaunch
  properties; a real macOS `.app` bundle) — the app should feel like a
  proper native application on each platform, not a script someone runs.

## 9. Hard-won lessons (don't redo work that was already tried and reverted)

- **Wall "inertia"/momentum panning was built, tested, and explicitly
  removed** because it didn't feel right. Don't reintroduce momentum-based
  panning without checking with the user first — it has already been tried.
- **Spring-based node motion (with rebound overshoot) was replaced** with a
  simple eased exponential approach because the bounce read as too playful/
  toy-like for this app's tone. Any future motion work should default to
  smooth deceleration, not springs, unless explicitly asked for.
- **Canvas `ctx.filter` (e.g. for the black-and-white toggle) silently
  no-ops on WKWebView (macOS's native webview) even though feature-detection
  reports it as supported** — this is a real false positive, not a
  hypothetical. The working fix was to always render a pre-desaturated copy
  of the image via an offscreen canvas (luma-based greyscale) rather than
  relying on any CSS/canvas filter property, on every platform. If you touch
  image-filter code, don't reintroduce a `ctx.filter` dependency without
  testing specifically on macOS's native window (not just a browser).
- **The preview/testing harness used during development cannot open a real
  pywebview/WebView2 window and suspends `requestAnimationFrame` when
  hidden.** Both the wall and the detail view expose manual `step()` methods
  for driving a single animation frame under test, specifically because of
  this. Native window behaviour (Windows taskbar icon/relaunch properties,
  in particular) had to be verified via a synthetic dummy window rather than
  the real running app, for the same reason.
- **Clustering only ever goes one folder-level deep on purpose.** A photo in
  a sub-subfolder still belongs to its top-level folder's cluster; deeper
  nesting does not create additional clusters. This keeps the wall from
  fragmenting into an ever-finer grid as an archive's folder structure grows
  more nested over time.

## 10. A short checklist before adding anything new

1. Does this belong on the wall, the inspection table, or one of the quiet
   secondary views — or is it actually asking for a new kind of space? (See
   §3.)
2. Does it touch original photographs in any way? It must not, ever.
3. Which of the three data tiers does any new piece of state belong to —
   rebuildable local cache, or irreplaceable shared metadata? (See §7.) Get
   this right before writing storage code.
4. Does it introduce a bright, saturated, or "UI-blue" colour, a modal
   confirmation dialog, a bouncy/springy animation, or dashboard-style
   chrome? If so, it's probably fighting the app's design language rather
   than extending it.
5. Could this be a single keyboard shortcut and a direct-manipulation
   gesture, instead of a form and a button?
6. Would this still make sense if the user is running the app on a second
   machine sharing the same cloud-synced archive? Multi-instance is the
   normal case here, not an edge case.
7. Read `README.md`'s current feature list before assuming what exists —
   this app has grown a lot of small, considered features (light table,
   gradient shelf, ambient mode, search, multi-tag AND filtering, per-roll
   camera/film with per-photo override, right-drag cluster repositioning)
   and it's easy to accidentally rebuild something that's already there.

---

*This document describes intent and philosophy, and will drift out of sync
with the code over time in its specifics — treat README.md and the source
as authoritative for "what currently exists," and this file as authoritative
for "what kind of app this is trying to be."*
