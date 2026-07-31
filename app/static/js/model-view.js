/* ——— the 3D look — a rudimentary object viewer for OBJ and FBX material ———

   A single click on a 3D file in the Project canvas shows it here; double
   click still hands the file to whatever application owns it.

   Deliberately the lightest thing that can honestly be called a 3D view. The
   geometry arrives from the server as one packed buffer of flat-shaded
   triangles (app/model3d.py), so this file is a plain WebGL renderer — no
   loader, no scene graph, no third-party code, no materials and no textures.
   The lights sit in view space, which keeps the shading constant as the model
   turns: the object rotates, the studio does not.                            */
const ModelView = (() => {
  const view = document.getElementById('model-view');
  const canvas = document.getElementById('model-canvas');
  const titleEl = document.getElementById('model-title');
  const statusEl = document.getElementById('model-status');
  const backBtn = document.getElementById('model-back');

  const VERTEX_SOURCE = `
    attribute vec3 aPos;
    attribute vec3 aNormal;
    uniform mat4 uProjection;
    uniform mat4 uView;
    varying vec3 vNormal;
    void main() {
      /* the view rotation is rigid, so its upper 3x3 carries normals exactly.
         mat3(mat4) is not available in this shading language — take the three
         columns instead. */
      mat3 rotation = mat3(uView[0].xyz, uView[1].xyz, uView[2].xyz);
      vNormal = rotation * aNormal;
      gl_Position = uProjection * uView * vec4(aPos, 1.0);
    }`;

  const FRAGMENT_SOURCE = `
    precision mediump float;
    varying vec3 vNormal;
    void main() {
      vec3 n = normalize(vNormal);
      /* exported meshes are not always consistently wound; a two-sided read
         keeps a stray inverted face from reading as a hole */
      if (!gl_FrontFacing) n = -n;
      vec3 key  = normalize(vec3(-0.32,  0.72,  0.84));
      vec3 fill = normalize(vec3( 0.78,  0.16,  0.42));
      vec3 rim  = normalize(vec3( 0.05, -0.55, -0.72));
      float light = 0.20
        + 0.66 * max(dot(n, key),  0.0)
        + 0.20 * max(dot(n, fill), 0.0)
        + 0.13 * max(dot(n, rim),  0.0);
      vec3 clay = vec3(0.796, 0.792, 0.773);
      gl_FragColor = vec4(clay * light, 1.0);
    }`;

  let gl = null, program = null, buffers = null, locations = null;
  let triangles = 0, target = [0, 0, 0], radius = 1;
  let yaw = 0.65, pitch = 0.42, distance = 4, offsetX = 0, offsetY = 0;
  let frame = 0, open = false, token = 0, onClosed = null;
  const drag = {active: false, id: null, x: 0, y: 0, panning: false};

  function say(text) { statusEl.textContent = text || ''; }

  // ——— context ————————————————————————————————————————————————
  function context() {
    if (gl && !gl.isContextLost()) return gl;
    const options = {alpha: false, antialias: true, depth: true,
      preserveDrawingBuffer: false, powerPreference: 'low-power'};
    gl = canvas.getContext('webgl', options) ||
         canvas.getContext('experimental-webgl', options);
    program = null; buffers = null;
    return gl;
  }
  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }
  function ensureProgram() {
    if (program) return program;
    const vs = compile(gl.VERTEX_SHADER, VERTEX_SOURCE);
    const fs = compile(gl.FRAGMENT_SHADER, FRAGMENT_SOURCE);
    if (!vs || !fs) return null;
    const built = gl.createProgram();
    gl.attachShader(built, vs); gl.attachShader(built, fs);
    gl.linkProgram(built);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(built, gl.LINK_STATUS)) {
      gl.deleteProgram(built); return null;
    }
    program = built;
    locations = {
      position: gl.getAttribLocation(program, 'aPos'),
      normal: gl.getAttribLocation(program, 'aNormal'),
      projection: gl.getUniformLocation(program, 'uProjection'),
      view: gl.getUniformLocation(program, 'uView'),
    };
    return program;
  }

  // ——— geometry ———————————————————————————————————————————————
  function readBuffer(bytes) {
    if (bytes.byteLength < 40) throw new Error('short');
    const head = new DataView(bytes);
    if (head.getUint32(0, false) !== 0x4133444d) throw new Error('magic');
    const count = head.getUint32(8, true);
    if (!count) throw new Error('empty');
    const min = [head.getFloat32(12, true), head.getFloat32(16, true),
                 head.getFloat32(20, true)];
    const max = [head.getFloat32(24, true), head.getFloat32(28, true),
                 head.getFloat32(32, true)];
    const positions = new Float32Array(bytes, 40, count * 9);
    const normals = new Int8Array(bytes, 40 + count * 36, count * 9);
    return {count, min, max, positions, normals};
  }
  function upload(mesh) {
    releaseBuffers();
    buffers = {position: gl.createBuffer(), normal: gl.createBuffer()};
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.normals, gl.STATIC_DRAW);
    triangles = mesh.count;
    target = [(mesh.min[0] + mesh.max[0]) / 2,
              (mesh.min[1] + mesh.max[1]) / 2,
              (mesh.min[2] + mesh.max[2]) / 2];
    radius = Math.max(1e-4, 0.5 * Math.hypot(
      mesh.max[0] - mesh.min[0], mesh.max[1] - mesh.min[1],
      mesh.max[2] - mesh.min[2]));
    reframe();
  }
  function releaseBuffers() {
    if (!gl || !buffers) { buffers = null; triangles = 0; return; }
    gl.deleteBuffer(buffers.position); gl.deleteBuffer(buffers.normal);
    buffers = null; triangles = 0;
  }

  // ——— camera —————————————————————————————————————————————————
  const FOV = 0.62;
  function reframe() {
    yaw = 0.65; pitch = 0.42; offsetX = 0; offsetY = 0;
    const aspect = Math.max(.2, (canvas.clientWidth || 1) /
      Math.max(1, canvas.clientHeight));
    // fit against the tighter of the two field angles, so neither a tall nor a
    // wide window crops the object
    const half = Math.min(FOV / 2, Math.atan(Math.tan(FOV / 2) * aspect));
    distance = radius / Math.sin(half) * 1.18;
    draw();
  }
  function projection(aspect) {
    const near = Math.max(radius * 0.004, 1e-4);
    const far = distance + radius * 8 + 1;
    const f = 1 / Math.tan(FOV / 2);
    const m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f;
    m[10] = (far + near) / (near - far); m[11] = -1;
    m[14] = 2 * far * near / (near - far);
    return m;
  }
  function viewMatrix() {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    // R = Rx(-pitch) · Ry(-yaw), stored column-major for WebGL
    const r = [cy, 0, -sy,
               sp * sy, cp, sp * cy,
               cp * sy, -sp, cp * cy];
    const m = new Float32Array(16);
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 3; col++) m[col * 4 + row] = r[row * 3 + col];
    const eye = [offsetX, offsetY, -distance];
    for (let row = 0; row < 3; row++)
      m[12 + row] = eye[row] - (r[row * 3] * target[0] +
        r[row * 3 + 1] * target[1] + r[row * 3 + 2] * target[2]);
    m[15] = 1;
    return m;
  }

  // ——— drawing ————————————————————————————————————————————————
  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
  }
  function draw() {
    if (!open) return;
    if (frame) return;
    // one frame per change, never a running loop: the view is still until the
    // pointer moves it
    frame = requestAnimationFrame(() => { frame = 0; render(); });
  }
  function render() {
    if (!open || !context()) return;
    resize();
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.980, 0.980, 0.968, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    // the paper is laid down first, so the view reads as an empty room while
    // the geometry is still being read rather than flashing an unpainted buffer
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!buffers || !ensureProgram()) return;
    gl.useProgram(program);
    gl.uniformMatrix4fv(locations.projection, false,
      projection(canvas.width / Math.max(1, canvas.height)));
    gl.uniformMatrix4fv(locations.view, false, viewMatrix());
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.position);
    gl.enableVertexAttribArray(locations.position);
    gl.vertexAttribPointer(locations.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffers.normal);
    gl.enableVertexAttribArray(locations.normal);
    gl.vertexAttribPointer(locations.normal, 3, gl.BYTE, true, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, triangles * 3);
  }

  // ——— pointer ————————————————————————————————————————————————
  canvas.addEventListener('pointerdown', e => {
    if (!open || drag.active) return;
    drag.active = true; drag.id = e.pointerId;
    drag.x = e.clientX; drag.y = e.clientY;
    drag.panning = e.shiftKey || e.button === 1 || e.button === 2;
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    e.preventDefault();
  });
  // The navigation follows the convention of the applications this material
  // comes out of: an orbit swings the *eye*, so dragging right turns the model
  // away to the left, while a shift-drag carries the model along with the
  // pointer. Inverting either one on its own would read as a bug.
  canvas.addEventListener('pointermove', e => {
    if (!drag.active || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    drag.x = e.clientX; drag.y = e.clientY;
    if (drag.panning) {
      const perPixel = 2 * distance * Math.tan(FOV / 2) /
        Math.max(1, canvas.clientHeight);
      offsetX += dx * perPixel; offsetY -= dy * perPixel;
    } else {
      yaw -= dx * 0.008;
      pitch = Math.max(-1.5, Math.min(1.5, pitch - dy * 0.008));
    }
    draw();
  });
  const endDrag = e => {
    if (!drag.active || (e && e.pointerId !== drag.id)) return;
    drag.active = false; drag.id = null;
    try { canvas.releasePointerCapture(e.pointerId); } catch {}
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('wheel', e => {
    if (!open) return;
    e.preventDefault();
    const step = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.12);
    distance = Math.max(radius * 0.15, Math.min(radius * 60, distance * step));
    draw();
  }, {passive: false});
  canvas.addEventListener('dblclick', reframe);
  canvas.addEventListener('webglcontextlost', e => {
    e.preventDefault(); program = null; buffers = null; triangles = 0;
  });
  window.addEventListener('resize', () => { if (open) draw(); });

  // ——— opening and closing ————————————————————————————————————
  async function show(name, url, onClose) {
    onClosed = typeof onClose === 'function' ? onClose : null;
    titleEl.textContent = name || '';
    open = true;
    view.classList.remove('hidden');
    // a timer, not a frame: the fade must engage even when the window is not
    // painting, the same discipline the rest of the archive keeps
    setTimeout(() => { if (open) view.classList.add('here'); }, 20);
    releaseBuffers();
    say('reading…');
    const mine = ++token;
    if (!context()) { say('this view needs WebGL, which is unavailable here'); return; }
    draw();                       // lay the paper down while the file is read
    let bytes;
    try {
      const res = await fetch(url, {cache: 'no-store'});
      if (!res.ok) throw new Error(String(res.status));
      bytes = await res.arrayBuffer();
    } catch {
      if (mine === token) say('that model has no preview here — double click to open it');
      return;
    }
    if (mine !== token || !open) return;
    try {
      const mesh = readBuffer(bytes);
      if (!context()) throw new Error('gl');
      upload(mesh);
      say(mesh.count.toLocaleString() + ' triangles');
    } catch {
      say('that model could not be read');
    }
  }
  function close() {
    if (!open) return;
    open = false; token++;
    if (frame) { cancelAnimationFrame(frame); frame = 0; }
    releaseBuffers();
    view.classList.remove('here');
    view.classList.add('hidden');
    say('');
    const done = onClosed; onClosed = null;
    if (done) done();
  }

  backBtn.addEventListener('click', close);
  // The viewer owns Escape while it is up. stopImmediatePropagation, not
  // stopPropagation: a key event whose target is the window itself reaches
  // every window listener in registration order regardless of phase, and one
  // Escape must close only this view — never the canvas underneath it too.
  window.addEventListener('keydown', e => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); close();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault(); e.stopImmediatePropagation(); reframe();
    }
  }, true);

  return {
    open: show, close, isOpen: () => open,
    // test hook: draw one frame synchronously, the same pattern the wall,
    // detail table and About field expose
    step() { if (frame) { cancelAnimationFrame(frame); frame = 0; } render(); },
    debug: () => ({open, triangles, radius, distance, yaw, pitch, target,
      offsetX, offsetY}),
  };
})();
window.ModelView = ModelView;
