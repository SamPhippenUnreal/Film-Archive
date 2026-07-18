/* ————————————————————————————————————————————————
   the archive wall: a large quiet surface of prints
   ———————————————————————————————————————————————— */

const Wall = (() => {
  const canvas = document.getElementById('wall-canvas');
  const ctx = canvas.getContext('2d');

  let clusters = [];         // latest layout from /api/wall
  let flags = {};            // photo_id -> {noted, inked, tags, rating}
  let bounds = null;         // of the *visible* layout

  // every print is a node with a position and a target — filtering sends
  // prints floating to their new cluster, quick but without recoil
  const nodes = new Map();   // id -> {x,y,vx,vy,alpha,ta,tx,ty,w,h}
  const labels = new Map();  // folder -> {x,y,tx,ty,alpha,ta,text}
  const FLOAT_K = 0.14;      // exponential approach per frame

  // camera: world point at screen centre + scale
  const cam  = { x: 0, y: 0, s: 0.35 };
  const goal = { x: 0, y: 0, s: 0.35 };

  // thumbnail cache
  const thumbs = new Map();       // id -> {img, ok, alpha}
  let loadQueue = [], loading = 0;
  const MAX_PARALLEL = 6;

  // full-resolution cache for close viewing on the wall
  const fulls = new Map();        // id -> {img, ok, tick}
  let fullLoading = 0;
  const FULL_PARALLEL = 2, FULL_CACHE = 12;
  const THUMB_NATIVE = 512;       // matches the server thumbnail size
  let tick = 0;                   // frame counter for LRU eviction

  let dpr = 1, W = 0, H = 0;
  let rafPending = false;
  let onOpenPhoto = null;

  // opening: prints land from near z-space, each at its own moment
  const INTRO_DUR = 1.5, INTRO_SPREAD = 1.15, INTRO_Z = 0.5;
  let introT0 = 0, introActive = false;
  // leaving (the about page): the landing played backwards — but quicker,
  // a lift rather than a landing — and the wall stays bare until the
  // prints are asked home again
  const OUTRO_DUR = 0.9, OUTRO_SPREAD = 0.65;
  let outroT0 = 0, outroActive = false, outroDone = null, away = false;

  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i); h = Math.imul(h, 16777619);
    }
    return ((h >>> 8) & 0xFFFF) / 0xFFFF;
  }

  function beginIntro() {
    away = false;
    outroActive = false;
    outroDone = null;
    if (!nodes.size) return;
    introActive = true;
    introT0 = performance.now();
    requestDraw();
  }

  function beginOutro(done) {
    if (away || !nodes.size) {
      away = true;
      if (done) done();
      return;
    }
    introActive = false;
    outroActive = true;
    outroT0 = performance.now();
    outroDone = done || null;
    requestDraw();
  }

  // shift-click gathers prints for the light table (at most four)
  const selected = new Set();
  let onSelChange = null;

  function toggleSelect(id) {
    if (selected.has(id)) selected.delete(id);
    else {
      if (selected.size >= 4)
        selected.delete(selected.values().next().value);
      selected.add(id);
    }
    if (onSelChange) onSelChange([...selected]);
    requestDraw();
  }

  function clearSelection() {
    if (!selected.size) return;
    selected.clear();
    if (onSelChange) onSelChange([]);
    requestDraw();
  }

  /* ——— setup ——— */

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    requestDraw();
  }

  function setData(data, animate = true) {
    clusters = data.clusters || [];
    flags = data.flags || {};

    const seen = new Set();
    for (const c of clusters) {
      for (const p of c.photos) {
        seen.add(p.id);
        let n = nodes.get(p.id);
        if (!n) {
          n = {id: p.id, x: p.x, y: p.y, vx: 0, vy: 0,
               alpha: 0, ta: 1, tx: p.x, ty: p.y, w: p.w, h: p.h,
               folder: c.folder};
          nodes.set(p.id, n);
        } else {
          n.tx = p.x; n.ty = p.y; n.ta = 1; n.w = p.w; n.h = p.h;
          n.folder = c.folder;
        }
        if (!animate) {
          n.x = n.tx; n.y = n.ty; n.vx = n.vy = 0; n.alpha = 1;
        }
      }
    }
    for (const [id, n] of nodes)
      if (!seen.has(id)) n.ta = 0;   // filtered away: fade out in place

    const seenL = new Set();
    for (const c of clusters) {
      seenL.add(c.folder);
      let L = labels.get(c.folder);
      if (!L) {
        L = {x: c.x, y: c.y, tx: c.x, ty: c.y, alpha: 0, ta: 1,
             text: c.label};
        labels.set(c.folder, L);
      } else {
        L.tx = c.x; L.ty = c.y; L.ta = 1; L.text = c.label;
      }
      if (!animate) { L.x = L.tx; L.y = L.ty; L.alpha = 1; }
    }
    for (const [f, L] of labels)
      if (!seenL.has(f)) L.ta = 0;

    computeBounds();
    requestDraw();
  }

  function computeBounds() {
    bounds = null;
    for (const [, n] of nodes) {
      if (n.ta <= 0) continue;
      if (!bounds) bounds = {minX: 1e9, minY: 1e9, maxX: -1e9, maxY: -1e9};
      bounds.minX = Math.min(bounds.minX, n.tx - n.w / 2);
      bounds.maxX = Math.max(bounds.maxX, n.tx + n.w / 2);
      bounds.minY = Math.min(bounds.minY, n.ty - n.h / 2);
      bounds.maxY = Math.max(bounds.maxY, n.ty + n.h / 2);
    }
  }

  function fitAll(animate = true) {
    if (W < 50 || H < 50) return;   // minimised / hidden window
    if (!bounds) { goal.x = 0; goal.y = 0; goal.s = 0.5; return; }
    const bw = bounds.maxX - bounds.minX + 500;
    const bh = bounds.maxY - bounds.minY + 500;
    goal.x = (bounds.minX + bounds.maxX) / 2;
    goal.y = (bounds.minY + bounds.maxY) / 2;
    goal.s = Math.min(W / bw, H / bh, 1.4);
    if (!animate) { cam.x = goal.x; cam.y = goal.y; cam.s = goal.s; }
    requestDraw();
  }

  /* ——— coordinates ——— */

  const toScreen = (wx, wy) =>
    [(wx - cam.x) * cam.s + W / 2, (wy - cam.y) * cam.s + H / 2];
  const toWorld = (sx, sy) =>
    [(sx - W / 2) / cam.s + cam.x, (sy - H / 2) / cam.s + cam.y];

  /* ——— image caches ——— */

  function wantThumb(id) {
    let t = thumbs.get(id);
    if (t) return t;
    t = {img: null, ok: false, alpha: 0};
    thumbs.set(id, t);
    loadQueue.push(id);
    pumpQueue();
    return t;
  }

  function pumpQueue() {
    while (loading < MAX_PARALLEL && loadQueue.length) {
      const id = loadQueue.shift();
      const t = thumbs.get(id);
      if (!t || t.img) continue;
      loading++;
      const img = new Image();
      img.onload = () => { t.ok = true; loading--; pumpQueue(); requestDraw(); };
      img.onerror = () => { loading--; pumpQueue(); };
      img.src = '/thumb/' + id + '.jpg';
      t.img = img;
    }
  }

  function wantFull(id) {
    let f = fulls.get(id);
    if (f) { f.tick = tick; return f; }
    if (fullLoading >= FULL_PARALLEL) return null;
    if (fulls.size >= FULL_CACHE) {
      let oldest = null, oldestTick = Infinity;
      for (const [fid, ff] of fulls)
        if (ff.tick < oldestTick) { oldest = fid; oldestTick = ff.tick; }
      if (oldest === null || oldestTick === tick) return null;
      fulls.delete(oldest);
    }
    f = {img: new Image(), ok: false, tick};
    fulls.set(id, f);
    fullLoading++;
    f.img.onload = () => { f.ok = true; fullLoading--; requestDraw(); };
    f.img.onerror = () => { fullLoading--; fulls.delete(id); };
    f.img.src = '/image/' + id;
    return f;
  }

  /* ——— drawing ——— */

  function requestDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(draw);
  }

  function draw() {
    rafPending = false;
    tick++;

    // ease camera toward goal
    const k = 0.16;
    cam.x += (goal.x - cam.x) * k;
    cam.y += (goal.y - cam.y) * k;
    cam.s += (goal.s - cam.s) * k;
    const camSettled = Math.abs(goal.x - cam.x) < 0.3 &&
                       Math.abs(goal.y - cam.y) < 0.3 &&
                       Math.abs(goal.s - cam.s) < 0.0005;
    if (camSettled) { cam.x = goal.x; cam.y = goal.y; cam.s = goal.s; }

    // each print floats home — a smooth glide that settles without bounce
    let moving = false;
    for (const [, n] of nodes) {
      const dx = n.tx - n.x, dy = n.ty - n.y;
      if (Math.abs(dx) > 0.15 || Math.abs(dy) > 0.15) {
        n.x += dx * FLOAT_K;
        n.y += dy * FLOAT_K;
        moving = true;
      } else {
        n.x = n.tx; n.y = n.ty; n.vx = n.vy = 0;
      }
      const da = n.ta - n.alpha;
      if (Math.abs(da) > 0.01) { n.alpha += da * 0.13; moving = true; }
      else n.alpha = n.ta;
    }
    for (const [, L] of labels) {
      const dx = L.tx - L.x, dy = L.ty - L.y;
      if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) {
        L.x += dx * 0.1; L.y += dy * 0.1; moving = true;
      } else { L.x = L.tx; L.y = L.ty; }
      const da = L.ta - L.alpha;
      if (Math.abs(da) > 0.01) { L.alpha += da * 0.1; moving = true; }
      else L.alpha = L.ta;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#FAFAF7';
    ctx.fillRect(0, 0, W, H);

    if (!nodes.size) { if (!camSettled) requestDraw(); return; }
    if (away && !outroActive) { if (!camSettled) requestDraw(); return; }

    // the opening landing: how far along the whole gesture is
    let introNow = 0, outroNow = 0;
    const intro = introActive, outro = outroActive;
    if (intro) {
      introNow = (performance.now() - introT0) / 1000;
      if (introNow > INTRO_SPREAD + INTRO_DUR + 0.15) introActive = false;
    }
    if (outro) {
      outroNow = (performance.now() - outroT0) / 1000;
      if (outroNow > OUTRO_SPREAD + OUTRO_DUR + 0.1) {
        outroActive = false;
        away = true;
        const cb = outroDone;
        outroDone = null;
        if (cb) setTimeout(cb, 0);
      }
    }
    const labIA = intro
      ? Math.max(0, Math.min(1, (introNow - 0.7) / 0.9))
      : outro ? Math.max(0, 1 - outroNow / 0.45) : 1;

    const [vx0, vy0] = toWorld(-160, -160);
    const [vx1, vy1] = toWorld(W + 160, H + 160);
    let fading = false;

    // cluster labels — small, grey, above each group
    for (const [, L] of labels) {
      if (L.alpha <= 0.02 || labIA <= 0) continue;
      const [lx, ly] = toScreen(L.x, L.y - 26);
      if (lx < -300 || lx > W + 300 || ly < -60 || ly > H + 60) continue;
      const px = Math.max(10, Math.min(13, 11 * Math.sqrt(cam.s / 0.35)));
      ctx.font = `300 ${px}px "Helvetica Neue","Segoe UI",sans-serif`;
      ctx.fillStyle = `rgba(138,138,132,${0.85 * L.alpha * labIA})`;
      ctx.textAlign = 'center';
      ctx.fillText(spaced(L.text), lx, ly);
    }

    for (const [, n] of nodes) {
      if (n.alpha <= 0.02) continue;
      const hw = n.w / 2, hh = n.h / 2;
      if (!intro && !outro && (n.x + hw < vx0 || n.x - hw > vx1 ||
                               n.y + hh < vy0 || n.y - hh > vy1)) continue;

      const [sx, sy] = toScreen(n.x, n.y);
      let ix = sx, iy = sy, iz = 1, ia = 1;
      if (intro) {
        // each print starts nearer the eye and eases back to the wall
        const p = (introNow - hash01(n.id) * INTRO_SPREAD) / INTRO_DUR;
        if (p <= 0) { moving = true; continue; }   // not landed yet
        const q = Math.min(1, p);
        const e = 1 - Math.pow(1 - q, 3);          // decelerating landing
        ia = q * q * (3 - 2 * q);                  // slow, smooth fade
        iz = 1 + INTRO_Z * (1 - e);
        ix = W / 2 + (sx - W / 2) * iz;
        iy = H / 2 + (sy - H / 2) * iz;
        if (q < 1) moving = true;
      } else if (outro) {
        // the landing in reverse: the last print to arrive leaves first,
        // lifting off the wall toward the eye and dissolving
        const p = (outroNow - (1 - hash01(n.id)) * OUTRO_SPREAD) / OUTRO_DUR;
        if (p >= 1) { moving = true; continue; }   // already away
        const q = 1 - Math.max(0, p);
        const e = 1 - Math.pow(1 - q, 3);
        ia = q * q * (3 - 2 * q);
        iz = 1 + INTRO_Z * (1 - e);
        ix = W / 2 + (sx - W / 2) * iz;
        iy = H / 2 + (sy - H / 2) * iz;
        moving = true;
      }
      const w = n.w * cam.s * iz, h = n.h * cam.s * iz;

      ctx.save();
      ctx.translate(ix, iy);
      ctx.globalAlpha = n.alpha * ia;

      // soft print shadow
      ctx.shadowColor = 'rgba(70,70,60,0.18)';
      ctx.shadowBlur = Math.max(2, 9 * cam.s);
      ctx.shadowOffsetY = Math.max(1, 3 * cam.s);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(-w / 2, -h / 2, w, h);
      ctx.shadowColor = 'transparent';

      const t = wantThumb(n.id);
      // once a print is shown larger than its thumbnail can carry,
      // quietly swap in the full-resolution image (when settled)
      let full = null;
      if (w * dpr > THUMB_NATIVE * 1.05) {
        full = camSettled && !moving ? wantFull(n.id)
                                     : fulls.get(n.id) || null;
        if (full && !full.ok) full = null;
      }
      if (full) {
        full.tick = tick;
        ctx.drawImage(full.img, -w / 2, -h / 2, w, h);
      } else if (t.ok) {
        if (t.alpha < 1) { t.alpha = Math.min(1, t.alpha + 0.09); fading = true; }
        ctx.globalAlpha = n.alpha * ia * t.alpha;
        ctx.drawImage(t.img, -w / 2, -h / 2, w, h);
        ctx.globalAlpha = n.alpha * ia;
      } else {
        ctx.fillStyle = '#F1F1EB';
        ctx.fillRect(-w / 2, -h / 2, w, h);
      }
      ctx.strokeStyle = 'rgba(0,0,0,0.045)';
      ctx.lineWidth = 1;
      ctx.strokeRect(-w / 2, -h / 2, w, h);

      // a quiet blue ring around prints gathered for the light table
      if (selected.has(n.id)) {
        ctx.strokeStyle = 'rgba(30,67,255,0.6)';
        ctx.lineWidth = 1.2;
        ctx.strokeRect(-w / 2 - 5, -h / 2 - 5, w + 10, h + 10);
      }

      // quiet dots beneath the print: one for notes/marks, one per tag
      const f = flags[n.id];
      if (f) {
        const dots = [];
        if (f.noted || f.inked) dots.push('rgba(138,138,150,0.55)');
        for (const tag of (f.tags || []).slice(0, 8))
          dots.push(tagColor(tag));
        if (dots.length) {
          const r = Math.max(1.2, 2.1 * Math.sqrt(cam.s));
          const gap = Math.max(5, 7 * cam.s);
          const y0 = h / 2 + Math.max(6, 10 * cam.s);
          let x0 = -((dots.length - 1) * gap) / 2;
          for (const col of dots) {
            ctx.fillStyle = col;
            ctx.beginPath();
            ctx.arc(x0, y0, r, 0, Math.PI * 2);
            ctx.fill();
            x0 += gap;
          }
        }
      }
      ctx.restore();
    }

    if (!camSettled || moving || fading) requestDraw();
  }

  function spaced(s) {
    return s.replace(/[_-]+/g, ' ');
  }

  /* ——— interaction ——— */

  let drag = null;
  let clusterDrag = null;   // carry a whole folder of prints (right / Ctrl-drag)

  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // A whole cluster is carried with the right button — or, on a Mac (trackpad
  // with no second button, or by preference), the physical Control key held
  // with the left button. macOS WebKit is the tricky case: a Control-click
  // fires `contextmenu` on mousedown and then *cancels the canvas pointer
  // stream* (pointer capture is dropped and no more pointermove arrives), so a
  // drag started from pointer events silently dies. We therefore start the
  // carry on `mousedown`, preventDefault so WebKit doesn't treat it as its own
  // context-menu gesture, and drive the move/up from window-level *mouse*
  // events — which keep firing through the whole drag on every platform.
  const isClusterButton = e => e.button === 2 || (e.button === 0 && e.ctrlKey);

  function onClusterMove(e) {
    if (!clusterDrag) return;
    const wx = (e.clientX - clusterDrag.x) / cam.s;
    const wy = (e.clientY - clusterDrag.y) / cam.s;
    const ddx = wx - clusterDrag.dx, ddy = wy - clusterDrag.dy;
    clusterDrag.dx = wx; clusterDrag.dy = wy;
    for (const [, n] of nodes) {
      if (n.folder !== clusterDrag.folder) continue;
      n.x += ddx; n.y += ddy; n.tx += ddx; n.ty += ddy;
      n.vx = n.vy = 0;
    }
    const L = labels.get(clusterDrag.folder);
    if (L) { L.x += ddx; L.y += ddy; L.tx += ddx; L.ty += ddy; }
    requestDraw();
  }

  function onClusterUp() {
    window.removeEventListener('mousemove', onClusterMove, true);
    window.removeEventListener('mouseup', onClusterUp, true);
    if (!clusterDrag) return;
    // the cluster keeps its new home, across launches
    if (clusterDrag.dx || clusterDrag.dy)
      API.saveFolderOffset(clusterDrag.folder, clusterDrag.dx, clusterDrag.dy);
    clusterDrag = null;
    computeBounds();
    canvas.style.cursor = 'default';
  }

  canvas.addEventListener('mousedown', e => {
    if (e.button === 1) { e.preventDefault(); return; }   // no middle autoscroll
    if (!isClusterButton(e)) return;
    // ours now: stop the native context-menu / Ctrl-click gesture from eating it
    e.preventDefault();
    const hit = pick(e.clientX, e.clientY);
    if (hit && hit.folder !== undefined) {
      clusterDrag = {folder: hit.folder, x: e.clientX, y: e.clientY,
                     dx: 0, dy: 0};
      canvas.style.cursor = 'grabbing';
      window.addEventListener('mousemove', onClusterMove, true);
      window.addEventListener('mouseup', onClusterUp, true);
    }
  });

  canvas.addEventListener('pointerdown', e => {
    // the cluster carry (right / Ctrl-left) is handled by the mousedown path
    // above via window mouse events; never start a pan or open for it
    if (isClusterButton(e) || clusterDrag) return;
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    if (e.button !== 0 && e.button !== 1) return;   // middle button pans too
    drag = {x: e.clientX, y: e.clientY, moved: false, button: e.button,
            camX: goal.x, camY: goal.y};
  });

  canvas.addEventListener('pointermove', e => {
    if (clusterDrag) return;            // driven by window mouse events
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    if (drag.moved) {
      goal.x = drag.camX - dx / cam.s;
      goal.y = drag.camY - dy / cam.s;
      cam.x = goal.x; cam.y = goal.y;   // pan tracks the hand directly
      requestDraw();
    }
  });

  canvas.addEventListener('pointerup', e => {
    if (clusterDrag) return;            // handled by onClusterUp (window mouseup)
    if (drag && !drag.moved && drag.button === 0) {
      const hit = pick(e.clientX, e.clientY);
      if (hit && e.shiftKey) toggleSelect(hit.id);
      else if (hit && onOpenPhoto) onOpenPhoto(hit.id);
    }
    drag = null;
  });

  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.0016);
    const ns = Math.min(4, Math.max(0.03, goal.s * factor));
    const [wx, wy] = toWorld(e.clientX, e.clientY);
    // keep the point under the cursor fixed
    goal.x = wx - (e.clientX - W / 2) / ns;
    goal.y = wy - (e.clientY - H / 2) / ns;
    goal.s = ns;
    requestDraw();
  }, {passive: false});

  function pick(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    let hit = null;
    for (const [, n] of nodes) {
      if (n.ta <= 0 || n.alpha < 0.5) continue;
      if (Math.abs(wx - n.x) <= n.w / 2 && Math.abs(wy - n.y) <= n.h / 2)
        hit = n;
    }
    return hit;
  }

  // hover cursor
  canvas.addEventListener('pointermove', e => {
    if (clusterDrag) { canvas.style.cursor = 'grabbing'; return; }
    if (drag) { canvas.style.cursor = 'grabbing'; return; }
    canvas.style.cursor = pick(e.clientX, e.clientY) ? 'pointer' : 'default';
  });

  window.addEventListener('resize', resize);
  resize();

  function orderedIds() {
    const out = [];
    for (const c of clusters)
      for (const p of c.photos) out.push(p.id);
    return out;
  }

  return {
    setData, fitAll, requestDraw, beginIntro, beginOutro, orderedIds,
    isAway: () => away,
    selection: () => [...selected],
    clearSelection,
    onSelection(fn) { onSelChange = fn; },
    debug: () => ({cam: {...cam}, goal: {...goal}, bounds, W, H,
                   nodes: nodes.size}),
    step() { rafPending = false; draw(); },   // manual frame (testing)
    setFlags(f) { flags = f; requestDraw(); },
    onOpen(fn) { onOpenPhoto = fn; },
    hasPhotos: () => bounds !== null,
  };
})();
