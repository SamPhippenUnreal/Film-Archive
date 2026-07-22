/* Shared pixel-brush vocabulary used by both photograph and writing contexts.
   Keeping the geometry and animation here means ink, wiggly and future marks
   cannot quietly drift into different implementations again. */
const PixelBrushes = (() => {
  const COLORS = ['#1E43FF', '#3A3A38', '#FFFFFF',
                  '#A96A45', '#8E9F72', '#C0A050', '#7E93A8', '#B08699'];
  const COLOR_NAMES = ['future blue', 'dark grey', 'white',
                       'clay', 'sage', 'ochre', 'slate', 'rose'];
  const CELL = 2;
  const FUTURE_HOLD = 3600;
  const FUTURE_FADE = 2800;

  function hash01(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i); h = Math.imul(h, 16777619);
    }
    return ((h >>> 8) & 0xFFFF) / 0xFFFF;
  }

  function cellsAround(wx, wy, brush) {
    const cx = Math.floor(wx / CELL), cy = Math.floor(wy / CELL);
    const out = [];
    const r = brush - 1;
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        if (dx * dx + dy * dy <= r * r + 0.4)
          out.push([cx + dx, cy + dy]);
    return out;
  }

  function strokeLine(x0, y0, x1, y1, apply) {
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.ceil(dist / (CELL * 0.6)));
    for (let i = 0; i <= steps; i++)
      apply(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
  }

  const visible = (sx, sy, cs, width, height) =>
    sx >= -cs && sx <= width + cs && sy >= -cs && sy <= height + cs;

  // A mark's colour is stored either as a legacy palette index (0..n, used by
  // the writing workspace and by older saved annotations) or as a literal hex
  // string (the photograph editor's free HSL colour). Resolve both, so a single
  // photograph can mix marks drawn under either scheme.
  function colorOf(c) {
    if (typeof c === 'string' && c.charAt(0) === '#') return c;
    return COLORS[c] || COLORS[1];
  }

  function hslToHex(h, s, l) {
    s /= 100; l /= 100;
    const k = n => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => Math.round(255 * (l - a * Math.max(-1,
      Math.min(k(n) - 3, 9 - k(n), 1)))).toString(16).padStart(2, '0');
    return '#' + f(0) + f(8) + f(4);
  }

  const rasterCache = new Map();
  function textRaster(str, sizeCells) {
    const key = str + '|' + sizeCells;
    let raster = rasterCache.get(key);
    if (raster) return raster;
    if (rasterCache.size > 80) rasterCache.clear();
    const ss = 3;
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', {willReadFrequently: true});
    const font = (sizeCells * ss) + 'px "Times New Roman", Times, Georgia, serif';
    context.font = font;
    const width = Math.ceil(context.measureText(str).width) + ss * 2;
    const height = Math.ceil(sizeCells * ss * 1.45);
    canvas.width = width; canvas.height = height;
    context.font = font; context.textBaseline = 'top'; context.fillStyle = '#000';
    context.fillText(str, ss, 0);
    const data = context.getImageData(0, 0, width, height).data;
    const offsets = [];
    let wc = 0, hc = 0;
    for (let cy = 0; cy * ss < height; cy++) {
      for (let cx = 0; cx * ss < width; cx++) {
        let alpha = 0;
        for (let sy = 0; sy < ss; sy++)
          for (let sx = 0; sx < ss; sx++) {
            const x = cx * ss + sx, y = cy * ss + sy;
            if (x < width && y < height) alpha += data[(y * width + x) * 4 + 3];
          }
        if (alpha / (ss * ss) > 92) {
          offsets.push([cx, cy]);
          wc = Math.max(wc, cx); hc = Math.max(hc, cy);
        }
      }
    }
    raster = {offsets, wc, hc};
    rasterCache.set(key, raster);
    return raster;
  }

  function paintInk(ctx, ink, {toScreen, scale, width, height}) {
    const cs = CELL * scale;
    for (const [key, c] of ink) {
      const i = key.indexOf(',');
      const cx = +key.slice(0, i), cy = +key.slice(i + 1);
      const [sx, sy] = toScreen((cx + 0.5) * CELL, (cy + 0.5) * CELL);
      if (!visible(sx, sy, cs, width, height)) continue;
      ctx.fillStyle = colorOf(c);
      ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
    }
  }

  function paintWiggly(ctx, wig, {toScreen, scale, width, height, now}) {
    if (!wig.size) return false;
    const cs = CELL * scale;
    const frame = (now / 125) | 0;
    const cell = (fx, fy, c) => {
      const [sx, sy] = toScreen((fx + 0.5) * CELL, (fy + 0.5) * CELL);
      if (!visible(sx, sy, cs, width, height)) return;
      ctx.fillStyle = colorOf(c);
      ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
    };
    const WB = 4;
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
    return true;
  }

  function paintFuture(ctx, future, {toScreen, scale, width, height, now}) {
    if (!future.size) return false;
    const cs = CELL * scale;
    let animating = false;
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
        if (hash01(key + '~' + ((now / 90) | 0)) < q * 0.5) continue;
      }
      const i = key.indexOf(',');
      const cx = +key.slice(0, i), cy = +key.slice(i + 1);
      const [sx, sy] = toScreen((cx + 0.5) * CELL, (cy + 0.5) * CELL);
      if (!visible(sx, sy, cs, width, height)) continue;
      ctx.globalAlpha = a;
      ctx.fillStyle = colorOf(f.c);
      ctx.fillRect(sx - cs / 2, sy - cs / 2, cs + 0.5, cs + 0.5);
    }
    ctx.globalAlpha = 1;
    return animating;
  }

  function mapsFrom(data) {
    const ink = new Map(), wig = new Map();
    if (!data || typeof data !== 'object') return {ink, wig};
    const factor = (data.cellSize || CELL) / CELL;
    const f = v => Math.round(v * factor);
    for (const [x, y, c] of data.cells || []) ink.set(f(x) + ',' + f(y), c);
    for (const [x, y, c] of data.wiggly || []) wig.set(f(x) + ',' + f(y), c);
    return {ink, wig};
  }

  function serialize(ink, wig) {
    const unpack = map => [...map].map(([key, c]) => {
      const i = key.indexOf(',');
      return [+key.slice(0, i), +key.slice(i + 1), c];
    });
    return {cellSize: CELL, cells: unpack(ink), wiggly: unpack(wig)};
  }

  return {COLORS, COLOR_NAMES, CELL, FUTURE_HOLD, FUTURE_FADE,
          hash01, colorOf, hslToHex, textRaster, cellsAround, strokeLine,
          paintInk, paintWiggly, paintFuture, mapsFrom, serialize};
})();
