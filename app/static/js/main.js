/* boot, view switching, scan status, filtering */
(() => {
  const boot = document.getElementById('boot-overlay');
  const bootStatus = document.getElementById('boot-status');

  /* ——— splash: the mark surfaces out of the paper, unevenly, like a
         print developing — then dissolves, and the wall lands ——— */
  const Splash = (() => {
    const cv = document.getElementById('splash-canvas');
    const cctx = cv.getContext('2d');
    const D_IN = 1150;         // ms for the noise-driven surfacing
    const HOLD = 380;          // ms of stillness once fully present
    const SPREAD = 0.55;       // how far apart the parts' moments are
    let src = null, noise = null, out = null, px = 0;
    let t0 = 0, dataReady = false, outStarted = false, done = false;
    let imgFailed = false, onDone = null;

    const ease = t => t < 0.5 ? 4 * t * t * t
                              : 1 - Math.pow(-2 * t + 2, 3) / 2;

    function build(img) {
      const dpr = window.devicePixelRatio || 1;
      const css = Math.round(Math.min(
        210, window.innerWidth * 0.26, window.innerHeight * 0.26));
      px = Math.max(64, Math.round(css * dpr));
      cv.width = px; cv.height = px;
      cv.style.width = css + 'px';
      cv.style.height = css + 'px';

      const oc = document.createElement('canvas');
      oc.width = px; oc.height = px;
      const octx = oc.getContext('2d', {willReadFrequently: true});
      octx.drawImage(img, 0, 0, px, px);
      src = octx.getImageData(0, 0, px, px).data;

      // smooth value noise: two octaves of an upscaled random grid
      noise = new Float32Array(px * px);
      const octave = (n, amt) => {
        const gc = document.createElement('canvas');
        gc.width = n; gc.height = n;
        const g = gc.getContext('2d');
        const im = g.createImageData(n, n);
        for (let i = 0; i < n * n; i++) {
          im.data[i * 4] = Math.random() * 255;
          im.data[i * 4 + 3] = 255;
        }
        g.putImageData(im, 0, 0);
        octx.imageSmoothingEnabled = true;
        octx.imageSmoothingQuality = 'high';
        octx.clearRect(0, 0, px, px);
        octx.drawImage(gc, 0, 0, px, px);
        const d = octx.getImageData(0, 0, px, px).data;
        for (let i = 0; i < px * px; i++) noise[i] += d[i * 4] / 255 * amt;
      };
      octave(6, 0.68);
      octave(18, 0.32);

      out = cctx.createImageData(px, px);
      for (let i = 0; i < px * px; i++) {
        out.data[i * 4]     = src[i * 4];
        out.data[i * 4 + 1] = src[i * 4 + 1];
        out.data[i * 4 + 2] = src[i * 4 + 2];
      }
    }

    // q 0..1 — each pixel surfaces at its own noise-chosen moment
    function frame(q) {
      if (!out) return;
      for (let i = 0; i < px * px; i++) {
        const a = src[i * 4 + 3];
        let v = 0;
        if (a) {
          const lp = q * (1 + SPREAD) - noise[i] * SPREAD;
          v = lp <= 0 ? 0 : lp >= 1 ? a : a * lp * lp * (3 - 2 * lp);
        }
        out.data[i * 4 + 3] = v;
      }
      cctx.putImageData(out, 0, 0);
    }

    function tick() {
      if (outStarted) return;
      const el = performance.now() - t0;
      frame(ease(Math.min(1, el / D_IN)));
      if (el >= D_IN + HOLD && dataReady) { beginOut(); return; }
      requestAnimationFrame(tick);
    }

    function beginOut() {
      if (outStarted) return;
      outStarted = true;
      frame(1);
      cv.style.opacity = '0';        // easy-out, via the css transition
      setTimeout(() => {
        done = true;
        boot.classList.add('fading');
        if (onDone) onDone();        // the wall begins to land
        setTimeout(() => boot.classList.add('hidden'), 600);
      }, 750);
    }

    function start() {
      const img = new Image();
      img.onload = () => {
        try { build(img); } catch { imgFailed = true; }
        t0 = performance.now();
        if (!imgFailed) tick();
        else if (dataReady) beginOut();
      };
      img.onerror = () => {
        imgFailed = true;
        if (dataReady) beginOut();
      };
      img.src = '/static/logo.png';
      // never trap the archive behind the splash
      const guard = setInterval(() => {
        if (outStarted) { clearInterval(guard); return; }
        if (dataReady && performance.now() - t0 > D_IN + HOLD + 2500) {
          clearInterval(guard);
          beginOut();
        }
      }, 1000);
    }

    return {
      start,
      dataIsReady() {
        if (dataReady) return;
        dataReady = true;
        if (imgFailed) beginOut();
      },
      isDone: () => done,
      onDone(fn) { onDone = fn; },
      frame, skip: beginOut,         // exposed for testing
    };
  })();
  window.Splash = Splash;
  const wallStatus = document.getElementById('wall-status');
  const emptyState = document.getElementById('empty-state');
  const emptyTitle = document.getElementById('empty-title');
  const emptySub = document.getElementById('empty-sub');
  const folderName = document.getElementById('folder-name');
  const filterBar = document.getElementById('filter-bar');
  const fbStars = [...document.querySelectorAll('.fb-star')];
  const fbMode = document.getElementById('fb-mode');
  const fbTagList = document.getElementById('fb-tag-list');

  let booted = false;
  let lastShown = -1;
  let scanBusy = false;
  let pollTimer = null;
  function kick() { clearTimeout(pollTimer); poll(); }
  const filter = {tags: [], stars: 0, camera: null, film: null, q: ''};
  const filterActive = () =>
    !!(filter.tags.length || filter.stars || filter.camera || filter.film ||
       filter.q);

  const PHASE_TEXT = {
    reading: 'reading archive…',
    thumbs: 'building thumbnails…',
    ready: '',
    error: 'the archive could not be read',
    idle: '',
  };

  function statusText() {
    if (filterActive() && lastShown === 0) return 'nothing matches';
    return '';
  }

  async function refreshWall(animate = true) {
    const data = await API.wall(filter);
    Wall.setData(data, animate && booted);
    if (data.shown !== lastShown) {
      lastShown = data.shown;
      Wall.fitAll(booted);
    }
    updateEmpty(data);
    renderTagList(data.flags);
    renderPlainList('camera', document.getElementById('fb-camera-list'),
                    data.flags, 'no cameras yet');
    renderPlainList('film', document.getElementById('fb-film-list'),
                    data.flags, 'no film types yet');
    renderFilterHints();
    if (!scanBusy) wallStatus.textContent = statusText();
    return data;
  }

  // the centred message when there is nothing to show — either no folder is
  // linked yet, or the linked folder holds no images
  function updateEmpty(data) {
    const show = !data.count;
    emptyState.classList.toggle('hidden', !show);
    if (!show) return;
    if (data.linked) {
      emptyTitle.textContent = 'no photographs here';
      emptySub.innerHTML =
        'this folder holds no images — choose another with ' +
        '<button class="link-btn" id="empty-folder-btn">folder</button>, ' +
        'top-left';
    } else {
      emptyTitle.textContent = 'no folder linked';
      emptySub.innerHTML =
        'use <button class="link-btn" id="empty-folder-btn">folder</button> ' +
        'in the top-left corner to choose the folder<br>that holds your ' +
        'photographs';
    }
    const b = document.getElementById('empty-folder-btn');
    if (b) b.addEventListener('click', chooseFolder);
  }

  /* ——— tag / star filter ——— */

  function renderTagList(flags) {
    const names = new Set();
    for (const id in flags)
      for (const t of (flags[id].tags || [])) names.add(t);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));

    fbTagList.innerHTML = '';
    if (!sorted.length) {
      const s = document.createElement('span');
      s.className = 'fb-none';
      s.textContent = 'no tags yet';
      fbTagList.appendChild(s);
      filter.tags = [];
      return;
    }
    filter.tags = filter.tags.filter(t => names.has(t));
    for (const name of sorted) {
      const chip = document.createElement('button');
      chip.className =
        'tag-chip' + (filter.tags.includes(name) ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => {
        // tags gather: click adds another, click again lets it go
        const i = filter.tags.indexOf(name);
        if (i >= 0) filter.tags.splice(i, 1);
        else filter.tags.push(name);
        refreshWall().then(() => Wall.fitAll(true));
      });
      fbTagList.appendChild(chip);
    }
  }

  function renderPlainList(key, el, flags, emptyText) {
    const names = new Set();
    for (const id in flags)
      if (flags[id][key]) names.add(flags[id][key]);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));

    el.innerHTML = '';
    if (!sorted.length) {
      const s = document.createElement('span');
      s.className = 'fb-none';
      s.textContent = emptyText;
      el.appendChild(s);
      if (filter[key]) filter[key] = null;
      return;
    }
    if (filter[key] && !names.has(filter[key])) filter[key] = null;
    for (const name of sorted) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip' + (filter[key] === name ? ' active' : '');
      chip.textContent = name;
      chip.addEventListener('click', () => {
        filter[key] = (filter[key] === name) ? null : name;
        refreshWall().then(() => Wall.fitAll(true));
      });
      el.appendChild(chip);
    }
  }

  function renderStarFilter() {
    fbStars.forEach((s, i) => s.classList.toggle('on', i < filter.stars));
    fbMode.textContent = filter.stars ? `${filter.stars} ★ and up` : '';
    renderFilterHints();
  }

  // each group stays folded; a small hint shows any active choice
  function renderFilterHints() {
    document.getElementById('fbh-stars').textContent =
      filter.stars ? `${filter.stars} ★ and up` : '';
    document.getElementById('fbh-tags').textContent =
      filter.tags.join(' · ');
    document.getElementById('fbh-camera').textContent = filter.camera || '';
    document.getElementById('fbh-film').textContent = filter.film || '';
  }

  document.querySelectorAll('.fb-group').forEach(btn => {
    btn.addEventListener('click', () => {
      const content = document.querySelector(
        `.fb-content[data-content="${btn.dataset.group}"]`);
      content.classList.toggle('hidden');
      btn.classList.toggle('open', !content.classList.contains('hidden'));
    });
  });

  fbStars.forEach((s, i) => s.addEventListener('click', () => {
    const n = i + 1;
    filter.stars = (filter.stars === n) ? 0 : n;
    renderStarFilter();
    refreshWall().then(() => Wall.fitAll(true));
  }));

  document.getElementById('fb-clear').addEventListener('click', () => {
    filter.tags = [];
    filter.stars = 0;
    filter.camera = null;
    filter.film = null;
    renderStarFilter();
    refreshWall().then(() => Wall.fitAll(true));
  });

  // the filter list hangs just beneath its own word, not the screen edge
  const filterBtn = document.getElementById('btn-filter');
  function placeFilterBar() {
    const r = filterBtn.getBoundingClientRect();
    filterBar.style.right =
      Math.max(12, window.innerWidth - r.right - 2) + 'px';
  }
  filterBtn.addEventListener('click', () => {
    placeFilterBar();
    filterBar.classList.toggle('hidden');
  });
  window.addEventListener('resize', () => {
    if (!filterBar.classList.contains('hidden')) placeFilterBar();
  });

  /* ——— folder: link the app to a folder of photographs ——— */

  const folderBar = document.getElementById('folder-bar');
  const folderInput = document.getElementById('folder-input');
  const folderError = document.getElementById('folder-error');

  function openFolderBar() {
    folderError.textContent = '';
    folderBar.classList.remove('hidden');
    folderInput.focus();
    folderInput.select();
  }
  function closeFolderBar() {
    folderBar.classList.add('hidden');
    folderError.textContent = '';
  }

  // true when running inside the native window (pywebview): a native folder
  // picker is available. In a plain browser it is not, so we fall back to the
  // paste-a-path bar.
  function hasNativePicker() {
    return !!(window.pywebview && window.pywebview.api &&
              typeof window.pywebview.api.pick_folder === 'function');
  }

  // Link (or relink) the app to a folder. Shared by the native picker and the
  // paste-path bar. Returns true on success. `setErr` (optional) receives
  // progress/error text for the paste bar; the native path has no text field.
  async function linkFolder(path, setErr) {
    if (!path) return false;
    if (setErr) setErr('linking…');
    let res;
    try { res = await API.setRoot(path); }
    catch { if (setErr) setErr('could not reach the app'); return false; }
    if (!res || !res.ok) {
      if (setErr) setErr((res && res.error) || 'that folder could not be found');
      return false;
    }
    // a fresh folder: forget the old filters and re-fit to the new archive
    filter.tags = []; filter.stars = 0; filter.camera = null;
    filter.film = null; filter.q = '';
    renderStarFilter();
    lastShown = -1;
    await refreshWall(false);
    kick();     // pick up the new folder's scan progress right away
    return true;
  }

  async function submitFolder() {
    const path = folderInput.value.trim();
    if (!path) { closeFolderBar(); return; }
    const ok = await linkFolder(path, t => { folderError.textContent = t; });
    if (ok) { closeFolderBar(); folderInput.value = ''; }
  }

  // The folder button's primary action: browse natively when we can,
  // otherwise toggle the paste-path bar.
  async function chooseFolder() {
    if (!hasNativePicker()) {
      folderBar.classList.contains('hidden')
        ? openFolderBar() : closeFolderBar();
      return;
    }
    let path;
    try { path = await window.pywebview.api.pick_folder(); }
    catch { path = null; }
    if (!path) return;            // dialog unavailable or the user cancelled
    const ok = await linkFolder(path);
    if (!ok) {
      // Rare: the chosen folder could not be linked. Fall back to the paste
      // bar, pre-filled, so the user can see and adjust the path.
      openFolderBar();
      folderInput.value = path;
      folderError.textContent = 'that folder could not be linked';
    }
  }

  document.getElementById('btn-folder').addEventListener('click', chooseFolder);
  document.getElementById('folder-open')
    .addEventListener('click', submitFolder);
  document.getElementById('folder-cancel')
    .addEventListener('click', closeFolderBar);
  folderInput.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') submitFolder();
    else if (ev.key === 'Escape') closeFolderBar();
  });

  /* ——— scan status ——— */

  let wasBusy = false;

  async function poll() {
    let s;
    try { s = await API.status(); }
    catch { pollTimer = setTimeout(poll, 1200); return; }

    folderName.textContent = s.root || '';

    const busy = s.phase === 'reading' || s.phase === 'thumbs';
    scanBusy = busy;
    let text = PHASE_TEXT[s.phase] ?? '';
    if (s.phase === 'thumbs' && s.total)
      text = `building thumbnails… ${s.done} / ${s.total}`;
    wallStatus.textContent = busy ? text : statusText();
    bootStatus.textContent = text || 'reading archive…';

    if (!booted && (!busy || s.done > 12)) {
      // enough to show the wall; keep indexing quietly behind it
      await refreshWall(false);
      Splash.dataIsReady();
      booted = true;
    } else if (booted && busy && s.done % 24 === 0) {
      refreshWall();   // let new prints appear as they are indexed
    }

    if (busy) {
      wasBusy = true;
      pollTimer = setTimeout(poll, 700);
    } else {
      if (!booted) {
        await refreshWall(false);
        Splash.dataIsReady();
        booted = true;
      } else if (wasBusy) {
        await refreshWall();   // a quiet background scan just finished
      }
      wasBusy = false;
      // keep listening: new rolls dropped into the folder appear on
      // their own (the server watches the disk; we watch the server)
      pollTimer = setTimeout(poll, 12000);
    }
  }

  /* view switching */
  Wall.onOpen(id => {
    Detail.setSequence(Wall.orderedIds());
    Detail.show(id);
  });
  Detail.onBack(() => refreshWall());

  document.getElementById('btn-overview')
    .addEventListener('click', () => Wall.fitAll(true));

  /* ——— search: one quiet line beneath the wordmark ——— */

  const searchInput = document.getElementById('search-input');
  let searchTimer = null;

  function openSearch() {
    searchInput.classList.remove('hidden');
    searchInput.focus();
  }
  function closeSearch() {
    searchInput.value = '';
    searchInput.classList.add('hidden');
    if (filter.q) {
      filter.q = '';
      refreshWall().then(() => Wall.fitAll(true));
    }
  }
  document.getElementById('btn-search').addEventListener('click', () => {
    searchInput.classList.contains('hidden') ? openSearch() : closeSearch();
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const v = searchInput.value.trim();
      if (v === filter.q) return;
      filter.q = v;
      refreshWall().then(() => Wall.fitAll(true));
    }, 260);
  });
  searchInput.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { closeSearch(); searchInput.blur(); }
    else if (ev.key === 'Enter') searchInput.blur();
  });
  searchInput.addEventListener('blur', () => {
    if (!searchInput.value.trim() && !filter.q)
      searchInput.classList.add('hidden');
  });

  /* ——— light table: a few prints laid side by side ——— */

  const tableBar = document.getElementById('table-bar');
  const tableCount = document.getElementById('table-count');
  const tableView = document.getElementById('table-view');
  const tableRow = document.getElementById('table-row');

  Wall.onSelection(ids => {
    tableBar.classList.toggle('hidden', ids.length === 0);
    tableCount.textContent =
      ids.length === 1 ? '1 print' : ids.length + ' prints';
  });

  function openTable() {
    const ids = Wall.selection();
    if (!ids.length) return;
    tableRow.innerHTML = '';
    const taken = 140 + 46 * (ids.length - 1);   // padding + gaps
    for (const id of ids) {
      const img = document.createElement('img');
      img.className = 'table-print';
      img.style.maxWidth = `calc((100vw - ${taken}px) / ${ids.length})`;
      img.onload = () => img.classList.add('here');
      img.src = '/image/' + id;
      img.addEventListener('click', () => {
        Detail.setSequence(ids);
        Detail.show(id);
      });
      tableRow.appendChild(img);
    }
    tableView.classList.remove('hidden');
  }
  document.getElementById('table-open').addEventListener('click', openTable);
  document.getElementById('table-clear')
    .addEventListener('click', () => Wall.clearSelection());
  document.getElementById('table-back')
    .addEventListener('click', () => tableView.classList.add('hidden'));

  /* ——— gradient shelf: every photograph, ordered by colour ——— */

  const gradientView = document.getElementById('gradient-view');
  const gradientGrid = document.getElementById('gradient-grid');

  async function openGradient() {
    let d;
    try { d = await fetch('/api/gradient').then(r => r.json()); }
    catch { return; }
    const items = d.order || [];
    if (!items.length) return;

    // a 5:4 field of colour, hue sweeping from one side to the other
    const n = items.length;
    const cols = Math.max(1, Math.round(Math.sqrt(n * 5 / 4)));
    const rows = Math.ceil(n / cols);
    const availW = window.innerWidth - 120;
    const availH = window.innerHeight - 130;
    let gw = Math.min(availW, availH * 5 / 4);
    let gh = gw * 4 / 5;
    if (gh > availH) { gh = availH; gw = gh * 5 / 4; }

    gradientGrid.classList.remove('here');
    gradientGrid.innerHTML = '';
    gradientGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
    gradientGrid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
    gradientGrid.style.width = gw + 'px';
    gradientGrid.style.height = gh + 'px';

    const ids = items.map(it => it.id);
    for (const it of items) {
      const img = document.createElement('img');
      // its own colour stands in while the print loads
      img.style.background =
        `hsl(${Math.round(it.h * 360)} ${Math.round(it.s * 100)}% ` +
        `${Math.round(it.l * 100)}%)`;
      img.src = '/thumb/' + it.id + '.jpg';
      img.addEventListener('click', () => {
        Detail.setSequence(ids);
        Detail.show(it.id);
      });
      gradientGrid.appendChild(img);
    }
    gradientView.classList.remove('hidden');
    requestAnimationFrame(() => gradientGrid.classList.add('here'));
  }
  document.getElementById('btn-gradient').addEventListener('click', openGradient);
  document.getElementById('gradient-back')
    .addEventListener('click', () => gradientView.classList.add('hidden'));

  /* ——— ambient drift: the archive as a living frame ——— */

  const Ambient = (() => {
    const view = document.getElementById('ambient-view');
    const imgs = [document.createElement('img'), document.createElement('img')];
    imgs.forEach(im => view.appendChild(im));
    const DWELL = 8500, XFADE = 2600;
    let cur = 0, order = [], idx = 0, timer = null;
    let active = false, token = 0;

    function shuffle(a) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = (Math.random() * (i + 1)) | 0;
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }

    async function slide() {
      if (!active) return;
      const t = token;
      const id = order[idx++ % order.length];
      let rot = 0, bw = false;
      try {
        const a = (await API.photo(id)).annotations || {};
        rot = a.rot ? ((a.rot % 4) + 4) % 4 : 0;
        bw = !!a.bw;
      } catch {}
      if (!active || t !== token) return;
      const im = imgs[cur ^= 1];
      const old = imgs[cur ^ 1];
      im.style.transition = 'none';
      im.style.opacity = '0';
      im.style.filter = bw ? 'grayscale(1)' : 'none';
      // a turned photograph needs its bounds swapped
      if (rot % 2) { im.style.maxWidth = '78vh'; im.style.maxHeight = '78vw'; }
      else { im.style.maxWidth = '84vw'; im.style.maxHeight = '82vh'; }
      im.style.transform = `translate(-50%, -50%) rotate(${rot * 90}deg)`;
      im.onload = () => {
        if (!active || t !== token) return;
        void im.offsetWidth;   // settle the starting styles
        // a still photograph; only the light changes
        im.style.transition =
          `opacity ${XFADE}ms cubic-bezier(.45,0,.55,1)`;
        im.style.opacity = '1';
        old.style.transition =
          `opacity ${XFADE}ms cubic-bezier(.45,0,.55,1)`;
        old.style.opacity = '0';
        timer = setTimeout(slide, DWELL);
      };
      im.src = '/image/' + id;
    }

    function enter() {
      order = shuffle(Wall.orderedIds().slice());
      if (!order.length) return;
      idx = 0;
      active = true;
      token++;
      imgs.forEach(im => {
        im.style.transition = 'none';
        im.style.opacity = '0';
      });
      view.classList.remove('hidden');
      slide();
    }
    function exit() {
      if (!active) return;
      active = false;
      token++;
      clearTimeout(timer);
      view.classList.add('hidden');
    }
    view.addEventListener('pointerdown', exit);
    return {enter, exit, isActive: () => active};
  })();
  document.getElementById('btn-ambient')
    .addEventListener('click', () => Ambient.enter());

  /* wall-side keys: search, drift, and quiet retreat */
  window.addEventListener('keydown', e => {
    if (Ambient.isActive()) { Ambient.exit(); e.preventDefault(); return; }
    if (Detail.isOpen()) return;             // the workspace has its own keys
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === '/') { openSearch(); e.preventDefault(); }
    else if (e.key === 'p') Ambient.enter();
    else if (e.key === 'Escape') {
      if (!gradientView.classList.contains('hidden'))
        gradientView.classList.add('hidden');
      else if (!tableView.classList.contains('hidden'))
        tableView.classList.add('hidden');
      else if (Wall.selection().length) Wall.clearSelection();
      else closeSearch();
    }
  });

  renderStarFilter();
  Splash.onDone(() => Wall.beginIntro());
  Splash.start();
  // if reading the archive runs long, let a quiet status line surface
  setTimeout(() => {
    if (!Splash.isDone()) bootStatus.classList.add('show');
  }, 4000);
  poll();
})();
