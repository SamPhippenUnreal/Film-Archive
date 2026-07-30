/* ————————————————————————————————————————————————
   the about page: the archive introduces itself.
   behind the whole screen drifts an imagined field of
   slow pastel light; the bracket marks of the logo are
   the only window into it.
   ———————————————————————————————————————————————— */

const About = (() => {
  const view = document.getElementById('about-view');
  const canvas = document.getElementById('about-logo');
  const ctx = canvas.getContext('2d');

  const SIZE = 141;              // logo square, css px
  const FIELD = 48;              // the light field is computed small and
                                 // stretched smooth — its blur is the point
  let dpr = 1, open = false, raf = 0;
  let returnContext = 'photos';

  // the four bracket marks of the wordmark icon (viewBox 0 0 100 100)
  const BRACKETS = [
    'M 33 15 L 24 15 Q 15 15 15 24 L 15 33',
    'M 67 15 L 76 15 Q 85 15 85 24 L 85 33',
    'M 15 67 L 15 76 Q 15 85 24 85 L 33 85',
    'M 85 67 L 85 76 Q 85 85 76 85 L 67 85',
  ].map(d => new Path2D(d));

  /* ——— a small, smooth 3d value noise; time is the third axis, so the
         field undulates in place rather than scrolling past ——— */

  function h3(x, y, z) {
    let n = Math.imul(x, 374761393) ^ Math.imul(y, 668265263)
          ^ Math.imul(z, 1440662683);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  }

  function noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);
    const c000 = h3(xi, yi, zi),     c100 = h3(xi + 1, yi, zi);
    const c010 = h3(xi, yi + 1, zi), c110 = h3(xi + 1, yi + 1, zi);
    const c001 = h3(xi, yi, zi + 1), c101 = h3(xi + 1, yi, zi + 1);
    const c011 = h3(xi, yi + 1, zi + 1), c111 = h3(xi + 1, yi + 1, zi + 1);
    const x0 = c000 + (c100 - c000) * u, x1 = c010 + (c110 - c010) * u;
    const x2 = c001 + (c101 - c001) * u, x3 = c011 + (c111 - c011) * u;
    const y0 = x0 + (x1 - x0) * v, y1 = x2 + (x3 - x2) * v;
    return y0 + (y1 - y0) * w;
  }

  /* ——— the light: broad waves of the app's earthy colours at full
         saturation, washed through by passing waves of white ——— */

  const STOPS = [
    [201, 139,  98],   // clay
    [216, 150, 105],   // soft orange
    [214, 178,  96],   // ochre
    [151, 178, 120],   // sage
    [130, 160, 190],   // slate
    [134, 166, 204],   // soft blue
    [214, 156, 182],   // soft pink
    [200, 144, 170],   // rose
    [201, 139,  98],   // back to clay, so the ramp has no seam
  ];
  const BRIGHT = [255, 250, 240];

  const fieldCanvas = document.createElement('canvas');
  fieldCanvas.width = FIELD; fieldCanvas.height = FIELD;
  const fctx = fieldCanvas.getContext('2d');
  const fieldData = fctx.createImageData(FIELD, FIELD);
  // the halo has its own copy of the light whose alpha follows the white
  // waves, so the edges glow only where and while the light is passing
  const glowFieldCanvas = document.createElement('canvas');
  glowFieldCanvas.width = FIELD; glowFieldCanvas.height = FIELD;
  const gfctx = glowFieldCanvas.getContext('2d');
  const glowData = gfctx.createImageData(FIELD, FIELD);

  // Project covers render a slightly softer, lighter variation of the shared
  // light field: saturation reduced 10%, lightness raised 5%. The About page
  // itself is never adjusted, so the treatment is opt-in per draw (see below).
  function softenForCover(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    s = Math.max(0, Math.min(1, s * 0.9));      // −10% saturation
    l = Math.max(0, Math.min(1, l * 1.05));     // +5% lightness
    if (s === 0) return [l * 255, l * 255, l * 255];
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const channel = tc => {
      if (tc < 0) tc += 1; else if (tc > 1) tc -= 1;
      if (tc < 1 / 6) return p + (q - p) * 6 * tc;
      if (tc < 1 / 2) return q;
      if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
      return p;
    };
    return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
  }

  function drawField(t, seed = 0, includeGlow = true, soften = false) {
    const d = fieldData.data;
    const gd = includeGlow ? glowData.data : null;
    const sx = seed * 997.3;
    const sy = seed * 619.7;
    const sz = seed * 431.9;
    let i = 0;
    for (let py = 0; py < FIELD; py++) {
      for (let px = 0; px < FIELD; px++) {
        const x = px / FIELD, y = py / FIELD;
        // Low-frequency domain warping keeps the colour regions broad and
        // calm. Seed offsets give every mounted cover its own field.
        const wx = noise3(x * 0.72 + 13.7 + sx,
                          y * 0.72 + sy, t * 0.5 + sz) - 0.5;
        const wy = noise3(x * 0.72 + sx,
                          y * 0.72 + 91.3 + sy, t * 0.5 + 40 + sz) - 0.5;
        let n = noise3(x * 0.82 + wx * 1.4 + t * 0.6 + sx,
                       y * 0.82 + wy * 1.4 + sy, t * 0.8 + sz);
        n = n * 0.82 + 0.18 * noise3(
          x * 1.65 + 7 + sx, y * 1.65 + sy, t * 1.1 + sz);
        // value noise huddles around the middle of its range, which would
        // leave the ends of the ramp — the warm hues — almost unvisited;
        // stretched a little, the waves wander the whole ramp
        n = 0.5 + (n - 0.5) * 1.5;
        // colour: where along the ramp this wave sits
        const f = Math.min(0.999, Math.max(0, n)) * (STOPS.length - 1);
        const s0 = STOPS[f | 0], s1 = STOPS[(f | 0) + 1], fr = f - (f | 0);
        let r = s0[0] + (s1[0] - s0[0]) * fr;
        let g = s0[1] + (s1[1] - s0[1]) * fr;
        let b = s0[2] + (s1[2] - s0[2]) * fr;
        // the white: a separate, broad wave of light passing through —
        // where it runs the colour lifts to white, elsewhere it stays deep
        const nb = noise3(x * 0.64 + 310 + sx,
                          y * 0.64 + 47 + sy, t * 0.7 + sz);
        let lum = (nb - 0.48) / 0.3;
        lum = Math.max(0, Math.min(1, lum));
        // never all the way to white: the hue survives even in the light
        lum = lum * lum * (3 - 2 * lum) * 0.85;
        r += (BRIGHT[0] - r) * lum;
        g += (BRIGHT[1] - g) * lum;
        b += (BRIGHT[2] - b) * lum;
        if (soften) {
          const soft = softenForCover(r, g, b);
          d[i] = soft[0]; d[i + 1] = soft[1]; d[i + 2] = soft[2];
        } else {
          d[i] = r; d[i + 1] = g; d[i + 2] = b;
        }
        d[i + 3] = 255;
        if (gd) {
          // the glow copy belongs to the About field only (includeGlow), which
          // is never softened, so it keeps the unadjusted colour
          gd[i] = r; gd[i + 1] = g; gd[i + 2] = b;
          gd[i + 3] = 25 + 215 * lum;
        }
        i += 4;
      }
    }
    fctx.putImageData(fieldData, 0, 0);
    if (includeGlow) gfctx.putImageData(glowData, 0, 0);
  }

  // Empty Project covers use seeded variations of this exact light field.
  // Their palette and motion stay related to About without moving in lockstep.
  const noiseSurfaces = new Map();
  const SURFACE_FRAME_MS = 70;
  let noiseRaf = 0, noiseLastFrame = 0;
  function noiseSurfaceFrame(now) {
    noiseRaf = 0;
    if (!noiseSurfaces.size) return;
    if (now - noiseLastFrame < SURFACE_FRAME_MS) {
      noiseRaf = requestAnimationFrame(noiseSurfaceFrame);
      return;
    }
    noiseLastFrame = now;
    const ratio = window.devicePixelRatio || 1;
    for (const [surface, variation] of [...noiseSurfaces]) {
      if (!surface.isConnected) {
        noiseSurfaces.delete(surface);
        continue;
      }
      drawField(now / 4000 + variation.phase, variation.seed, false, true);
      const width = Math.max(1, Math.round((surface.clientWidth || 1) * ratio));
      const height = Math.max(1, Math.round((surface.clientHeight || 1) * ratio));
      if (surface.width !== width) surface.width = width;
      if (surface.height !== height) surface.height = height;
      const surfaceContext = surface.getContext('2d');
      surfaceContext.imageSmoothingEnabled = true;
      surfaceContext.imageSmoothingQuality = 'high';
      surfaceContext.clearRect(0, 0, width, height);
      surfaceContext.drawImage(fieldCanvas, 0, 0, width, height);
    }
    if (noiseSurfaces.size) noiseRaf = requestAnimationFrame(noiseSurfaceFrame);
  }
  function randomNoiseSeed() {
    if (globalThis.crypto &&
        typeof globalThis.crypto.getRandomValues === 'function') {
      const value = new Uint32Array(1);
      globalThis.crypto.getRandomValues(value);
      return value[0] / 4294967296;
    }
    return Math.random();
  }
  function mountNoise(surface) {
    if (!surface || typeof surface.getContext !== 'function') return;
    if (!noiseSurfaces.has(surface)) {
      noiseSurfaces.set(surface, {
        seed: randomNoiseSeed(),
        phase: randomNoiseSeed() * 12,
      });
    }
    if (!noiseRaf) noiseRaf = requestAnimationFrame(noiseSurfaceFrame);
  }

  /* Empty Project covers use the *same* moving colour field as a hidden value
     map.  Its luminance drives a quiet grid of grey dots: light regions grow
     and lift, dark regions shrink and deepen.  This stays separate from the
     About renderer so the wordmark remains pixel-for-pixel unchanged. */
  const projectDotSurfaces = new Map();
  const DOT_FRAME_MS = 72;
  const reducedMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let projectDotRaf = 0, projectDotLastFrame = 0;

  function stableSurfaceSeed(value) {
    let hash = 2166136261;
    for (const ch of String(value || 'project')) {
      hash ^= ch.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967296;
  }

  function drawProjectDots(surface, variation, now) {
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const cssWidth = Math.max(1, surface.clientWidth || 1);
    const cssHeight = Math.max(1, surface.clientHeight || 1);
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (surface.width !== width) surface.width = width;
    if (surface.height !== height) surface.height = height;

    const still = reducedMotion && reducedMotion.matches;
    const time = still ? variation.phase : now / 4000 + variation.phase;
    drawField(time, variation.seed, false, false);

    const g = surface.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, cssWidth, cssHeight);
    const spacing = 13;
    const cols = Math.ceil(cssWidth / spacing) + 1;
    const rows = Math.ceil(cssHeight / spacing) + 1;
    const breathe = still ? 0 : now / 2600;
    for (let row = -1; row < rows; row++) {
      for (let col = -1; col < cols; col++) {
        const bx = col * spacing + spacing / 2;
        const by = row * spacing + spacing / 2;
        const px = Math.max(0, Math.min(FIELD - 1,
          Math.round((bx / cssWidth) * (FIELD - 1))));
        const py = Math.max(0, Math.min(FIELD - 1,
          Math.round((by / cssHeight) * (FIELD - 1))));
        const offset = (py * FIELD + px) * 4;
        const luma = (fieldData.data[offset] * .2126 +
          fieldData.data[offset + 1] * .7152 +
          fieldData.data[offset + 2] * .0722) / 255;
        const radius = .85 + luma * 2.25 +
          (still ? 0 : Math.sin(breathe + col * .38 + row * .31) * .10);
        const gray = Math.round(70 + luma * 118);
        const driftX = still ? 0 : Math.sin(breathe * .55 + row * .47 + variation.seed * 9) * .55;
        const driftY = still ? 0 : Math.cos(breathe * .48 + col * .43 + variation.seed * 7) * .55;
        g.fillStyle = `rgb(${gray},${gray},${gray})`;
        g.beginPath();
        g.arc(bx + driftX, by + driftY, Math.max(.6, radius), 0, Math.PI * 2);
        g.fill();
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  function ensureProjectDotLoop() {
    if (!projectDotRaf && projectDotSurfaces.size)
      projectDotRaf = requestAnimationFrame(projectDotFrame);
  }

  function projectDotFrame(now) {
    projectDotRaf = 0;
    if (!projectDotSurfaces.size || document.hidden) return;
    const still = reducedMotion && reducedMotion.matches;
    if (!still && now - projectDotLastFrame < DOT_FRAME_MS) {
      ensureProjectDotLoop(); return;
    }
    projectDotLastFrame = now;
    let animated = false;
    for (const [surface, variation] of [...projectDotSurfaces]) {
      if (!surface.isConnected) {
        projectDotObserver.unobserve(surface);
        projectDotSurfaces.delete(surface);
        continue;
      }
      if (!variation.visible || !surface.clientWidth || !surface.clientHeight)
        continue;
      drawProjectDots(surface, variation, now);
      if (!still) animated = true;
    }
    if (animated) ensureProjectDotLoop();
  }

  const projectDotObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          const variation = projectDotSurfaces.get(entry.target);
          if (variation) variation.visible = entry.isIntersecting;
        }
        ensureProjectDotLoop();
      }, {rootMargin: '120px'})
    : {observe() {}, unobserve() {}};

  function mountProjectDots(surface, identity) {
    if (!surface || typeof surface.getContext !== 'function') return;
    if (!projectDotSurfaces.has(surface)) {
      projectDotSurfaces.set(surface, {
        seed: stableSurfaceSeed(identity),
        phase: stableSurfaceSeed(String(identity) + ':phase') * 12,
        visible: true,
      });
      projectDotObserver.observe(surface);
    }
    ensureProjectDotLoop();
  }

  function unmountProjectDots(surface) {
    if (!surface || !projectDotSurfaces.has(surface)) return;
    projectDotObserver.unobserve(surface);
    projectDotSurfaces.delete(surface);
    if (!projectDotSurfaces.size && projectDotRaf) {
      cancelAnimationFrame(projectDotRaf);
      projectDotRaf = 0;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) ensureProjectDotLoop();
  });
  if (reducedMotion) {
    const motionChanged = () => ensureProjectDotLoop();
    if (typeof reducedMotion.addEventListener === 'function')
      reducedMotion.addEventListener('change', motionChanged);
    else if (typeof reducedMotion.addListener === 'function')
      reducedMotion.addListener(motionChanged);
  }

  /* ——— the stencil: the brackets sharp, and a soft widened copy through
         which the light bleeds just past the edges — the brighter the wave
         passing an edge, the more that edge glows ——— */

  const sharpMask = document.createElement('canvas');
  const glowMask = document.createElement('canvas');
  const temp = document.createElement('canvas');
  const tctx = temp.getContext('2d');

  function strokeMask(c, passes) {
    const g = c.getContext('2d');
    const k = (SIZE * dpr) / 100;
    g.setTransform(k, 0, 0, k, 0, 0);
    g.clearRect(0, 0, 100, 100);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const [lw, a] of passes) {
      g.strokeStyle = `rgba(255,255,255,${a})`;
      g.lineWidth = lw;
      for (const p of BRACKETS) g.stroke(p);
    }
  }

  function sizeCanvas() {
    dpr = window.devicePixelRatio || 1;
    const s = SIZE * dpr;
    canvas.width = s; canvas.height = s;
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    for (const c of [sharpMask, glowMask, temp]) {
      c.width = s; c.height = s;
    }
    strokeMask(sharpMask, [[7, 1]]);
    strokeMask(glowMask, [[15, 0.06], [11.5, 0.10], [9, 0.16]]);
  }

  function frame() {
    if (!open) return;
    drawField(performance.now() / 4000);
    const s = SIZE * dpr;
    ctx.clearRect(0, 0, s, s);
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    // the halo first: light spilling a little past the stencil, only as
    // strong as the wave of white passing that part of the shape
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, s, s);
    tctx.drawImage(glowFieldCanvas, 0, 0, s, s);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(glowMask, 0, 0);
    ctx.drawImage(temp, 0, 0);
    // then the window itself
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, s, s);
    tctx.drawImage(fieldCanvas, 0, 0, s, s);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(sharpMask, 0, 0);
    ctx.drawImage(temp, 0, 0);
    raf = requestAnimationFrame(frame);
  }

  /* ——— arriving and leaving ——— */

  function show() {
    if (open) return;
    returnContext = window.ContextNav ? window.ContextNav.active() : 'photos';
    open = true;
    sizeCanvas();
    document.body.classList.add('about-open');
    Wall.beginOutro(() => {});     // the prints lift away as they once landed
    view.classList.add('veiled');
    view.classList.add('arriving');   // …and the page fades in with them
    view.classList.remove('hidden');
    void view.offsetWidth;            // settle the starting styles
    requestAnimationFrame(() => view.classList.remove('veiled'));
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    document.body.classList.remove('about-open');
    view.classList.remove('arriving');   // leaving is quicker than arriving
    view.classList.add('veiled');
    setTimeout(() => {
      view.classList.add('hidden');
      view.classList.remove('veiled');
    }, 600);
    if (window.ContextNav) window.ContextNav.resume(returnContext);
    else Wall.beginIntro();
  }

  view.addEventListener('pointerdown', close);
  for (const el of document.querySelectorAll('#wordmark-btn, .wordmark-icon'))
    el.addEventListener('click', show);

  return {
    show, close, mountNoise, mountProjectDots, unmountProjectDots,
    showFromContext(leaveContext) {
      returnContext = window.ContextNav ? window.ContextNav.active() : 'photos';
      if (typeof leaveContext === 'function') leaveContext();
      setTimeout(() => {
        // show() normally remembers the visible context.  Here it was already
        // lifted, so preserve the context captured before its leave animation.
        const destination = returnContext;
        show();
        returnContext = destination;
      }, 500);
    },
    isOpen: () => open,
    step() { if (!open) return; cancelAnimationFrame(raf); frame(); },   // manual frame (testing)
  };
})();
