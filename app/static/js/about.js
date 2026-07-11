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

  const SIZE = 128;              // logo square, css px
  const FIELD = 48;              // the light field is computed small and
                                 // stretched smooth — its blur is the point
  let dpr = 1, open = false, raf = 0;

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
    [151, 178, 120],   // sage
    [130, 160, 190],   // slate
    [214, 178,  96],   // ochre
    [200, 144, 170],   // rose
    [201, 139,  98],   // back to clay, so the ramp has no seam
  ];
  const BRIGHT = [255, 253, 248];

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

  function drawField(t) {
    const d = fieldData.data;
    const gd = glowData.data;
    let i = 0;
    for (let py = 0; py < FIELD; py++) {
      for (let px = 0; px < FIELD; px++) {
        const x = px / FIELD, y = py / FIELD;
        // a gentle domain warp keeps the waves organic, never repeating
        const wx = noise3(x * 1.15 + 13.7, y * 1.15, t * 0.5) - 0.5;
        const wy = noise3(x * 1.15, y * 1.15 + 91.3, t * 0.5 + 40) - 0.5;
        let n = noise3(x * 1.35 + wx * 1.4 + t * 0.6,
                       y * 1.35 + wy * 1.4, t * 0.8);
        n = n * 0.8 + 0.2 * noise3(x * 2.8 + 7, y * 2.8, t * 1.1);
        // colour: where along the ramp this wave sits
        const f = Math.min(0.999, Math.max(0, n)) * (STOPS.length - 1);
        const s0 = STOPS[f | 0], s1 = STOPS[(f | 0) + 1], fr = f - (f | 0);
        let r = s0[0] + (s1[0] - s0[0]) * fr;
        let g = s0[1] + (s1[1] - s0[1]) * fr;
        let b = s0[2] + (s1[2] - s0[2]) * fr;
        // the white: a separate, broad wave of light passing through —
        // where it runs the colour lifts to white, elsewhere it stays deep
        const nb = noise3(x * 1.05 + 310, y * 1.05 + 47, t * 0.7);
        let lum = (nb - 0.48) / 0.3;
        lum = Math.max(0, Math.min(1, lum));
        lum = lum * lum * (3 - 2 * lum);
        r += (BRIGHT[0] - r) * lum;
        g += (BRIGHT[1] - g) * lum;
        b += (BRIGHT[2] - b) * lum;
        d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
        gd[i] = r; gd[i + 1] = g; gd[i + 2] = b;
        gd[i + 3] = 25 + 215 * lum;
        i += 4;
      }
    }
    fctx.putImageData(fieldData, 0, 0);
    gfctx.putImageData(glowData, 0, 0);
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
    open = true;
    sizeCanvas();
    document.body.classList.add('about-open');
    Wall.beginOutro(() => {});     // the prints lift away as they once landed
    view.classList.remove('hidden');
    view.classList.add('veiled');
    requestAnimationFrame(() => view.classList.remove('veiled'));
    raf = requestAnimationFrame(frame);
  }

  function close() {
    if (!open) return;
    open = false;
    cancelAnimationFrame(raf);
    document.body.classList.remove('about-open');
    view.classList.add('veiled');
    setTimeout(() => {
      view.classList.add('hidden');
      view.classList.remove('veiled');
    }, 600);
    Wall.beginIntro();             // and the archive returns
  }

  view.addEventListener('pointerdown', close);
  for (const el of document.querySelectorAll('#wordmark-btn, .wordmark-icon'))
    el.addEventListener('click', show);

  return {
    show, close,
    isOpen: () => open,
    step() { if (!open) return; cancelAnimationFrame(raf); frame(); },   // manual frame (testing)
  };
})();
