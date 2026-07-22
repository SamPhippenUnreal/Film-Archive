/* ————————————————————————————————————————————————
   the inspection table: one photograph, notes, marks
   ———————————————————————————————————————————————— */

const Detail = (() => {
  const view = document.getElementById('detail-view');
  const canvas = document.getElementById('detail-canvas');
  const ctx = canvas.getContext('2d');

  // Photograph and writing annotations execute the same brush code. Colours are
  // resolved through PixelBrushes.colorOf, which accepts this editor's free hex
  // values as well as the legacy palette indexes still on older saved marks.
  const {CELL} = PixelBrushes;
  const WORLD_W = 1000;                    // photo width in workspace units
  const MARGIN = 0.85;                     // drawable margin around the photo

  let photo = null, meta = null;
  let folderMeta = {camera: '', film: ''};
  let imgFull = null, imgThumb = null, imgReady = false;
  let worldH = 700;

  // camera (world point at screen centre, scale = px per unit)
  const cam = {x: 0, y: 0, s: 1};
  const goal = {x: 0, y: 0, s: 1};

  // annotation state
  let ink = new Map();        // "x,y" -> colorIndex (persistent)
  let wig = new Map();        // "x,y" -> colorIndex (persistent, boiling)
  let wigTimer = null;        // the slow heartbeat of the wiggly marks
  let texts = [];             // {id, str, x, y, size, color} — movable notes
  let nextTextId = 1;
  let future = new Map();     // "x,y" -> {t, c}     (session, decaying)
  let undoStack = [];
  let tool = 'view';
  let color = '#1E43FF';      // brush colour as a literal hex (free HSL choice)
  const hsl = {h: 226, s: 100, l: 56};   // the picker's live H/S/L state
  let brush = 4;              // radius in cells (1..10); 1 is a single cell
  let bwMode = false;         // view the photograph in black & white
  let dirty = false;          // unsaved ink changes
  let saveTimer = null;

  let dpr = 1, W = 0, H = 0, rafPending = false, open = false;
  let onBack = null, onMetaSaved = null;
  let seq = [], seqPos = -1;   // the wall's current order, for the arrows
  let lastMouse = {x: 0, y: 0};
  let sizePreviewUntil = 0;

  /* ——— lifecycle ——— */

  async function show(photoId) {
    const d = await API.photo(photoId);
    photo = d.photo; meta = d.meta;
    folderMeta = d.folder_meta || {camera: '', film: ''};
    worldH = WORLD_W * (photo.height || 2) / (photo.width || 3);

    ink = new Map();
    wig = new Map();
    texts = [];
    const a = d.annotations;
    if (a) {
      // older marks may live on a coarser grid — remap them onto this one
      const factor = (a.cellSize || CELL) / CELL;
      const f = v => Math.round(v * factor);
      if (a.cells)
        for (const [x, y, c] of a.cells) ink.set(f(x) + ',' + f(y), c);
      if (a.wiggly)
        for (const [x, y, c] of a.wiggly) wig.set(f(x) + ',' + f(y), c);
      if (a.texts)
        for (const t of a.texts)
          texts.push({id: nextTextId++, str: t.str, x: f(t.x), y: f(t.y),
                      size: Math.max(6, f(t.size)), color: t.color || 0});
    }
    future = new Map();
    undoStack = [];
    dirty = false;
    setTool('view');
    // the photograph keeps its last turn and its b/w here — never the wall
    bwMode = !!(a && a.bw);
    bwBtn.classList.toggle('active', bwMode);
    rot = a && a.rot ? ((a.rot % 4) + 4) % 4 : 0;
    seqPos = seq.indexOf(photoId);
    navPrev.classList.toggle('hidden', seqPos <= 0);
    navNext.classList.toggle('hidden',
      seqPos < 0 || seqPos >= seq.length - 1);

    // images: thumb immediately, full resolution when it arrives
    imgReady = false;
    imgThumb = new Image();
    imgThumb.src = '/thumb/' + photo.id + '.jpg';
    imgThumb.onload = requestDraw;
    imgFull = new Image();
    imgFull.onload = () => { imgReady = true; requestDraw(); };
    imgFull.src = '/image/' + photo.id;

    fillNotesPanel();
    refreshAllTags();
    view.classList.remove('hidden');
    // now the panel has layout — size the title for real (fillNotesPanel ran
    // while the view was still display:none, so it could not measure). Done
    // synchronously so a long title never flashes clipped to a single line,
    // and again after the fade in case first layout was still settling.
    sizeTitle();
    view.classList.add('fading');
    // a timer, not rAF: rAF is suspended while the window is hidden, which
    // would leave the workspace stuck invisible at opacity 0
    setTimeout(() => {
      view.classList.remove('fading');
      sizeTitle();
    }, 20);
    open = true;
    resize();
    fitPhoto(false);
    requestDraw();
  }

  function close() {
    commitTextInput();
    flushMeta();
    flushFolderMeta();
    flushInk(true);
    open = false;
    clearTimeout(wigTimer);
    wigTimer = null;
    view.classList.add('fading');
    setTimeout(() => { view.classList.add('hidden'); }, 400);
    imgFull = null; imgThumb = null;
    if (onBack) onBack();
  }

  function fitPhoto(animate = true) {
    if (W < 560 || H < 220) return;   // minimised / hidden window
    const rw = rot % 2 ? worldH : WORLD_W;   // bounds as displayed
    const rh = rot % 2 ? WORLD_W : worldH;
    const fit = Math.min(
      (W - 510) / rw,               // leave air for the notes column
      (H - 170) / rh
    ) * 0.96;
    // camera centre sits right of the photo centre, so the photo
    // rests left of the notes column
    goal.x = WORLD_W / 2 + 172 / fit;
    goal.y = worldH / 2;
    goal.s = fit;
    if (!animate) { cam.x = goal.x; cam.y = goal.y; cam.s = goal.s; }
  }

  /* ——— coordinates ——— */

  let rot = 0;   // quarter turns of the photograph (view-only, not saved)

  // rotation about the photo centre; marks stay glued to the photograph
  function rotW(wx, wy) {
    const dx = wx - WORLD_W / 2, dy = wy - worldH / 2;
    if (rot === 1) return [WORLD_W / 2 - dy, worldH / 2 + dx];
    if (rot === 2) return [WORLD_W / 2 - dx, worldH / 2 - dy];
    if (rot === 3) return [WORLD_W / 2 + dy, worldH / 2 - dx];
    return [wx, wy];
  }
  function unrotW(x, y) {
    const dx = x - WORLD_W / 2, dy = y - worldH / 2;
    if (rot === 1) return [WORLD_W / 2 + dy, worldH / 2 - dx];
    if (rot === 2) return [WORLD_W / 2 - dx, worldH / 2 - dy];
    if (rot === 3) return [WORLD_W / 2 - dy, worldH / 2 + dx];
    return [x, y];
  }

  const toScreen = (wx, wy) => {
    const [rx, ry] = rotW(wx, wy);
    return [(rx - cam.x) * cam.s + W / 2, (ry - cam.y) * cam.s + H / 2];
  };
  const toWorld = (sx, sy) =>
    unrotW((sx - W / 2) / cam.s + cam.x, (sy - H / 2) / cam.s + cam.y);

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    requestDraw();
  }

  /* ——— rendering ——— */

  function requestDraw() {
    if (rafPending || !open) return;
    rafPending = true;
    requestAnimationFrame(draw);
  }

  // Black & white in the detail view greys only the photograph (the coloured
  // marks stay coloured), so it is applied to the image as it is drawn.
  //
  // We render it by drawing a pre-greyed copy of the image rather than using
  // CanvasRenderingContext2D.filter = 'grayscale(1)'. That property is unusable
  // on macOS: older WebKit doesn't support it at all, and some versions accept
  // it (so feature-detecting the property passes) yet silently ignore it when
  // drawing — the photo stays in colour. The manual copy below works
  // identically on every WebView, so it is the single code path.
  //
  // A grey copy of an image, built once and cached on the image itself. Uses
  // the Rec.709 luma weights of the CSS grayscale(1) filter so it matches the
  // greyscale on the wall. Same-origin images (served by our local server) are
  // never tainted; guard anyway.
  function greyVersion(img) {
    if (!img || !img.naturalWidth) return null;
    if (img._greyCanvas && img._greyW === img.naturalWidth)
      return img._greyCanvas;
    const w = img.naturalWidth, h = img.naturalHeight;
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const octx = off.getContext('2d');
    octx.drawImage(img, 0, 0);
    let id;
    try { id = octx.getImageData(0, 0, w, h); }
    catch (e) { return null; }
    const p = id.data;
    for (let i = 0; i < p.length; i += 4) {
      const g = (0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2]) | 0;
      p[i] = p[i + 1] = p[i + 2] = g;
    }
    octx.putImageData(id, 0, 0);
    img._greyCanvas = off; img._greyW = w;
    return off;
  }

  function draw() {
    rafPending = false;
    if (!open) return;

    const k = 0.18;
    cam.x += (goal.x - cam.x) * k;
    cam.y += (goal.y - cam.y) * k;
    cam.s += (goal.s - cam.s) * k;
    const settled = Math.abs(goal.x - cam.x) < 0.05 &&
                    Math.abs(goal.y - cam.y) < 0.05 &&
                    Math.abs(goal.s - cam.s) / cam.s < 0.001;
    if (settled) { cam.x = goal.x; cam.y = goal.y; cam.s = goal.s; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#FAFAF7';
    ctx.fillRect(0, 0, W, H);

    if (!photo) return;

    // the photograph, drawn about its centre so it can turn
    const [pcx, pcy] = toScreen(WORLD_W / 2, worldH / 2);
    const pw = WORLD_W * cam.s, ph = worldH * cam.s;
    const bw = rot % 2 ? ph : pw, bh = rot % 2 ? pw : ph;

    ctx.shadowColor = 'rgba(70,70,60,0.14)';
    ctx.shadowBlur = 26;
    ctx.shadowOffsetY = 6;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(pcx - bw / 2, pcy - bh / 2, bw, bh);
    ctx.shadowColor = 'transparent';

    const img = imgReady ? imgFull : imgThumb;
    if (img && img.complete && img.naturalWidth) {
      ctx.save();
      // crisp pixels when inspecting closely
      const nativeScale = pw / img.naturalWidth;
      ctx.imageSmoothingEnabled = nativeScale < 1.8;
      ctx.imageSmoothingQuality = 'high';
      let src = img;
      if (bwMode) src = greyVersion(img) || img;   // draw a pre-greyed copy
      ctx.translate(pcx, pcy);
      ctx.rotate(rot * Math.PI / 2);
      ctx.drawImage(src, -pw / 2, -ph / 2, pw, ph);
      ctx.restore();
    }

    // ——— marks — the same renderer used by the writing workspace ———
    const cs = CELL * cam.s;
    const brushView = {toScreen, scale: cam.s, width: W, height: H,
                       now: performance.now()};
    PixelBrushes.paintInk(ctx, ink, brushView);
    if (PixelBrushes.paintWiggly(ctx, wig, brushView)) {
      // wake up only when the boil frame changes — a true low frame rate
      if (!wigTimer && open) {
        wigTimer = setTimeout(() => { wigTimer = null; requestDraw(); }, 125);
      }
    }

    // ——— placed text (permanent, movable) ———
    for (const t of texts) {
      const r = PixelBrushes.textRaster(t.str, t.size);
      ctx.fillStyle = PixelBrushes.colorOf(t.color);
      for (const [dx, dy] of r.offsets) {
        const [sx, sy] = toScreen((t.x + dx + 0.5) * CELL, (t.y + dy + 0.5) * CELL);
        if (sx < -cs || sx > W + cs || sy < -cs || sy > H + cs) continue;
        ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
      }
    }

    // ——— future marks (decaying) ———
    let animating = PixelBrushes.paintFuture(ctx, future, brushView);

    // brief brush-size preview at the cursor while sizing
    if (performance.now() < sizePreviewUntil) {
      const d = (2 * (brush - 1) + 1) * CELL * cam.s;
      ctx.strokeStyle = 'rgba(110,110,105,0.55)';
      ctx.lineWidth = 1;
      ctx.strokeRect(lastMouse.x - d / 2, lastMouse.y - d / 2, d, d);
      animating = true;
    }

    if (!settled || animating) requestDraw();
  }

  /* ——— drawing tools ——— */

  function inBounds(cx, cy) {
    const x = cx * CELL, y = cy * CELL;
    const mx = WORLD_W * MARGIN, my = worldH * MARGIN;
    return x >= -mx && x <= WORLD_W + mx && y >= -my && y <= worldH + my;
  }

  let stroke = null;   // current op being recorded for undo

  function applyBrush(wx, wy) {
    for (const [cx, cy] of PixelBrushes.cellsAround(wx, wy, brush)) {
      if (!inBounds(cx, cy)) continue;
      const key = cx + ',' + cy;
      if (tool === 'ink') {
        const prev = ink.has(key) ? ink.get(key) : null;
        if (prev === color) continue;
        stroke.cells.push([key, prev]);
        ink.set(key, color);
        dirty = true;
      } else if (tool === 'wiggly') {
        const prev = wig.has(key) ? wig.get(key) : null;
        if (prev === color) continue;
        stroke.wigCells.push([key, prev]);
        wig.set(key, color);
        dirty = true;
      } else if (tool === 'future') {
        future.set(key, {t: performance.now(), c: color});
      } else if (tool === 'erase') {
        if (ink.has(key)) {
          stroke.cells.push([key, ink.get(key)]);
          ink.delete(key);
          dirty = true;
        }
        if (wig.has(key)) {
          stroke.wigCells.push([key, wig.get(key)]);
          wig.delete(key);
          dirty = true;
        }
        future.delete(key);
      }
    }
    // the eraser also lifts whole placed texts it touches
    if (tool === 'erase') {
      const ccx = wx / CELL, ccy = wy / CELL, r = brush;
      for (let i = texts.length - 1; i >= 0; i--) {
        const t = texts[i], ras = PixelBrushes.textRaster(t.str, t.size);
        if (ccx >= t.x - r && ccx <= t.x + ras.wc + r &&
            ccy >= t.y - r && ccy <= t.y + ras.hc + r) {
          stroke.texts.push({obj: t, index: i});
          texts.splice(i, 1);
          dirty = true;
        }
      }
    }
  }

  /* ——— text brush: serif letters crystallised into the pixel grid ——— */

  let textInput = null;   // {el, wx, wy}

  const textSizeCells = () => 3 + brush * 6;   // brush 1..10 → 9..63 cells

  function textAt(wx, wy) {
    const cx = wx / CELL, cy = wy / CELL;
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i], r = PixelBrushes.textRaster(t.str, t.size);
      if (cx >= t.x - 1 && cx <= t.x + r.wc + 1 &&
          cy >= t.y - 1 && cy <= t.y + r.hc + 1) return t;
    }
    return null;
  }

  function openTextInput(sx, sy) {
    commitTextInput();
    const [wx, wy] = toWorld(sx, sy);
    const el = document.createElement('input');
    el.type = 'text';
    el.className = 'text-brush-input';
    el.spellcheck = false;
    el.autocomplete = 'off';
    const fontPx = Math.max(8, textSizeCells() * CELL * cam.s);
    el.style.left = sx + 'px';
    el.style.top = sy + 'px';
    el.style.fontSize = fontPx + 'px';
    // ink colour and caret agree — a near-white ink reads as a faint grey so
    // the caret and the letters it types are never invisible on the paper
    const dispColor = hsl.l > 90 ? '#B8B8B0' : color;
    el.style.color = dispColor;
    el.style.caretColor = dispColor;
    view.appendChild(el);
    textInput = {el, wx, wy};
    setTimeout(() => el.focus(), 0);
    el.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') commitTextInput();
      else if (ev.key === 'Escape') cancelTextInput();
    });
    el.addEventListener('wheel', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      resizeTextInput(ev.deltaY < 0 ? 1 : -1);
    }, {passive: false});
    el.addEventListener('blur', () => commitTextInput());
  }

  // the wheel sizes the note while the caret blinks; the caret grows with it
  function resizeTextInput(step) {
    if (!textInput) return;
    setBrush(brush + step);
    textInput.el.style.fontSize =
      Math.max(8, textSizeCells() * CELL * cam.s) + 'px';
  }

  function commitTextInput() {
    if (!textInput) return;
    const {el, wx, wy} = textInput;
    textInput = null;
    const str = el.value.trim();
    el.remove();
    if (!str) { requestDraw(); return; }
    const t = {id: nextTextId++, str,
               x: Math.floor(wx / CELL), y: Math.floor(wy / CELL),
               size: textSizeCells(), color};
    texts.push(t);
    undoStack.push({type: 'text-add', tid: t.id});
    if (undoStack.length > 120) undoStack.shift();
    dirty = true;
    scheduleInkSave();
    requestDraw();
  }

  function cancelTextInput() {
    if (!textInput) return;
    const el = textInput.el;
    textInput = null;
    el.remove();
  }

  function strokeLine(x0, y0, x1, y1) {
    PixelBrushes.strokeLine(x0, y0, x1, y1, applyBrush);
  }

  function undo() {
    const op = undoStack.pop();
    if (!op) return;
    if (op.type === 'stroke') {
      for (let i = op.cells.length - 1; i >= 0; i--) {
        const [key, prev] = op.cells[i];
        if (prev === null) ink.delete(key); else ink.set(key, prev);
      }
      for (let i = (op.wigCells || []).length - 1; i >= 0; i--) {
        const [key, prev] = op.wigCells[i];
        if (prev === null) wig.delete(key); else wig.set(key, prev);
      }
      for (let i = (op.texts || []).length - 1; i >= 0; i--) {
        const {obj, index} = op.texts[i];
        texts.splice(Math.min(index, texts.length), 0, obj);
      }
    } else if (op.type === 'clear') {
      ink = new Map(op.snapshot);
      wig = new Map(op.wigSnapshot || []);
      texts = op.texts.slice();
    } else if (op.type === 'text-add') {
      const i = texts.findIndex(t => t.id === op.tid);
      if (i >= 0) texts.splice(i, 1);
    } else if (op.type === 'text-move') {
      op.t.x = op.from[0]; op.t.y = op.from[1];
    }
    dirty = true;
    scheduleInkSave();
    requestDraw();
  }

  function clearAll() {
    if (!ink.size && !wig.size && !future.size && !texts.length) return;
    undoStack.push({type: 'clear', snapshot: [...ink],
                    wigSnapshot: [...wig], texts: texts.slice()});
    ink.clear();
    wig.clear();
    texts = [];
    future.clear();
    dirty = true;
    scheduleInkSave();
    requestDraw();
  }

  /* ——— persistence ——— */

  function scheduleInkSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushInk(), 900);
  }

  function flushInk(sync = false) {
    clearTimeout(saveTimer);
    if (!dirty || !photo) return;
    const cells = [];
    for (const [key, c] of ink) {
      const i = key.indexOf(',');
      cells.push([+key.slice(0, i), +key.slice(i + 1), c]);
    }
    const wiggly = [];
    for (const [key, c] of wig) {
      const i = key.indexOf(',');
      wiggly.push([+key.slice(0, i), +key.slice(i + 1), c]);
    }
    const payload = {
      cellSize: CELL, worldW: WORLD_W, cells, wiggly,
      rot, bw: bwMode ? 1 : 0,
      texts: texts.map(({str, x, y, size, color}) =>
                       ({str, x, y, size, color})),
    };
    dirty = false;
    if (sync && navigator.sendBeacon) {
      navigator.sendBeacon(`/api/photo/${photo.id}/annotations`,
        new Blob([JSON.stringify(payload)], {type: 'application/json'}));
    } else {
      API.saveAnnotations(photo.id, payload).then(() => hintSaved());
    }
    if (onMetaSaved) onMetaSaved();
  }

  /* ——— notes panel ——— */

  const $ = id => document.getElementById(id);
  const fTitle = $('f-title'), fDate = $('f-date'), fNotes = $('f-notes'),
        fLocation = $('f-location'),
        fTags = $('f-tags'), fRoll = $('f-roll'),
        fFile = $('f-file'), hint = $('save-hint'),
        chipsEl = $('tag-chips'), suggestEl = $('tag-suggest');
  const starEls = [...document.querySelectorAll('#f-stars button')];
  let metaTimer = null, metaDirty = false;
  let tags = [];
  let allTags = [];   // every tag in use anywhere in the archive
  let rating = 0;

  function refreshAllTags() {
    API.tags().then(list => { allTags = list; renderSuggestions(); })
      .catch(() => {});
  }

  function renderSuggestions() {
    suggestEl.innerHTML = '';
    const typed = fTags.value.trim().toLowerCase();
    const mine = new Set(tags.map(t => t.toLowerCase()));
    const options = allTags.filter(name => {
      const low = name.toLowerCase();
      if (mine.has(low)) return false;
      return !typed || low.includes(typed);
    }).slice(0, 12);
    for (const name of options) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => {
        tags.push(name);
        fTags.value = '';
        renderTags();
        scheduleMetaSave();
      });
      suggestEl.appendChild(chip);
    }
  }

  function parseTags(s) {
    return (s || '').split(',').map(t => t.trim()).filter(Boolean);
  }

  function renderTags() {
    chipsEl.innerHTML = '';
    tags.forEach((name, i) => {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      chip.title = 'remove';
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => {
        tags.splice(i, 1);
        renderTags();
        scheduleMetaSave();
      });
      chipsEl.appendChild(chip);
    });
    renderSuggestions();
  }

  function addTagFromInput() {
    const raw = fTags.value;
    fTags.value = '';
    for (const name of parseTags(raw)) {
      if (!tags.some(t => t.toLowerCase() === name.toLowerCase()))
        tags.push(name);
    }
    renderTags();
    scheduleMetaSave();
  }

  fTags.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter' || ev.key === ',') {
      ev.preventDefault();
      addTagFromInput();
    }
  });
  fTags.addEventListener('input', renderSuggestions);
  fTags.addEventListener('blur', () => {
    if (fTags.value.trim()) addTagFromInput();
  });

  /* ——— camera & film: a fact of the whole roll, or of one photo ——— */

  const gear = {
    camera: {input: $('f-camera'), override: '', scope: 'roll',
             rollBtn: $('camera-scope-roll'), photoBtn: $('camera-scope-photo')},
    film:   {input: $('f-film'), override: '', scope: 'roll',
             rollBtn: $('film-scope-roll'), photoBtn: $('film-scope-photo')},
  };
  let folderTimer = null, folderDirty = false;

  function syncGear(key) {
    const g = gear[key];
    g.rollBtn.classList.toggle('on', g.scope === 'roll');
    g.photoBtn.classList.toggle('on', g.scope === 'photo');
    if (g.scope === 'roll') {
      g.input.value = folderMeta[key] || '';
      g.input.placeholder = 'unset';
    } else {
      g.input.value = g.override || '';
      g.input.placeholder = folderMeta[key]
        ? folderMeta[key] + '  ·  roll' : 'unset';
    }
  }

  function commitGear(key) {
    const g = gear[key];
    const val = g.input.value.trim();
    if (g.scope === 'roll') {
      if (val !== (folderMeta[key] || '')) {
        folderMeta[key] = val;
        folderDirty = true;
        clearTimeout(folderTimer);
        folderTimer = setTimeout(flushFolderMeta, 900);
      }
    } else if (val !== g.override) {
      g.override = val;
      scheduleMetaSave();
    }
  }

  function flushFolderMeta() {
    clearTimeout(folderTimer);
    if (!folderDirty || !photo) return;
    folderDirty = false;
    API.saveFolderMeta(photo.folder, {
      camera: folderMeta.camera, film: folderMeta.film,
    }).then(() => { hintSaved(); if (onMetaSaved) onMetaSaved(); });
  }

  for (const key of ['camera', 'film']) {
    const g = gear[key];
    g.rollBtn.addEventListener('click', () => {
      commitGear(key);
      g.scope = 'roll';
      syncGear(key);
    });
    g.photoBtn.addEventListener('click', () => {
      commitGear(key);
      g.scope = 'photo';
      syncGear(key);
    });
    g.input.addEventListener('input', () => commitGear(key));
    g.input.addEventListener('blur', () => {
      commitGear(key);
      flushFolderMeta();
      flushMeta();
    });
    g.input.addEventListener('keydown', ev => {
      if (ev.key === 'Enter') g.input.blur();
    });
  }

  function renderStars() {
    starEls.forEach((s, i) => s.classList.toggle('on', i < rating));
  }
  starEls.forEach((s, i) => s.addEventListener('click', () => {
    const n = i + 1;
    rating = (rating === n) ? 0 : n;   // click the current star to clear
    renderStars();
    scheduleMetaSave();
  }));

  function fillNotesPanel() {
    fTitle.value = meta.title || '';
    sizeTitle();
    fDate.value = meta.date || photo.exif_date || '';
    fLocation.value = meta.location || '';
    fNotes.value = meta.notes || '';
    fTags.value = '';
    tags = parseTags(meta.tags);
    renderTags();
    rating = meta.rating || 0;
    renderStars();
    for (const key of ['camera', 'film']) {
      gear[key].override = meta[key] || '';
      gear[key].scope = gear[key].override ? 'photo' : 'roll';
      syncGear(key);
    }
    folderDirty = false;
    const roll = photo.folder ? photo.folder.split('/').pop() : 'loose photographs';
    fRoll.textContent = roll.replace(/[_-]+/g, ' ');
    document.getElementById('detail-roll').textContent =
      roll.replace(/[_-]+/g, ' ');
    fFile.textContent = photo.filename +
      (photo.width ? `  ·  ${photo.width} × ${photo.height}` : '');
    metaDirty = false;
  }

  function scheduleMetaSave() {
    metaDirty = true;
    clearTimeout(metaTimer);
    metaTimer = setTimeout(flushMeta, 900);
  }

  function flushMeta() {
    clearTimeout(metaTimer);
    if (!metaDirty || !photo) return;
    metaDirty = false;
    API.saveMeta(photo.id, {
      title: fTitle.value.trim(),
      date: fDate.value.trim(),
      location: fLocation.value.trim(),
      notes: fNotes.value,
      tags: tags.join(', '),
      rating: rating,
      camera: gear.camera.override,
      film: gear.film.override,
    }).then(() => {
      hintSaved();
      refreshAllTags();   // tag usage may have changed
      if (onMetaSaved) onMetaSaved();
    });
  }

  let hintTimer = null;
  function hintSaved() {
    hint.textContent = 'saved';
    hint.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), 1400);
  }

  // The date field accepts eight digits and shapes them into YYYY-MM-DD as
  // they are typed (2026 07 10 -> 2026-07-10); any non-digit is dropped and
  // nothing past eight digits is kept. The caret is restored by digit count so
  // editing mid-value still feels natural.
  function reformatDate() {
    const raw = fDate.value;
    const digitsBeforeCaret =
      raw.slice(0, fDate.selectionStart).replace(/\D/g, '').length;
    const d = raw.replace(/\D/g, '').slice(0, 8);
    let out = d.slice(0, 4);
    if (d.length > 4) out += '-' + d.slice(4, 6);
    if (d.length > 6) out += '-' + d.slice(6, 8);
    fDate.value = out;
    let pos = 0, seen = 0;
    while (pos < out.length && seen < digitsBeforeCaret) {
      if (out[pos] >= '0' && out[pos] <= '9') seen++;
      pos++;
    }
    fDate.setSelectionRange(pos, pos);
  }

  for (const el of [fNotes, fLocation]) {
    el.addEventListener('input', scheduleMetaSave);
    el.addEventListener('blur', flushMeta);
  }
  fDate.addEventListener('input', () => { reformatDate(); scheduleMetaSave(); });
  fDate.addEventListener('blur', flushMeta);

  // The title always wraps within the panel (never runs off the edge) and
  // steps its size down responsively the longer it grows — so a two-line
  // title only eases down a little, and an unusually long one keeps shrinking
  // toward a readable floor rather than pushing the panel around. The size is
  // chosen from a small ladder: the largest that keeps the title within a
  // couple of lines wins, and the floor is enforced so it never gets tiny.
  // Because font-size changes re-wrap the text, each candidate is measured in
  // turn. Works the same at any window width or display scaling.
  const TITLE_SIZES = [25, 22, 19, 16.5];   // px; last entry is the minimum
  const TITLE_TARGET_LINES = 2;             // prefer fitting within this many
  function sizeTitle() {
    // while the panel is hidden (display:none) the textarea has no layout and
    // scrollHeight reads 0 — measuring then would collapse the title to
    // nothing. clientWidth is 0 only when it is genuinely unrendered (unlike
    // offsetParent, which is also null under a positioned ancestor). Skip;
    // show() re-runs this once the panel is on screen.
    if (!fTitle.clientWidth) return;
    let chosen = TITLE_SIZES[TITLE_SIZES.length - 1];
    for (const size of TITLE_SIZES) {
      fTitle.style.fontSize = size + 'px';
      fTitle.style.height = 'auto';
      const lh = parseFloat(getComputedStyle(fTitle).lineHeight) || size * 1.35;
      const lines = Math.round(fTitle.scrollHeight / lh);
      chosen = size;
      if (lines <= TITLE_TARGET_LINES) break;   // largest size that fits wins
    }
    fTitle.style.fontSize = chosen + 'px';
    // wrapped marks the reduced state for any styling that keys off it
    fTitle.classList.toggle('wrapped', chosen < TITLE_SIZES[0]);
    fTitle.style.height = 'auto';
    fTitle.style.height = fTitle.scrollHeight + 'px';
  }
  fTitle.addEventListener('input', () => { sizeTitle(); scheduleMetaSave(); });
  fTitle.addEventListener('blur', flushMeta);
  fTitle.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') { ev.preventDefault(); fTitle.blur(); }
  });
  window.addEventListener('resize', () => { if (open) sizeTitle(); });

  /* ——— dash lists in image notes, with no toolbar button ———
     A line beginning with the literal "-" marker is a list item. Enter carries
     it to a fresh line; Enter on an empty item ends the list; Tab and Shift-Tab
     nest and un-nest by two spaces, so wrapped items sit under their own text. */
  // Accept both "- item" and the compact "-item" form. Continued items are
  // normalised to "- " so the marker stays legible and predictable.
  const BULLET_RE = /^(\s*)-(?:(\s+)(.*)|(.*))$/;

  function bulletLine(line) {
    const m = line.match(BULLET_RE);
    if (!m) return null;
    return {
      indent: m[1],
      gap: m[2] || '',
      content: m[2] !== undefined ? m[3] : m[4]
    };
  }

  function notesLine() {
    const v = fNotes.value, pos = fNotes.selectionStart;
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos);
    if (end === -1) end = v.length;
    return {v, pos, start, end, line: v.slice(start, end)};
  }

  function setNotes(value, caret) {
    fNotes.value = value;
    fNotes.setSelectionRange(caret, caret);
    scheduleMetaSave();
  }

  fNotes.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && !ev.shiftKey) {
      const {v, pos, start, line} = notesLine();
      const bullet = bulletLine(line);
      if (!bullet) return;
      const {indent, content} = bullet;
      ev.preventDefault();
      if (!content.trim()) {
        // an empty bullet ends the list — clear the marker off this line
        setNotes(v.slice(0, start) + v.slice(start + line.length), start);
      } else {
        const insert = '\n' + indent + '- ';
        setNotes(v.slice(0, pos) + insert + v.slice(pos), pos + insert.length);
      }
    } else if (ev.key === 'Tab') {
      const {v, start, line} = notesLine();
      if (!bulletLine(line)) return;
      ev.preventDefault();
      const caret = fNotes.selectionStart;
      if (ev.shiftKey) {
        const lead = line.match(/^( {1,2})/);
        if (lead) setNotes(v.slice(0, start) + v.slice(start + lead[1].length),
                           Math.max(start, caret - lead[1].length));
      } else {
        setNotes(v.slice(0, start) + '  ' + v.slice(start), caret + 2);
      }
    } else if (ev.key === 'Backspace') {
      // Backspace at the head of an empty bullet reduces its indentation one
      // level, or removes the marker entirely when it is already at the left —
      // the natural word-processor gesture, instead of nibbling one space at a
      // time. Only fires for a truly empty bullet with the caret at its end.
      const {v, pos, start, end, line} = notesLine();
      const bullet = bulletLine(line);
      if (!bullet || bullet.content.trim() || pos !== end) return;
      const {indent, gap} = bullet;
      ev.preventDefault();
      if (indent.length >= 2) {
        setNotes(v.slice(0, start) + v.slice(start + 2), pos - 2);
      } else if (indent.length === 1) {
        setNotes(v.slice(0, start) + v.slice(start + 1), pos - 1);
      } else {
        // at the left margin: drop the whole marker, leaving an empty line
        setNotes(v.slice(0, start) + v.slice(start + 1 + gap.length),
                 start);
      }
    }
  });

  /* ——— toolbar ——— */

  const toolButtons = [...document.querySelectorAll('#toolbar .tool')];
  const sizeDot = document.querySelector('#size-dot span');
  const clearBtn = $('btn-clear');
  const paletteEl = $('palette');

  // The colour wheel unfolds a small HSL popup — three sliders and a live
  // preview — in place of a fixed row of preset swatches. Any colour is a drag
  // away, and the brush, the size dot and the popup all follow the sliders the
  // instant they move.
  const hueSlider = $('hsl-h'), satSlider = $('hsl-s'), litSlider = $('hsl-l');
  const hslPreview = $('hsl-preview');

  const hslToHex = PixelBrushes.hslToHex;

  function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255,
          g = parseInt(hex.slice(3, 5), 16) / 255,
          b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [Math.round(h), Math.round(s * 100), Math.round(l * 100)];
  }

  // The saturation and lightness tracks recolour to the current hue, so the
  // sliders read as a preview of what each one does from where it stands now.
  function paintSliderTracks() {
    const {h, s} = hsl;
    satSlider.style.setProperty('--track',
      `linear-gradient(90deg, hsl(${h},0%,60%), hsl(${h},100%,50%))`);
    litSlider.style.setProperty('--track',
      `linear-gradient(90deg,#000, hsl(${h},${s}%,50%), #fff)`);
  }

  // The one place the brush colour is set: the H/S/L state resolves to a hex,
  // and every surface that shows the colour — the brush ink, the size dot, the
  // popup preview, the slider tracks — is refreshed together so a change is
  // never left half-applied.
  function applyHsl() {
    color = hslToHex(hsl.h, hsl.s, hsl.l);
    sizeDot.style.background = color;
    sizeDot.classList.toggle('white', hsl.l > 85);
    hslPreview.style.background = color;
    paintSliderTracks();
  }

  // Adopt a colour (a hex string, or a legacy palette index) and move the
  // sliders to match, so the picker always shows the truth.
  function setColor(c) {
    const [h, s, l] = hexToHsl(PixelBrushes.colorOf(c));
    hsl.h = h; hsl.s = s; hsl.l = l;
    hueSlider.value = h; satSlider.value = s; litSlider.value = l;
    applyHsl();
  }

  for (const sl of [hueSlider, satSlider, litSlider]) {
    sl.addEventListener('input', () => {
      hsl.h = +hueSlider.value; hsl.s = +satSlider.value; hsl.l = +litSlider.value;
      applyHsl();
    });
    // a slider drag or wheel is its own gesture — never pan, zoom or size the
    // brush on the canvas underneath
    sl.addEventListener('pointerdown', e => e.stopPropagation());
    sl.addEventListener('wheel', e => e.stopPropagation());
  }

  $('wheel-btn').addEventListener('click', () => paletteEl.classList.toggle('open'));

  function setTool(t) {
    if (tool === 'text' && t !== 'text') commitTextInput();
    tool = t;
    for (const b of toolButtons)
      b.classList.toggle('active', b.dataset.tool === t);
    canvas.style.cursor =
      t === 'view' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  }

  function setBrush(b) {
    brush = Math.max(1, Math.min(10, b));
    const px = 3 + brush * 1.4;
    sizeDot.style.width = px + 'px';
    sizeDot.style.height = px + 'px';
  }

  for (const b of toolButtons)
    b.addEventListener('click', () => setTool(b.dataset.tool));
  const bwBtn = $('btn-bw');
  bwBtn.addEventListener('click', () => {
    bwMode = !bwMode;
    bwBtn.classList.toggle('active', bwMode);
    dirty = true;            // remembered with the marks, like the turn
    scheduleInkSave();
    requestDraw();
  });
  function rotate() {
    commitTextInput();
    rot = (rot + 1) % 4;
    dirty = true;            // the turn is remembered with the marks
    scheduleInkSave();
    fitPhoto();
    requestDraw();
  }
  $('btn-rotate').addEventListener('click', rotate);

  $('size-down').addEventListener('click', () => setBrush(brush - 1));
  $('size-up').addEventListener('click', () => setBrush(brush + 1));
  $('btn-undo').addEventListener('click', undo);

  // clear acts at once — undo is always there to bring the marks back
  clearBtn.addEventListener('click', clearAll);

  $('btn-back').addEventListener('click', close);
  $('btn-notes-toggle').addEventListener('click', () => {
    document.getElementById('notes-panel').classList.toggle('tucked');
  });

  /* ——— passing between photographs ——— */

  const navPrev = $('nav-prev'), navNext = $('nav-next');

  function nav(step) {
    const t = seqPos + step;
    if (seqPos < 0 || t < 0 || t >= seq.length) return;
    commitTextInput();
    flushMeta();
    flushFolderMeta();
    flushInk(true);      // the leaving photo keeps its marks and its turn
    show(seq[t]);
  }
  navPrev.addEventListener('click', () => nav(-1));
  navNext.addEventListener('click', () => nav(1));

  setColor(color);
  setBrush(4);

  /* ——— pointer interaction ——— */

  let pointer = null;   // {mode:'pan'|'draw'|'text-drag', ...}
  let spaceHeld = false;

  // keep the browser's middle-click autoscroll out of the way
  canvas.addEventListener('mousedown', e => {
    if (e.button === 1) e.preventDefault();
  });

  canvas.addEventListener('pointerdown', e => {
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const [wx, wy] = toWorld(e.clientX, e.clientY);

    // grabbing placed text directly — no handles, it just moves
    if (e.button === 0 && !spaceHeld &&
        (tool === 'view' || tool === 'text')) {
      const t = textAt(wx, wy);
      if (t) {
        commitTextInput();
        pointer = {mode: 'text-drag', t, fromX: t.x, fromY: t.y, wx, wy,
                   moved: false};
        canvas.style.cursor = 'grabbing';
        return;
      }
    }

    const pan = tool === 'view' || spaceHeld || e.button === 1;
    if (pan) {
      commitTextInput();
      pointer = {mode: 'pan', x: e.clientX, y: e.clientY,
                 camX: goal.x, camY: goal.y};
    } else if (e.button === 0 && tool === 'text') {
      openTextInput(e.clientX, e.clientY);
    } else if (e.button === 0) {
      stroke = {type: 'stroke', cells: [], texts: [], wigCells: []};
      pointer = {mode: 'draw', wx, wy};
      applyBrush(wx, wy);
      requestDraw();
    }
  });

  canvas.addEventListener('pointermove', e => {
    lastMouse = {x: e.clientX, y: e.clientY};
    if (!pointer) {
      // quiet affordance: the cursor hints that text can be picked up
      if ((tool === 'view' || tool === 'text') && texts.length) {
        const [wx, wy] = toWorld(e.clientX, e.clientY);
        canvas.style.cursor = textAt(wx, wy) ? 'move'
          : tool === 'view' ? 'default' : 'text';
      }
      return;
    }
    if (pointer.mode === 'pan') {
      goal.x = pointer.camX - (e.clientX - pointer.x) / cam.s;
      goal.y = pointer.camY - (e.clientY - pointer.y) / cam.s;
      cam.x = goal.x; cam.y = goal.y;
      requestDraw();
    } else if (pointer.mode === 'text-drag') {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      const dx = Math.round((wx - pointer.wx) / CELL);
      const dy = Math.round((wy - pointer.wy) / CELL);
      if (dx || dy) pointer.moved = true;
      pointer.t.x = pointer.fromX + dx;
      pointer.t.y = pointer.fromY + dy;
      requestDraw();
    } else {
      const [wx, wy] = toWorld(e.clientX, e.clientY);
      strokeLine(pointer.wx, pointer.wy, wx, wy);
      pointer.wx = wx; pointer.wy = wy;
      requestDraw();
    }
  });

  canvas.addEventListener('pointerup', () => {
    if (pointer && pointer.mode === 'draw' && stroke) {
      if (stroke.cells.length || stroke.texts.length ||
          stroke.wigCells.length) {
        undoStack.push(stroke);
        if (undoStack.length > 120) undoStack.shift();
        scheduleInkSave();
      }
      stroke = null;
    } else if (pointer && pointer.mode === 'text-drag') {
      const p = pointer;
      if (p.moved) {
        undoStack.push({type: 'text-move', t: p.t,
                        from: [p.fromX, p.fromY], to: [p.t.x, p.t.y]});
        if (undoStack.length > 120) undoStack.shift();
        dirty = true;
        scheduleInkSave();
      }
      canvas.style.cursor = tool === 'view' ? 'default' : 'text';
    }
    pointer = null;
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    // while a note is being typed, the wheel sizes the note in place
    if (textInput && !spaceHeld) {
      resizeTextInput(e.deltaY < 0 ? 1 : -1);
      return;
    }
    // with a drawing tool in hand, the wheel sizes the brush;
    // hold space (or switch to view) to zoom instead
    if (tool !== 'view' && !spaceHeld) {
      commitTextInput();
      setBrush(brush + (e.deltaY < 0 ? 1 : -1));
      sizePreviewUntil = performance.now() + 650;
      requestDraw();
      return;
    }
    commitTextInput();   // the note settles in place before the view moves
    const factor = Math.exp(-e.deltaY * 0.0016);
    const maxS = Math.max(8, (imgFull && imgFull.naturalWidth || 3000)
                              / WORLD_W * 6);
    const ns = Math.min(maxS, Math.max(0.08, goal.s * factor));
    // the camera lives in the rotated frame (toScreen rotates first, then
    // frames), so the zoom anchor must too — toWorld un-rotates, which on a
    // turned photograph would swing the view about instead of holding the
    // point under the cursor still
    const rx = (e.clientX - W / 2) / cam.s + cam.x;
    const ry = (e.clientY - H / 2) / cam.s + cam.y;
    goal.x = rx - (e.clientX - W / 2) / ns;
    goal.y = ry - (e.clientY - H / 2) / ns;
    goal.s = ns;
    requestDraw();
  }, {passive: false});

  /* ——— keys ——— */

  window.addEventListener('keydown', e => {
    if (!open) return;
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === ' ' && !typing) { spaceHeld = true; e.preventDefault(); }
    if (typing) return;
    let handled = true;
    if (e.key === 'Escape') close();
    else if (e.key === 'v') setTool('view');
    else if (e.key === 'f') setTool('future');
    else if (e.key === 'i') setTool('ink');
    else if (e.key === 'w') setTool('wiggly');
    else if (e.key === 't') setTool('text');
    else if (e.key === 'e') setTool('erase');
    else if (e.key === 'r') rotate();
    else if (e.key === 'ArrowLeft' || e.key === 'a') nav(-1);
    else if (e.key === 'ArrowRight' || e.key === 'd') nav(1);
    else if (e.key === '[') setBrush(brush - 1);
    else if (e.key === ']') setBrush(brush + 1);
    else if (e.key === '0') fitPhoto();
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') undo();
    else handled = false;
    // Consume any shortcut we acted on. Otherwise macOS WebKit treats the key
    // as unhandled and plays its alert "bonk" — loudest on the arrow keys and
    // ⌘-combos used to step between photographs.
    if (handled) e.preventDefault();
  });
  window.addEventListener('keyup', e => {
    if (e.key === ' ') spaceHeld = false;
  });

  window.addEventListener('resize', () => { if (open) resize(); });
  window.addEventListener('beforeunload', () => {
    flushMeta();
    flushInk(true);
  });

  return {
    show,
    setSequence(ids) { seq = ids || []; },
    isOpen: () => open,
    onBack(fn) { onBack = fn; },
    onSaved(fn) { onMetaSaved = fn; },
    step() { rafPending = false; draw(); },   // manual frame (testing)
  };
})();
