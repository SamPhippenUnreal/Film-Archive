/* ————————————————————————————————————————————————
   the inspection table: one photograph, notes, marks
   ———————————————————————————————————————————————— */

const Detail = (() => {
  const view = document.getElementById('detail-view');
  const canvas = document.getElementById('detail-canvas');
  const ctx = canvas.getContext('2d');

  // the original three, then a quiet row of earthy pastels
  const COLORS = ['#1E43FF', '#3A3A38', '#FFFFFF',
                  '#A96A45',   // clay
                  '#8E9F72',   // sage
                  '#C0A050',   // ochre
                  '#7E93A8',   // slate
                  '#B08699'];  // dusty rose
  const COLOR_NAMES = ['future blue', 'dark grey', 'white',
                       'clay', 'sage', 'ochre', 'slate', 'rose'];
  const CELL = 2;                          // annotation grid, workspace units
  const WORLD_W = 1000;                    // photo width in workspace units
  const MARGIN = 0.85;                     // drawable margin around the photo
  const FUTURE_HOLD = 3600;                // ms before a future mark decays
  const FUTURE_FADE = 2800;                // ms of pixel-by-pixel dissolve

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
  let color = 0;              // index into COLORS
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
    view.classList.add('fading');
    requestAnimationFrame(() => view.classList.remove('fading'));
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
    setTimeout(() => { view.classList.add('hidden'); }, 300);
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

  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i); h = Math.imul(h, 16777619);
    }
    return ((h >>> 8) & 0xFFFF) / 0xFFFF;
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
      if (bwMode) ctx.filter = 'grayscale(1)';
      ctx.translate(pcx, pcy);
      ctx.rotate(rot * Math.PI / 2);
      ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
      ctx.restore();
    }

    // ——— ink marks (permanent) ———
    const cs = CELL * cam.s;
    for (const [key, c] of ink) {
      const i = key.indexOf(',');
      const cx = +key.slice(0, i), cy = +key.slice(i + 1);
      // cells are drawn about their centre so they sit still when rotated
      const [sx, sy] = toScreen((cx + 0.5) * CELL, (cy + 0.5) * CELL);
      if (sx < -cs || sx > W + cs || sy < -cs || sy > H + cs) continue;
      ctx.fillStyle = COLORS[c] || COLORS[1];
      ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
    }

    // ——— wiggly marks (permanent, gently boiling at ~8 fps) ———
    if (wig.size) {
      const frame = (performance.now() / 125) | 0;
      const cell = (fx, fy, c) => {
        const [sx, sy] = toScreen((fx + 0.5) * CELL, (fy + 0.5) * CELL);
        if (sx < -cs || sx > W + cs || sy < -cs || sy > H + cs) return;
        ctx.fillStyle = COLORS[c] || COLORS[1];
        ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
      };
      // every home cell is always drawn, so the body stays fully opaque
      // like the other brushes; a coherent per-block offset is drawn on top,
      // giving the stroke a hand-drawn boil that never opens gaps
      const WB = 4;   // cells per block that boil together
      for (const [key, c] of wig) {
        const i = key.indexOf(',');
        const cx = +key.slice(0, i), cy = +key.slice(i + 1);
        cell(cx, cy, c);
        const bx = Math.floor(cx / WB), by = Math.floor(cy / WB);
        const h1 = hash01(bx + ',' + by + ':' + frame);
        const h2 = hash01(frame + '~' + bx + ',' + by);
        const jx = h1 < 0.34 ? -1 : h1 > 0.66 ? 1 : 0;
        const jy = h2 < 0.34 ? -1 : h2 > 0.66 ? 1 : 0;
        if (jx || jy) cell(cx + jx, cy + jy, c);
      }
      // wake up only when the boil frame changes — a true low frame rate
      if (!wigTimer && open) {
        wigTimer = setTimeout(() => { wigTimer = null; requestDraw(); }, 125);
      }
    }

    // ——— placed text (permanent, movable) ———
    for (const t of texts) {
      const r = textRaster(t.str, t.size);
      ctx.fillStyle = COLORS[t.color] || COLORS[1];
      for (const [dx, dy] of r.offsets) {
        const [sx, sy] = toScreen((t.x + dx + 0.5) * CELL, (t.y + dy + 0.5) * CELL);
        if (sx < -cs || sx > W + cs || sy < -cs || sy > H + cs) continue;
        ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
      }
    }

    // ——— future marks (decaying) ———
    let animating = false;
    if (future.size) {
      const now = performance.now();
      for (const [key, f] of future) {
        const age = now - f.t;
        const jitter = hash01(key) * FUTURE_FADE * 0.9;
        const fadeStart = FUTURE_HOLD + jitter;
        if (age > fadeStart + FUTURE_FADE * 0.35) { future.delete(key); continue; }
        animating = true;
        let a = 0.92;
        if (age > fadeStart) {
          const q = (age - fadeStart) / (FUTURE_FADE * 0.35);
          a = 0.92 * (1 - q);
          // dissolving pixels flicker faintly as they go
          if (hash01(key + '~' + ((now / 90) | 0)) < q * 0.5) continue;
        }
        const i = key.indexOf(',');
        const cx = +key.slice(0, i), cy = +key.slice(i + 1);
        const [sx, sy] = toScreen((cx + 0.5) * CELL, (cy + 0.5) * CELL);
        if (sx < -cs || sx > W + cs || sy < -cs || sy > H + cs) continue;
        ctx.globalAlpha = a;
        ctx.fillStyle = COLORS[f.c] || COLORS[0];
        ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
      }
      ctx.globalAlpha = 1;
    }

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

  function cellsAround(wx, wy) {
    // cells under a round brush of radius `brush` cells
    const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
    const out = [];
    const r = brush - 1;
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (dx * dx + dy * dy <= r * r + 0.4)
          out.push([cx + dx, cy + dy]);
    return out;
  }

  function inBounds(cx, cy) {
    const x = cx * CELL, y = cy * CELL;
    const mx = WORLD_W * MARGIN, my = worldH * MARGIN;
    return x >= -mx && x <= WORLD_W + mx && y >= -my && y <= worldH + my;
  }

  let stroke = null;   // current op being recorded for undo

  function applyBrush(wx, wy) {
    for (const [cx, cy] of cellsAround(wx, wy)) {
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
        const t = texts[i], ras = textRaster(t.str, t.size);
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
  const rasterCache = new Map();   // "str|size" -> {offsets, wc, hc}

  const textSizeCells = () => 3 + brush * 6;   // brush 1..10 → 9..63 cells

  function textRaster(str, sizeCells) {
    const key = str + '|' + sizeCells;
    let r = rasterCache.get(key);
    if (r) return r;
    if (rasterCache.size > 80) rasterCache.clear();
    // draw the text small (1 canvas px per grid cell, 3× supersampled),
    // then threshold it into cell offsets — same pixels as the brushes
    const ss = 3;
    const oc = document.createElement('canvas');
    const octx = oc.getContext('2d', {willReadFrequently: true});
    const font = (sizeCells * ss) + 'px "Times New Roman", Times, Georgia, serif';
    octx.font = font;
    const w = Math.ceil(octx.measureText(str).width) + ss * 2;
    const h = Math.ceil(sizeCells * ss * 1.45);
    oc.width = w; oc.height = h;
    octx.font = font;
    octx.textBaseline = 'top';
    octx.fillStyle = '#000';
    octx.fillText(str, ss, 0);
    const data = octx.getImageData(0, 0, w, h).data;
    const offsets = [];
    let wc = 0, hc = 0;
    for (let cy = 0; cy * ss < h; cy++) {
      for (let cx = 0; cx * ss < w; cx++) {
        let a = 0;
        for (let sy = 0; sy < ss; sy++)
          for (let sx = 0; sx < ss; sx++) {
            const qx = cx * ss + sx, qy = cy * ss + sy;
            if (qx < w && qy < h) a += data[(qy * w + qx) * 4 + 3];
          }
        if (a / (ss * ss) > 92) {
          offsets.push([cx, cy]);
          if (cx > wc) wc = cx;
          if (cy > hc) hc = cy;
        }
      }
    }
    r = {offsets, wc, hc};
    rasterCache.set(key, r);
    return r;
  }

  function textAt(wx, wy) {
    const cx = wx / CELL, cy = wy / CELL;
    for (let i = texts.length - 1; i >= 0; i--) {
      const t = texts[i], r = textRaster(t.str, t.size);
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
    // ink colour and caret agree — white writes as a faint grey on paper
    const dispColor = COLORS[color] === '#FFFFFF' ? '#B8B8B0' : COLORS[color];
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
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.6)));
    for (let i = 0; i <= steps; i++)
      applyBrush(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
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
    fDate.value = meta.date || photo.exif_date || '';
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

  for (const el of [fTitle, fDate, fNotes]) {
    el.addEventListener('input', scheduleMetaSave);
    el.addEventListener('blur', flushMeta);
  }

  /* ——— toolbar ——— */

  const toolButtons = [...document.querySelectorAll('#toolbar .tool')];
  const sizeDot = document.querySelector('#size-dot span');
  const clearBtn = $('btn-clear');
  const paletteEl = $('palette'), swatchesEl = $('swatches');

  // the palette lives folded inside the colour wheel
  const swatchBtns = COLORS.map((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === '#FFFFFF' ? ' white' : '');
    b.style.background = c;
    b.title = COLOR_NAMES[i] || '';
    b.addEventListener('click', () => setColor(i));
    swatchesEl.appendChild(b);
    return b;
  });
  $('wheel-btn').addEventListener('click', () =>
    paletteEl.classList.toggle('open'));

  function setTool(t) {
    if (tool === 'text' && t !== 'text') commitTextInput();
    tool = t;
    for (const b of toolButtons)
      b.classList.toggle('active', b.dataset.tool === t);
    canvas.style.cursor =
      t === 'view' ? 'default' : t === 'text' ? 'text' : 'crosshair';
  }

  function setColor(c) {
    color = c;
    swatchBtns.forEach((b, i) => b.classList.toggle('active', i === c));
    // the size dot carries the chosen colour
    sizeDot.style.background = COLORS[c];
    sizeDot.classList.toggle('white', COLORS[c] === '#FFFFFF');
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

  setColor(0);
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
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    goal.x = wx - (e.clientX - W / 2) / ns;
    goal.y = wy - (e.clientY - H / 2) / ns;
    goal.s = ns;
    requestDraw();
  }, {passive: false});

  /* ——— keys ——— */

  window.addEventListener('keydown', e => {
    if (!open) return;
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (e.key === ' ' && !typing) { spaceHeld = true; e.preventDefault(); }
    if (typing) return;
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
    else if ((e.ctrlKey || e.metaKey) && e.key === 'z') { undo(); e.preventDefault(); }
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
