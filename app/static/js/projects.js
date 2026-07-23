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

  let open = false, linked = false, projects = [], current = null;
  let files = [], positions = Object.create(null), maxZ = 0;
  let coverPositions = Object.create(null), coverMaxZ = 0, coverPointer = null;
  let pan = {x: 0, y: 0}, pointer = null, spaceDown = false;
  let tool = 'view', brushTool = 'ink', brushSize = 4, brushColor = '#1E43FF';
  let ink = new Map(), wig = new Map(), future = new Map(), undoStack = [];
  let texts = [], nextTextId = 1, textInput = null;
  let positionTimer = null, coverTimer = null, annoTimer = null;
  let drawPending = false, animTimer = null;
  let picking = false, pickIds = [];
  // the project's trash: material taken off the canvas, never off the disk
  let trashOpen = false, trashFiles = [], trashPositions = Object.create(null);
  // choosing only begins once "restore" is pressed, so the trash can be looked
  // through without any risk of picking things up by accident
  let trashSelecting = false, trashSelection = new Set();
  let statusTimer = null, writingSelection = new Set();
  let writingReturnProjectId = null, reopenProjectId = null;
  let contextTarget = null, savingCanvas = false;
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
      save.textContent = 'save'; save.setAttribute('aria-label', 'save visible project canvas as JPEG');
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
    addMenuButton('project-delete-element', 'delete from project');
    addMenuButton('project-delete-project', 'delete project');
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
    commitProjectTextInput();
    if (current) {
      clearTimeout(positionTimer); savePositions();
      clearTimeout(annoTimer); saveAnnotations();
    } else {
      clearTimeout(coverTimer); saveCoverPositions();
    }
    open = false;
    closeFolderBar(); closeContext(); closeWritingPicker();
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
      showEmpty('no folder linked',
        'use <button class="link-btn" id="proj-empty-folder-btn">folder</button> ' +
        'in the top-left corner to choose the folder<br>that holds your projects');
      bindEmptyFolder();
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

  function renderIndex() {
    current = null;
    showProjectTitle();
    view.classList.remove('workspace-open');
    workspace.classList.add('hidden');
    backBtn.classList.add('hidden');
    folderControls.classList.remove('hidden');
    $('proj-wordmark-link').classList.remove('hidden');
    if (!projects.length) {
      showEmpty('no projects yet',
        'each folder placed inside the linked projects folder becomes a project');
      return;
    }
    empty.classList.add('hidden');
    index.classList.remove('hidden');
    index.classList.remove('leaving-for-about');
    index.innerHTML = '';
    let layoutChanged = false;
    projects.forEach((p, i) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'project-cover';
      card.dataset.projectId = projectId(p);
      card.style.setProperty('--delay', Math.min(i, 12) * 35 + 'ms');
      const cover = projectCover(p);
      if (cover) {
        const im = document.createElement('img');
        im.alt = '';
        im.src = cover;
        im.addEventListener('error', () => im.remove(), {once: true});
        card.appendChild(im);
      }
      const fallback = document.createElement('span');
      fallback.className = 'project-cover-fallback';
      fallback.setAttribute('aria-hidden', 'true');
      fallback.textContent = String(p.title || p.name || 'project').slice(0, 1).toLowerCase();
      card.appendChild(fallback);
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
      index.appendChild(card);
      let pos = coverPositions[projectId(p)];
      if (!pos) {
        pos = initialCoverPosition(i, card.offsetWidth || 200);
        pos.z = ++coverMaxZ; coverPositions[projectId(p)] = pos;
        layoutChanged = true;
      }
      const bounded = boundedCoverPosition(pos.x, pos.y, card);
      if (bounded.x !== pos.x || bounded.y !== pos.y) layoutChanged = true;
      pos.x = bounded.x; pos.y = bounded.y;
      card.style.left = pos.x + 'px'; card.style.top = pos.y + 'px';
      card.style.zIndex = String(pos.z || 0);
    });
    const spacer = document.createElement('span');
    spacer.className = 'project-index-spacer';
    const firstCard = index.querySelector('.project-cover');
    spacer.style.top = coverCanvasHeight(firstCard) + 'px';
    index.appendChild(spacer);
    if (layoutChanged) scheduleCoverPositions();
    requestAnimationFrame(() => index.classList.add('here'));
  }

  function initialCoverPosition(i, width) {
    const gap = Math.max(22, Math.min(54, index.clientWidth * .035));
    const cols = Math.max(1, Math.floor((index.clientWidth + gap) / (width + gap)));
    const used = Math.min(projects.length, cols) * width + (Math.min(projects.length, cols) - 1) * gap;
    const start = Math.max(0, (index.clientWidth - used) / 2);
    return {x: start + (i % cols) * (width + gap),
      y: 22 + Math.floor(i / cols) * (width + gap)};
  }

  function boundedCoverPosition(x, y, card) {
    const pad = 3, maxX = Math.max(pad, index.clientWidth - card.offsetWidth - pad);
    const maxY = Math.max(pad, coverCanvasHeight(card) - card.offsetHeight - pad);
    return {x: Math.max(pad, Math.min(maxX, x)),
      y: Math.max(pad, Math.min(maxY, y))};
  }

  function coverCanvasHeight(card) {
    const width = card ? (card.offsetWidth || 200) : 200;
    const gap = Math.max(22, Math.min(54, index.clientWidth * .035));
    const cols = Math.max(1, Math.floor((index.clientWidth + gap) / (width + gap)));
    const rows = Math.ceil(Math.max(1, projects.length) / cols);
    return Math.max(index.clientHeight, 44 + rows * width + Math.max(0, rows - 1) * gap);
  }

  function beginCoverDrag(e, card, id) {
    if (e.button !== 0 || current) return;
    const pos = coverPositions[id];
    if (!pos) return;
    coverPointer = {id, card, pointerId: e.pointerId, sx: e.clientX, sy: e.clientY,
      x: pos.x, y: pos.y, moved: false};
    card.setPointerCapture(e.pointerId);
  }

  function moveCover(e) {
    if (!coverPointer || e.pointerId !== coverPointer.pointerId) return;
    const dx = e.clientX - coverPointer.sx, dy = e.clientY - coverPointer.sy;
    if (!coverPointer.moved && Math.hypot(dx, dy) < 6) return;
    e.preventDefault();
    if (!coverPointer.moved) {
      coverPointer.moved = true; coverPointer.card.classList.add('dragging');
      const pos = coverPositions[coverPointer.id];
      pos.z = ++coverMaxZ; coverPointer.card.style.zIndex = String(pos.z);
      if (coverMaxZ > 90000) normalizeCoverStack();
    }
    const bounded = boundedCoverPosition(
      coverPointer.x + dx, coverPointer.y + dy, coverPointer.card);
    Object.assign(coverPositions[coverPointer.id], bounded);
    coverPointer.card.style.left = bounded.x + 'px';
    coverPointer.card.style.top = bounded.y + 'px';
  }

  function endCoverDrag(e) {
    if (!coverPointer || e.pointerId !== coverPointer.pointerId) return;
    const {card, moved} = coverPointer;
    card.classList.remove('dragging'); coverPointer = null;
    if (moved) {
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
    ink = maps.ink; wig = maps.wig; future = new Map(); undoStack = [];
    texts = Array.isArray(annotationData.texts)
      ? annotationData.texts.filter(t => t && typeof t.str === 'string').map(t => ({
          id: nextTextId++, str: t.str, x: +t.x || 0, y: +t.y || 0,
          size: +t.size || 27, color: t.color || '#3A3A38',
        })) : [];
    pan = {x: 70, y: 95};
    backBtn.classList.remove('hidden');
    folderControls.classList.add('hidden');
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

  function kindOf(f) {
    const kind = String(f.kind || f.type || '').toLowerCase();
    const ext = String(f.extension || f.ext || f.name || '').split('.').pop().toLowerCase();
    if (kind === 'document' && ext === 'txt') return 'text';
    if (kind) return kind;
    if (/^(jpe?g|png|tiff?|psd|gif|bmp|webp)$/.test(ext)) return 'image';
    if (/^(mp3|wav)$/.test(ext)) return 'audio';
    if (/^(mp4|mov)$/.test(ext)) return 'video';
    if (ext === 'txt') return 'text';
    if (/^(pdf|docx)$/.test(ext)) return 'document';
    return 'file';
  }

  // The trash is drawn as another project canvas, so both use one renderer:
  // only what a card responds to differs (arranging vs. choosing).
  const activeFiles = () => trashOpen ? trashFiles : files;
  const activePositions = () => trashOpen ? trashPositions : positions;

  function renderFiles() {
    documentPreviewObserver.disconnect();
    layer.innerHTML = '';
    updateLayerTransform();
    activeFiles().forEach((f, i) => {
      const id = fileId(f), kind = kindOf(f), p = activePositions()[id];
      const el = document.createElement('article');
      el.className = 'project-file project-file-' + kind;
      el.dataset.fileId = id;
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      el.style.zIndex = String(p.z || 0);
      if (Number.isFinite(p.width)) el.style.width = p.width + 'px';
      el.style.setProperty('--delay', Math.min(i, 14) * 45 + 'ms');
      const media = document.createElement('div');
      media.className = 'project-file-media';
      if (Number.isFinite(p.height)) media.style.height = p.height + 'px';
      if (kind === 'image') appendImage(media, f);
      else if (kind === 'video') {
        const v = document.createElement('video'); v.controls = true; v.preload = 'metadata';
        v.src = urlFor(f, false); media.appendChild(v);
      } else if (kind === 'audio') {
        const fullTitle = f.name || f.filename || f.relative_path || 'untitled audio';
        const trackTitle = document.createElement('span');
        trackTitle.className = 'project-audio-title';
        trackTitle.textContent = fullTitle.replace(/\.[^.]+$/, '');
        trackTitle.title = fullTitle;
        const a = document.createElement('audio'); a.controls = true; a.preload = 'metadata';
        a.src = urlFor(f, false); a.setAttribute('aria-label', fullTitle);
        media.append(trackTitle, a);
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
      }
      const caption = document.createElement('div'); caption.className = 'project-file-name';
      caption.textContent = displayName(f);
      const resize = document.createElement('button');
      resize.type = 'button'; resize.className = 'project-asset-handle project-resize-handle';
      resize.title = 'resize'; resize.setAttribute('aria-label', 'resize ' + caption.textContent);
      if (!trashOpen)
        resize.addEventListener('pointerdown', e => beginFileResize(e, el, media, id, kind));
      media.appendChild(resize);
      el.append(media, caption);
      // Image presentation needs the real layout dimensions. Applying it while
      // detached can preserve a stale aspect-ratio box after a quarter turn.
      layer.appendChild(el);
      applyAssetPresentation(el, media, p, kind);
      if (trashOpen) {
        // in the trash a card is chosen, not arranged — and only once
        // "restore" has asked for a choice. A chosen card washes out.
        el.classList.add('trashed');
        el.classList.toggle('chosen', trashSelection.has(id));
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.setAttribute('aria-pressed', trashSelection.has(id) ? 'true' : 'false');
        const toggle = () => { if (trashSelecting) toggleTrashSelection(id, el); };
        el.addEventListener('click', toggle);
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
        });
        return;
      }
      el.addEventListener('pointerdown', e => beginFileDrag(e, el, id));
      if ((kind === 'text' || kind === 'document') && f.document) {
        el.tabIndex = 0; el.setAttribute('role', 'button');
        el.setAttribute('aria-label', 'open ' + caption.textContent);
        el.addEventListener('click', e => {
          if (performance.now() < +(el.dataset.suppressOpenUntil || 0)) {
            e.preventDefault(); return;
          }
          openProjectDocument(f);
        });
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault(); openProjectDocument(f);
          }
        });
      }
      el.addEventListener('contextmenu', e => openContext(e, f));
    });
    requestAnimationFrame(() => layer.classList.add('here'));
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

  function appendImage(holder, f) {
    const im = document.createElement('img'); im.alt = '';
    holder.style.aspectRatio = '4 / 3';
    im.src = urlFor(f, true);
    im.addEventListener('load', () => {
      if (!holder.style.height && im.naturalWidth && im.naturalHeight)
        holder.style.aspectRatio = `${im.naturalWidth} / ${im.naturalHeight}`;
      const el = holder.closest('.project-file');
      const id = el && el.dataset.fileId;
      if (el && id && positions[id])
        applyAssetPresentation(el, holder, positions[id], 'image');
    });
    im.addEventListener('error', () => {
      if (im.dataset.fallback) { im.remove(); holder.classList.add('preview-failed'); return; }
      im.dataset.fallback = '1'; im.src = urlFor(f, false);
    });
    holder.appendChild(im);
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
      schedulePositions();
      setTimeout(() => el.classList.remove('rotating'), 380);
    }, 120);
  }

  function isMediaControl(target) {
    return !!(target && target.closest &&
      target.closest('audio, video, button, input, select, textarea, a'));
  }

  function bringToFront(id, el) {
    const p = positions[id];
    if (!p) return;
    p.z = ++maxZ; el.style.zIndex = String(p.z);
    if (maxZ > 90000) normalizeStack();
  }

  function normalizeStack() {
    const ordered = files.map((f, index) => ({id: fileId(f), index}))
      .filter(item => positions[item.id])
      .sort((a, b) => (positions[a.id].z || 0) - (positions[b.id].z || 0) ||
        a.index - b.index);
    ordered.forEach((item, index) => {
      positions[item.id].z = index + 1;
      const el = [...layer.querySelectorAll('.project-file')]
        .find(node => node.dataset.fileId === item.id);
      if (el) el.style.zIndex = String(index + 1);
    });
    maxZ = ordered.length;
  }

  function beginFileDrag(e, el, id) {
    if (tool !== 'view' || e.button !== 0 || isMediaControl(e.target) ||
        e.target.closest('.project-resize-handle')) return;
    e.preventDefault(); e.stopPropagation(); closeContext();
    const p = positions[id];
    bringToFront(id, el);
    pointer = {type: 'file', id, el, sx: e.clientX, sy: e.clientY,
               x: p.x, y: p.y, moved: false};
    el.setPointerCapture(e.pointerId); el.classList.add('dragging');
  }

  function beginFileResize(e, el, media, id, kind) {
    if (tool !== 'view' || e.button !== 0) return;
    e.preventDefault(); e.stopPropagation(); closeContext();
    const p = positions[id];
    const width = Number.isFinite(p.width) ? p.width : media.clientWidth;
    const height = Number.isFinite(p.height) ? p.height : media.clientHeight;
    bringToFront(id, el);
    pointer = {type: 'resize', id, el, media, kind, sx: e.clientX, sy: e.clientY,
      width, height};
    e.currentTarget.setPointerCapture(e.pointerId);
    el.classList.add('resizing');
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
    trashFiles.forEach((f, i) => {
      const id = fileId(f), p = f.position;
      trashPositions[id] = (p && Number.isFinite(+p.x) && Number.isFinite(+p.y))
        ? {x: +p.x, y: +p.y, z: ++z,
           ...(Number.isFinite(+p.width) ? {width: +p.width} : {}),
           ...(Number.isFinite(+p.height) ? {height: +p.height} : {}),
           ...(Number.isFinite(+p.rotation) ? {rotation: +p.rotation} : {})}
        : initialPosition(id, i, ++z);
    });
  }

  async function openTrash() {
    if (!current || trashOpen) return;
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
    trashOpen = false; trashSelecting = false;
    trashSelection = new Set();
    trashFiles = []; trashPositions = Object.create(null);
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
    commitProjectTextInput();
    closeTrash({redraw: false});   // the trash belongs to the project we are leaving
    clearTimeout(positionTimer); savePositions();
    clearTimeout(annoTimer); saveAnnotations();
    current = null; files = []; layer.classList.remove('here');
    workspace.classList.add('hidden');
    view.classList.remove('workspace-open');
    renderIndex();
    return true;
  }

  function updateLayerTransform() {
    layer.style.transform = `translate(${pan.x}px, ${pan.y}px)`;
    requestDraw();
  }

  function schedulePositions() {
    clearTimeout(positionTimer);
    positionTimer = setTimeout(savePositions, 260);
  }
  async function savePositions() {
    if (!current) return;
    try {
      const res = await API.saveProjectPositions(projectId(current), positions);
      if (!res || !res.ok) throw new Error('save failed');
      say('saved');
    }
    catch { say('positions will save when the folder is available'); }
  }

  function setTool(next) {
    if (!/^(view|annotate)$/.test(next)) return;
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
    if (drawPending || !current) return;
    drawPending = true;
    requestAnimationFrame(drawAnnotations);
  }
  function drawAnnotations(now) {
    drawPending = false;
    if (!current) return;
    const r = viewport.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, r.width, r.height);
    const brushView = {toScreen: (x, y) => [x + pan.x, y + pan.y], scale: 1,
      width: r.width, height: r.height, now: now || performance.now()};
    PixelBrushes.paintInk(ctx, ink, brushView);
    drawProjectTexts(brushView);
    const animated = PixelBrushes.paintWiggly(ctx, wig, brushView) |
      PixelBrushes.paintFuture(ctx, future, brushView);
    clearTimeout(animTimer);
    if (animated) animTimer = setTimeout(requestDraw, 125);
  }

  const worldPoint = e => {
    const r = viewport.getBoundingClientRect();
    return [e.clientX - r.left - pan.x, e.clientY - r.top - pan.y];
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
  function pushUndo() {
    undoStack.push(annotationSnapshot());
    if (undoStack.length > 80) undoStack.shift();
  }
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

  viewport.addEventListener('pointerdown', e => {
    closeContext();
    if (tool === 'view' && e.button === 0 && !spaceDown) {
      const world = worldPoint(e), text = textAt(world[0], world[1]);
      if (text) {
        e.preventDefault(); pushUndo();
        pointer = {type: 'text', text, start: world,
          fromX: text.x, fromY: text.y};
        viewport.setPointerCapture(e.pointerId);
        return;
      }
    }
    const panGesture = tool === 'view' || e.button === 1 || spaceDown;
    if (panGesture) {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      pointer = {type: 'pan', sx: e.clientX, sy: e.clientY, x: pan.x, y: pan.y};
      viewport.setPointerCapture(e.pointerId); viewport.classList.add('panning');
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
  window.addEventListener('pointermove', e => {
    moveCover(e);
    if (!pointer) return;
    if (pointer.type === 'pan') {
      pan.x = pointer.x + e.clientX - pointer.sx;
      pan.y = pointer.y + e.clientY - pointer.sy; updateLayerTransform();
    } else if (pointer.type === 'file') {
      const dx = e.clientX - pointer.sx, dy = e.clientY - pointer.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
      positions[pointer.id].x = pointer.x + dx;
      positions[pointer.id].y = pointer.y + dy;
      pointer.el.style.left = positions[pointer.id].x + 'px';
      pointer.el.style.top = positions[pointer.id].y + 'px';
    } else if (pointer.type === 'resize') {
      const dx = e.clientX - pointer.sx, dy = e.clientY - pointer.sy;
      const limits = pointer.kind === 'audio'
        ? {minW: 170, minH: 40, maxW: 560, maxH: 180}
        : {minW: 120, minH: 80, maxW: 1400, maxH: 1100};
      let width = Math.max(limits.minW, Math.min(limits.maxW, pointer.width + dx));
      let height = Math.max(limits.minH, Math.min(limits.maxH, pointer.height + dy));
      if (pointer.kind === 'image' || pointer.kind === 'video') {
        // Project the pointer movement onto the element's diagonal. Unlike
        // switching between horizontal and vertical deltas, this produces one
        // continuous scale value and cannot jump as the pointer crosses axes.
        const denominator = pointer.width * pointer.width + pointer.height * pointer.height;
        let scale = 1 + (dx * pointer.width + dy * pointer.height) /
          Math.max(1, denominator);
        const minScale = Math.max(limits.minW / pointer.width,
          limits.minH / pointer.height);
        const maxScale = Math.min(limits.maxW / pointer.width,
          limits.maxH / pointer.height);
        scale = Math.max(minScale, Math.min(maxScale, scale));
        width = pointer.width * scale;
        height = pointer.height * scale;
      }
      positions[pointer.id].width = Math.round(width * 10) / 10;
      positions[pointer.id].height = Math.round(height * 10) / 10;
      applyAssetPresentation(pointer.el, pointer.media,
        positions[pointer.id], pointer.kind);
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
  window.addEventListener('pointerup', () => {
    if (!pointer) return;
    if (pointer.type === 'file') {
      pointer.el.classList.remove('dragging');
      if (pointer.moved)
        pointer.el.dataset.suppressOpenUntil = String(performance.now() + 400);
      schedulePositions();
    } else if (pointer.type === 'resize') {
      pointer.el.classList.remove('resizing'); schedulePositions();
    }
    else if ((pointer.type === 'draw' && brushTool !== 'future') || pointer.type === 'text')
      scheduleAnnotations();
    viewport.classList.remove('panning'); pointer = null;
  });
  window.addEventListener('pointerup', endCoverDrag);
  window.addEventListener('pointercancel', () => {
    if (pointer && pointer.el) pointer.el.classList.remove('dragging', 'resizing');
    viewport.classList.remove('panning'); pointer = null;
  });
  window.addEventListener('pointercancel', endCoverDrag);

  function openContext(e, file) {
    e.preventDefault(); e.stopPropagation();
    contextTarget = {type: 'file', file};
    const menu = $('project-context');
    menu.style.left = Math.max(12, Math.min(e.clientX, innerWidth - 372)) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - 150) + 'px';
    configureContextMenu();
    menu.classList.remove('hidden');
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
  $('project-delete-element').addEventListener('click', e => {
    if (!current || !contextTarget || contextTarget.type !== 'file') return;
    const project = projectId(current), id = fileId(contextTarget.file);
    // name it the way the card does, so the question matches what is on screen
    const name = displayName(contextTarget.file);
    confirmContextAction(e.currentTarget,
      `are you sure you want to delete ${name}?`, async () => {
      say('deleting material…');
      try {
        const res = await API.deleteProjectFile(project, id);
        if (!res || !res.ok) throw new Error((res && res.error) || 'delete failed');
        delete positions[id];
        files = files.filter(f => fileId(f) !== id);
        Object.assign(current, res.project || {});
        const summary = projects.find(p => projectId(p) === project);
        if (summary && res.project) Object.assign(summary, res.project);
        renderFiles(); say('material deleted');
      } catch (error) { say(error.message || 'material could not be deleted'); }
    });
  });
  $('project-delete-project').addEventListener('click', e => {
    if (!contextTarget || contextTarget.type !== 'project') return;
    const id = projectId(contextTarget.project);
    const name = contextTarget.project.title || contextTarget.project.name || 'this';
    confirmContextAction(e.currentTarget,
      `are you sure you want to delete ${name} project?`, async () => {
      say('deleting project…');
      try {
        const res = await API.deleteProject(id);
        if (!res || !res.ok) throw new Error((res && res.error) || 'delete failed');
        projects = projects.filter(p => projectId(p) !== id);
        delete coverPositions[id]; renderIndex(); say('project deleted');
      } catch (error) { say(error.message || 'project could not be deleted'); }
    });
  });

  function beginPictureImport() {
    if (!current || picking) return;
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
      const dataUrl = await composeVisibleProject();
      const res = await API.saveProjectSnapshot(projectId(current), dataUrl);
      if (!res || !res.ok) throw new Error((res && res.error) || 'save failed');
      say('project canvas saved to downloads');
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

  function beginWritingImport() {
    if (!current) return;
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
  workspace.querySelector('.proj-brush[data-brush="ink"]').classList.add('active');

  function setBrushSize(n) {
    brushSize = Math.max(1, Math.min(10, n));
    const d = 3 + brushSize * 1.4, dot = workspace.querySelector('.proj-brush-dot span');
    dot.style.width = d + 'px'; dot.style.height = d + 'px';
    if (textInput) textInput.input.style.fontSize = Math.max(8,
      textSizeCells() * PixelBrushes.CELL) + 'px';
  }
  $('proj-brush-down').addEventListener('click', () => setBrushSize(brushSize - 1));
  $('proj-brush-up').addEventListener('click', () => setBrushSize(brushSize + 1));
  $('proj-anno-undo').addEventListener('click', () => {
    const s = undoStack.pop(); if (!s) return; restoreSnapshot(s); scheduleAnnotations();
  });
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
  async function linkFolder(path, setErr) {
    if (!path) return false;
    if (setErr) setErr('linking…');
    try {
      const res = await API.setProjectRoot(path);
      if (!res || !res.ok) { if (setErr) setErr((res && res.error) || 'that folder could not be found'); return false; }
      await refresh(); return true;
    } catch { if (setErr) setErr('could not reach the app'); return false; }
  }
  async function submitFolder() {
    const path = folderInput.value.trim(); if (!path) { closeFolderBar(); return; }
    if (await linkFolder(path, t => { folderError.textContent = t; })) { closeFolderBar(); folderInput.value = ''; }
  }
  async function chooseFolder() {
    if (!hasNativePicker()) {
      folderBar.classList.contains('hidden') ? openFolderBar() : closeFolderBar(); return;
    }
    let path = null;
    try { path = await window.pywebview.api.pick_folder(); } catch {}
    if (!path) return;
    if (!await linkFolder(path)) { openFolderBar(); folderInput.value = path; folderError.textContent = 'that folder could not be linked'; }
  }

  folderBtn.addEventListener('click', chooseFolder);
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
  $('project-import').addEventListener('click', importFilesDirectly);
  $('project-save-canvas').addEventListener('click', saveVisibleProject);
  $('project-trash-btn').addEventListener('click', () => {
    if (trashOpen) closeTrash(); else openTrash();
  });
  $('project-trash-restore').addEventListener('click', beginTrashSelection);
  $('project-trash-back').addEventListener('click', () => closeTrash());
  $('project-restore').addEventListener('click', restoreChosen);
  document.addEventListener('pointerdown', e => {
    const menu = $('project-context');
    if (!menu.classList.contains('hidden') && !menu.contains(e.target)) closeContext();
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
    if (!open || current || index.classList.contains('hidden')) return;
    let changed = false;
    for (const card of index.querySelectorAll('.project-cover')) {
      const pos = coverPositions[card.dataset.projectId];
      if (!pos) continue;
      const bounded = boundedCoverPosition(pos.x, pos.y, card);
      if (bounded.x !== pos.x || bounded.y !== pos.y) changed = true;
      Object.assign(pos, bounded);
      card.style.left = pos.x + 'px'; card.style.top = pos.y + 'px';
    }
    const spacer = index.querySelector('.project-index-spacer');
    const firstCard = index.querySelector('.project-cover');
    if (spacer) spacer.style.top = coverCanvasHeight(firstCard) + 'px';
    if (changed) scheduleCoverPositions();
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
