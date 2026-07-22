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
  const folderName = $('proj-folder-name');
  const folderBar = $('proj-folder-bar');
  const folderInput = $('proj-folder-input');
  const folderError = $('proj-folder-error');
  const empty = $('project-empty');
  const emptyTitle = $('proj-empty-title');
  const emptySub = $('proj-empty-sub');
  const statusEl = $('project-status');
  const backBtn = $('proj-back');
  const titleEl = $('proj-title');
  const annoTools = $('project-annotation-tools');

  let open = false, linked = false, projects = [], current = null;
  let files = [], positions = Object.create(null);
  let pan = {x: 0, y: 0}, pointer = null, spaceDown = false;
  let tool = 'view', brushTool = 'ink', brushSize = 4, brushColor = '#1E43FF';
  let ink = new Map(), wig = new Map(), future = new Map(), undoStack = [];
  let texts = [], nextTextId = 1, textInput = null;
  let positionTimer = null, annoTimer = null, drawPending = false, animTimer = null;
  let contextFile = null, picking = false, pickIds = [];
  let statusTimer = null, writingSelection = new Set();
  let writingReturnProjectId = null, reopenProjectId = null;

  const listOf = (value, names) => {
    if (Array.isArray(value)) return value;
    for (const n of names) if (value && Array.isArray(value[n])) return value[n];
    return [];
  };
  const cleanId = v => String(v == null ? '' : v);
  const fileId = f => cleanId(f.id || f.file_id || f.relative_path || f.name);
  const projectId = p => cleanId(p.id || p.project_id || p.relative_path || p.title);
  const urlFor = (f, preview) => {
    const supplied = preview ? (f.preview_url || f.thumbnail_url) : f.file_url;
    if (supplied) return supplied;
    return preview ? API.projectPreviewUrl(projectId(current), fileId(f))
      : API.projectFileUrl(projectId(current), fileId(f));
  };

  function say(text) {
    clearTimeout(statusTimer);
    statusEl.textContent = text || '';
    statusEl.classList.toggle('show', !!text);
    if (text) statusTimer = setTimeout(() => statusEl.classList.remove('show'), 2400);
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
    }
    open = false;
    closeFolderBar(); closeContext(); closeWritingPicker();
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
    view.classList.remove('workspace-open');
    workspace.classList.add('hidden');
    backBtn.classList.add('hidden');
    titleEl.textContent = '';
    if (!projects.length) {
      showEmpty('no projects yet',
        'each folder placed inside the linked projects folder becomes a project');
      return;
    }
    empty.classList.add('hidden');
    index.classList.remove('hidden');
    index.innerHTML = '';
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
      fallback.textContent = String(p.title || p.name || 'project').slice(0, 1).toLowerCase();
      card.appendChild(fallback);
      const name = document.createElement('span');
      name.className = 'project-cover-title';
      name.textContent = p.title || p.name || 'untitled project';
      card.appendChild(name);
      card.addEventListener('click', () => openProject(p, card));
      index.appendChild(card);
    });
    requestAnimationFrame(() => index.classList.add('here'));
  }

  async function openProject(project, card) {
    if (current) return;
    index.querySelectorAll('.project-cover').forEach(el =>
      el.classList.add(el === card ? 'chosen' : 'leaving'));
    say('opening project…');
    let data;
    try { data = await API.project(projectId(project)); }
    catch { renderIndex(); say('project could not be opened'); return; }
    const detailProject = (data && data.project) || project;
    current = Object.assign({}, project, detailProject);
    files = listOf(data, ['files', 'items']);
    const saved = (data && (data.positions || (data.metadata && data.metadata.positions))) || {};
    positions = Object.create(null);
    files.forEach((f, i) => {
      const id = fileId(f), p = saved[id] || f.position;
      positions[id] = p && Number.isFinite(+p.x) && Number.isFinite(+p.y)
        ? {x: +p.x, y: +p.y} : initialPosition(id, i);
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
    titleEl.textContent = current.title || current.name || 'project';
    backBtn.classList.remove('hidden');
    index.classList.add('hidden');
    index.classList.remove('here');
    workspace.classList.remove('hidden');
    view.classList.add('workspace-open');
    renderFiles();
    resizeCanvas();
    setTool('view');
    say(files.length ? '' : 'this project is waiting for its first material');
  }

  function initialPosition(id, i) {
    let h = 2166136261;
    for (const ch of id) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    const col = i % 4, row = Math.floor(i / 4);
    return {x: 50 + col * 290 + ((h >>> 3) % 34),
            y: 40 + row * 260 + ((h >>> 11) % 28)};
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

  function renderFiles() {
    layer.innerHTML = '';
    updateLayerTransform();
    files.forEach((f, i) => {
      const id = fileId(f), kind = kindOf(f), p = positions[id];
      const el = document.createElement('article');
      el.className = 'project-file project-file-' + kind;
      el.dataset.fileId = id;
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
      el.style.setProperty('--delay', Math.min(i, 14) * 45 + 'ms');
      const media = document.createElement('div');
      media.className = 'project-file-media';
      if (kind === 'image') appendImage(media, f);
      else if (kind === 'video') {
        const v = document.createElement('video'); v.controls = true; v.preload = 'metadata';
        v.src = urlFor(f, false); media.appendChild(v);
      } else if (kind === 'audio') {
        const a = document.createElement('audio'); a.controls = true; a.preload = 'metadata';
        a.src = urlFor(f, false); media.appendChild(a);
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
      caption.textContent = f.name || f.filename || f.relative_path || 'untitled';
      el.append(media, caption);
      el.addEventListener('pointerdown', e => beginFileDrag(e, el, id));
      if (kind === 'image') el.addEventListener('contextmenu', e => openContext(e, f));
      layer.appendChild(el);
    });
    requestAnimationFrame(() => layer.classList.add('here'));
  }

  function appendImage(holder, f) {
    const im = document.createElement('img'); im.alt = '';
    im.src = urlFor(f, true);
    im.addEventListener('error', () => {
      if (im.dataset.fallback) { im.remove(); holder.classList.add('preview-failed'); return; }
      im.dataset.fallback = '1'; im.src = urlFor(f, false);
    });
    holder.appendChild(im);
  }

  function beginFileDrag(e, el, id) {
    if (tool !== 'view' || e.button !== 0 || /^(AUDIO|VIDEO)$/.test(e.target.tagName)) return;
    e.preventDefault(); e.stopPropagation(); closeContext();
    const p = positions[id];
    pointer = {type: 'file', id, el, sx: e.clientX, sy: e.clientY,
               x: p.x, y: p.y, moved: false};
    el.setPointerCapture(e.pointerId); el.classList.add('dragging');
  }

  function closeProject() {
    if (!current) return false;
    commitProjectTextInput();
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
    if (!pointer) return;
    if (pointer.type === 'pan') {
      pan.x = pointer.x + e.clientX - pointer.sx;
      pan.y = pointer.y + e.clientY - pointer.sy; updateLayerTransform();
    } else if (pointer.type === 'file') {
      const dx = e.clientX - pointer.sx, dy = e.clientY - pointer.sy;
      if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
      positions[pointer.id] = {x: pointer.x + dx, y: pointer.y + dy};
      pointer.el.style.left = positions[pointer.id].x + 'px';
      pointer.el.style.top = positions[pointer.id].y + 'px';
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
    if (pointer.type === 'file') { pointer.el.classList.remove('dragging'); schedulePositions(); }
    else if ((pointer.type === 'draw' && brushTool !== 'future') || pointer.type === 'text')
      scheduleAnnotations();
    viewport.classList.remove('panning'); pointer = null;
  });
  window.addEventListener('pointercancel', () => {
    if (pointer && pointer.el) pointer.el.classList.remove('dragging');
    viewport.classList.remove('panning'); pointer = null;
  });

  function openContext(e, file) {
    e.preventDefault(); e.stopPropagation(); contextFile = file;
    const menu = $('project-context');
    menu.style.left = Math.min(e.clientX, innerWidth - 190) + 'px';
    menu.style.top = Math.min(e.clientY, innerHeight - 60) + 'px';
    menu.classList.remove('hidden');
  }
  function closeContext() { $('project-context').classList.add('hidden'); contextFile = null; }
  $('project-use-cover').addEventListener('click', async () => {
    if (!current || !contextFile) return;
    const id = fileId(contextFile); closeContext();
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
    const tray = $('proj-pick-tray'); tray.innerHTML = '';
    pickIds.forEach(id => {
      const im = document.createElement('img'); im.className = 'pick-thumb';
      im.src = '/thumb/' + encodeURIComponent(id) + '.jpg'; im.title = 'remove';
      im.addEventListener('click', () => onPhotoPick(id)); tray.appendChild(im);
    });
    tray.classList.toggle('empty', !pickIds.length);
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

  async function reloadCurrent() {
    if (!current) return;
    const id = projectId(current), oldPositions = positions;
    const data = await API.project(id); files = listOf(data, ['files', 'items']);
    Object.assign(current, data || {});
    const summary = projects.find(p => projectId(p) === id);
    if (summary) Object.assign(summary, data || {});
    const saved = (data && (data.positions || (data.metadata && data.metadata.positions))) || {};
    positions = Object.create(null);
    files.forEach((f, i) => {
      const fid = fileId(f), p = saved[fid] || oldPositions[fid] || f.position;
      positions[fid] = p || initialPosition(fid, i);
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

  const hsl = {h: 226, s: 100, l: 56};
  const hue = $('proj-hsl-h'), sat = $('proj-hsl-s'), lit = $('proj-hsl-l');
  function applyHsl() {
    hsl.h = +hue.value; hsl.s = +sat.value; hsl.l = +lit.value;
    brushColor = PixelBrushes.hslToHex(hsl.h, hsl.s, hsl.l);
    $('proj-hsl-preview').style.background = brushColor;
    const dot = workspace.querySelector('.proj-brush-dot span'); dot.style.background = brushColor;
    sat.style.setProperty('--track', `linear-gradient(90deg,hsl(${hsl.h},0%,60%),hsl(${hsl.h},100%,50%))`);
    lit.style.setProperty('--track', `linear-gradient(90deg,#3a3a38,hsl(${hsl.h},${hsl.s}%,50%),#fafaf7)`);
  }
  [hue, sat, lit].forEach(sl => {
    sl.addEventListener('input', applyHsl);
    sl.addEventListener('pointerdown', e => e.stopPropagation());
  });
  $('proj-wheel-btn').addEventListener('click', () => $('proj-palette').classList.toggle('open'));
  applyHsl(); setBrushSize(2);

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
  backBtn.addEventListener('click', closeProject);
  $('proj-pick-place').addEventListener('click', placePictures);
  $('proj-pick-cancel').addEventListener('click', endPictureImport);
  $('project-writing-place').addEventListener('click', () => completeWritingImport());
  $('project-writing-cancel').addEventListener('click', cancelWritingImport);
  window.addEventListener('resize', resizeCanvas);
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

  return {enter, leave, refresh, isOpen: () => open, isPicking: () => picking,
    onPhotoPick, beginWritingImport, completeWritingImport, cancelWritingImport,
    handleEscape};
})();
