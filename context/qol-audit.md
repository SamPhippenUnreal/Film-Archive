# Navigation and quality-of-life audit — 20 September 2026

The audit preserves the white-paper presentation, existing contexts, originals,
and restrained motion. It builds on the earlier Project inspection and snapping
changes. Existing unrelated workspace changes were retained.

## Context coverage

| Context | Findings and changes |
| --- | --- |
| Pictures wall | Right-click exposes opening, light-table selection and overview. Right-drag selection has a threshold; pointer cancellation and blur release gestures. Search/filter requests ignore stale results. Hidden filters cannot receive keyboard focus. |
| Photo inspection | Escape and an unmoved primary click on surrounding paper return to the originating context. Dragging still pans; annotation tools still draw on paper. Escape unwinds menus, text entry and palettes first. Pending requests and delayed image loads cannot reopen or overwrite a newer inspection. |
| Light table and gradient | Images accept Enter/Space with visible focus. Back labels identify the originating surface. Escape/blank paper leave one layer; cancelled transitions cannot hide a subsequently reopened view. Gradient requests handle errors and cancellation. |
| Ambient presentation | Failed images are skipped with bounded attempts. Visibility pauses the timer. Modifier keys and focused controls no longer accidentally exit presentation; star controls expose pressed state. |
| About | Pending reveal/close transitions are cancelled on reentry. Return preserves the previous context; leaving Writing waits for its save. |
| Projects index/canvas | Inspection uses all four arrow keys by direction/proximity, preserving the canvas. Clean affects only the selection when present and packs actual bounds with fixed gaps; Messy restores that subset. Snapping uses one stable world-space grid; group moves preserve relative offsets. Fit selection/all (0), select all (Ctrl/Cmd+A), and contextual inspect/clean/import actions reduce navigation overhead. Escape unwinds transient tools and selection before leaving. Selected material can be moved to project trash together. |
| Project previews | Five server-generated sizes replace original-image promotion on the canvas. Visible tiles load small first, then sharpen. Four concurrent fetch/decode slots, near-view prefetch, cancellation, retry backoff and pixel-budget accounting limit work. Offscreen tiles release decoded sources; background tabs stop loading. Dragged images retain their existing resolution. |
| Project preview backend | Source-versioned URLs/cache keys, EXIF orientation, alpha-preserving PNG, atomic writes, two decoder slots and striped locks. Each thumbnail resolves one lightweight file scan without parsing every Writing document or annotation in the project. Full originals remain available in inspection. |
| Writing archive/editor and Project documents | Save snapshots are ordered and revision-aware. A failed save keeps the editor open, with an explicit retry hint and Ctrl/Cmd+S. Picture picker cancellation/reentry is guarded; Place restores editing. Undo preserves picture-group metadata as well as markup. Nested-list pagination uses text ranges and merges split ancestors; composition defers repagination. Long words can wrap. Group controls support right-click and removal. |
| 3D inspection | Late texture/folder responses cannot update a different model or overwrite a newer colour choice. Close ends pointer dragging. F/0 reframe, matching overview shortcuts elsewhere. Escape/back remain the exit controls because canvas dragging orbits the model. |
| Global controls | Shared exit transitions disable hidden controls and restore focus. Context switching waits for Writing saves and guards concurrent switches. The mouse-trail toggle was removed; the existing bounded trail remains active for a mouse, respecting reduced motion and page visibility. |

## Verification

- Full Python unittest suite: 232 tests run successfully, including one skipped
  optional OpenEXR dependency test. After the final preview-resolution optimization, all 39 Project
  HTTP tests passed again, including tier sizing, alpha preservation, source
  version changes and avoiding full-project parsing for thumbnails.
- The final JavaScript run passed all five test files: two unit suites cover
  the Writing model and annotation history, plus the three browser suites below.
- Three isolated headless Edge/Playwright browser suites cover Project
  directional inspection, stale loads, selection Clean, mixed-size gaps,
  zoom-independent snapping, preview request limits, reduced motion; Writing
  image placement/cancellation, group undo, long prose/list pagination,
  serialization and save-failure recovery; and navigation between inspection,
  table, gradient, About and Projects, including keyboard access and rapid reentry.
- Tests use static repository assets, in-memory browser fixtures and temporary
  Python directories. They do not alter a linked user archive.

Run Python with `python -m unittest discover -s tests`. Run JavaScript with
`node --test tests/js/*.test.js` in an environment with Playwright installed;
`PLAYWRIGHT_CHANNEL=msedge` selects an installed Edge browser. No runtime
dependency was added to the application.

## Practical limits

Native WebView/picker interactions and a large real archive were not exercised
in this pass. Model texture changes were reviewed and syntax checked, not
visually tested on a GPU. IME variants and arbitrary pasted documents need
native manual verification; Writing still uses contentEditable. The preview
budget estimates tile pixels, not total browser memory or transient decodes,
and resolution still performs a project file scan per request. Existing disk
preview-cache eviction policy was not redesigned. Audio/video native playback,
PDF export, and filesystem interactions retain their existing design and
backend coverage. These limits should guide the next manual acceptance pass;
automated checks do not establish that every possible document is flawless.
