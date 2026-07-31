/* Folder-backed project walls. Files remain ordinary files in the linked
   folder; this module only renders them and edits the shared project sidecar
   through the project API. */
const Projects = (() => {
  const $ = id => document.getElementById(id);
  const view = $('project-view');
  const index = $('project-index');
  const workspace = $('project-workspace');
  const viewport = $('project-viewport');
  const layer = $('project-layer');
  const canvas = $('project-annotations');
  const ctx = canvas.getContext('2d');
  const folderBtn = $('proj-btn-folder');
  const folderControls = $('proj-folder-controls');
  const folderName = $('proj-folder-name');
  const folderBar = $('proj-folder-bar');
  const folderInput = $('proj-folder-input');
  const folderError = $('proj-folder-error');
  const empty = $('project-empty');
  const emptyTitle = $('proj-empty-title');
  const emptySub = $('proj-empty-sub');
  const statusEl = $('project-status');
  const backBtn = $('proj-back');
  const annoTools = $('project-annotation-tools');
  const createBtn = $('project-create');
  const createName = $('project-create-name');
  const createNameInput = $('project-create-name-input');
  const createNameError = $('project-create-name-error');
  const importMenu = $('project-import-menu');

  let open = false, linked = false, projects = [], current = null;
  let folderAction = null;
  let creatingProject = false;
  let files = [], positions = Object.create(null), maxZ = 0;
  let coverPositions = Object.create(null), coverMaxZ = 0, coverPointer = null;
  let coverMoveFrame = 0;
  // The project context pans and zooms exactly like a project canvas, only with
  // a tighter surround. Covers live in world units inside #project-index-layer.
  let indexLayer = null, indexPan = {x: 0, y: 0}, indexScale = 1, indexPointer = null;
  const INDEX_MIN_SCALE = 0.35, INDEX_MAX_SCALE = 1.5, INDEX_MARGIN = 90;
  let pan = {x: 0, y: 0}, scale = 1, pointer = null, spaceDown = false;
  // The canvas can be zoomed farther out and panned a little past its material;
  // MARGIN is how much empty surround the panning may reveal beyond the content.
  const MIN_SCALE = 0.08, MAX_SCALE = 4, CANVAS_MARGIN = 260;
  // a brief square that previews the brush size while the wheel sizes it,
  // exactly as the photograph and document isolation modes do
  let sizePreviewUntil = 0, lastCanvasMouse = {x: 0, y: 0};
  // Annotation opens on the wiggly brush by default — the quietest, liveliest
  // mark, and the one the archive reaches for first.
  let tool = 'view', brushTool = 'wiggly', brushSize = 4, brushColor = '#1E43FF';
  let ink = new Map(), wig = new Map(), future = new Map();
  let texts = [], nextTextId = 1, textInput = null;
  let positionTimer = null, coverTimer = null, annoTimer = null;
  let drawPending = false, animTimer = null;
  // View-dependent image previews: every image tile shows the light server
  // preview by default; only images the user has zoomed close into (large on
  // screen and near the viewport) are quietly upgraded to their full-resolution
  // original, with a small bounded, least-recently-used cache — the same idea
  // the picture wall uses. Originals are never modified; this only chooses which
  // bytes to display. See §3.3 wall.js and §4 (read-only originals).
  let imageTiles = [], lodTimer = null, lodLoading = 0, lodTick = 0;
  const lodFull = new Map();          // file id -> tick last wanted at full res
  // Images being moved render one level below what their on-screen size would
  // normally choose: while an id is in this set the tile is held on its cached
  // server preview (never upgraded, never decoding a new original), even when
  // zoomed in close. It is emptied once the move — and its settle — has finished.
  const movingLowIds = new Set();
  // thresholds are in *device* pixels, so they hold across display densities;
  // full res only when a tile is shown larger than the server preview can carry
  const LOD_FULL_TRIGGER = 1050, LOD_HYSTERESIS = 0.68;
  const LOD_FULL_CACHE = 16, LOD_FULL_PARALLEL = 3, LOD_NEAR = 400;
  let picking = false, pickIds = [];
  // the project's trash: material taken off the canvas, never off the disk
  let trashOpen = false, trashFiles = [], trashPositions = Object.create(null);
  let trashMaxZ = 0;
  // choosing only begins once "restore" is pressed, so the trash can be looked
  // through without any risk of picking things up by accident
  let trashSelecting = false, trashSelection = new Set();
  let statusTimer = null, writingSelection = new Set();
  let writingReturnProjectId = null, reopenProjectId = null;
  let contextTarget = null, savingCanvas = false;
  // Clean/messy: a non-destructive tidy that clusters material by file type in
  // screen space. The original desktop arrangement is snapshotted and restored
  // exactly on "messy"; the cleaned layout is never persisted to disk.
  let cleanMode = false, cleanSnapshot = null, cleanTimer = null;
  // Marquee selection: a set of selected file ids, and the live drag state. The
  // marquee is drawn in screen space; intersection is tested in world space
  // against each file's stored canvas bounds, so no layout is read per frame.
  let selection = new Set(), marquee = null;
  const SNAP_GRID = 24;                  // the reference cell, at 1× zoom
  const SNAP_MIN = 6, SNAP_MAX = 192;    // finest / coarsest world cells
  // The invisible grid scales with zoom: it stays roughly one constant size on
  // screen (~SNAP_GRID px), so its world-space cell is coarser when zoomed out
  // (bigger jumps) and finer when zoomed in (smaller jumps). Cells step along a
  // power-of-two ladder anchored on SNAP_GRID, so the grids **nest** — anything
  // snapped at a coarser cell is exactly on every finer one, and a layout never
  // drifts when it is re-snapped at a different zoom.
  function gridSize() {
    const ideal = SNAP_GRID / (scale || 1);          // world px for one screen cell
    const step = Math.round(Math.log2(ideal / SNAP_GRID));
    return Math.max(SNAP_MIN, Math.min(SNAP_MAX, SNAP_GRID * Math.pow(2, step)));
  }
  const SNAP_PREF_KEY = 'archive.project.snapping';
  let snapping = false;
  try { snapping = localStorage.getItem(SNAP_PREF_KEY) === 'on'; } catch {}
  const reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  const documentPreviewObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const inner = entry.target.querySelector('.project-document-inner');
      if (inner && entry.contentRect.width)
        inner.style.transform = `scale(${entry.contentRect.width / 816})`;
    }
  });

  const listOf = (value, names) => {
    if (Array.isArray(value)) return value;
    for (const n of names) if (value && Array.isArray(value[n])) return value[n];
    return [];
  };
  const cleanId = v => String(v == null ? '' : v);
  const fileId = f => cleanId(f.id || f.file_id || f.relative_path || f.name);
  // Material goes by its filename, unless it is a photograph that was given a
  // title in the image gallery — then the archive already knows it by that
  // name, and the project should call it the same thing.
  const displayName = f =>
    f.gallery_title || f.name || f.filename || f.relative_path || 'untitled';
  const projectId = p => cleanId(p.id || p.project_id || p.relative_path || p.title);
  const urlFor = (f, preview) => {
    const supplied = preview ? (f.preview_url || f.thumbnail_url) : f.file_url;
    if (supplied) return supplied;
    return preview ? API.projectPreviewUrl(projectId(current), fileId(f))
      : API.projectFileUrl(projectId(current), fileId(f));
  };

  const snapValue = (value, grid = gridSize()) =>
    Math.round((Number(value) || 0) / grid) * grid;
  const snapSizeValue = (value, min, max, grid = gridSize()) => Math.max(
    Math.ceil(min / grid) * grid,
    Math.min(Math.floor(max / grid) * grid, snapValue(value, grid)));
  function fileForId(id) {
    return activeFiles().find(file => fileId(file) === id) || null;
  }
  function mediaAspect(media, p, width, height) {
    const image = media && media.querySelector('img');
    const video = media && media.querySelector('video');
    let ratio = image && image.naturalWidth && image.naturalHeight
      ? image.naturalWidth / image.naturalHeight
      : video && video.videoWidth && video.videoHeight
        ? video.videoWidth / video.videoHeight : width / height;
    const rotation = ((+(p && p.rotation) || 0) % 360 + 360) % 360;
    if (rotation % 180) ratio = 1 / ratio;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : width / height;
  }
  function snappedImageSize(width, height, aspect = width / height,
                            limits = {minW: SNAP_GRID, minH: SNAP_GRID,
                              maxW: Infinity, maxH: Infinity},
                            grid = gridSize()) {
    width = Math.max(1, Number(width) || 1); height = Math.max(1, Number(height) || 1);
    aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : width / height;
    let best = null;
    const consider = (w, h) => {
      if (w < limits.minW || h < limits.minH ||
          w > limits.maxW || h > limits.maxH) return;
      // The visible media box always keeps the real aspect ratio. Only one
      // dimension needs to land exactly on a grid line; forcing both dimensions
      // onto whole cells creates a larger letterboxed rectangle around most
      // photographs and makes that synthetic outline visible during selection.
      const score = Math.abs(w - width) + Math.abs(h - height);
      if (!best || score < best.score) best = {width: w, height: h, score};
    };
    const targetW = Math.max(1, Math.round(width / grid));
    const targetH = Math.max(1, Math.round(height / grid));
    for (let offset = -8; offset <= 8; offset++) {
      const w = (targetW + offset) * grid;
      if (w > 0) consider(w, w / aspect);
      const h = (targetH + offset) * grid;
      if (h > 0) consider(h * aspect, h);
    }
    if (!best) {
      // Extremely wide/tall media may have no nearby grid-line candidate inside
      // the size limits. Project the requested box onto the intrinsic-ratio line
      // and clamp there, rather than falling back to the wrapper's old ratio.
      let h = (width * aspect + height) / (aspect * aspect + 1);
      const minH = Math.max(limits.minH, limits.minW / aspect);
      const maxH = Math.min(limits.maxH, limits.maxW / aspect);
      h = Math.max(minH, Math.min(maxH, h));
      best = {width: h * aspect, height: h};
    }
    return {
      width: Math.round(best.width * 10) / 10,
      height: Math.round(best.height * 10) / 10,
    };
  }
  function conformPositionsToGrid(source = positions, present = true,
                                  animate = false, grid = gridSize()) {
    for (const id in source) {
      const p = source[id], file = fileForId(id);
      if (!p || !file) continue;
      const el = present && [...layer.querySelectorAll('.project-file')]
        .find(node => node.dataset.fileId === id);
      const media = el && el.querySelector('.project-file-media');
      const kind = kindOf(file);
      const resizable = !fixedIconOf(file) &&
        Number.isFinite(p.width) && Number.isFinite(p.height);
      p.x = snapValue(p.x, grid); p.y = snapValue(p.y, grid);
      if (resizable) {
        const limits = resizeLimits(kind);
        const size = (kind === 'image' || kind === 'video')
          ? snappedImageSize(p.width, p.height,
              mediaAspect(media, p, p.width, p.height), limits, grid)
          : {width: snapSizeValue(p.width, limits.minW, limits.maxW, grid),
             height: snapSizeValue(p.height, limits.minH, limits.maxH, grid)};
        p.width = size.width; p.height = size.height;
      }
      if (!el) continue;
      if (animate && !settleReduced()) {
        settleTo(el, {toX: p.x, toY: p.y, media, kind, sizes: resizable,
          toW: p.width, toH: p.height, rotation: p.rotation});
      } else {
        cancelSettle(el);
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
        if (media) applyAssetPresentation(el, media, p, kind);
      }
    }
  }
  function updateSnappingButton() {
    const button = $('proj-btn-snapping');
    if (!button) return;
    button.textContent = snapping ? 'snapping on' : 'snapping off';
    button.setAttribute('aria-pressed', snapping ? 'true' : 'false');
    button.classList.toggle('active', snapping);
  }
  function toggleSnapping() {
    snapping = !snapping;
    try { localStorage.setItem(SNAP_PREF_KEY, snapping ? 'on' : 'off'); } catch {}
    updateSnappingButton();
    if (!snapping || !current || trashOpen) return;
    // Aligning is an explicit action, so it uses the cell for the current zoom.
    const grid = gridSize();
    conformPositionsToGrid(activePositions(), true, true, grid);
    // A tidy keeps its pre-clean arrangement as the destination of "messy".
    // Quantize that snapshot too, otherwise leaving Clean could silently undo
    // the grid the user just enabled.
    if (cleanMode && cleanSnapshot) conformPositionsToGrid(cleanSnapshot, false, false, grid);
    requestDraw(); scheduleImageLOD(); schedulePositions(activePositions());
    say('canvas aligned to the invisible grid');
  }

  /* ——— settle animation ———
     Dragging stays immediate: the tile follows the pointer one-to-one. Only the
     *settle* into a grid cell is eased — a short in/out glide of the element's
     own left/top (and, for a resize, its size) from where the pointer left it to
     the exact snapped coordinate. The snapped coordinate is persisted the moment
     the gesture ends; the glide is purely visual, retargets cleanly the instant
     the pointer picks the tile up again (cancelSettle on a fresh grab), and is
     skipped entirely under reduced motion or while the window is hidden. Left
     and top carry no CSS transition, so this animation and the entrance/tidy
     transforms never fight. World-space coordinates keep it exact under pan and
     zoom. */
  const SETTLE_MS = 190;
  const settleAnims = new Map();      // el -> live glide state
  let settleFrame = 0;
  const easeInOut = t => t <= 0 ? 0 : t >= 1 ? 1
    : (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const settleReduced = () =>
    (reducedMotion && reducedMotion.matches) || document.hidden;
  function applySettleFinal(a) {
    a.el.style.left = a.toX + 'px'; a.el.style.top = a.toY + 'px';
    if (a.sizes) {
      a.tmp.x = a.toX; a.tmp.y = a.toY; a.tmp.width = a.toW; a.tmp.height = a.toH;
      a.tmp.rotation = a.rotation;
      applyAssetPresentation(a.el, a.media, a.tmp, a.kind);
    }
  }
  function settleTick(now) {
    settleFrame = 0;
    for (const [el, a] of settleAnims) {
      if (!el.isConnected) { settleAnims.delete(el); continue; }
      const t = easeInOut((now - a.start) / SETTLE_MS);
      if (t >= 1) { applySettleFinal(a); settleAnims.delete(el); continue; }
      const x = a.fromX + (a.toX - a.fromX) * t;
      const y = a.fromY + (a.toY - a.fromY) * t;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      if (a.sizes) {
        a.tmp.x = x; a.tmp.y = y;
        a.tmp.width = a.fromW + (a.toW - a.fromW) * t;
        a.tmp.height = a.fromH + (a.toH - a.fromH) * t;
        a.tmp.rotation = a.rotation;
        applyAssetPresentation(el, a.media, a.tmp, a.kind);
      }
    }
    if (settleAnims.size) settleFrame = requestAnimationFrame(settleTick);
  }
  function cancelSettle(el) { settleAnims.delete(el); }
  // Ease `el` from its current on-screen box to a snapped target box. Callers
  // have already written the exact snapped coordinates into the position map.
  function settleTo(el, opts) {
    cancelSettle(el);
    const a = {
      el, media: opts.media || null, kind: opts.kind || '', sizes: !!opts.sizes,
      toX: opts.toX, toY: opts.toY, toW: opts.toW, toH: opts.toH,
      rotation: opts.rotation || 0, start: 0, tmp: opts.sizes ? {} : null,
    };
    if (settleReduced()) { applySettleFinal(a); return; }
    a.fromX = parseFloat(el.style.left) || 0;
    a.fromY = parseFloat(el.style.top) || 0;
    if (opts.sizes) {
      a.fromW = parseFloat(el.style.width) ||
        (opts.media ? opts.media.clientWidth : opts.toW);
      a.fromH = opts.media
        ? (parseFloat(opts.media.style.height) || opts.media.clientHeight)
        : opts.toH;
    }
    const still = Math.abs(a.fromX - a.toX) < .5 && Math.abs(a.fromY - a.toY) < .5 &&
      (!opts.sizes || (Math.abs(a.fromW - a.toW) < .5 && Math.abs(a.fromH - a.toH) < .5));
    if (still) { applySettleFinal(a); return; }   // already there: no visible glide
    a.start = performance.now();
    settleAnims.set(el, a);
    if (!settleFrame) settleFrame = requestAnimationFrame(settleTick);
  }

  /* Project-only chrome is assembled here so the workspace keeps one source
     of interaction truth without spreading state through the page shell. */
  function ensureProjectControls() {
    let title = $('project-title-control');
    if (!title) {
      title = document.createElement('div');
      title.id = 'project-title-control';
      title.innerHTML =
        '<button class="quiet" id="project-title-button" aria-label="rename project"></button>' +
        '<input id="project-title-input" class="hidden" type="text" maxlength="120" ' +
        'spellcheck="false" aria-label="project title">';
      title.setAttribute('aria-hidden', 'true');
      view.appendChild(title);
    }
    const toolbar = $('project-toolbar');
    if (!$('project-import')) {
      const sep = document.createElement('span'); sep.className = 'dot-sep'; sep.textContent = '·';
      const button = document.createElement('button');
      button.id = 'project-import'; button.className = 'quiet'; button.textContent = 'import';
      toolbar.append(sep, button);
    }
    if (!$('project-save-canvas')) {
      const sep = document.createElement('span'); sep.className = 'dot-sep'; sep.textContent = '·';
      const save = document.createElement('button');
      save.id = 'project-save-canvas'; save.className = 'quiet project-save-canvas';
      save.textContent = 'capture'; save.setAttribute('aria-label', 'capture the visible project canvas as a JPEG');
      toolbar.append(sep, save);
    }
    // the trash sits at the far right of the bar: everything taken off this
    // canvas is gathered there, still on disk, waiting to be restored
    if (!$('project-trash-btn')) {
      const sep = document.createElement('span'); sep.className = 'dot-sep'; sep.textContent = '·';
      const trash = document.createElement('button');
      trash.id = 'project-trash-btn'; trash.className = 'quiet';
      trash.textContent = 'trash';
      trash.setAttribute('aria-label', 'material removed from this project');
      toolbar.append(sep, trash);
    }
    // Inside the trash the bar carries only these two — restore at the left
    // end, back at the right — and the canvas tools step aside (see CSS).
    if (!$('project-trash-restore')) {
      const restore = document.createElement('button');
      restore.id = 'project-trash-restore'; restore.className = 'quiet trash-only';
      restore.textContent = 'restore';
      const back = document.createElement('button');
      back.id = 'project-trash-back'; back.className = 'quiet trash-only';
      back.textContent = 'back';
      back.setAttribute('aria-label', 'back to the project canvas');
      toolbar.append(restore, back);
    }
    // the confirmation rises above the bar once something has been chosen
    if (!$('project-restore-bar')) {
      const bar = document.createElement('div');
      bar.id = 'project-restore-bar'; bar.className = 'hidden';
      bar.innerHTML = '<button class="quiet" id="project-restore">confirm</button>';
      view.appendChild(bar);
    }
    const menu = $('project-context');
    // A single quiet menu serves project covers and every canvas element.
    view.appendChild(menu);
    const addMenuButton = (id, text) => {
      if ($(id)) return;
      const b = document.createElement('button'); b.id = id; b.className = 'quiet';
      b.textContent = text; menu.appendChild(b);
    };
    addMenuButton('project-rotate-image', 'rotate');
    addMenuButton('project-open-in', 'open in');
    addMenuButton('project-delete-element', 'remove from project');
    addMenuButton('project-delete-project', 'unlink project');
  }
  ensureProjectControls();
  const titleButton = $('project-title-button');
  const titleInput = $('project-title-input');

  // `hold` keeps a standing instruction on screen (choosing what to restore)
  // rather than letting it fade like a passing status line
  function say(text, hold = false) {
    clearTimeout(statusTimer);
    statusEl.textContent = text || '';
    statusEl.classList.toggle('show', !!text);
    if (text && !hold)
      statusTimer = setTimeout(() => statusEl.classList.remove('show'), 2400);
  }

  function closeImportMenu() {
    importMenu.classList.add('hidden');
    $('project-import').classList.remove('active');
  }

  function toggleImportMenu() {
    if (!current || trashOpen) return;
    const opening = importMenu.classList.contains('hidden');
    importMenu.classList.toggle('hidden', !opening);
    $('project-import').classList.toggle('active', opening);
  }

  function showProjectTitle() {
    const title = current && (current.title || current.name) || '';
    titleButton.textContent = title;
    titleButton.title = title ? 'rename project' : '';
    titleInput.value = title;
    const control = $('project-title-control');
    control.classList.toggle('visible', !!current);
    control.setAttribute('aria-hidden', current ? 'false' : 'true');
    titleButton.tabIndex = current ? 0 : -1;
    titleButton.classList.remove('hidden'); titleInput.classList.add('hidden');
  }

  function beginProjectRename() {
    if (!current) return;
    titleInput.value = current.title || current.name || '';
    titleButton.classList.add('hidden'); titleInput.classList.remove('hidden');
    titleInput.focus(); titleInput.select();
  }

  function cancelProjectRename() {
    titleInput.classList.add('hidden'); titleButton.classList.remove('hidden');
    if (current) titleInput.value = current.title || current.name || '';
  }

  async function commitProjectRename() {
    if (!current || titleInput.classList.contains('hidden')) return;
    const value = titleInput.value.trim();
    if (!value || value === (current.title || current.name || '')) {
      cancelProjectRename(); return;
    }
    const id = projectId(current);
    titleInput.disabled = true;
    try {
      clearTimeout(positionTimer); await savePositions();
      const res = await API.renameProject(id, value);
      if (!res || !res.ok) throw new Error((res && res.error) || 'rename failed');
      Object.assign(current, res.project || {title: value, name: value});
      const summary = projects.find(p => projectId(p) === id);
      if (summary) Object.assign(summary, res.project || {title: value, name: value});
      const renamedId = projectId(current);
      if (renamedId !== id && coverPositions[id]) {
        coverPositions[renamedId] = coverPositions[id]; delete coverPositions[id];
      }
      if (res.project && Array.isArray(res.project.files)) {
        files = res.project.files; renderFiles();
      }
      showProjectTitle(); say('project renamed');
    } catch (error) {
      say(error.message && error.message !== 'rename failed'
        ? error.message : 'project could not be renamed');
      cancelProjectRename();
    } finally { titleInput.disabled = false; }
  }

  function enter(animateWall = true) {
    if (open) return;
    open = true;
    document.body.classList.add('hide-wall-chrome');
    if (animateWall) Wall.beginOutro(() => {});
    view.classList.add('veiled', 'arriving');
    view.classList.remove('hidden');
    void view.offsetWidth;
    setTimeout(() => view.classList.remove('veiled'), 20);
    refresh();
  }

  function leave(animateWall = true) {
    if (!open) return;
    if (typeof ModelView !== 'undefined') ModelView.close();
    cancelProjectCreation(true);
    commitProjectTextInput();
    resetCleanState();
    clearCanvasSelection();
    if (current) {
      clearTimeout(positionTimer); savePositions();
      clearTimeout(annoTimer); saveAnnotations();
    } else {
      clearTimeout(coverTimer); saveCoverPositions();
    }
    open = false;
    // always release a cover drag on the way out, so pointer state never leaks
    // across a context change
    if (coverMoveFrame) { cancelAnimationFrame(coverMoveFrame); coverMoveFrame = 0; }
    if (coverPointer && coverPointer.card) coverPointer.card.classList.remove('dragging');
    coverPointer = null;
    closeFolderBar(); closeContext(); closeWritingPicker(); closeImportMenu();
    closeTrash({redraw: false});
    current = null;
    view.classList.remove('workspace-open', 'picking-away');
    if (animateWall) {
      document.body.classList.remove('hide-wall-chrome');
      Wall.beginIntro();
    }
    view.classList.remove('arriving');
    view.classList.add('veiled');
    setTimeout(() => {
      view.classList.add('hidden');
      view.classList.remove('veiled');
    }, 520);
  }

  function leaveForAbout() {
    const covers = [...index.querySelectorAll('.project-cover')];
    index.classList.add('leaving-for-about');
    covers.forEach((cover, i) =>
      cover.style.setProperty('--about-delay', Math.min(i, 10) * 24 + 'ms'));
    // Let the covers lift independently, then cross-fade the paper itself.
    // The wall remains in its away state throughout, so Picture never flashes.
    setTimeout(() => leave(false), 360);
  }

  async function refresh() {
    let s;
    try { s = await API.projectStatus(); }
    catch { showEmpty('projects could not be read', 'the linked folder is still untouched'); return; }
    linked = !!(s && s.linked);
    folderName.textContent = (s && s.root) || '';
    if (!linked) {
      projects = [];
      createBtn.classList.remove('hidden');
      folderControls.classList.add('hidden');
      showEmpty('no projects linked',
        'use the + on the left to choose an existing project folder');
      return;
    }
    try {
      const data = await API.projects();
      projects = listOf(data, ['projects', 'items']);
      const savedLayout = (data && data.layout) || {};
      coverPositions = Object.create(null); coverMaxZ = 0;
      for (const p of Object.values(savedLayout))
        if (p && Number.isFinite(+p.z)) coverMaxZ = Math.max(coverMaxZ, Math.round(+p.z));
      for (const project of projects) {
        const id = projectId(project), p = savedLayout[id];
        if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) {
          coverPositions[id] = {x: +p.x, y: +p.y,
            z: Number.isFinite(+p.z) ? Math.max(0, Math.round(+p.z)) : ++coverMaxZ};
        }
      }
      renderIndex();
      if (reopenProjectId) {
        const wanted = reopenProjectId;
        reopenProjectId = null;
        const project = projects.find(p => projectId(p) === wanted);
        const card = project && [...index.querySelectorAll('.project-cover')]
          .find(el => el.dataset.projectId === wanted);
        if (project && card) setTimeout(() => openProject(project, card), 40);
      }
    } catch {
      showEmpty('projects could not be read', 'the linked folder is still untouched');
    }
  }

  function showEmpty(title, html) {
    emptyTitle.textContent = title;
    emptySub.innerHTML = html;
    empty.classList.remove('hidden');
    index.classList.add('hidden');
    workspace.classList.add('hidden');
  }
  function bindEmptyFolder() {
    const b = $('proj-empty-folder-btn');
    if (b) b.addEventListener('click', chooseFolder);
  }

  function projectCover(p) {
    if (p.cover_url) return p.cover_url;
    const cid = p.cover_file_id || p.cover_id;
    return cid ? API.projectPreviewUrl(projectId(p), cid) : '';
  }

  // The cover thumbnail is a flat server-rendered JPEG, so a picture turned on
  // the canvas would otherwise show upright on its cover. Carry the promoted
  // image's stored rotation onto the cover so the two always agree.
  function coverRotation(p) {
    const cid = p.cover_file_id || p.cover_id;
    if (!cid || !Array.isArray(p.files)) return 0;
    const file = p.files.find(f => cleanId(fileId(f)) === cleanId(cid));
    const rot = file && file.position && +file.position.rotation;
    return Number.isFinite(rot) ? ((Math.round(rot / 90) * 90) % 360 + 360) % 360 : 0;
  }

  function mountProjectCoverGradient(surface, project) {
    // About is a top-level lexical binding, not a property on `window`. Empty
    // covers reuse its exact moving field as the value map for grey dots.
    if (typeof About !== 'undefined' &&
        typeof About.mountProjectDots === 'function')
      About.mountProjectDots(surface, projectId(project));
  }

  function renderIndex() {
    current = null;
    closeImportMenu();
    if (typeof About !== 'undefined' &&
        typeof About.unmountProjectDots === 'function') {
      for (const surface of index.querySelectorAll('.project-cover-noise'))
        About.unmountProjectDots(surface);
    }
    showProjectTitle();
    view.classList.remove('workspace-open');
    workspace.classList.add('hidden');
    backBtn.classList.add('hidden');
    folderControls.classList.add('hidden');
    updateFolderButton();
    $('proj-wordmark-link').classList.remove('hidden');
    createBtn.classList.remove('hidden');
    if (!projects.length) {
      showEmpty('no projects yet',
        'use + to create a project, or place project folders inside the linked folder');
      return;
    }
    empty.classList.add('hidden');
    index.classList.remove('hidden');
    index.classList.remove('leaving-for-about');
    index.innerHTML = '';
    // a fresh transform layer holds the covers; the context recentres on itself
    indexLayer = document.createElement('div');
    indexLayer.id = 'project-index-layer';
    index.appendChild(indexLayer);
    indexPan = {x: 0, y: 0}; indexScale = 1;
    let layoutChanged = false;
    projects.forEach((p, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'project-cover';
      card.dataset.projectId = projectId(p);
      card.style.setProperty('--delay', Math.min(i, 12) * 35 + 'ms');
      // The square thumbnail is its own clipped surface; the title sits below
      // it in normal flow, so it reads as a caption rather than an overlay.
      const thumb = document.createElement('span');
      thumb.className = 'project-cover-thumb';
      const cover = projectCover(p);
      if (cover) {
        const im = document.createElement('img');
        im.alt = '';
        im.src = cover;
        const rot = coverRotation(p);
        im.style.setProperty('--cover-rotation', `${rot}deg`);
        im.addEventListener('error', () => {
          im.remove();
          mountProjectCoverGradient(noise, p);
        }, {once: true});
        thumb.appendChild(im);
      }
      const fallback = document.createElement('span');
      fallback.className = 'project-cover-fallback';
      fallback.setAttribute('aria-hidden', 'true');
      const noise = document.createElement('canvas');
      noise.className = 'project-cover-noise';
      fallback.appendChild(noise);
      if (!cover) mountProjectCoverGradient(noise, p);
      thumb.appendChild(fallback);
      card.appendChild(thumb);
      const name = document.createElement('span');
      name.className = 'project-cover-title';
      name.textContent = p.title || p.name || 'untitled project';
      card.appendChild(name);
      card.addEventListener('pointerdown', e => beginCoverDrag(e, card, projectId(p)));
      card.addEventListener('contextmenu', e => openProjectContext(e, p));
      card.addEventListener('click', e => {
        if (performance.now() < +(card.dataset.suppressClickUntil || 0)) {
          e.preventDefault(); return;
        }
        openProject(p, card);
      });
      indexLayer.appendChild(card);
      let pos = coverPositions[projectId(p)];
      if (!pos) {
        pos = initialCoverPosition(i, card);
        pos.z = ++coverMaxZ; coverPositions[projectId(p)] = pos;
        layoutChanged = true;
      }
      const bounded = boundedCoverPosition(pos.x, pos.y, card);
      if (bounded.x !== pos.x || bounded.y !== pos.y) layoutChanged = true;
      pos.x = bounded.x; pos.y = bounded.y;
      card.style.left = pos.x + 'px'; card.style.top = pos.y + 'px';
      card.style.zIndex = String(pos.z || 0);
    });
    updateIndexTransform();
    if (layoutChanged) scheduleCoverPositions();
    requestAnimationFrame(() => index.classList.add('here'));
  }

  function initialCoverPosition(i, card) {
    const width = (card && card.offsetWidth) || 200;
    // the caption below the thumbnail makes a cover taller than it is wide, so
    // the row stride follows the real card height rather than its width
    const rowStride = (card && card.offsetHeight) || width;
    const gap = Math.max(22, Math.min(54, index.clientWidth * .035));
    const cols = Math.max(1, Math.floor((index.clientWidth + gap) / (width + gap)));
    const used = Math.min(projects.length, cols) * width + (Math.min(projects.length, cols) - 1) * gap;
    const start = Math.max(0, (index.clientWidth - used) / 2);
    return {x: start + (i % cols) * (width + gap),
      y: 22 + Math.floor(i / cols) * (rowStride + gap)};
  }

  // Covers are placed freely on the panning surface; only a small minimum keeps
  // them out of the far negative corner. The pan clamp keeps them reachable.
  function boundedCoverPosition(x, y) {
    const pad = 3;
    return {x: Math.max(pad, x), y: Math.max(pad, y)};
  }

  // World bounding box of the cover cards, using the (uniform) measured card
  // size, so the context pan can be held to a little past the projects.
  function coverBounds() {
    const first = index.querySelector('.project-cover');
    const w = first ? (first.offsetWidth || 200) : 200;
    const h = first ? (first.offsetHeight || w) : w;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const id in coverPositions) {
      const p = coverPositions[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      any = true;
    }
    return any ? {minX, minY, maxX, maxY} : null;
  }

  function updateIndexTransform() {
    if (!indexLayer) return;
    const r = index.getBoundingClientRect();
    const bounded = clampedPan(indexPan.x, indexPan.y, indexScale,
      coverBounds(), INDEX_MARGIN, r.width, r.height);
    indexPan.x = bounded.x; indexPan.y = bounded.y;
    indexLayer.style.transformOrigin = '0 0';
    indexLayer.style.transform =
      `translate(${indexPan.x}px, ${indexPan.y}px) scale(${indexScale})`;
  }

  // zoom the context about a screen point, the same gesture as a project canvas
  function zoomIndexAt(clientX, clientY, factor) {
    const r = index.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    const wx = (sx - indexPan.x) / indexScale, wy = (sy - indexPan.y) / indexScale;
    indexScale = Math.max(INDEX_MIN_SCALE, Math.min(INDEX_MAX_SCALE, indexScale * factor));
    indexPan.x = sx - wx * indexScale;
    indexPan.y = sy - wy * indexScale;
    updateIndexTransform();
  }

  // Panning the context: a drag on empty surface moves the whole board; a drag
  // that begins on a cover is left to the cover itself.
  function beginIndexPan(e) {
    if (current || e.button !== 0) return;
    if (e.target.closest && e.target.closest('.project-cover')) return;
    indexPointer = {pointerId: e.pointerId, sx: e.clientX, sy: e.clientY,
      x: indexPan.x, y: indexPan.y};
    index.classList.add('panning');
    try { index.setPointerCapture(e.pointerId); } catch {}
  }
  function moveIndexPan(e) {
    if (!indexPointer || e.pointerId !== indexPointer.pointerId) return;
    indexPan.x = indexPointer.x + (e.clientX - indexPointer.sx);
    indexPan.y = indexPointer.y + (e.clientY - indexPointer.sy);
    updateIndexTransform();
  }
  function endIndexPan(e) {
    if (!indexPointer || e.pointerId !== indexPointer.pointerId) return;
    indexPointer = null; index.classList.remove('panning');
  }
  index.addEventListener('pointerdown', beginIndexPan);
  index.addEventListener('pointermove', moveIndexPan);
  index.addEventListener('pointerup', endIndexPan);
  index.addEventListener('pointercancel', endIndexPan);
  index.addEventListener('wheel', e => {
    if (current || !indexLayer) return;
    e.preventDefault();
    zoomIndexAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, {passive: false});

  function beginCoverDrag(e, card, id) {
    if (e.button !== 0 || current) return;
    const pos = coverPositions[id];
    if (!pos) return;
    coverPointer = {id, card, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY,
      clientX: e.clientX, clientY: e.clientY, x: pos.x, y: pos.y, moved: false};
    card.setPointerCapture(e.pointerId);
  }

  function moveCover(e) {
    if (!coverPointer || e.pointerId !== coverPointer.pointerId) return;
    e.preventDefault();
    coverPointer.clientX = e.clientX; coverPointer.clientY = e.clientY;
    if (!coverMoveFrame) coverMoveFrame = requestAnimationFrame(applyCoverMove);
  }

  function applyCoverMove() {
    coverMoveFrame = 0;
    if (!coverPointer) return;
    // screen movement maps to world units through the context zoom, so the
    // cover stays exactly under the pointer at any scale
    const dx = (coverPointer.clientX - coverPointer.sx) / indexScale;
    const dy = (coverPointer.clientY - coverPointer.sy) / indexScale;
    if (!coverPointer.moved && Math.hypot(coverPointer.clientX - coverPointer.sx,
      coverPointer.clientY - coverPointer.sy) < 6) return;
    if (!coverPointer.moved) {
      coverPointer.moved = true; coverPointer.card.classList.add('dragging');
      const pos = coverPositions[coverPointer.id];
      pos.z = ++coverMaxZ; coverPointer.card.style.zIndex = String(pos.z);
      if (coverMaxZ > 90000) normalizeCoverStack();
    }
    // Project covers move freely, like assets on a Project Canvas: the dragged
    // cover follows the pointer and no neighbour is displaced. The live bounded
    // position is where it stays.
    const bounded = boundedCoverPosition(
      coverPointer.x + dx, coverPointer.y + dy, coverPointer.card);
    Object.assign(coverPositions[coverPointer.id], bounded);
    coverPointer.card.style.left = bounded.x + 'px';
    coverPointer.card.style.top = bounded.y + 'px';
  }

  function endCoverDrag(e) {
    if (!coverPointer || e.pointerId !== coverPointer.pointerId) return;
    if (coverMoveFrame) {
      cancelAnimationFrame(coverMoveFrame); coverMoveFrame = 0;
      applyCoverMove();
    }
    const {card, moved, id} = coverPointer;
    card.classList.remove('dragging'); coverPointer = null;
    if (moved) {
      const current = coverPositions[id] || {x: 0, y: 0};
      const landing = boundedCoverPosition(current.x, current.y, card);
      Object.assign(coverPositions[id], landing);
      card.style.left = landing.x + 'px'; card.style.top = landing.y + 'px';
      // a drag must never read as a click that opens the project
      card.dataset.suppressClickUntil = String(performance.now() + 400);
      scheduleCoverPositions();
    }
  }

  function normalizeCoverStack() {
    const ordered = projects.map((project, index) => ({id: projectId(project), index}))
      .filter(item => coverPositions[item.id])
      .sort((a, b) => (coverPositions[a.id].z || 0) - (coverPositions[b.id].z || 0) ||
        a.index - b.index);
    ordered.forEach((item, i) => {
      coverPositions[item.id].z = i + 1;
      const card = [...index.querySelectorAll('.project-cover')]
        .find(el => el.dataset.projectId === item.id);
      if (card) card.style.zIndex = String(i + 1);
    });
    coverMaxZ = ordered.length;
  }

  function scheduleCoverPositions() {
    clearTimeout(coverTimer); coverTimer = setTimeout(saveCoverPositions, 260);
  }

  async function saveCoverPositions() {
    if (!open || current || !linked) return;
    try {
      const res = await API.saveProjectLayout(coverPositions);
      if (!res || !res.ok) throw new Error('save failed');
    } catch { say('project covers will save when the folder is available'); }
  }

  async function beginProjectCreation() {
    if (!open || current || creatingProject) return;
    closeContext();
    await chooseProjectFolder('link');
  }

  function finishProjectCreation() {
    creatingProject = false;
    createNameInput.disabled = false;
    createNameInput.value = '';
    createNameError.textContent = '';
    createName.classList.add('hidden');
    createName.classList.remove('needs-name');
    createName.setAttribute('aria-hidden', 'true');
    view.classList.remove('creating-project');
    document.body.classList.remove('project-creating');
  }

  function cancelProjectCreation(force = false) {
    if (!creatingProject || (createNameInput.disabled && !force)) return false;
    finishProjectCreation();
    return true;
  }

  async function commitProjectCreation() {
    if (!creatingProject || createNameInput.disabled) return;
    const name = createNameInput.value.trim();
    if (!name) {
      createNameError.textContent = 'type a project title';
      createName.classList.remove('needs-name');
      void createName.offsetWidth;
      createName.classList.add('needs-name');
      createNameInput.focus();
      return;
    }

    createNameInput.disabled = true;
    createNameError.textContent = 'creating project…';
    try {
      clearTimeout(coverTimer);
      await saveCoverPositions();
      const res = await API.createProject(name);
      if (!res || !res.ok || !res.project)
        throw new Error((res && res.error) || 'project could not be created');
      await refresh();
      const createdId = projectId(res.project);
      const created = projects.find(project => projectId(project) === createdId);
      const card = created && [...index.querySelectorAll('.project-cover')]
        .find(element => element.dataset.projectId === createdId);
      if (!created || !card)
        throw new Error('project was created but could not be opened');
      await openProject(created, card);
      finishProjectCreation();
      say('project created');
    } catch (error) {
      createNameInput.disabled = false;
      createNameError.textContent =
        error.message || 'project could not be created';
      createNameInput.focus();
      createNameInput.select();
    }
  }

  async function openProject(project, card) {
    if (current) return;
    clearTimeout(coverTimer); await saveCoverPositions();
    index.querySelectorAll('.project-cover').forEach(el =>
      el.classList.add(el === card ? 'chosen' : 'leaving'));
    say('opening project…');
    let data;
    try { data = await API.project(projectId(project)); }
    catch { renderIndex(); say('project could not be opened'); return; }
    const detailProject = (data && data.project) || project;
    current = Object.assign({}, project, detailProject);
    showProjectTitle();
    files = listOf(data, ['files', 'items']);
    const saved = (data && (data.positions || (data.metadata && data.metadata.positions))) || {};
    positions = Object.create(null);
    maxZ = 0;
    for (const p of Object.values(saved))
      if (p && Number.isFinite(+p.z)) maxZ = Math.max(maxZ, Math.round(+p.z));
    files.forEach((f, i) => {
      const id = fileId(f), p = saved[id] || f.position;
      if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) {
        positions[id] = {x: +p.x, y: +p.y,
          z: Number.isFinite(+p.z) ? Math.max(0, Math.round(+p.z)) : ++maxZ};
        if (Number.isFinite(+p.width)) positions[id].width = +p.width;
        if (Number.isFinite(+p.height)) positions[id].height = +p.height;
        if (Number.isFinite(+p.rotation))
          positions[id].rotation = ((Math.round(+p.rotation / 90) * 90) % 360 + 360) % 360;
      } else positions[id] = initialPosition(id, i, ++maxZ);
    });
    const annotationData =
      (data && (data.annotations || (data.metadata && data.metadata.annotations))) || {};
    const maps = PixelBrushes.mapsFrom(annotationData);
    ink = maps.ink; wig = maps.wig; future = new Map(); annoHistory.clear();
    texts = Array.isArray(annotationData.texts)
      ? annotationData.texts.filter(t => t && typeof t.str === 'string').map(t => ({
          id: nextTextId++, str: t.str, x: +t.x || 0, y: +t.y || 0,
          size: +t.size || 27, color: t.color || '#3A3A38',
        })) : [];
    pan = {x: 70, y: 95}; scale = 1;
    // a freshly opened project always starts messy (its own saved arrangement)
    cleanMode = false; cleanSnapshot = null; updateCleanButton();
    createBtn.classList.add('hidden');
    backBtn.classList.remove('hidden');
    folderControls.classList.remove('hidden');
    folderName.textContent = current.folder_path || current.rel_path || '';
    updateFolderButton();
    $('proj-wordmark-link').classList.add('hidden');
    index.classList.add('hidden');
    index.classList.remove('here');
    workspace.classList.remove('hidden');
    view.classList.add('workspace-open');
    renderFiles();
    resizeCanvas();
    setTool('view');
    say(files.length ? '' : 'this project is waiting for its first material');
  }

  function initialPosition(id, i, z = i + 1) {
    let h = 2166136261;
    for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const col = i % 4, row = Math.floor(i / 4);
    return {x: 50 + col * 290 + ((h >>> 3) % 34),
            y: 40 + row * 260 + ((h >>> 11) % 28), z};
  }

  const extOf = f =>
    String(f.extension || f.ext || f.name || '').split('.').pop().toLowerCase();

  function kindOf(f) {
    const kind = String(f.kind || f.type || '').toLowerCase();
    const ext = extOf(f);
    if (kind === 'document' && ext === 'txt') return 'text';
    if (kind) return kind;
    if (/^(jpe?g|png|tiff?|psd|gif|bmp|webp|exr)$/.test(ext)) return 'image';
    if (/^(mp3|wav)$/.test(ext)) return 'audio';
    if (/^(mp4|mov)$/.test(ext)) return 'video';
    if (ext === 'txt') return 'text';
    if (/^(pdf|docx)$/.test(ext)) return 'document';
    return 'file';
  }

  // Standardised, fixed-size file glyphs (icons/*.svg), inlined so they draw
  // with their own silhouette — no card, no box behind them — and recolour
  // through `currentColor`. Three families share one presentation:
  //   3D model files, 3D project files, and every other document-like file
  //   (code, .json, .md, config, …) that isn't a picture, a/v, or a
  //   rich-preview document (pdf/docx/txt).
  const MODEL_3D = /^(obj|fbx|stl|glb|gltf|3ds|dae|ply|abc|usd|usda|usdc|usdz)$/;
  const PROJECT_3D = /^(hip|hipnc|hiplc|blend|c4d|max|ma|mb|spp|sbs|sbsar|ztl|lxo|lwo|lws)$/;
  const CREATIVE_PROJECT = /^(psd|ai|indd|idml|indt)$/;
  // rich-preview / strictly-text documents keep their own tile, not the icon
  const DOC_PREVIEW_EXT = /^(pdf|docx|txt)$/;
  function threeDKindOf(f) {
    const ext = extOf(f);
    if (MODEL_3D.test(ext)) return 'model';
    if (PROJECT_3D.test(ext)) return 'project';
    return null;
  }
  // which standardised icon a file should show, or null if it renders its own
  // media (image / audio / video) or a rich document preview (pdf / docx / txt)
  function fixedIconOf(f) {
    if (CREATIVE_PROJECT.test(extOf(f))) return 'creative';
    const t = threeDKindOf(f);
    if (t) return t;
    const kind = kindOf(f);
    if (kind === 'image' || kind === 'audio' || kind === 'video') return null;
    if (DOC_PREVIEW_EXT.test(extOf(f))) return null;
    return 'document';
  }
  // the 3D material the archive can read geometry from — everything else in
  // MODEL_3D keeps the icon and opens in its own application
  const MODEL_PREVIEW = /^(obj|fbx)$/;
  function openModelPreview(file) {
    if (!current || trashOpen || typeof ModelView === 'undefined') return;
    closeContext(); closeImportMenu(); setTool('view');
    const pid = projectId(current), fid = fileId(file);
    // the viewer keeps the ids so it can look for the model's own texture
    // folder, and open the picker on the folder the model sits in
    ModelView.open(displayName(file), API.projectModelUrl(pid, fid), null,
      {projectId: pid, fileId: fid});
  }
  const FIXED_ICONS = {
    model:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">' +
      '<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
      'stroke-linejoin="round">' +
      '<path d="M15 7h22l12 12v38H15z"/><path d="M37 7v12h12"/>' +
      '<path d="m32 26 11 6-11 6-11-6z"/>' +
      '<path d="M21 32v12l11 7 11-7V32M32 38v13"/></g></svg>',
    project:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">' +
      '<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
      'stroke-linejoin="round">' +
      '<path d="M15 7h22l12 12v38H15z"/><path d="M37 7v12h12"/>' +
      '<path d="m25 31 7-4 7 4-7 4zM25 31v8l7 4 7-4v-8M32 35v8"/>' +
      '<path d="m22 42 4-2.3M42 42l-4-2.3M22 42v5l4 2.3M42 42v5l-4 2.3"/></g></svg>',
    document:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" aria-hidden="true">' +
      '<g fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" ' +
      'stroke-linejoin="round">' +
      '<path d="M15 7h22l12 12v38H15z"/><path d="M37 7v12h12"/>' +
      '<path d="M22 30h20M22 36h20M22 42h15M22 48h11"/></g></svg>',
  };
  function appendFixedIcon(media, which) {
    const icon = document.createElement('span');
    icon.className = 'project-file-fixed-icon';
    icon.setAttribute('aria-hidden', 'true');
    if (which === 'creative') {
      const image = document.createElement('img');
      image.src = '/assets/creative-project-file.svg';
      image.alt = '';
      image.addEventListener('error', () => {
        icon.innerHTML = FIXED_ICONS.document;
      }, {once: true});
      icon.appendChild(image);
    } else icon.innerHTML = FIXED_ICONS[which] || FIXED_ICONS.document;
    media.appendChild(icon);
  }

  // The trash is drawn as another project canvas, so both use one renderer:
  // only what a card responds to differs (arranging vs. choosing).
  const activeFiles = () => trashOpen ? trashFiles : files;
  const activePositions = () => trashOpen ? trashPositions : positions;

  // A quiet, centred prompt shown the first time an empty project is opened,
  // inviting the user to bring material in. It hides the moment anything is on
  // the canvas, and is never shown over the trash.
  let canvasEmpty = null;
  function updateCanvasEmpty() {
    if (!canvasEmpty) {
      canvasEmpty = document.createElement('div');
      canvasEmpty.className = 'project-canvas-empty';
      canvasEmpty.textContent =
        'this project is empty — use import to bring in pictures, writing, or files';
      viewport.appendChild(canvasEmpty);
    }
    canvasEmpty.classList.toggle('hidden',
      !current || trashOpen || files.length > 0);
  }

  function renderFiles() {
    documentPreviewObserver.disconnect();
    // the tiles are about to be rebuilt; forget the old resolution registry
    for (const tile of imageTiles) {
      tile.loadToken = (tile.loadToken || 0) + 1;
      if (tile.preloader) { tile.preloader.onload = tile.preloader.onerror = null; tile.preloader.src = ''; }
    }
    imageTiles = []; lodFull.clear(); movingLowIds.clear();
    clearTimeout(lodTimer); lodLoading = 0;
    layer.innerHTML = '';
    // A passive pass on render only tidies stray fractional pixels: it uses the
    // finest cell, which every zoom's grid is a multiple of, so a layout snapped
    // at any zoom is left exactly where it was (never coarsened on reopen).
    if (snapping && !trashOpen)
      conformPositionsToGrid(activePositions(), false, false, SNAP_MIN);
    updateLayerTransform();
    activeFiles().forEach((f, i) => {
      const id = fileId(f), kind = kindOf(f), p = activePositions()[id];
      // 3D models, 3D project files, and other document-like files (code,
      // .json, .md, …) draw as a fixed, upright icon with their own silhouette —
      // never resized, never rotated, never boxed.
      const fixed = fixedIconOf(f);
      const el = document.createElement('article');
      el.className = 'project-file project-file-' + kind +
        (fixed ? ' project-file-fixed project-file-fixed-' + fixed : '');
      el.dataset.fileId = id;
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      el.style.zIndex = String(p.z || 0);
      if (!fixed && Number.isFinite(p.width)) el.style.width = p.width + 'px';
      el.style.setProperty('--delay', Math.min(i, 14) * 45 + 'ms');
      const media = document.createElement('div');
      media.className = 'project-file-media';
      if (!fixed && Number.isFinite(p.height)) media.style.height = p.height + 'px';
      if (fixed) appendFixedIcon(media, fixed);
      else if (kind === 'image') appendImage(media, f);
      else if (kind === 'video') {
        const v = document.createElement('video'); v.controls = true; v.preload = 'metadata';
        v.src = urlFor(f, false); media.appendChild(v);
      } else if (kind === 'audio') {
        appendAudioPlayer(media, f);
      } else if (kind === 'document' &&
                 String(f.extension || f.ext || '').toLowerCase() === '.pdf') {
        appendPdfPreview(media, f);
      } else if ((kind === 'document' || kind === 'text') && f.document) {
        appendDocumentPreview(media, f.document);
      } else if (f.preview_url || f.thumbnail_url) appendImage(media, f);
      else {
        const glyph = document.createElement('span'); glyph.className = 'project-file-glyph';
        glyph.textContent = String(f.extension || f.ext || kind || 'file').replace('.', '').slice(0, 5);
        media.appendChild(glyph);
        if (f.excerpt) {
          const excerpt = document.createElement('span'); excerpt.className = 'project-file-excerpt';
          excerpt.textContent = f.excerpt; media.appendChild(excerpt);
        }
        // files with no visual preview (.hip, .hipnc, …) try their real Windows
        // icon; on success it replaces the letter glyph, otherwise the glyph stays
        if (!trashOpen) appendNativeIcon(media, f, glyph);
      }
      const caption = document.createElement('div'); caption.className = 'project-file-name';
      caption.textContent = displayName(f);
      // fixed icons hold a fixed size, so they carry no resize handle at all.
      if (!fixed) {
        const resize = document.createElement('button');
        resize.type = 'button'; resize.className = 'project-asset-handle project-resize-handle';
        resize.title = 'resize'; resize.setAttribute('aria-label', 'resize ' + caption.textContent);
        resize.addEventListener('pointerdown', e =>
          beginFileResize(e, el, media, id, kind));
        media.appendChild(resize);
      }
      el.append(media, caption);
      // Image presentation needs the real layout dimensions. Applying it while
      // detached can preserve a stale aspect-ratio box after a quarter turn.
      layer.appendChild(el);
      if (!fixed) applyAssetPresentation(el, media, p, kind);
      if (trashOpen) {
        // in the trash a card is chosen, not arranged — and only once
        // "restore" has asked for a choice. A chosen card washes out.
        el.classList.add('trashed');
        el.classList.toggle('chosen', trashSelection.has(id));
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', trashSelection.has(id) ? 'true' : 'false');
        const toggle = () => { if (trashSelecting) toggleTrashSelection(id, el); };
        el.addEventListener('pointerdown', e => {
          if (trashSelecting) {
            e.preventDefault();
            e.stopPropagation();
          } else beginFileDrag(e, el, id);
        });
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        return;
      }
      el.addEventListener('pointerdown', e => beginFileDrag(e, el, id));
      el.addEventListener('dblclick', e => {
        if (isMediaControl(e.target) ||
            performance.now() < +(el.dataset.suppressOpenUntil || 0)) return;
        clearTimeout(el._archiveOpenTimer);
        e.preventDefault(); e.stopPropagation();
        openExternalFile(f, false);
      });
      // A 3D file keeps its icon and its double-click-to-open behaviour; one
      // click looks at it inside the archive instead.
      if (fixed === 'model' && MODEL_PREVIEW.test(extOf(f))) {
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'look at ' + caption.textContent);
        el.addEventListener('click', e => {
          if (performance.now() < +(el.dataset.suppressOpenUntil || 0)) {
            e.preventDefault(); return;
          }
          // the same wait the documents use, so a double-click reaches the
          // file's own application without the viewer flashing up first
          clearTimeout(el._archiveOpenTimer);
          el._archiveOpenTimer = setTimeout(() => {
            if (el.isConnected) openModelPreview(f);
          }, 260);
        });
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); openModelPreview(f);
          }
        });
      }
      if (!fixed && (kind === 'text' || kind === 'document') && f.document) {
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'open ' + caption.textContent);
        el.addEventListener('click', e => {
          if (performance.now() < +(el.dataset.suppressOpenUntil || 0)) {
            e.preventDefault(); return;
          }
          // Wait through the system double-click interval so a double-click
          // launches externally without first opening Archive's editor.
          clearTimeout(el._archiveOpenTimer);
          el._archiveOpenTimer = setTimeout(() => {
            if (el.isConnected) openProjectDocument(f);
          }, 260);
        });
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); openProjectDocument(f);
          }
        });
      }
      el.addEventListener('contextmenu', e => openContext(e, f));
    });
    updateCanvasEmpty();
    // keep the selection consistent with the freshly rendered tiles
    if (!trashOpen) reconcileSelection();
    requestAnimationFrame(() => layer.classList.add('here'));
    if (snapping && !trashOpen) schedulePositions(activePositions());
  }

  function appendDocumentPreview(holder, doc) {
    holder.classList.add('project-document-preview');
    const inner = document.createElement('div');
    inner.className = 'project-document-inner';
    holder.appendChild(inner);
    if (window.WritingPreview && typeof WritingPreview.render === 'function')
      WritingPreview.render(inner, doc);
    else {
      inner.classList.add('project-document-fallback');
      inner.textContent = String(doc.content || '').replace(/<[^>]*>/g, ' ').trim();
    }
    documentPreviewObserver.observe(holder);
  }

  function appendPdfPreview(holder, file) {
    holder.classList.add('project-document-preview');
    const page = document.createElement('img');
    page.className = 'project-pdf-page';
    page.alt = '';
    page.src = urlFor(file, true);
    page.addEventListener('error', () => {
      page.remove();
      holder.classList.add('preview-failed');
    }, {once: true});
    holder.appendChild(page);
  }

  function appendAudioPlayer(holder, file) {
    const fullTitle =
      file.name || file.filename || file.relative_path || 'untitled audio';
    const trackTitle = document.createElement('span');
    trackTitle.className = 'project-audio-title';
    trackTitle.textContent = fullTitle.replace(/\.[^.]+$/, '');
    trackTitle.title = fullTitle;

    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    audio.src = urlFor(file, false);
    audio.setAttribute('aria-label', fullTitle);
    const controls = document.createElement('div');
    controls.className = 'project-audio-controls';
    const play = document.createElement('button');
    play.type = 'button'; play.className = 'project-audio-button';
    play.textContent = '▶'; play.setAttribute('aria-label', 'play ' + fullTitle);
    const progress = document.createElement('input');
    progress.type = 'range'; progress.className = 'project-audio-progress';
    progress.min = '0'; progress.max = '1000'; progress.step = '1';
    progress.value = '0'; progress.setAttribute('aria-label', 'audio position');
    const volume = document.createElement('button');
    volume.type = 'button'; volume.className = 'project-audio-button';
    volume.textContent = '◖'; volume.setAttribute('aria-label', 'mute ' + fullTitle);

    const sync = () => {
      const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
      progress.value = duration
        ? String(Math.round(audio.currentTime / duration * 1000)) : '0';
      play.textContent = audio.paused ? '▶' : 'Ⅱ';
      volume.textContent = audio.muted ? '×' : '◖';
    };
    play.addEventListener('click', () => {
      if (audio.paused) audio.play().catch(() => {});
      else audio.pause();
    });
    volume.addEventListener('click', () => {
      audio.muted = !audio.muted;
      sync();
    });
    progress.addEventListener('input', () => {
      if (Number.isFinite(audio.duration))
        audio.currentTime = +progress.value / 1000 * audio.duration;
    });
    audio.addEventListener('timeupdate', sync);
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    audio.addEventListener('loadedmetadata', sync);
    controls.append(play, progress, volume);
    holder.append(trackTitle, audio, controls);
  }

  function appendImage(holder, f) {
    const im = document.createElement('img'); im.alt = '';
    holder.style.aspectRatio = '4 / 3';
    const previewUrl = urlFor(f, true), fullUrl = urlFor(f, false);
    im.dataset.lod = 'preview';
    im.src = previewUrl;
    // register the tile so the view-dependent optimiser can raise or drop its
    // resolution as the canvas is zoomed and panned
    const tile = {id: fileId(f), img: im, holder, previewUrl, fullUrl,
      loading: false, wanted: false, loadToken: 0, preloader: null,
      previewPixels: 0};
    imageTiles.push(tile);
    im.addEventListener('load', () => {
      const el = holder.closest('.project-file');
      const id = el && el.dataset.fileId;
      const active = activePositions();
      if (el && id && active[id] && im.naturalWidth && im.naturalHeight) {
        const p = active[id];
        const rotation = ((+p.rotation || 0) % 360 + 360) % 360;
        const ratio = im.naturalWidth / im.naturalHeight;
        const visibleRatio = rotation % 180 ? 1 / ratio : ratio;
        let width = Number.isFinite(p.width) ? p.width : (el.clientWidth || 230);
        let height = Math.max(1, width / visibleRatio);
        if (snapping && !trashOpen) {
          // Initial sizing is passive too — align the nearest dimension to the
          // finest cell while preserving the real media aspect. This avoids a
          // visible grid-sized wrapper around images whose ratio cannot occupy
          // whole cells on both axes.
          const exact = snappedImageSize(width, height, visibleRatio,
            resizeLimits('image'), SNAP_MIN);
          width = exact.width; height = exact.height;
        }
        const repaired = !Number.isFinite(p.width) || !Number.isFinite(p.height) ||
          Math.abs(p.width - width) > .5 || Math.abs(p.height - height) > .5;
        p.width = Math.round(width * 10) / 10;
        p.height = Math.round(height * 10) / 10;
        holder.style.aspectRatio = `${visibleRatio}`;
        applyAssetPresentation(el, holder, active[id], 'image');
        updateResizeHandleContrast(holder, im, rotation);
        if (repaired) schedulePositions(active);
      }
      if (im.dataset.lod === 'preview')
        tile.previewPixels = Math.max(im.naturalWidth, im.naturalHeight);
      scheduleImageLOD();
    });
    im.addEventListener('error', () => {
      if (im.dataset.fallback) { im.remove(); holder.classList.add('preview-failed'); return; }
      im.dataset.fallback = '1'; im.dataset.lod = 'full'; im.src = fullUrl;
    });
    holder.appendChild(im);
  }

  /* ——— view-dependent image resolution ———
     Preview by default; full-resolution only where the user has zoomed close.
     A bounded, least-recently-used set keeps memory in hand even across a
     project of hundreds of high-resolution images, and swaps happen through a
     pre-decoded image so the change never flickers or blocks the canvas. */
  function scheduleImageLOD() {
    clearTimeout(lodTimer);
    lodTimer = setTimeout(updateImageLOD, 55);
  }
  function revertTile(tile) {
    lodFull.delete(tile.id);
    tile.wanted = false;
    tile.loadToken++;
    if (tile.preloader) {
      tile.preloader.onload = tile.preloader.onerror = null;
      tile.preloader.src = ''; tile.preloader = null;
      if (tile.loading) lodLoading = Math.max(0, lodLoading - 1);
      tile.loading = false;
    }
    if (tile.img.dataset.lod === 'full' && !tile.img.dataset.fallback) {
      tile.img.dataset.lod = 'preview';
      if (tile.img.src !== tile.previewUrl) tile.img.src = tile.previewUrl;
    }
  }
  function loadFullTile(tile) {
    const token = ++tile.loadToken;
    tile.loading = true; lodLoading++;
    const pre = new Image();
    tile.preloader = pre;
    pre.onload = async () => {
      try { if (pre.decode) await pre.decode(); } catch {}
      if (token !== tile.loadToken) return;
      lodLoading = Math.max(0, lodLoading - 1); tile.loading = false;
      tile.preloader = null;
      if (tile.wanted && tile.img.isConnected && !tile.img.dataset.fallback) {
        tile.img.dataset.lod = 'full';
        if (tile.img.src !== tile.fullUrl) tile.img.src = tile.fullUrl;
      }
      scheduleImageLOD();
    };
    pre.onerror = () => {
      if (token !== tile.loadToken) return;
      lodLoading = Math.max(0, lodLoading - 1); tile.loading = false;
      tile.preloader = null; lodFull.delete(tile.id);
    };
    pre.src = tile.fullUrl;
  }
  function updateImageLOD() {
    if (!current || !imageTiles.length) return;
    const r = viewport.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const active = activePositions();
    lodTick++;
    const wantFull = [];
    for (const tile of imageTiles) {
      if (!tile.img.isConnected) { lodFull.delete(tile.id); continue; }
      const p = active[tile.id];
      if (!p) continue;
      const w = Number.isFinite(p.width) ? p.width : 230;
      const h = Number.isFinite(p.height) ? p.height : 160;
      const sx = pan.x + p.x * scale, sy = pan.y + p.y * scale;
      const sw = w * scale, sh = h * scale;
      const near = sx < r.width + LOD_NEAR && sx + sw > -LOD_NEAR &&
                   sy < r.height + LOD_NEAR && sy + sh > -LOD_NEAR;
      const deviceWidth = Math.max(sw, sh) * dpr;
      const isFull = tile.img.dataset.lod === 'full';
      // hysteresis: a tile already at full res is only dropped once it becomes
      // clearly small, so nudging the zoom never thrashes the resolution
      const previewLimit = tile.previewPixels ? tile.previewPixels * .88 : LOD_FULL_TRIGGER;
      const baseTrigger = Math.max(760, Math.min(LOD_FULL_TRIGGER, previewLimit));
      const trigger = isFull ? baseTrigger * LOD_HYSTERESIS : baseTrigger;
      // A moving image is forced one level down: it is dropped to (and held on)
      // its preview regardless of how close the zoom is, and never queued for a
      // full-resolution load until the move settles.
      if (!movingLowIds.has(tile.id) && near && deviceWidth >= trigger) {
        tile.wanted = true;
        wantFull.push({tile, size: deviceWidth});
        lodFull.set(tile.id, lodTick);
      } else if (isFull || tile.loading) {
        revertTile(tile);
      } else tile.wanted = false;
    }
    // raise the largest (closest) tiles first, within the parallel budget
    wantFull.sort((a, b) => b.size - a.size);
    for (const {tile} of wantFull) {
      if (lodLoading >= LOD_FULL_PARALLEL) break;
      if (tile.img.dataset.lod !== 'full' && !tile.loading && !tile.img.dataset.fallback)
        loadFullTile(tile);
    }
    // hold the cache to a bounded size, dropping the least-recently-wanted
    if (lodFull.size > LOD_FULL_CACHE) {
      const wanted = new Set(wantFull.map(x => x.tile.id));
      const ordered = [...lodFull.entries()].sort((a, b) => a[1] - b[1]);
      for (const [fid] of ordered) {
        if (lodFull.size <= LOD_FULL_CACHE) break;
        if (wanted.has(fid)) continue;
        const t = imageTiles.find(x => x.id === fid);
        if (t) revertTile(t); else lodFull.delete(fid);
      }
    }
  }

  // Load the file's native OS icon over its generic tile. The extraction and
  // caching happen server-side (off the UI thread); this only swaps in the
  // finished PNG when it arrives, and quietly keeps the glyph if none exists
  // (a plain browser, an unassociated type, or a missing file all 404 here).
  function appendNativeIcon(media, file, glyph) {
    if (!current) return;
    const icon = document.createElement('img');
    icon.className = 'project-file-icon';
    icon.alt = ''; icon.draggable = false;
    icon.addEventListener('load', () => {
      if (!icon.isConnected || !icon.naturalWidth) { icon.remove(); return; }
      media.classList.add('has-native-icon');
      if (glyph && glyph.isConnected) glyph.remove();
    }, {once: true});
    icon.addEventListener('error', () => icon.remove(), {once: true});
    icon.src = API.projectIconUrl(projectId(current), fileId(file));
    media.appendChild(icon);
  }

  function updateResizeHandleContrast(media, image, rotation) {
    const handle = media.querySelector('.project-resize-handle');
    if (!handle || !image.complete || !image.naturalWidth) return;
    try {
      const sample = document.createElement('canvas');
      sample.width = sample.height = 8;
      const g = sample.getContext('2d', {willReadFrequently: true});
      g.fillStyle = '#f4f4ef'; g.fillRect(0, 0, 8, 8);
      g.save(); g.translate(4, 4); g.rotate(rotation * Math.PI / 180);
      g.drawImage(image, -4, -4, 8, 8); g.restore();
      const pixels = g.getImageData(6, 6, 2, 2).data;
      let luma = 0;
      for (let i = 0; i < pixels.length; i += 4)
        luma += .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
      luma /= 4;
      const gray = Math.round(luma < 128 ? Math.min(224, luma + 64)
                                         : Math.max(32, luma - 64));
      handle.style.setProperty('--resize-handle-color',
        `rgba(${gray},${gray},${gray},.82)`);
    } catch {
      handle.style.removeProperty('--resize-handle-color');
    }
  }

  function positionImageResizeHandle(media, image, rotation, widthHint, heightHint) {
    const handle = media.querySelector('.project-resize-handle');
    if (!handle) return;
    const boxWidth = Number.isFinite(widthHint) ? widthHint : media.clientWidth;
    const boxHeight = Number.isFinite(heightHint) ? heightHint : media.clientHeight;
    if (!(boxWidth > 0 && boxHeight > 0 && image.naturalWidth && image.naturalHeight)) {
      handle.style.right = '0px'; handle.style.bottom = '0px'; return;
    }

    // The <img> uses object-fit: contain. Work out the rectangle occupied by
    // its painted pixels before rotation, then turn that rectangle with the
    // image. The resize marker can therefore sit on the raster corner even
    // when the surrounding layout box contains letterboxing.
    const quarterTurn = rotation % 180 !== 0;
    const imageBoxWidth = quarterTurn ? boxHeight : boxWidth;
    const imageBoxHeight = quarterTurn ? boxWidth : boxHeight;
    const intrinsicRatio = image.naturalWidth / image.naturalHeight;
    let paintedWidth = imageBoxWidth;
    let paintedHeight = paintedWidth / intrinsicRatio;
    if (paintedHeight > imageBoxHeight) {
      paintedHeight = imageBoxHeight;
      paintedWidth = paintedHeight * intrinsicRatio;
    }
    const visibleWidth = quarterTurn ? paintedHeight : paintedWidth;
    const visibleHeight = quarterTurn ? paintedWidth : paintedHeight;
    handle.style.right = Math.max(0, (boxWidth - visibleWidth) / 2) + 'px';
    handle.style.bottom = Math.max(0, (boxHeight - visibleHeight) / 2) + 'px';
  }

  function applyAssetPresentation(el, media, p, kind, visualRotation = null) {
    if (Number.isFinite(p.width)) el.style.width = p.width + 'px';
    if (Number.isFinite(p.height)) media.style.height = p.height + 'px';
    if (kind !== 'image') return;
    const rotation = ((+p.rotation || 0) % 360 + 360) % 360;
    const priorVisual = Number.parseFloat(el.dataset.visualRotation);
    const priorMatches = Number.isFinite(priorVisual) &&
      ((priorVisual - rotation) % 360 + 360) % 360 < .001;
    const renderedRotation = Number.isFinite(visualRotation)
      ? visualRotation : (priorMatches ? priorVisual : rotation);
    el.dataset.rotation = String(rotation);
    el.dataset.visualRotation = String(renderedRotation);
    const image = media.querySelector('img');
    if (!image) return;
    const boxWidth = Number.isFinite(p.width) ? p.width : media.clientWidth;
    const boxHeight = Number.isFinite(p.height) ? p.height : media.clientHeight;
    const quarterTurn = rotation % 180 !== 0;
    const imageWidth = Math.max(1, quarterTurn ? boxHeight : boxWidth);
    const imageHeight = Math.max(1, quarterTurn ? boxWidth : boxHeight);
    // Centre the unrotated raster using explicit pixel coordinates. Percentage
    // translation inside a rotation changes axes and was displacing both the
    // visible image and its resize corner after a 90-degree turn.
    image.style.left = (boxWidth - imageWidth) / 2 + 'px';
    image.style.top = (boxHeight - imageHeight) / 2 + 'px';
    image.style.width = imageWidth + 'px';
    image.style.height = imageHeight + 'px';
    image.style.transform = `rotate(${renderedRotation}deg)`;
    positionImageResizeHandle(media, image, rotation, boxWidth, boxHeight);
  }

  function rotateImage(id, el, media) {
    if (tool !== 'view' || !positions[id] || el.classList.contains('rotating')) return;
    // rotating a file on a tidied canvas also settles the tidy into a new messy
    if (cleanMode) convertCleanToMessy();
    closeContext(); bringToFront(id, el);
    const p = positions[id];
    const oldWidth = Number.isFinite(p.width) ? p.width : el.getBoundingClientRect().width;
    const oldHeight = Number.isFinite(p.height) ? p.height : media.getBoundingClientRect().height;
    const centreX = p.x + oldWidth / 2;
    const centreY = p.y + oldHeight / 2;
    const newWidth = oldHeight;
    const newHeight = oldWidth;
    const storedRotation = ((+p.rotation || 0) % 360 + 360) % 360;
    const priorVisual = Number.parseFloat(el.dataset.visualRotation);
    const nextVisual = (Number.isFinite(priorVisual) ? priorVisual : storedRotation) + 90;

    // Let the resize marker disappear at the old corner before swapping the
    // footprint. It returns only after the clockwise image turn has settled,
    // at which point right/bottom refer to the new visible bounds.
    el.classList.add('rotating');
    setTimeout(() => {
      if (!el.isConnected || positions[id] !== p) {
        el.classList.remove('rotating'); return;
      }
      p.rotation = (storedRotation + 90) % 360;
      // Width and height always describe the visible, rotated footprint. Keep
      // its centre fixed so subsequent resizing uses the new geometry.
      p.width = Math.round(newWidth * 10) / 10;
      p.height = Math.round(newHeight * 10) / 10;
      p.x = Math.round((centreX - newWidth / 2) * 10) / 10;
      p.y = Math.round((centreY - newHeight / 2) * 10) / 10;
      el.style.left = p.x + 'px';
      el.style.top = p.y + 'px';
      applyAssetPresentation(el, media, p, 'image', nextVisual);
      const image = media.querySelector('img');
      if (image) updateResizeHandleContrast(media, image, p.rotation);
      const liveFile = files.find(file => fileId(file) === id);
      if (liveFile) liveFile.position = {...p};
      if ((current.cover_file_id || current.cover_id) === id) {
        const summary = projects.find(project => projectId(project) === projectId(current));
        const summaryFile = summary && Array.isArray(summary.files) &&
          summary.files.find(file => fileId(file) === id);
        if (summaryFile) summaryFile.position = {...p};
      }
      schedulePositions();
      setTimeout(() => el.classList.remove('rotating'), 380);
    }, 120);
  }

  // A video is dragged like any other element, so it is deliberately absent
  // here; beginFileDrag leaves its own controls clickable instead.
  function isMediaControl(target) {
    return !!(target && target.closest &&
      target.closest('audio, button, input, select, textarea, a'));
  }

  function bringToFront(id, el) {
    const active = activePositions();
    const p = active[id];
    if (!p) return;
    if (trashOpen) p.z = ++trashMaxZ;
    else p.z = ++maxZ;
    el.style.zIndex = String(p.z);
    if ((trashOpen ? trashMaxZ : maxZ) > 90000) normalizeStack();
  }

  function bringGroupToFront(items) {
    const active = activePositions();
    const ordered = [...items].sort((a, b) =>
      (active[a.id].z || 0) - (active[b.id].z || 0));
    for (const item of ordered) {
      const p = active[item.id];
      p.z = trashOpen ? ++trashMaxZ : ++maxZ;
      item.el.style.zIndex = String(p.z);
    }
    if ((trashOpen ? trashMaxZ : maxZ) > 90000) normalizeStack();
  }

  function normalizeStack() {
    const active = activePositions();
    const ordered = activeFiles().map((f, index) => ({id: fileId(f), index}))
      .filter(item => active[item.id])
      .sort((a, b) => (active[a.id].z || 0) - (active[b.id].z || 0) ||
        a.index - b.index);
    ordered.forEach((item, index) => {
      active[item.id].z = index + 1;
      const el = [...layer.querySelectorAll('.project-file')]
        .find(node => node.dataset.fileId === item.id);
      if (el) el.style.zIndex = String(index + 1);
    });
    if (trashOpen) trashMaxZ = ordered.length;
    else maxZ = ordered.length;
  }

  function beginFileDrag(e, el, id) {
    if (tool !== 'view' || e.button !== 0 || trashSelecting ||
        isMediaControl(e.target) ||
        e.target.closest('.project-resize-handle')) return;
    // A video moves like everything else, but suppressing the default here
    // would also swallow the click its own controls need — so let that one
    // through. The drag still only takes effect once the pointer actually
    // travels, so pressing play never nudges the footage.
    if (!e.target.closest('video')) e.preventDefault();
    e.stopPropagation(); closeContext();
    const positionMap = activePositions();
    // One cell for the whole gesture, chosen from the current zoom.
    const grid = gridSize();
    const p = positionMap[id];
    if (!p) return;
    const groupIds = !trashOpen && selection.has(id) && selection.size > 1
      ? [...selection] : [id];
    const items = groupIds.map(itemId => {
      const position = positionMap[itemId];
      const itemEl = [...layer.querySelectorAll('.project-file')]
        .find(node => node.dataset.fileId === itemId);
      return position && itemEl
        ? {id: itemId, el: itemEl, x: position.x, y: position.y} : null;
    }).filter(Boolean);
    if (!items.length) return;
    // Snap only the tiles about to move onto this cell (position only), so the
    // group stays grid-aligned through a shared delta without disturbing — or
    // mass-shifting — anything the pointer isn't touching.
    if (snapping && !trashOpen) {
      for (const item of items) {
        const q = positionMap[item.id];
        q.x = snapValue(q.x, grid); q.y = snapValue(q.y, grid);
        item.el.style.left = q.x + 'px'; item.el.style.top = q.y + 'px';
        item.x = q.x; item.y = q.y;
      }
    }
    items.length > 1 ? bringGroupToFront(items) : bringToFront(id, el);
    pointer = {type: 'file', id, el, items, pointerId: e.pointerId, grid,
               sx: e.clientX, sy: e.clientY,
               cx: e.clientX, cy: e.clientY, frame: 0,
               lastCx: e.clientX, lastCy: e.clientY,
               lastTime: performance.now(), speed: 0, snapEngaged: false,
               moved: false, positionMap,
               selShift: e.shiftKey, selToggle: e.ctrlKey || e.metaKey};
    try { el.setPointerCapture(e.pointerId); } catch {}
    // Every tile in this move — the whole group — drops one detail level while
    // it travels. Only image tiles carry a level, so other kinds are ignored.
    for (const item of items) { item.el.classList.add('dragging'); movingLowIds.add(item.id); }
    scheduleImageLOD();
  }

  function applyFileDrag() {
    if (!pointer || pointer.type !== 'file') return;
    pointer.frame = 0;
    const sdx = pointer.cx - pointer.sx, sdy = pointer.cy - pointer.sy;
    if (!pointer.moved && Math.abs(sdx) + Math.abs(sdy) > 3) {
      pointer.moved = true;
      if (cleanMode) convertCleanToMessy();
    }
    let dx = sdx / scale, dy = sdy / scale;
    if (snapping && pointer.moved) {
      if (pointer.forceSnap || pointer.speed < .32) pointer.snapEngaged = true;
      else if (pointer.speed > .78) pointer.snapEngaged = false;
      if (pointer.snapEngaged) {
        const primary = pointer.items.find(item => item.id === pointer.id) || pointer.items[0];
        dx = snapValue(primary.x + dx, pointer.grid) - primary.x;
        dy = snapValue(primary.y + dy, pointer.grid) - primary.y;
      }
    }
    for (const item of pointer.items) {
      const position = pointer.positionMap[item.id];
      if (!position) continue;
      position.x = item.x + dx;
      position.y = item.y + dy;
      item.el.style.left = position.x + 'px';
      item.el.style.top = position.y + 'px';
    }
    scheduleImageLOD();
  }

  function finishFileDrag(cancelled = false) {
    if (!pointer || pointer.type !== 'file') return;
    if (pointer.frame) cancelAnimationFrame(pointer.frame);
    if (!cancelled) {
      // Apply the final pointer position unsnapped, then ease each tile into its
      // exact grid cell. The snapped coordinates are written to the position map
      // now (that is what persists); only the on-screen box glides.
      pointer.forceSnap = false;
      applyFileDrag();
      if (snapping && !trashOpen && pointer.moved) {
        const primary = pointer.items.find(it => it.id === pointer.id) ||
          pointer.items[0];
        const pp = pointer.positionMap[primary.id];
        const tdx = snapValue(pp.x, pointer.grid) - pp.x;
        const tdy = snapValue(pp.y, pointer.grid) - pp.y;
        for (const item of pointer.items) {
          const p = pointer.positionMap[item.id];
          if (!p) continue;
          p.x = snapValue(p.x + tdx, pointer.grid);
          p.y = snapValue(p.y + tdy, pointer.grid);
          settleTo(item.el, {toX: p.x, toY: p.y});
        }
      }
    }
    if (pointer.el.hasPointerCapture &&
        pointer.el.hasPointerCapture(pointer.pointerId)) {
      try { pointer.el.releasePointerCapture(pointer.pointerId); } catch {}
    }
    for (const item of pointer.items) {
      if (cancelled) {
        cancelSettle(item.el);
        const position = pointer.positionMap[item.id];
        if (position) {
          position.x = item.x; position.y = item.y;
          item.el.style.left = item.x + 'px'; item.el.style.top = item.y + 'px';
        }
      }
      item.el.classList.remove('dragging');
      if (pointer.moved)
        item.el.dataset.suppressOpenUntil = String(performance.now() + 400);
    }
    // Restore full detail once the move — and any settle glide — has finished, so
    // the resolution never changes mid-glide. A cancelled or unsettled drop
    // restores at once.
    const movedIds = pointer.items.map(it => it.id);
    const gliding = !cancelled && snapping && !trashOpen && pointer.moved &&
      !settleReduced();
    const restoreDetail = () => {
      for (const id of movedIds) movingLowIds.delete(id);
      scheduleImageLOD();
    };
    if (gliding) setTimeout(restoreDetail, SETTLE_MS + 30);
    else restoreDetail();
  }

  // A plain click on a file (no drag) selects it; modifiers add or toggle. This
  // sits alongside — never replaces — the existing open/drag behaviour.
  function selectFileFromClick(id, {shift, toggle}) {
    if (trashOpen) return;
    if (toggle) {
      const next = new Set(selection);
      next.has(id) ? next.delete(id) : next.add(id);
      applySelection(next);
    } else if (shift) {
      applySelection(new Set([...selection, id]));
    } else applySelection(new Set([id]));
  }

  function beginFileResize(e, el, media, id, kind) {
    if (tool !== 'view' || e.button !== 0 || trashSelecting) return;
    e.preventDefault(); e.stopPropagation(); closeContext();
    const positionMap = activePositions();
    const grid = gridSize();          // one cell for the whole gesture
    const p = positionMap[id];
    if (!p) return;
    const selectedImages = !trashOpen && kind === 'image' && selection.has(id)
      ? [...selection].map(itemId => {
          const file = fileForId(itemId), position = positionMap[itemId];
          const itemEl = [...layer.querySelectorAll('.project-file')]
            .find(node => node.dataset.fileId === itemId);
          const itemMedia = itemEl && itemEl.querySelector('.project-file-media');
          if (!file || kindOf(file) !== 'image' || !position || !itemEl || !itemMedia)
            return null;
          return {id: itemId, el: itemEl, media: itemMedia, kind: 'image',
            x: position.x, y: position.y,
            width: Number.isFinite(position.width) ? position.width : itemEl.clientWidth,
            height: Number.isFinite(position.height) ? position.height : itemMedia.clientHeight,
            aspect: mediaAspect(itemMedia, position,
              Number.isFinite(position.width) ? position.width : itemEl.clientWidth,
              Number.isFinite(position.height) ? position.height : itemMedia.clientHeight)};
        }).filter(Boolean) : [];
    const width = Number.isFinite(p.width) ? p.width : media.clientWidth;
    const height = Number.isFinite(p.height) ? p.height : media.clientHeight;
    const items = selectedImages.length > 1 ? selectedImages
      : [{id, el, media, kind, x: p.x, y: p.y, width, height,
          aspect: mediaAspect(media, p, width, height)}];
    items.length > 1 ? bringGroupToFront(items) : bringToFront(id, el);
    // Snap only the tiles being resized onto this gesture's cell, then take the
    // bounds from those grid-aligned baselines — untouched tiles never move.
    if (snapping && !trashOpen) {
      const sub = {};
      for (const item of items) if (positionMap[item.id]) sub[item.id] = positionMap[item.id];
      conformPositionsToGrid(sub, true, false, grid);
      for (const item of items) {
        const q = positionMap[item.id];
        if (!q) continue;
        item.x = q.x; item.y = q.y;
        if (Number.isFinite(q.width)) item.width = q.width;
        if (Number.isFinite(q.height)) item.height = q.height;
      }
    }
    const left = Math.min(...items.map(item => item.x));
    const top = Math.min(...items.map(item => item.y));
    const right = Math.max(...items.map(item => item.x + item.width));
    const bottom = Math.max(...items.map(item => item.y + item.height));
    // scaling is not opening: a click/drag on the resize handle must never be
    // treated as a click-to-open on the document tile beneath it
    el.dataset.suppressOpenUntil = String(performance.now() + 600);
    pointer = {type: 'resize', id, el, media, kind, items, grid,
      bounds: {left, top, width: right - left, height: bottom - top},
      sx: e.clientX, sy: e.clientY, cx: e.clientX, cy: e.clientY,
      lastCx: e.clientX, lastCy: e.clientY, lastTime: performance.now(),
      speed: 0, snapEngaged: false, frame: 0,
      pointerId: e.pointerId, captureEl: e.currentTarget,
      width, height, positionMap};
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    for (const item of items) item.el.classList.add('resizing');
  }

  function resizeLimits(kind) {
    return kind === 'audio'
      ? {minW: 170, minH: 40, maxW: 560, maxH: 180}
      : {minW: 120, minH: 80, maxW: 1400, maxH: 1100};
  }

  function applyFileResize() {
    if (!pointer || pointer.type !== 'resize') return;
    pointer.frame = 0;
    const dx = (pointer.cx - pointer.sx) / scale;
    const dy = (pointer.cy - pointer.sy) / scale;
    if (cleanMode && (Math.abs(dx) + Math.abs(dy)) * scale > 3) convertCleanToMessy();
    const group = pointer.items.length > 1;
    if (group) {
      const b = pointer.bounds;
      const denominator = b.width * b.width + b.height * b.height;
      let factor = 1 + (dx * b.width + dy * b.height) / Math.max(1, denominator);
      let minFactor = 0, maxFactor = Infinity;
      for (const item of pointer.items) {
        const limits = resizeLimits(item.kind);
        minFactor = Math.max(minFactor, limits.minW / item.width,
          limits.minH / item.height);
        maxFactor = Math.min(maxFactor, limits.maxW / item.width,
          limits.maxH / item.height);
      }
      factor = Math.max(minFactor, Math.min(maxFactor, factor));
      if (snapping) {
        if (pointer.forceSnap || pointer.speed < .30) pointer.snapEngaged = true;
        else if (pointer.speed > .72) pointer.snapEngaged = false;
        if (pointer.snapEngaged)
          factor = Math.max(minFactor, Math.min(maxFactor,
            Math.max(pointer.grid, snapValue(b.width * factor, pointer.grid)) / b.width));
      }
      for (const item of pointer.items) {
        const p = pointer.positionMap[item.id];
        p.x = Math.round((b.left + (item.x - b.left) * factor) * 10) / 10;
        p.y = Math.round((b.top + (item.y - b.top) * factor) * 10) / 10;
        p.width = Math.round(item.width * factor * 10) / 10;
        p.height = Math.round(item.height * factor * 10) / 10;
        item.el.style.left = p.x + 'px'; item.el.style.top = p.y + 'px';
        applyAssetPresentation(item.el, item.media, p, item.kind);
      }
    } else {
      const item = pointer.items[0], limits = resizeLimits(item.kind);
      let width = Math.max(limits.minW, Math.min(limits.maxW, item.width + dx));
      let height = Math.max(limits.minH, Math.min(limits.maxH, item.height + dy));
      if (item.kind === 'image' || item.kind === 'video') {
        const denominator = item.width * item.width + item.height * item.height;
        let factor = 1 + (dx * item.width + dy * item.height) / Math.max(1, denominator);
        factor = Math.max(Math.max(limits.minW / item.width, limits.minH / item.height),
          Math.min(Math.min(limits.maxW / item.width, limits.maxH / item.height), factor));
        width = item.width * factor; height = item.height * factor;
      }
      if (snapping && (pointer.forceSnap || pointer.speed < .30)) {
        const size = item.kind === 'image' || item.kind === 'video'
          ? snappedImageSize(width, height, item.aspect, limits, pointer.grid)
          : {width: snapSizeValue(width, limits.minW, limits.maxW, pointer.grid),
             height: snapSizeValue(height, limits.minH, limits.maxH, pointer.grid)};
        width = size.width; height = size.height;
      }
      const p = pointer.positionMap[item.id];
      p.width = Math.round(width * 10) / 10;
      p.height = Math.round(height * 10) / 10;
      applyAssetPresentation(item.el, item.media, p, item.kind);
    }
    scheduleImageLOD();
  }

  // Ease resized items into their snapped boxes, persisting the snapped
  // geometry immediately while the on-screen box glides (position and size).
  // Images/videos keep their intrinsic ratio and may approximate one grid axis;
  // this is preferable to exposing an artificial grid-sized bounding rectangle.
  function settleResizedItems(items, positionMap, grid = gridSize()) {
    for (const item of items) {
      const p = positionMap[item.id], limits = resizeLimits(item.kind);
      if (!p) continue;
      const toX = snapValue(p.x, grid), toY = snapValue(p.y, grid);
      let toW, toH;
      if (item.kind === 'image' || item.kind === 'video') {
        const size = snappedImageSize(p.width, p.height, item.aspect, limits, grid);
        toW = size.width; toH = size.height;
      } else {
        toW = snapSizeValue(p.width, limits.minW, limits.maxW, grid);
        toH = snapSizeValue(p.height, limits.minH, limits.maxH, grid);
      }
      p.x = toX; p.y = toY; p.width = toW; p.height = toH;
      settleTo(item.el, {toX, toY, media: item.media, kind: item.kind,
        sizes: true, toW, toH, rotation: p.rotation});
    }
  }

  function finishFileResize(cancelled = false) {
    if (!pointer || pointer.type !== 'resize') return;
    if (pointer.frame) cancelAnimationFrame(pointer.frame);
    if (!cancelled) {
      pointer.forceSnap = false; applyFileResize();
      if (snapping) settleResizedItems(pointer.items, pointer.positionMap, pointer.grid);
    }
    for (const item of pointer.items) {
      if (cancelled) {
        cancelSettle(item.el);
        const p = pointer.positionMap[item.id];
        Object.assign(p, {x: item.x, y: item.y, width: item.width, height: item.height});
        item.el.style.left = p.x + 'px'; item.el.style.top = p.y + 'px';
        applyAssetPresentation(item.el, item.media, p, item.kind);
      }
      item.el.dataset.suppressOpenUntil = String(performance.now() + 400);
      item.el.classList.remove('resizing');
    }
    try {
      if (pointer.captureEl.hasPointerCapture(pointer.pointerId))
        pointer.captureEl.releasePointerCapture(pointer.pointerId);
    } catch {}
  }

  /* ——— the trash: material taken off this canvas, never off the disk ———
     It is shown as another project canvas, and the bar beneath it carries only
     restore and back. "restore" asks which material to bring back; choosing
     washes a card out, and a "confirm" rises above the bar to return them. */

  function updateRestoreBar() {
    const bar = $('project-restore-bar');
    if (bar) bar.classList.toggle('hidden',
      !(trashOpen && trashSelecting && trashSelection.size));
  }

  function beginTrashSelection() {
    if (!trashOpen || trashSelecting) return;
    if (!trashFiles.length) { say('nothing has been removed from this project'); return; }
    trashSelecting = true;
    trashSelection = new Set();
    view.classList.add('trash-selecting');
    $('project-trash-restore').classList.add('active');
    updateRestoreBar();
    say('select files you want to restore', true);
  }

  function toggleTrashSelection(id, el) {
    if (trashSelection.has(id)) trashSelection.delete(id);
    else trashSelection.add(id);
    const chosen = trashSelection.has(id);
    el.classList.toggle('chosen', chosen);
    el.setAttribute('aria-pressed', chosen ? 'true' : 'false');
    updateRestoreBar();
  }

  function layOutTrash() {
    trashPositions = Object.create(null);
    let z = 0;
    for (const file of trashFiles) {
      const saved = file.position;
      if (saved && Number.isFinite(+saved.z))
        z = Math.max(z, Math.round(+saved.z));
    }
    trashFiles.forEach((f, i) => {
      const id = fileId(f), p = f.position;
      trashPositions[id] = (p && Number.isFinite(+p.x) && Number.isFinite(+p.y))
        ? {x: +p.x, y: +p.y,
           z: Number.isFinite(+p.z) ? Math.max(0, Math.round(+p.z)) : ++z,
           ...(Number.isFinite(+p.width) ? {width: +p.width} : {}),
           ...(Number.isFinite(+p.height) ? {height: +p.height} : {}),
           ...(Number.isFinite(+p.rotation) ? {rotation: +p.rotation} : {})}
        : initialPosition(id, i, ++z);
    });
    trashMaxZ = z;
  }

  async function openTrash() {
    if (!current || trashOpen) return;
    closeImportMenu();
    clearCanvasSelection();        // selection belongs to the canvas, not the trash
    resetCleanState();             // the trash shows the real desktop, not a tidy
    clearTimeout(positionTimer); await savePositions();
    let data;
    try { data = await API.projectTrash(projectId(current)); }
    catch { say('the trash could not be read'); return; }
    trashOpen = true;
    trashSelecting = false;
    trashSelection = new Set();
    trashFiles = listOf(data, ['files', 'items']);
    layOutTrash();
    setTool('view');
    view.classList.add('trash-open');
    view.classList.remove('trash-selecting');
    $('project-trash-btn').classList.add('active');
    $('project-trash-restore').classList.remove('active');
    layer.classList.remove('here');
    renderFiles();
    updateRestoreBar();
    say(trashFiles.length
      ? 'nothing here has left the folder'
      : 'nothing has been removed from this project');
  }

  function closeTrash({redraw = true} = {}) {
    if (!trashOpen) return;
    // Do not let a quick Back/context-navigation gesture cancel the final
    // Trash arrangement before its debounce fires.
    if (positionTimer !== null) {
      clearTimeout(positionTimer);
      positionTimer = null;
      savePositions(trashPositions,
        current ? projectId(current) : null);
    }
    trashOpen = false; trashSelecting = false;
    trashSelection = new Set();
    trashFiles = []; trashPositions = Object.create(null); trashMaxZ = 0;
    view.classList.remove('trash-open', 'trash-selecting');
    const btn = $('project-trash-btn'), restore = $('project-trash-restore');
    if (btn) btn.classList.remove('active');
    if (restore) restore.classList.remove('active');
    updateRestoreBar();
    say('');                       // the standing instruction goes with it
    if (redraw && current) { layer.classList.remove('here'); renderFiles(); }
  }

  async function restoreChosen() {
    if (!current || !trashOpen || !trashSelecting || !trashSelection.size) return;
    const ids = [...trashSelection];
    say('restoring…');
    try {
      const res = await API.restoreProjectFiles(projectId(current), ids);
      if (!res || !res.ok) throw new Error((res && res.error) || 'restore failed');
      if (res.project && Array.isArray(res.project.files)) {
        files = res.project.files;
        const saved = res.project.positions || {};
        files.forEach((f, i) => {
          const id = fileId(f), p = saved[id] || f.position;
          if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) {
            positions[id] = {x: +p.x, y: +p.y,
              z: Number.isFinite(+p.z) ? Math.max(0, Math.round(+p.z)) : ++maxZ};
            if (Number.isFinite(+p.width)) positions[id].width = +p.width;
            if (Number.isFinite(+p.height)) positions[id].height = +p.height;
            if (Number.isFinite(+p.rotation))
              positions[id].rotation =
                ((Math.round(+p.rotation / 90) * 90) % 360 + 360) % 360;
          } else if (!positions[id]) positions[id] = initialPosition(id, i, ++maxZ);
        });
      }
      trashFiles = listOf(res.trash, ['files', 'items']);
      // the choice is spent; the trash settles back to simply being looked at
      trashSelecting = false;
      trashSelection = new Set();
      view.classList.remove('trash-selecting');
      $('project-trash-restore').classList.remove('active');
      layOutTrash();
      layer.classList.remove('here');
      renderFiles();
      updateRestoreBar();
      say(ids.length === 1
        ? 'restored to the project' : ids.length + ' restored to the project');
    } catch (error) { say(error.message || 'those files could not be restored'); }
  }

  async function openProjectDocument(file) {
    if (!current || typeof Writing === 'undefined' ||
        typeof Writing.openProjectDocument !== 'function') return;
    const destination = projectId(current), id = fileId(file);
    clearTimeout(positionTimer); await savePositions();
    reopenProjectId = destination;
    if (window.ContextNav) window.ContextNav.go('writing');
    if (!await Writing.openProjectDocument(destination, id))
      returnToProject(destination);
  }

  function closeProject() {
    if (!current) return false;
    if (typeof ModelView !== 'undefined') ModelView.close();
    commitProjectTextInput();
    clearCanvasSelection();
    resetCleanState();             // forget any tidy; the desktop positions stand
    closeTrash({redraw: false});   // the trash belongs to the project we are leaving
    clearTimeout(positionTimer); savePositions();
    clearTimeout(annoTimer); saveAnnotations();
    current = null; files = []; layer.classList.remove('here');
    workspace.classList.add('hidden');
    view.classList.remove('workspace-open');
    renderIndex();
    return true;
  }

  // The bounding box of all placed material, in world units, so panning can be
  // held to a little past the content instead of drifting into empty space.
  function contentBounds(posMap) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, any = false;
    for (const id in posMap) {
      const p = posMap[id];
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const w = Number.isFinite(p.width) ? p.width : 230;
      const h = Number.isFinite(p.height) ? p.height : 160;
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + w); maxY = Math.max(maxY, p.y + h);
      any = true;
    }
    return any ? {minX, minY, maxX, maxY} : null;
  }

  // Clamp a pan so the content edges stay within a MARGIN of empty surround.
  // When the content is smaller than the viewport on an axis it is centred, so
  // small projects never fly off the edge. Identical maths for canvas and index.
  function clampedPan(px, py, s, bounds, margin, width, height) {
    if (!bounds) return {x: px, y: py};
    const clampAxis = (value, min0, max0, mid) => {
      const lo = Math.min(min0, max0), hi = Math.max(min0, max0);
      return lo <= hi ? Math.max(lo, Math.min(hi, value)) : mid;
    };
    const minPanX = (width - margin) - bounds.maxX * s;
    const maxPanX = margin - bounds.minX * s;
    const minPanY = (height - margin) - bounds.maxY * s;
    const maxPanY = margin - bounds.minY * s;
    const midX = (width - (bounds.minX + bounds.maxX) * s) / 2;
    const midY = (height - (bounds.minY + bounds.maxY) * s) / 2;
    return {x: clampAxis(px, minPanX, maxPanX, midX),
      y: clampAxis(py, minPanY, maxPanY, midY)};
  }

  function clampCanvasPan() {
    const r = viewport.getBoundingClientRect();
    const bounded = clampedPan(pan.x, pan.y, scale,
      contentBounds(activePositions()), CANVAS_MARGIN, r.width, r.height);
    pan.x = bounded.x; pan.y = bounded.y;
  }

  function updateLayerTransform() {
    // top-left origin so the world→screen map is a plain scale-then-translate,
    // matching the annotation canvas and the wall/detail camera model
    clampCanvasPan();
    layer.style.transformOrigin = '0 0';
    layer.style.transform =
      `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
    requestDraw();
    // re-evaluate which images deserve full resolution once movement settles
    scheduleImageLOD();
  }

  // zoom about a screen point, keeping the world point beneath it fixed —
  // the same gesture as the picture wall and the inspection table
  function zoomAt(clientX, clientY, factor) {
    const r = viewport.getBoundingClientRect();
    const sx = clientX - r.left, sy = clientY - r.top;
    const wx = (sx - pan.x) / scale, wy = (sy - pan.y) / scale;
    scale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor));
    pan.x = sx - wx * scale;
    pan.y = sy - wy * scale;
    updateLayerTransform();
  }

  function schedulePositions(source = positions) {
    // the cleaned layout is a view, never a save; the desktop positions stand
    if (cleanMode) return;
    const targetId = current ? projectId(current) : null;
    const snapshot = Object.fromEntries(
      Object.entries(source || {}).map(([id, value]) => [id, {...value}]));
    clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      positionTimer = null;
      savePositions(snapshot, targetId);
    }, 260);
  }
  async function savePositions(source = positions,
                               targetId = current ? projectId(current) : null) {
    if (!targetId || cleanMode) return;
    try {
      const res = await API.saveProjectPositions(targetId, source);
      if (!res || !res.ok) throw new Error('save failed');
      say('saved');
    }
    catch { say('positions will save when the folder is available'); }
  }

  function setTool(next) {
    if (!/^(view|annotate)$/.test(next)) return;
    closeImportMenu();
    if (next !== 'annotate') commitProjectTextInput();
    tool = next;
    workspace.querySelectorAll('[data-project-tool]').forEach(b =>
      b.classList.toggle('active', b.dataset.projectTool === next));
    annoTools.classList.toggle('hidden', next !== 'annotate');
    canvas.classList.toggle('drawing', next === 'annotate');
    closeContext();
  }

  function resizeCanvas() {
    if (!current) return;
    const r = viewport.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(r.width * dpr));
    canvas.height = Math.max(1, Math.round(r.height * dpr));
    canvas.style.width = r.width + 'px'; canvas.style.height = r.height + 'px';
    requestDraw();
  }
  function requestDraw() {
    // the marks are faded out over the trash — nothing to keep animating there
    if (drawPending || !current || trashOpen) return;
    drawPending = true;
    requestAnimationFrame(drawAnnotations);
  }
  function drawAnnotations(now) {
    drawPending = false;
    if (!current) return;
    const r = viewport.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const brushView = {toScreen: (x, y) => [x * scale + pan.x, y * scale + pan.y],
      scale, width: r.width, height: r.height, now: now || performance.now()};
    PixelBrushes.paintInk(ctx, ink, brushView);
    drawProjectTexts(brushView);
    let animated = PixelBrushes.paintWiggly(ctx, wig, brushView) |
      PixelBrushes.paintFuture(ctx, future, brushView);
    if (performance.now() < sizePreviewUntil) {
      const d = (2 * (brushSize - 1) + 1) * PixelBrushes.CELL * scale;
      ctx.strokeStyle = 'rgba(110,110,105,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lastCanvasMouse.x - d / 2, lastCanvasMouse.y - d / 2, d, d);
      animated = 1;
    }
    clearTimeout(animTimer);
    if (animated) animTimer = setTimeout(requestDraw, 125);
  }

  const worldPoint = e => {
    const r = viewport.getBoundingClientRect();
    return [(e.clientX - r.left - pan.x) / scale,
            (e.clientY - r.top - pan.y) / scale];
  };
  function drawProjectTexts(brushView) {
    for (const text of texts) {
      const raster = PixelBrushes.textRaster(text.str, text.size);
      ctx.fillStyle = PixelBrushes.colorOf(text.color);
      for (const [ox, oy] of raster.offsets) {
        const screen = brushView.toScreen(
          (text.x + ox + .5) * PixelBrushes.CELL,
          (text.y + oy + .5) * PixelBrushes.CELL);
        ctx.fillRect(screen[0] - PixelBrushes.CELL / 2,
          screen[1] - PixelBrushes.CELL / 2,
          PixelBrushes.CELL + .5, PixelBrushes.CELL + .5);
      }
    }
  }
  function textAt(x, y) {
    const cx = x / PixelBrushes.CELL, cy = y / PixelBrushes.CELL;
    for (let i = texts.length - 1; i >= 0; i--) {
      const text = texts[i], raster = PixelBrushes.textRaster(text.str, text.size);
      if (cx >= text.x - 1 && cx <= text.x + raster.wc + 1 &&
          cy >= text.y - 1 && cy <= text.y + raster.hc + 1) return text;
    }
    return null;
  }
  const textSizeCells = () => 3 + brushSize * 6;
  function cancelProjectTextInput() {
    if (!textInput) return;
    const input = textInput.input;
    textInput = null;
    input.remove();
  }
  function commitProjectTextInput() {
    if (!textInput) return;
    const pending = textInput;
    textInput = null;
    const value = pending.input.value.trim();
    pending.input.remove();
    if (!value) return;
    pushUndo();
    texts.push({id: nextTextId++, str: value,
      x: Math.floor(pending.x / PixelBrushes.CELL),
      y: Math.floor(pending.y / PixelBrushes.CELL),
      size: textSizeCells(), color: brushColor});
    requestDraw(); scheduleAnnotations();
  }
  function openProjectTextInput(event) {
    commitProjectTextInput();
    const world = worldPoint(event), rect = viewport.getBoundingClientRect();
    const input = document.createElement('input');
    input.type = 'text'; input.className = 'project-text-brush-input';
    input.spellcheck = false; input.autocomplete = 'off';
    input.style.left = (event.clientX - rect.left) + 'px';
    input.style.top = (event.clientY - rect.top) + 'px';
    input.style.fontSize = Math.max(8,
      textSizeCells() * PixelBrushes.CELL) + 'px';
    input.style.color = brushColor; input.style.caretColor = brushColor;
    viewport.appendChild(input);
    textInput = {input, x: world[0], y: world[1]};
    input.addEventListener('pointerdown', e => e.stopPropagation());
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') commitProjectTextInput();
      else if (e.key === 'Escape') cancelProjectTextInput();
    });
    input.addEventListener('blur', commitProjectTextInput);
    setTimeout(() => input.focus(), 0);
  }
  function applyBrush(x, y) {
    for (const [cx, cy] of PixelBrushes.cellsAround(x, y, brushSize)) {
      const key = cx + ',' + cy;
      if (brushTool === 'ink') ink.set(key, brushColor);
      else if (brushTool === 'wiggly') wig.set(key, brushColor);
      else if (brushTool === 'future') future.set(key, {t: performance.now(), c: brushColor});
      else if (brushTool === 'erase') { ink.delete(key); wig.delete(key); future.delete(key); }
    }
    if (brushTool === 'erase') {
      const cx = x / PixelBrushes.CELL, cy = y / PixelBrushes.CELL;
      texts = texts.filter(text => {
        const raster = PixelBrushes.textRaster(text.str, text.size);
        return !(cx >= text.x - brushSize && cx <= text.x + raster.wc + brushSize &&
          cy >= text.y - brushSize && cy <= text.y + raster.hc + brushSize);
      });
    }
  }
  function annotationSnapshot() {
    return {ink: [...ink], wig: [...wig], texts: texts.map(t => ({...t}))};
  }
  function restoreSnapshot(s) {
    ink = new Map(s.ink); wig = new Map(s.wig);
    texts = (s.texts || []).map(t => ({...t}));
    future.clear(); requestDraw();
  }
  // Undo runs through the shared annotation controller (PixelBrushes.createHistory),
  // the same one the photograph and document surfaces use, so every context steps
  // back a complete gesture identically and keeps at most 25 of them. This
  // project's history is its own instance, isolated from other projects.
  const annoHistory = PixelBrushes.createHistory({
    capture: annotationSnapshot,
    restore(snapshot) { restoreSnapshot(snapshot); scheduleAnnotations(); },
  });
  function pushUndo() { annoHistory.record(); }
  function scheduleAnnotations() {
    clearTimeout(annoTimer);
    annoTimer = setTimeout(saveAnnotations, 360);
  }
  async function saveAnnotations() {
    if (!current) return;
    try {
      const payload = PixelBrushes.serialize(ink, wig);
      payload.texts = texts.map(({str, x, y, size, color}) =>
        ({str, x, y, size, color}));
      const res = await API.saveProjectAnnotations(
        projectId(current), payload);
      if (!res || !res.ok) throw new Error('save failed');
      say('saved');
    }
    catch { say('marks will save when the folder is available'); }
  }

  /* ——— marquee selection ——— */

  // Which file ids the selection visual is currently on. Applied by toggling a
  // single quiet class; previews and names stay readable beneath it.
  function applySelection(next) {
    for (const el of layer.querySelectorAll('.project-file')) {
      const on = next.has(el.dataset.fileId);
      if (el.classList.contains('selected') !== on)
        el.classList.toggle('selected', on);
    }
    selection = next;
  }
  function clearSelection() {
    if (selection.size) applySelection(new Set());
  }
  // reconcile after files change: drop ids that no longer exist, re-mark the rest
  function reconcileSelection() {
    const live = new Set(files.map(f => fileId(f)));
    const next = new Set([...selection].filter(id => live.has(id)));
    applySelection(next);
  }

  // Each file's world-space box, captured once when the marquee begins so live
  // hit-testing never touches layout. Falls back to the element's own size for
  // fixed icons / documents that store no width/height.
  function selectableBounds() {
    const out = [];
    for (const el of layer.querySelectorAll('.project-file')) {
      const id = el.dataset.fileId, p = positions[id];
      if (!p) continue;
      const w = Number.isFinite(p.width) ? p.width : (el.offsetWidth || 200);
      const h = Number.isFinite(p.height) ? p.height : (el.offsetHeight || 150);
      out.push({id, x: p.x, y: p.y, w, h});
    }
    return out;
  }

  function beginMarquee(e) {
    if (trashOpen) return;
    e.preventDefault();
    const r = viewport.getBoundingClientRect();
    marquee = {
      pointerId: e.pointerId,
      sx: e.clientX - r.left, sy: e.clientY - r.top,
      cx: e.clientX - r.left, cy: e.clientY - r.top,
      additive: e.shiftKey, toggle: e.ctrlKey || e.metaKey,
      base: new Set(selection), items: selectableBounds(),
      moved: false, el: null, frame: 0,
    };
    viewport.setPointerCapture(e.pointerId);
  }

  function marqueeSelected() {
    const x0 = Math.min(marquee.sx, marquee.cx), x1 = Math.max(marquee.sx, marquee.cx);
    const y0 = Math.min(marquee.sy, marquee.cy), y1 = Math.max(marquee.sy, marquee.cy);
    // screen rectangle → world rectangle
    const wx0 = (x0 - pan.x) / scale, wx1 = (x1 - pan.x) / scale;
    const wy0 = (y0 - pan.y) / scale, wy1 = (y1 - pan.y) / scale;
    const hit = new Set();
    for (const b of marquee.items)
      if (b.x < wx1 && b.x + b.w > wx0 && b.y < wy1 && b.y + b.h > wy0) hit.add(b.id);
    if (marquee.toggle) {
      const next = new Set(marquee.base);
      for (const id of hit) next.has(id) ? next.delete(id) : next.add(id);
      return next;
    }
    if (marquee.additive) return new Set([...marquee.base, ...hit]);
    return hit;
  }

  function drawMarquee() {
    marquee.frame = 0;
    if (!marquee.el) {
      marquee.el = document.createElement('div');
      marquee.el.className = 'project-marquee';
      viewport.appendChild(marquee.el);
    }
    const x0 = Math.min(marquee.sx, marquee.cx), y0 = Math.min(marquee.sy, marquee.cy);
    marquee.el.style.left = x0 + 'px';
    marquee.el.style.top = y0 + 'px';
    marquee.el.style.width = Math.abs(marquee.cx - marquee.sx) + 'px';
    marquee.el.style.height = Math.abs(marquee.cy - marquee.sy) + 'px';
    applySelection(marqueeSelected());
  }

  function moveMarquee(e) {
    const r = viewport.getBoundingClientRect();
    marquee.cx = e.clientX - r.left; marquee.cy = e.clientY - r.top;
    if (!marquee.moved &&
        Math.abs(marquee.cx - marquee.sx) + Math.abs(marquee.cy - marquee.sy) > 4)
      marquee.moved = true;
    if (marquee.moved && !marquee.frame)
      marquee.frame = requestAnimationFrame(drawMarquee);
  }

  function endMarquee() {
    if (!marquee) return;
    if (marquee.frame) cancelAnimationFrame(marquee.frame);
    if (marquee.el) marquee.el.remove();
    if (marquee.moved) applySelection(marqueeSelected());   // guarantee final set
    else if (!marquee.additive && !marquee.toggle) clearSelection(); // click clears
    marquee = null;
  }
  function cancelMarquee() {
    if (!marquee) return;
    if (marquee.frame) cancelAnimationFrame(marquee.frame);
    if (marquee.el) marquee.el.remove();
    // a cancelled gesture leaves the selection as it was before the drag
    applySelection(marquee.base);
    marquee = null;
  }
  // forget the whole selection and abandon any in-flight marquee — used when the
  // project closes, the trash opens, or Writing/About takes over
  function clearCanvasSelection() {
    if (pointer && pointer.type === 'file') {
      finishFileDrag(true);
      pointer = null;
    } else if (pointer && pointer.type === 'resize') {
      finishFileResize(true);
      pointer = null;
    }
    if (marquee) {
      if (marquee.frame) cancelAnimationFrame(marquee.frame);
      if (marquee.el) marquee.el.remove();
      marquee = null;
    }
    selection = new Set();
  }

  viewport.addEventListener('pointerdown', e => {
    closeContext();
    // Panning is a deliberate gesture: the middle button, or space held with the
    // left button — so an ordinary left drag on empty canvas is free to select.
    if (e.button === 1 || (spaceDown && e.button === 0)) {
      e.preventDefault();
      pointer = {type: 'pan', sx: e.clientX, sy: e.clientY, x: pan.x, y: pan.y};
      viewport.setPointerCapture(e.pointerId); viewport.classList.add('panning');
      return;
    }
    // Files/handles stop propagation before this fires, so reaching here in view
    // mode means empty canvas: move a mark under the pointer, else marquee-select.
    if (tool === 'view' && e.button === 0) {
      const world = worldPoint(e), text = textAt(world[0], world[1]);
      if (text) {
        e.preventDefault(); pushUndo();
        pointer = {type: 'text', text, start: world,
          fromX: text.x, fromY: text.y};
        viewport.setPointerCapture(e.pointerId);
        return;
      }
      beginMarquee(e);
    }
  });
  canvas.addEventListener('pointerdown', e => {
    if (tool !== 'annotate') return;
    if (e.button === 1 || spaceDown) {
      e.preventDefault(); pointer = {type: 'pan', sx: e.clientX, sy: e.clientY, x: pan.x, y: pan.y};
      canvas.setPointerCapture(e.pointerId); viewport.classList.add('panning'); return;
    }
    if (e.button !== 0) return;
    if (brushTool === 'text') {
      e.preventDefault(); openProjectTextInput(e); return;
    }
    e.preventDefault(); pushUndo();
    const p = worldPoint(e); applyBrush(p[0], p[1]);
    pointer = {type: 'draw', last: p}; canvas.setPointerCapture(e.pointerId); requestDraw();
  });
  // The wheel sizes the brush/text before use while annotating (hold space to
  // zoom instead) and zooms the canvas at the cursor otherwise — the same
  // gesture the photograph and document isolation modes already use.
  viewport.addEventListener('wheel', e => {
    if (!current) return;
    e.preventDefault();
    if (tool === 'annotate' && !spaceDown) {
      setBrushSize(brushSize + (e.deltaY < 0 ? 1 : -1));
      const r = viewport.getBoundingClientRect();
      lastCanvasMouse = {x: e.clientX - r.left, y: e.clientY - r.top};
      sizePreviewUntil = performance.now() + 650;
      requestDraw();
      return;
    }
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  }, {passive: false});
  window.addEventListener('pointermove', e => {
    moveCover(e);
    if (marquee && e.pointerId === marquee.pointerId) { moveMarquee(e); return; }
    if (!pointer) return;
    if (pointer.type === 'pan') {
      pan.x = pointer.x + e.clientX - pointer.sx;
      pan.y = pointer.y + e.clientY - pointer.sy; updateLayerTransform();
    } else if (pointer.type === 'file') {
      if (e.pointerId !== pointer.pointerId) return;
      const now = performance.now(), dt = Math.max(8, now - pointer.lastTime);
      pointer.speed = Math.hypot(e.clientX - pointer.lastCx,
        e.clientY - pointer.lastCy) / dt;
      pointer.lastCx = e.clientX; pointer.lastCy = e.clientY; pointer.lastTime = now;
      pointer.cx = e.clientX; pointer.cy = e.clientY;
      if (!pointer.frame) pointer.frame = requestAnimationFrame(applyFileDrag);
    } else if (pointer.type === 'resize') {
      if (e.pointerId !== pointer.pointerId) return;
      const now = performance.now(), dt = Math.max(8, now - pointer.lastTime);
      pointer.speed = Math.hypot(e.clientX - pointer.lastCx,
        e.clientY - pointer.lastCy) / dt;
      pointer.lastCx = e.clientX; pointer.lastCy = e.clientY; pointer.lastTime = now;
      pointer.cx = e.clientX; pointer.cy = e.clientY;
      if (!pointer.frame) pointer.frame = requestAnimationFrame(applyFileResize);
    } else if (pointer.type === 'text') {
      const world = worldPoint(e);
      pointer.text.x = pointer.fromX +
        Math.round((world[0] - pointer.start[0]) / PixelBrushes.CELL);
      pointer.text.y = pointer.fromY +
        Math.round((world[1] - pointer.start[1]) / PixelBrushes.CELL);
      requestDraw();
    } else if (pointer.type === 'draw') {
      const p = worldPoint(e);
      PixelBrushes.strokeLine(pointer.last[0], pointer.last[1], p[0], p[1], applyBrush);
      pointer.last = p; requestDraw();
    }
  });
  window.addEventListener('pointerup', e => {
    if (!pointer) return;
    if (pointer.type === 'file' && e.pointerId !== pointer.pointerId) return;
    if (pointer.type === 'file') {
      const movedPositions = pointer.positionMap;
      finishFileDrag();
      if (!pointer.moved)
        selectFileFromClick(pointer.id,
          {shift: pointer.selShift, toggle: pointer.selToggle});
      schedulePositions(movedPositions);
    } else if (pointer.type === 'resize') {
      const resizedPositions = pointer.positionMap;
      finishFileResize(); schedulePositions(resizedPositions);
    }
    else if ((pointer.type === 'draw' && brushTool !== 'future') || pointer.type === 'text')
      scheduleAnnotations();
    viewport.classList.remove('panning'); pointer = null;
  });
  window.addEventListener('pointerup', endCoverDrag);
  window.addEventListener('pointerup', endMarquee);
  window.addEventListener('pointercancel', e => {
    if (pointer && pointer.type === 'file' &&
        e.pointerId !== pointer.pointerId) return;
    if (pointer && pointer.type === 'file') finishFileDrag(true);
    else if (pointer && pointer.type === 'resize') finishFileResize(true);
    else if (pointer && pointer.el) pointer.el.classList.remove('dragging', 'resizing');
    viewport.classList.remove('panning'); pointer = null;
  });
  window.addEventListener('pointercancel', endCoverDrag);
  window.addEventListener('pointercancel', cancelMarquee);
  // a cancelled capture (or the window losing focus) must never leave a marquee
  // element or its animation frame behind
  viewport.addEventListener('lostpointercapture', () => { if (marquee) cancelMarquee(); });
  window.addEventListener('blur', () => {
    if (marquee) cancelMarquee();
    if (pointer && pointer.type === 'file') {
      finishFileDrag(true); pointer = null;
    } else if (pointer && pointer.type === 'resize') {
      finishFileResize(true); pointer = null;
    }
    viewport.classList.remove('panning');
  });

  function openContext(e, file) {
    e.preventDefault(); e.stopPropagation();
    contextTarget = {type: 'file', file};
    const menu = $('project-context');
    menu.style.left = Math.max(12, Math.min(e.clientX, innerWidth - 372)) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - 150) + 'px';
    configureContextMenu();
    menu.classList.remove('hidden');
  }
  async function openExternalFile(file, chooseApplication) {
    if (!current || !file) return false;
    const nativeOpen = window.pywebview && window.pywebview.api &&
      window.pywebview.api.open_project_file;
    if (typeof nativeOpen !== 'function') {
      say('opening files is available in the desktop app'); return false;
    }
    try {
      const res = await nativeOpen.call(window.pywebview.api,
        projectId(current), fileId(file), !!chooseApplication);
      if (!res || !res.ok) throw new Error((res && res.error) || 'open failed');
      return true;
    } catch (error) {
      say(error.message && error.message !== 'open failed'
        ? error.message : 'that file could not be opened');
      return false;
    }
  }
  function openProjectContext(e, project) {
    e.preventDefault(); e.stopPropagation();
    contextTarget = {type: 'project', project};
    const menu = $('project-context');
    menu.style.left = Math.max(12, Math.min(e.clientX, innerWidth - 372)) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - 90) + 'px';
    configureContextMenu(); menu.classList.remove('hidden');
  }
  function configureContextMenu() {
    const isFile = contextTarget && contextTarget.type === 'file';
    const image = isFile && kindOf(contextTarget.file) === 'image';
    $('project-use-cover').classList.toggle('hidden', !image);
    $('project-open-in').classList.toggle('hidden', !isFile);
    $('project-rotate-image').classList.toggle('hidden', !image);
    $('project-delete-element').classList.toggle('hidden', !isFile);
    $('project-delete-project').classList.toggle('hidden', isFile);
    for (const b of $('project-context').querySelectorAll('button')) {
      b.dataset.confirming = ''; b.classList.remove('confirming');
      if (b.dataset.label) b.textContent = b.dataset.label;
      else b.dataset.label = b.textContent;
    }
  }
  function closeContext() {
    $('project-context').classList.add('hidden'); contextTarget = null;
  }
  function confirmContextAction(button, question, action) {
    if (button.dataset.confirming !== 'yes') {
      button.dataset.confirming = 'yes'; button.classList.add('confirming');
      button.textContent = question;
      return;
    }
    closeContext(); action();
  }
  $('project-use-cover').addEventListener('click', async () => {
    if (!current || !contextTarget || contextTarget.type !== 'file') return;
    const id = fileId(contextTarget.file); closeContext();
    try {
      const res = await API.setProjectCover(projectId(current), id);
      if (!res || !res.ok) throw new Error('cover failed');
      Object.assign(current, res.project || {cover_file_id: id});
      const summary = projects.find(p => projectId(p) === projectId(current));
      if (summary) Object.assign(summary, res.project || {cover_file_id: id});
      say('cover saved');
    }
    catch { say('cover could not be saved'); }
  });
  $('project-rotate-image').addEventListener('click', () => {
    if (!current || !contextTarget || contextTarget.type !== 'file') return;
    const id = fileId(contextTarget.file);
    const el = layer.querySelector(`.project-file[data-file-id="${CSS.escape(id)}"]`);
    const media = el && el.querySelector('.project-file-media');
    if (el && media) rotateImage(id, el, media);
  });
  $('project-open-in').addEventListener('click', () => {
    if (!contextTarget || contextTarget.type !== 'file') return;
    const file = contextTarget.file; closeContext();
    openExternalFile(file, true);
  });
  // Nothing is destroyed here — the file stays in the project folder and only
  // steps off the canvas into the trash — so it asks nothing and simply does it.
  $('project-delete-element').addEventListener('click', async () => {
    if (!current || !contextTarget || contextTarget.type !== 'file') return;
    const project = projectId(current), id = fileId(contextTarget.file);
    closeContext();
    try {
      const res = await API.deleteProjectFile(project, id);
      if (!res || !res.ok) throw new Error((res && res.error) || 'remove failed');
      delete positions[id];
      files = files.filter(f => fileId(f) !== id);
      Object.assign(current, res.project || {});
      const summary = projects.find(p => projectId(p) === project);
      if (summary && res.project) Object.assign(summary, res.project);
      renderFiles(); say('moved to the trash');
    } catch (error) { say(error.message || 'that could not be removed'); }
  });
  // Unlinking removes only the folder association — never the folder or its
  // files. It is confirmed in-place (one extra click) like every other menu
  // action, but it is not destructive, so the wording is gentle.
  $('project-delete-project').addEventListener('click', e => {
    if (!contextTarget || contextTarget.type !== 'project') return;
    const id = projectId(contextTarget.project);
    const name = contextTarget.project.title || contextTarget.project.name || 'this';
    confirmContextAction(e.currentTarget,
      `unlink ${name}? the folder and its files are kept`, async () => {
      say('unlinking project…');
      try {
        const res = await API.unlinkProject(id);
        if (!res || !res.ok) throw new Error((res && res.error) || 'unlink failed');
        projects = projects.filter(p => projectId(p) !== id);
        delete coverPositions[id]; renderIndex(); say('project unlinked');
      } catch (error) {
        // never pretend the project was unlinked when it was not
        say(error.message && error.message !== 'unlink failed'
          ? error.message : 'project could not be unlinked');
      }
    });
  });

  function beginPictureImport() {
    if (!current || picking) return;
    closeImportMenu();
    $('proj-palette').classList.remove('open');
    setTool('view');
    picking = true; pickIds = [];
    view.classList.add('picking-away');
    document.body.classList.remove('hide-wall-chrome');
    document.body.classList.add('project-picking');
    Wall.beginIntro(); Wall.setPick([]);
    $('proj-pick-actions').classList.remove('hidden');
    $('proj-pick-tray').classList.remove('hidden'); renderPictureTray();
  }
  function onPhotoPick(id) {
    if (!picking) return false;
    const i = pickIds.indexOf(id);
    if (i < 0) pickIds.push(id); else pickIds.splice(i, 1);
    Wall.setPick(pickIds); renderPictureTray(); return true;
  }
  function renderPictureTray() {
    PhotoSelectionTray.render($('proj-pick-tray'), pickIds, onPhotoPick);
  }
  function endPictureImport() {
    picking = false; pickIds = []; Wall.setPick([]);
    $('proj-pick-actions').classList.add('hidden');
    $('proj-pick-tray').classList.add('hidden');
    document.body.classList.remove('project-picking');
    document.body.classList.add('hide-wall-chrome');
    Wall.beginOutro(() => {}); view.classList.remove('picking-away');
  }
  async function placePictures() {
    if (!picking || !pickIds.length) return;
    const ids = pickIds.slice(); endPictureImport(); say('placing pictures…');
    try {
      const res = await API.importProjectPictures(projectId(current), ids);
      await reloadCurrent();
      say(res && res.ok ? 'pictures placed' :
        ((res && res.errors && res.errors[0]) || 'some pictures could not be placed'));
    }
    catch { say('pictures could not be placed'); }
  }

  async function importFilesDirectly() {
    if (!current) return;
    closeImportMenu();
    const picker = window.pywebview && window.pywebview.api &&
      window.pywebview.api.pick_files;
    if (typeof picker !== 'function') {
      say('direct import is available in the desktop app'); return;
    }
    let paths;
    try { paths = await picker.call(window.pywebview.api); } catch { paths = null; }
    if (!paths) return;
    if (!Array.isArray(paths)) paths = [paths];
    paths = paths.map(String).filter(Boolean);
    if (!paths.length) return;
    say('importing materials…');
    try {
      const res = await API.importProjectFiles(projectId(current), paths);
      await reloadCurrent();
      say(res && res.ok ? 'materials imported' :
        ((res && res.errors && res.errors[0]) || 'some materials could not be imported'));
    } catch { say('materials could not be imported'); }
  }

  function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function paintContained(g, node, x, y, width, height, rotation = 0) {
    const naturalWidth = node.videoWidth || node.naturalWidth || node.width;
    const naturalHeight = node.videoHeight || node.naturalHeight || node.height;
    if (!naturalWidth || !naturalHeight) return false;
    const quarterTurn = rotation % 180 !== 0;
    const rw = quarterTurn ? naturalHeight : naturalWidth;
    const rh = quarterTurn ? naturalWidth : naturalHeight;
    const scale = Math.min(width / rw, height / rh);
    g.save();
    g.translate(x + width / 2, y + height / 2);
    g.rotate(rotation * Math.PI / 180);
    try {
      g.drawImage(node, -naturalWidth * scale / 2, -naturalHeight * scale / 2,
        naturalWidth * scale, naturalHeight * scale);
    } catch { g.restore(); return false; }
    g.restore(); return true;
  }

  function paintTextLines(g, text, x, y, maxWidth, maxLines, lineHeight) {
    const words = String(text || '').replace(/\s+/g, ' ').trim().split(' ');
    let line = '', row = 0;
    for (const word of words) {
      const candidate = line ? line + ' ' + word : word;
      if (line && g.measureText(candidate).width > maxWidth) {
        g.fillText(line, x, y + row * lineHeight); row++; line = word;
        if (row >= maxLines) return;
      } else line = candidate;
    }
    if (line && row < maxLines) g.fillText(line, x, y + row * lineHeight);
  }

  function projectCssText() {
    let css = '';
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch { continue; }
      for (const rule of rules) css += rule.cssText + '\n';
    }
    return css;
  }

  function rasterDataUrl(node) {
    const width = node.videoWidth || node.naturalWidth || node.width;
    const height = node.videoHeight || node.naturalHeight || node.height;
    if (!width || !height) return null;
    const cv = document.createElement('canvas'); cv.width = width; cv.height = height;
    try {
      cv.getContext('2d').drawImage(node, 0, 0, width, height);
      return cv.toDataURL('image/png');
    } catch { return null; }
  }

  function mediaClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    return Math.floor(whole / 60) + ':' + String(whole % 60).padStart(2, '0');
  }

  function staticAudioControl(audio) {
    // Native audio controls live in browser shadow DOM and disappear from an
    // SVG foreignObject capture.  Replace only the exported clone with a quiet
    // state-faithful control so the saved canvas retains playback state, time,
    // duration and volume instead of leaving a blank strip.
    const control = document.createElement('span');
    control.className = 'project-audio-snapshot';
    control.style.cssText =
      'display:flex;align-items:center;gap:9px;flex:1 1 170px;min-width:150px;' +
      'height:34px;color:#565650;font:300 10px/1 "Helvetica Neue",Helvetica,' +
      '"Segoe UI",Arial,sans-serif;box-sizing:border-box;';
    const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
    const current = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    const progress = duration > 0 ? Math.max(0, Math.min(1, current / duration)) : 0;
    const state = document.createElement('span');
    state.textContent = audio.paused ? '\u25b6' : '\u2161';
    state.style.cssText = 'font-size:12px;width:12px;text-align:center;';
    const clock = document.createElement('span');
    clock.textContent = mediaClock(current) + ' / ' + mediaClock(duration);
    clock.style.cssText = 'white-space:nowrap;';
    const track = document.createElement('span');
    track.style.cssText =
      'position:relative;display:block;flex:1;height:2px;min-width:34px;' +
      'background:#d8d8d1;border-radius:2px;overflow:hidden;';
    const played = document.createElement('span');
    played.style.cssText = `position:absolute;inset:0 auto 0 0;width:${progress * 100}%;` +
      'background:#7b7b74;';
    track.appendChild(played);
    const volume = document.createElement('span');
    volume.textContent = audio.muted || audio.volume === 0 ? '\u00d7' : '\u25d6';
    volume.style.cssText = 'font-size:13px;width:13px;text-align:center;';
    control.append(state, clock, track, volume);
    return control;
  }

  async function composeDomViewport() {
    const bounds = viewport.getBoundingClientRect();
    const clone = viewport.cloneNode(true);
    clone.querySelectorAll('.project-asset-handle').forEach(el => el.remove());
    clone.style.cssText += `;position:relative;width:${bounds.width}px;height:${bounds.height}px;` +
      'inset:auto;overflow:hidden;background:#FAFAF7;cursor:default;';

    const originalImages = [...viewport.querySelectorAll('img')];
    const cloneImages = [...clone.querySelectorAll('img')];
    originalImages.forEach((image, i) => {
      const data = rasterDataUrl(image);
      if (data && cloneImages[i]) cloneImages[i].setAttribute('src', data);
    });
    const originalVideos = [...viewport.querySelectorAll('video')];
    const cloneVideos = [...clone.querySelectorAll('video')];
    originalVideos.forEach((video, i) => {
      const data = rasterDataUrl(video), target = cloneVideos[i];
      if (!data || !target) return;
      const image = document.createElement('img');
      image.setAttribute('src', data); image.setAttribute('style', target.getAttribute('style') || '');
      image.className = target.className; target.replaceWith(image);
    });
    const originalAudio = [...viewport.querySelectorAll('audio')];
    const cloneAudio = [...clone.querySelectorAll('audio')];
    originalAudio.forEach((audio, i) => {
      if (cloneAudio[i]) cloneAudio[i].replaceWith(staticAudioControl(audio));
    });
    const cloneCanvas = clone.querySelector('#project-annotations');
    if (cloneCanvas) {
      const image = document.createElement('img');
      image.id = 'project-annotations'; image.src = canvas.toDataURL('image/png');
      image.style.cssText = `position:absolute;inset:0;width:${bounds.width}px;` +
        `height:${bounds.height}px;pointer-events:none;z-index:2;`;
      cloneCanvas.replaceWith(image);
    }

    const host = document.createElement('div');
    host.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const style = document.createElement('style'); style.textContent = projectCssText();
    host.append(style, clone);
    const markup = new XMLSerializer().serializeToString(host);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" ` +
      `height="${bounds.height}"><foreignObject width="100%" height="100%">` +
      `${markup}</foreignObject></svg>`;
    const blobUrl = URL.createObjectURL(new Blob([svg], {type: 'image/svg+xml;charset=utf-8'}));
    try {
      const image = new Image();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('snapshot timed out')), 5000);
        image.onload = () => { clearTimeout(timer); resolve(); };
        image.onerror = () => { clearTimeout(timer); reject(new Error('snapshot unsupported')); };
        image.src = blobUrl;
      });
      const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const out = document.createElement('canvas');
      out.width = Math.max(1, Math.round(bounds.width * ratio));
      out.height = Math.max(1, Math.round(bounds.height * ratio));
      const outCtx = out.getContext('2d'); outCtx.scale(ratio, ratio);
      outCtx.drawImage(image, 0, 0, bounds.width, bounds.height);
      // Reading one pixel detects WebKit's foreignObject security false-positive
      // before a later toDataURL obscures the useful fallback path.
      outCtx.getImageData(0, 0, 1, 1);
      const hasVisibleMaterial = [...layer.querySelectorAll('.project-file')].some(el => {
        const r = el.getBoundingClientRect();
        return r.right > bounds.left && r.left < bounds.right &&
          r.bottom > bounds.top && r.top < bounds.bottom;
      });
      if (hasVisibleMaterial) {
        let varied = false;
        const visibleMedia = [...viewport.querySelectorAll(
          '.project-file-media img, .project-file-media video')].filter(node => {
          const r = node.getBoundingClientRect();
          return r.right > bounds.left && r.left < bounds.right &&
            r.bottom > bounds.top && r.top < bounds.bottom;
        });
        // Sample where visible media actually lives rather than a coarse whole-
        // viewport grid.  Sparse canvases can otherwise let a blank WebKit
        // foreignObject pass because every grid point happens to hit paper.
        for (const node of visibleMedia) {
          const r = node.getBoundingClientRect();
          for (const fy of [.3, .5, .7]) for (const fx of [.3, .5, .7]) {
            const px = Math.max(0, Math.min(out.width - 1,
              Math.floor((r.left - bounds.left + r.width * fx) * ratio)));
            const py = Math.max(0, Math.min(out.height - 1,
              Math.floor((r.top - bounds.top + r.height * fy) * ratio)));
            const pixel = outCtx.getImageData(px, py, 1, 1).data;
            if (Math.abs(pixel[0] - 250) + Math.abs(pixel[1] - 250) +
                Math.abs(pixel[2] - 247) > 24) { varied = true; break; }
          }
          if (varied) break;
        }
        if (!visibleMedia.length) {
          for (let gy = 1; gy < 8 && !varied; gy++) for (let gx = 1; gx < 8; gx++) {
            const pixel = outCtx.getImageData(
              Math.min(out.width - 1, Math.floor(gx / 8 * out.width)),
              Math.min(out.height - 1, Math.floor(gy / 8 * out.height)), 1, 1).data;
            if (Math.abs(pixel[0] - 250) + Math.abs(pixel[1] - 250) +
                Math.abs(pixel[2] - 247) > 18) { varied = true; break; }
          }
        }
        if (!varied) throw new Error('foreignObject rendered blank');
      }
      return out.toDataURL('image/jpeg', .92);
    } finally { URL.revokeObjectURL(blobUrl); }
  }

  async function composeVisibleProject() {
    try { return await composeDomViewport(); }
    catch { return composeVisibleProjectManual(); }
  }

  async function composeVisibleProjectManual() {
    const bounds = viewport.getBoundingClientRect();
    const ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const output = document.createElement('canvas');
    output.width = Math.max(1, Math.round(bounds.width * ratio));
    output.height = Math.max(1, Math.round(bounds.height * ratio));
    const g = output.getContext('2d');
    g.scale(ratio, ratio); g.fillStyle = '#FAFAF7';
    g.fillRect(0, 0, bounds.width, bounds.height);

    const ordered = [...layer.querySelectorAll('.project-file')]
      .sort((a, b) => (+a.style.zIndex || 0) - (+b.style.zIndex || 0));
    for (const el of ordered) {
      const id = el.dataset.fileId, f = files.find(item => fileId(item) === id);
      if (!f) continue;
      const media = el.querySelector('.project-file-media');
      const mr = media.getBoundingClientRect();
      if (mr.right <= bounds.left || mr.left >= bounds.right ||
          mr.bottom <= bounds.top || mr.top >= bounds.bottom) continue;
      const x = mr.left - bounds.left, y = mr.top - bounds.top;
      const w = mr.width, h = mr.height, kind = kindOf(f);
      g.save();
      g.shadowColor = 'rgba(70,70,62,.10)'; g.shadowBlur = 18; g.shadowOffsetY = 7;
      g.fillStyle = kind === 'image' ? '#FFFFFF' : '#F4F4EF';
      g.fillRect(x, y, w, h); g.restore();
      g.strokeStyle = '#ECECE6'; g.lineWidth = 1; g.strokeRect(x + .5, y + .5, w - 1, h - 1);
      const visual = media.querySelector('img, video');
      if (visual) {
        paintContained(g, visual, x, y, w, h,
          kind === 'image' ? (+positions[id].rotation || 0) : 0);
      } else if (kind === 'audio') {
        g.fillStyle = '#8A8A84'; g.font = '300 11px "Segoe UI", sans-serif';
        const name = (f.name || f.filename || 'audio').replace(/\.[^.]+$/, '');
        g.fillText(name.slice(0, 36), x + 13, y + Math.min(h - 12, 25));
        g.fillStyle = '#D8D8D1'; g.fillRect(x + 13, y + h - 13, Math.max(20, w - 26), 2);
      } else {
        g.fillStyle = '#8A8A84'; g.font = '300 11px Georgia, serif';
        paintTextLines(g, f.excerpt || f.filename || f.name || f.extension || 'file',
          x + 14, y + 24, Math.max(20, w - 28), Math.max(1, Math.floor((h - 28) / 16)), 16);
      }
      const caption = el.querySelector('.project-file-name');
      if (caption && getComputedStyle(caption).display !== 'none') {
        const cr = caption.getBoundingClientRect();
        g.fillStyle = '#8A8A84'; g.font = '300 11px "Segoe UI", sans-serif';
        g.fillText(caption.textContent.slice(0, 58), cr.left - bounds.left,
          cr.top - bounds.top + 11, Math.max(20, cr.width));
      }
    }
    // The annotation canvas already represents exactly the visible world
    // window, including permanent text and all z-independent marks.
    g.drawImage(canvas, 0, 0, canvas.width, canvas.height,
      0, 0, bounds.width, bounds.height);
    return output.toDataURL('image/jpeg', .92);
  }

  async function saveVisibleProject() {
    if (!current || savingCanvas) return;
    savingCanvas = true; closeContext(); commitProjectTextInput();
    $('proj-palette').classList.remove('open');
    view.classList.add('saving-project-canvas');
    say('saving project canvas…');
    try {
      requestDraw(); await nextPaint();
      const capture = window.pywebview && window.pywebview.api &&
        window.pywebview.api.capture_visible_region;
      if (typeof capture !== 'function')
        throw new Error('pixel capture is available in the desktop app');
      const bounds = viewport.getBoundingClientRect();
      const borderX = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
      const chromeY = Math.max(0, window.outerHeight - window.innerHeight - borderX);
      const shot = await capture.call(window.pywebview.api, {
        left: window.screenX + borderX + bounds.left,
        top: window.screenY + chromeY + bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
      if (!shot || !shot.ok || !shot.data_url)
        throw new Error((shot && shot.error) ||
          'the visible canvas could not be captured');
      const res = await API.saveProjectSnapshot(projectId(current), shot.data_url);
      if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
      // tell the user exactly where the capture landed, and keep it on screen
      say(res.path ? 'captured · ' + res.path : 'project canvas captured', true);
    } catch (error) {
      say(error.message && error.message !== 'save failed'
        ? error.message : 'project canvas could not be saved');
    } finally {
      view.classList.remove('saving-project-canvas'); savingCanvas = false;
    }
  }

  async function reloadCurrent() {
    if (!current) return;
    const id = projectId(current), oldPositions = positions;
    const data = await API.project(id); files = listOf(data, ['files', 'items']);
    Object.assign(current, data || {});
    const summary = projects.find(p => projectId(p) === id);
    if (summary) Object.assign(summary, data || {});
    const saved = (data && (data.positions || (data.metadata && data.metadata.positions))) || {};
    positions = Object.create(null);
    maxZ = 0;
    for (const p of Object.values(saved))
      if (p && Number.isFinite(+p.z)) maxZ = Math.max(maxZ, Math.round(+p.z));
    files.forEach((f, i) => {
      const fid = fileId(f), p = saved[fid] || oldPositions[fid] || f.position;
      if (p && Number.isFinite(+p.x) && Number.isFinite(+p.y)) {
        positions[fid] = {x: +p.x, y: +p.y,
          z: Number.isFinite(+p.z) ? Math.round(+p.z) : ++maxZ};
        if (Number.isFinite(+p.width)) positions[fid].width = +p.width;
        if (Number.isFinite(+p.height)) positions[fid].height = +p.height;
        if (Number.isFinite(+p.rotation))
          positions[fid].rotation = ((Math.round(+p.rotation / 90) * 90) % 360 + 360) % 360;
      } else positions[fid] = initialPosition(fid, i, ++maxZ);
    });
    renderFiles();
  }

  /* ——— clean / messy: cluster material by type, non-destructively ———
     The tidy arranges everything in the currently-visible world so the result
     is clearly in view, groups each file type into its own compact, roughly
     square cluster, and offsets the clusters organically. Nothing is rotated,
     nothing is resized, and the cleaned layout is never written to disk — the
     exact original arrangement is restored on "messy". */
  function cleanCategoryOf(f) {
    const fx = fixedIconOf(f);
    if (fx === 'project') return 'project3d';
    if (fx === 'model') return 'model3d';
    if (fx === 'document') return 'documents';
    const k = kindOf(f);
    if (k === 'image') return 'images';
    if (k === 'document' || k === 'text') return 'documents';   // pdf / docx / txt
    return 'other';
  }
  function cleanItemSize(id) {
    const el = layer.querySelector('.project-file[data-file-id="' + CSS.escape(id) + '"]');
    if (el && el.offsetWidth) return {w: el.offsetWidth, h: el.offsetHeight};
    const p = positions[id] || {};
    return {w: Number.isFinite(p.width) ? p.width : 210,
      h: Number.isFinite(p.height) ? p.height : 150};
  }
  function organizeFilesLayout() {
    const order = ['project3d', 'model3d', 'images', 'documents', 'other'];
    const groups = new Map();
    for (const f of files) {
      const c = cleanCategoryOf(f), id = fileId(f);
      if (!groups.has(c)) groups.set(c, []);
      groups.get(c).push(id);
    }
    const gap = 26, clusterGap = 92;
    const r = viewport.getBoundingClientRect();
    const pad = 48 / scale;
    // The tidy is laid out for the world rectangle currently on screen and then
    // centred inside it, so "clean" gathers the material where you are looking
    // rather than sending it off to the top-left of the canvas.
    const availW = Math.max(360, r.width / scale - pad * 2);
    const clusters = [];
    for (const key of order) {
      const ids = groups.get(key);
      if (!ids || !ids.length) continue;
      let cellW = 0, cellH = 0;
      for (const id of ids) {
        const s = cleanItemSize(id);
        cellW = Math.max(cellW, s.w); cellH = Math.max(cellH, s.h);
      }
      cellW += gap; cellH += gap;
      const cols = Math.max(1, Math.ceil(Math.sqrt(ids.length)));
      const rows = Math.ceil(ids.length / cols);
      clusters.push({ids, cols, cellW, cellH, w: cols * cellW, h: rows * cellH});
    }
    // a stable pseudo-random offset gives the clusters an organic, hand-placed
    // feel rather than a rigid row
    const jitter = (n, amp) =>
      ((Math.sin(n * 12.9898) * 43758.5453 % 1 + 1) % 1 - .5) * 2 * amp;
    const layout = Object.create(null);
    let cx = 0, cy = 0, rowH = 0, ci = 0;
    // the extent of everything placed, so the whole arrangement can be moved
    // onto the middle of the screen once its shape is known
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const cluster of clusters) {
      if (cx > 0 && cx + cluster.w > availW) { cx = 0; cy += rowH + clusterGap; rowH = 0; }
      const baseX = cx + jitter(ci + 1, 22);
      const baseY = cy + jitter(ci + 7, 24) + (ci % 2 ? 26 : 0);
      cluster.ids.forEach((id, k) => {
        const col = k % cluster.cols, row = Math.floor(k / cluster.cols);
        const s = cleanItemSize(id);
        const x = baseX + col * cluster.cellW + (cluster.cellW - gap - s.w) / 2;
        const y = baseY + row * cluster.cellH + (cluster.cellH - gap - s.h) / 2;
        layout[id] = {x, y};
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x + s.w > maxX) maxX = x + s.w;
        if (y + s.h > maxY) maxY = y + s.h;
      });
      cx += cluster.w + clusterGap;
      rowH = Math.max(rowH, cluster.h);
      ci++;
    }
    if (!Number.isFinite(minX)) return layout;
    // centre the arrangement on the world point the viewport is looking at; a
    // group taller or wider than the screen still keeps its middle in view
    const viewX = (-pan.x + r.width / 2) / scale;
    const viewY = (-pan.y + r.height / 2) / scale;
    const shiftX = viewX - (minX + maxX) / 2;
    const shiftY = viewY - (minY + maxY) / 2;
    for (const id in layout) {
      layout[id].x = Math.round(layout[id].x + shiftX);
      layout[id].y = Math.round(layout[id].y + shiftY);
    }
    return layout;
  }
  function applyOrganizedPositions(targetMap) {
    for (const el of layer.querySelectorAll('.project-file')) {
      const t = targetMap[el.dataset.fileId];
      if (!t) continue;
      el.classList.add('organizing');
      el.style.left = t.x + 'px'; el.style.top = t.y + 'px';
    }
    clearTimeout(cleanTimer);
    cleanTimer = setTimeout(() => {
      for (const el of layer.querySelectorAll('.project-file.organizing'))
        el.classList.remove('organizing');
    }, 700);
  }
  function updateCleanButton() {
    const btn = $('proj-btn-clean');
    if (!btn) return;
    btn.textContent = cleanMode ? 'messy' : 'clean';
    btn.classList.toggle('active', cleanMode);
  }
  function enterCleanMode() {
    if (!current || cleanMode || trashOpen || !files.length) return;
    closeContext(); setTool('view');
    // flush any pending real arrangement first, so nothing genuine is lost
    if (positionTimer) { clearTimeout(positionTimer); positionTimer = null; savePositions(); }
    cleanSnapshot = Object.create(null);
    for (const id in positions) cleanSnapshot[id] = {x: positions[id].x, y: positions[id].y};
    const layout = organizeFilesLayout();
    if (snapping) {
      const grid = gridSize();          // tidy onto the current zoom's cell
      for (const id in layout) {
        layout[id].x = snapValue(layout[id].x, grid);
        layout[id].y = snapValue(layout[id].y, grid);
      }
    }
    for (const id in layout)
      if (positions[id]) { positions[id].x = layout[id].x; positions[id].y = layout[id].y; }
    applyOrganizedPositions(layout);
    cleanMode = true; updateCleanButton();
    requestDraw(); scheduleImageLOD();
    say('tidied by type');
  }
  function exitCleanMode(animate = true) {
    if (!cleanMode || !cleanSnapshot) { cleanMode = false; cleanSnapshot = null; updateCleanButton(); return; }
    const restore = Object.create(null);
    for (const id in cleanSnapshot) {
      restore[id] = {x: cleanSnapshot[id].x, y: cleanSnapshot[id].y};
      if (positions[id]) { positions[id].x = cleanSnapshot[id].x; positions[id].y = cleanSnapshot[id].y; }
    }
    if (animate) applyOrganizedPositions(restore);
    cleanMode = false; cleanSnapshot = null; updateCleanButton();
    requestDraw(); scheduleImageLOD();
    if (animate) say('back to your arrangement');
  }
  // used when leaving the canvas or entering the trash: forget the tidy, keeping
  // the original positions the desktop already held
  function resetCleanState() {
    if (cleanMode) exitCleanMode(false);
    else { cleanMode = false; cleanSnapshot = null; updateCleanButton(); }
  }

  // The first deliberate manual move after a tidy adopts the clean arrangement
  // as the new messy layout: the moved item settles on top of the clean
  // positions, everything else keeps its clean spot, and the whole arrangement
  // becomes the persisted messy layout. The pre-clean snapshot is discarded so
  // the move is never undone.
  function convertCleanToMessy() {
    if (!cleanMode) return;
    cleanMode = false; cleanSnapshot = null; updateCleanButton();
  }

  function beginWritingImport() {
    if (!current) return;
    closeImportMenu();
    $('proj-palette').classList.remove('open');
    setTool('view');
    writingReturnProjectId = projectId(current);
    const event = new CustomEvent('archive:project-writing-picker', {
      cancelable: true,
      detail: {projectId: writingReturnProjectId,
        complete: ids => completeWritingImport(ids, writingReturnProjectId),
        cancel: () => cancelWritingImport(true)},
    });
    if (!window.dispatchEvent(event)) return; // Writing accepted the hand-off.
    openWritingPicker();                      // Quiet local fallback.
  }
  async function openWritingPicker() {
    writingSelection.clear();
    const pop = $('project-writing-picker'), list = $('project-writing-list');
    list.innerHTML = '<span class="project-picker-note">reading writing…</span>';
    pop.classList.remove('hidden');
    try {
      const data = await API.documents(), docs = listOf(data, ['documents', 'items']);
      list.innerHTML = '';
      docs.forEach(d => {
        const b = document.createElement('button'); b.type = 'button';
        b.className = 'project-writing-choice'; b.dataset.id = cleanId(d.id);
        b.textContent = d.title || d.name || 'untitled';
        b.addEventListener('click', () => {
          const id = b.dataset.id;
          if (writingSelection.has(id)) writingSelection.delete(id); else writingSelection.add(id);
          b.classList.toggle('selected', writingSelection.has(id));
        });
        list.appendChild(b);
      });
      if (!docs.length) list.innerHTML = '<span class="project-picker-note">no writing found</span>';
    } catch { list.innerHTML = '<span class="project-picker-note">writing could not be read</span>'; }
  }
  function closeWritingPicker() { $('project-writing-picker').classList.add('hidden'); writingSelection.clear(); }
  function cancelWritingImport(returnToProject = false) {
    closeWritingPicker(); view.classList.remove('picking-away');
    if (returnToProject && writingReturnProjectId)
      reopenProjectId = writingReturnProjectId;
  }
  async function completeWritingImport(ids, destinationId = null) {
    const chosen = (ids || [...writingSelection]).map(cleanId).filter(Boolean);
    closeWritingPicker();
    const destination = destinationId || writingReturnProjectId ||
      (current ? projectId(current) : null);
    if (!destination || !chosen.length) return false;
    if (!current || projectId(current) !== destination) reopenProjectId = destination;
    say('placing writing…');
    try {
      const res = await API.importProjectWriting(destination, chosen);
      if (!res || !res.ok) {
        say((res && res.errors && res.errors[0]) ||
          'some writing could not be placed');
        return false;
      }
      if (current && projectId(current) === destination) await reloadCurrent();
      say('writing placed');
    }
    catch { say('writing could not be placed'); return false; }
    return true;
  }

  for (const b of workspace.querySelectorAll('[data-project-tool]')) b.addEventListener('click', () => {
    const t = b.dataset.projectTool;
    if (t === 'picture') beginPictureImport();
    else if (t === 'writing') beginWritingImport();
    else setTool(t);
  });
  for (const b of workspace.querySelectorAll('.proj-brush')) b.addEventListener('click', () => {
    if (brushTool === 'text' && b.dataset.brush !== 'text') commitProjectTextInput();
    brushTool = b.dataset.brush;
    workspace.querySelectorAll('.proj-brush').forEach(o => o.classList.toggle('active', o === b));
  });
  workspace.querySelector('.proj-brush[data-brush="' + brushTool + '"]').classList.add('active');

  function setBrushSize(n) {
    brushSize = Math.max(1, Math.min(10, n));
    const d = 3 + brushSize * 1.4, dot = workspace.querySelector('.proj-brush-dot span');
    dot.style.width = d + 'px'; dot.style.height = d + 'px';
    if (textInput) textInput.input.style.fontSize = Math.max(8,
      textSizeCells() * PixelBrushes.CELL) + 'px';
  }
  $('proj-brush-down').addEventListener('click', () => setBrushSize(brushSize - 1));
  $('proj-brush-up').addEventListener('click', () => setBrushSize(brushSize + 1));
  $('proj-anno-undo').addEventListener('click', () => { annoHistory.undo(); });
  $('proj-anno-clear').addEventListener('click', () => {
    pushUndo(); ink.clear(); wig.clear(); future.clear(); texts = [];
    requestDraw(); scheduleAnnotations();
  });

  PixelBrushes.createHslPicker({
    root: $('proj-palette'), trigger: $('proj-wheel-btn'),
    hue: $('proj-hsl-h'), saturation: $('proj-hsl-s'), lightness: $('proj-hsl-l'),
    preview: $('proj-hsl-preview'), initial: brushColor,
    onChange(color) {
      brushColor = color;
      workspace.querySelector('.proj-brush-dot span').style.background = color;
    },
  });
  setBrushSize(2);

  function hasNativePicker() {
    return !!(window.pywebview && window.pywebview.api &&
      typeof window.pywebview.api.pick_folder === 'function');
  }
  function openFolderBar() { folderError.textContent = ''; folderBar.classList.remove('hidden'); folderInput.focus(); folderInput.select(); }
  function closeFolderBar() { folderBar.classList.add('hidden'); folderError.textContent = ''; }
  async function applyProjectFolder(path, action, setErr) {
    if (!path) return false;
    if (setErr) setErr('linking…');
    try {
      const res = action === 'relink' && current
        ? await API.relinkProjectFolder(projectId(current), path)
        : await API.linkProjectFolder(path);
      if (!res || !res.ok) { if (setErr) setErr((res && res.error) || 'that folder could not be found'); return false; }
      if (action === 'relink' && res.project)
        reopenProjectId = projectId(res.project);
      await refresh(); return true;
    } catch { if (setErr) setErr('could not reach the app'); return false; }
  }
  async function submitFolder() {
    const path = folderInput.value.trim(); if (!path) { closeFolderBar(); return; }
    const action = folderAction || (current ? 'relink' : 'link');
    if (await applyProjectFolder(path, action, t => { folderError.textContent = t; })) {
      closeFolderBar(); folderInput.value = ''; folderAction = null;
    }
  }
  async function chooseProjectFolder(action) {
    if (!hasNativePicker()) {
      folderAction = action;
      folderBar.classList.contains('hidden') ? openFolderBar() : closeFolderBar();
      return false;
    }
    let path = null;
    try { path = await window.pywebview.api.pick_folder(); } catch {}
    if (!path) return false;
    if (!await applyProjectFolder(path, action)) {
      folderAction = action; openFolderBar(); folderInput.value = path;
      folderError.textContent = 'that folder could not be linked';
      return false;
    }
    return true;
  }
  // Inside a project the folder button shows that project's own folder in
  // Explorer/Finder — the folder whose name sits beside the button.
  async function revealProjectFolder() {
    if (!current) return false;
    const nativeOpen = window.pywebview && window.pywebview.api &&
      window.pywebview.api.open_project_folder;
    if (typeof nativeOpen !== 'function') {
      say('showing the folder is available in the desktop app'); return false;
    }
    try {
      const res = await nativeOpen.call(window.pywebview.api, projectId(current));
      if (!res || !res.ok) throw new Error((res && res.error) || 'open failed');
      return true;
    } catch (error) {
      say(error.message && error.message !== 'open failed'
        ? error.message : 'that folder could not be opened');
      return false;
    }
  }
  function chooseFolder() {
    return current ? revealProjectFolder() : chooseProjectFolder('link');
  }
  function updateFolderButton() {
    folderBtn.title = current
      ? 'show this project in your file browser  ·  right-click to link it elsewhere'
      : 'choose the folder that holds your projects';
  }

  // From the index the folder button links the folder the archive reads; from
  // inside a project it opens that project's folder. Relinking a single project
  // keeps its own gesture rather than taking the plain click.
  folderBtn.addEventListener('click', chooseFolder);
  folderBtn.addEventListener('contextmenu', e => {
    e.preventDefault(); e.stopPropagation();
    chooseProjectFolder(current ? 'relink' : 'link');
  });
  $('proj-folder-open').addEventListener('click', submitFolder);
  $('proj-folder-cancel').addEventListener('click', closeFolderBar);
  folderInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') submitFolder(); else if (e.key === 'Escape') closeFolderBar();
  });
  titleButton.addEventListener('dblclick', beginProjectRename);
  titleButton.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); beginProjectRename(); }
  });
  titleInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); commitProjectRename(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancelProjectRename(); }
  });
  titleInput.addEventListener('blur', commitProjectRename);
  createBtn.addEventListener('click', beginProjectCreation);
  createNameInput.addEventListener('input', () => {
    createNameError.textContent = '';
    createName.classList.remove('needs-name');
  });
  createNameInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      commitProjectCreation();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelProjectCreation();
    }
  });
  $('project-import').addEventListener('click', toggleImportMenu);
  importMenu.querySelector('[data-project-import="picture"]')
    .addEventListener('click', beginPictureImport);
  importMenu.querySelector('[data-project-import="writing"]')
    .addEventListener('click', beginWritingImport);
  importMenu.querySelector('[data-project-import="file"]')
    .addEventListener('click', importFilesDirectly);
  $('project-save-canvas').addEventListener('click', saveVisibleProject);
  $('proj-btn-clean').addEventListener('click', () =>
    cleanMode ? exitCleanMode() : enterCleanMode());
  $('proj-btn-snapping').addEventListener('click', toggleSnapping);
  updateSnappingButton();
  $('project-trash-btn').addEventListener('click', () => {
    if (trashOpen) closeTrash(); else openTrash();
  });
  $('project-trash-restore').addEventListener('click', beginTrashSelection);
  $('project-trash-back').addEventListener('click', () => closeTrash());
  $('project-restore').addEventListener('click', restoreChosen);
  document.addEventListener('pointerdown', e => {
    const menu = $('project-context');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) closeContext();
    if (!importMenu.classList.contains('hidden') &&
        !importMenu.contains(e.target) && e.target !== $('project-import'))
      closeImportMenu();
  }, true);
  $('proj-wordmark-link').addEventListener('click', () =>
    About.showFromContext(leaveForAbout));
  backBtn.addEventListener('click', closeProject);
  $('proj-pick-place').addEventListener('click', placePictures);
  $('proj-pick-cancel').addEventListener('click', endPictureImport);
  $('project-writing-place').addEventListener('click', () => completeWritingImport());
  $('project-writing-cancel').addEventListener('click', cancelWritingImport);
  window.addEventListener('resize', () => {
    resizeCanvas();
    if (current) updateLayerTransform();
    if (!open || current || index.classList.contains('hidden')) return;
    // covers keep their world positions; only the pan is re-held to the surround
    updateIndexTransform();
  });
  window.addEventListener('keydown', e => {
    spaceDown = e.code === 'Space' ? true : spaceDown;
    if (!open || !current || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (tool === 'annotate' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      $('proj-anno-undo').click(); e.preventDefault();
    } else if (e.key === '[') setBrushSize(brushSize - 1);
    else if (e.key === ']') setBrushSize(brushSize + 1);
  });
  window.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });

  function handleEscape() {
    if (creatingProject) {
      cancelProjectCreation();
      return true;
    }
    if (picking) { endPictureImport(); return true; }
    if (!$('project-writing-picker').classList.contains('hidden')) { cancelWritingImport(); return true; }
    if (!$('project-context').classList.contains('hidden')) { closeContext(); return true; }
    return closeProject();
  }

  function returnToProject(id) {
    reopenProjectId = cleanId(id);
    if (window.ContextNav) window.ContextNav.go('projects');
  }

  return {enter, leave, refresh, isOpen: () => open, isPicking: () => picking,
    onPhotoPick, beginWritingImport, completeWritingImport, cancelWritingImport,
    returnToProject, handleEscape};
})();
