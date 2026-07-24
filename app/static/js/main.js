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
      // The mark sits on a near-white plate inside the logo, and the boot
      // screen is the paper colour — so remap the logo's white point onto the
      // paper with a per-channel multiply. White lands exactly on #FAFAF7,
      // the dark mark shifts imperceptibly, and the splash surfaces out of
      // the page instead of flashing a white square on it.
      const PR = 250 / 255, PG = 250 / 255, PB = 247 / 255;
      for (let i = 0; i < px * px; i++) {
        out.data[i * 4]     = src[i * 4] * PR;
        out.data[i * 4 + 1] = src[i * 4 + 1] * PG;
        out.data[i * 4 + 2] = src[i * 4 + 2] * PB;
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
  let wallFlags = {};   // photo_id -> flags (rating, tags…) — latest wall read
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
    wallFlags = data.flags || {};
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
    // dedupe case-insensitively so the same tag in different casings
    // ("Beach" / "beach") is offered once and never splits the filter
    const byLow = new Map();
    for (const id in flags)
      for (const t of (flags[id].tags || [])) {
        const k = String(t).trim().toLowerCase();
        if (k && !byLow.has(k)) byLow.set(k, String(t).trim());
      }
    const sorted = [...byLow.values()].sort((a, b) => a.localeCompare(b));

    fbTagList.innerHTML = '';
    if (!sorted.length) {
      const s = document.createElement('span');
      s.className = 'fb-none';
      s.textContent = 'no tags yet';
      fbTagList.appendChild(s);
      filter.tags = [];
      return;
    }
    const isActive = name =>
      filter.tags.some(t => t.toLowerCase() === name.toLowerCase());
    filter.tags = filter.tags.filter(t => byLow.has(t.trim().toLowerCase()));
    for (const name of sorted) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip' + (isActive(name) ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => {
        // tags gather: click adds another, click again lets it go
        const i = filter.tags.findIndex(
          t => t.toLowerCase() === name.toLowerCase());
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
  // the list folds away when the eye moves on — any press outside it
  document.addEventListener('pointerdown', e => {
    if (filterBar.classList.contains('hidden')) return;
    if (filterBar.contains(e.target) || filterBtn.contains(e.target)) return;
    filterBar.classList.add('hidden');
  }, true);

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
    // A project picture import borrows the same archive wall as Writing, but
    // keeps its own selection and destination state.
    if (Projects.onPhotoPick(id)) return;
    // while writing mode is choosing pictures, a click on a print toggles it
    // into the document's selection instead of opening the inspection table
    if (Writing.onPickClick(id)) return;
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

  /* ——— a shared quiet veil: whole views fade in on open, away on close ——— */

  function fadeViewIn(el) {
    el.classList.add('veiled');
    el.classList.remove('hidden');
    void el.offsetWidth;                 // settle the starting styles
    el.classList.remove('veiled');
  }
  function fadeViewOut(el, ms = 460) {
    if (el.classList.contains('hidden')) return;
    el.classList.add('veiled');
    setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('veiled');
    }, ms);
  }

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
    fadeViewIn(tableView);
  }
  document.getElementById('table-open').addEventListener('click', openTable);
  document.getElementById('table-clear')
    .addEventListener('click', () => Wall.clearSelection());
  document.getElementById('table-back')
    .addEventListener('click', () => fadeViewOut(tableView));

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
    // minmax(0, 1fr) — not a bare 1fr — so the tracks may shrink below the
    // thumbnails' intrinsic size. Safari/WebKit treats 1fr as minmax(auto,1fr)
    // and sizes each track to the image's natural pixels, which blew the grid
    // far past the container and left the shelf blank on macOS.
    gradientGrid.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    gradientGrid.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
    gradientGrid.style.width = gw + 'px';
    gradientGrid.style.height = gh + 'px';

    // serpentine columns: the shelf fills column by column, so every other
    // column runs its slice of the ramp in reverse — the eye then never hits
    // a hard reset where one column ends and the next begins
    const snaked = [];
    for (let c0 = 0, ci = 0; c0 < items.length; c0 += rows, ci++) {
      const col = items.slice(c0, c0 + rows);
      if (ci % 2 === 1) col.reverse();
      snaked.push(...col);
    }
    const ids = snaked.map(it => it.id);
    for (const it of snaked) {
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
    fadeViewIn(gradientView);
    requestAnimationFrame(() => gradientGrid.classList.add('here'));
  }
  document.getElementById('btn-gradient').addEventListener('click', openGradient);
  document.getElementById('gradient-back')
    .addEventListener('click', () => fadeViewOut(gradientView));
  // a click on the quiet space around the field also steps back out
  gradientView.addEventListener('click', e => {
    if (e.target === gradientView || e.target === gradientGrid)
      fadeViewOut(gradientView);
  });

  /* ——— ambient drift: the archive as a living frame ——— */

  const Ambient = (() => {
    const view = document.getElementById('ambient-view');
    const imgs = [document.createElement('img'), document.createElement('img')];
    imgs.forEach(im => view.appendChild(im));
    const DWELL = 8500, XFADE = 2600;
    let cur = 0, order = [], idx = 0, timer = null;
    let active = false, token = 0;

    // a temporary star-rating filter, alive only while ambient mode is (it
    // never touches the main archive). moving the mouse reveals it; stillness
    // fades it away; it stays put while the pointer is on it.
    const STAR_HIDE = 2600;   // ms of stillness before the stars fade
    let starFilter = 0, overStars = false, hideTimer = null;
    const starsEl = document.createElement('div');
    starsEl.id = 'ambient-stars';
    const starBtns = [];
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.className = 'fb-star';
      b.textContent = '★';
      b.addEventListener('click', () => setStarFilter(i));
      starsEl.appendChild(b);
      starBtns.push(b);
    }
    view.appendChild(starsEl);
    // clicks on the control must never fall through to the view's exit gesture
    starsEl.addEventListener('pointerdown', e => e.stopPropagation());
    starsEl.addEventListener('pointerenter', () => {
      overStars = true; revealStars();
    });
    starsEl.addEventListener('pointerleave', () => {
      overStars = false; scheduleStarHide();
    });

    function renderStars() {
      starBtns.forEach((s, i) => s.classList.toggle('on', i < starFilter));
    }
    function revealStars() {
      starsEl.classList.add('show');
      clearTimeout(hideTimer);
    }
    function scheduleStarHide() {
      clearTimeout(hideTimer);
      // never let the control disappear mid-interaction
      if (overStars) return;
      hideTimer = setTimeout(() => starsEl.classList.remove('show'), STAR_HIDE);
    }

    // the ambient pool: the wall's current order, optionally kept to photos
    // rated at the chosen star and up (matching the archive's own star-filter
    // semantics), then shuffled
    function pool() {
      let ids = Wall.orderedIds().slice();
      if (starFilter)
        ids = ids.filter(id =>
          ((wallFlags[id] && wallFlags[id].rating) || 0) >= starFilter);
      return shuffle(ids);
    }

    function setStarFilter(n) {
      starFilter = (starFilter === n) ? 0 : n;
      renderStars();
      revealStars();
      if (!active) return;
      // rebuild the pool and glide to a fresh match using the same crossfade
      order = pool();
      idx = 0;
      token++;
      clearTimeout(timer);
      if (order.length) slide();
      else imgs.forEach(im => {   // nothing matches: let the frame go quiet
        im.style.transition = `opacity ${XFADE}ms cubic-bezier(.45,0,.55,1)`;
        im.style.opacity = '0';
      });
    }

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
      // re-entering always begins with every otherwise-eligible image visible
      starFilter = 0;
      renderStars();
      order = pool();
      if (!order.length) return;
      idx = 0;
      active = true;
      token++;
      imgs.forEach(im => {
        im.style.transition = 'none';
        im.style.opacity = '0';
      });
      starsEl.classList.remove('show');
      fadeViewIn(view);
      slide();
    }
    function exit() {
      if (!active) return;
      active = false;
      token++;
      clearTimeout(timer);
      clearTimeout(hideTimer);
      // the ambient rating filter is temporary: forget it on the way out, so
      // the main archive is never touched and the next entry starts clean
      starFilter = 0;
      overStars = false;
      starsEl.classList.remove('show');
      renderStars();
      fadeViewOut(view, 620);      // the frame dims gently back to the wall
    }
    // moving the mouse surfaces the stars; stillness lets them fade
    view.addEventListener('pointermove', () => {
      if (!active) return;
      revealStars();
      scheduleStarHide();
    });
    view.addEventListener('pointerdown', exit);
    return {enter, exit, isActive: () => active};
  })();
  document.getElementById('btn-ambient')
    .addEventListener('click', () => Ambient.enter());

  /* ——— context navigation: the quiet pill that names where you are, and
         carries you between the three archives. The darkened marker glides
         between the names on a deliberate ease-in-out. ——— */
  const ContextNav = (() => {
    const nav = document.getElementById('context-nav');
    const highlight = document.getElementById('context-highlight');
    const items = [...nav.querySelectorAll('.ctx-item')];
    let active = 'photos';

    // move the marker behind the active name; `animate` false snaps it there
    // without motion (initial placement, and settling after a resize)
    function place(animate) {
      const item = items.find(b => b.dataset.context === active);
      if (!item) return;
      if (!animate) highlight.style.transition = 'none';
      highlight.style.width = item.offsetWidth + 'px';
      highlight.style.transform = 'translateX(' + item.offsetLeft + 'px)';
      items.forEach(b => b.classList.toggle('active', b === item));
      if (!animate) {
        void highlight.offsetWidth;          // commit before motion resumes
        highlight.style.transition = '';
      }
    }
    function set(ctx, animate = true) {
      if (!items.some(b => b.dataset.context === ctx)) return;
      active = ctx;
      place(animate);
    }
    function go(ctx) {
      if (ctx === active) return;
      const from = active;
      set(ctx, true);                          // the marker glides at once
      // between two overlays the wall stays put beneath them; only Photos
      // being involved animates the clusters lifting away or drifting back
      const between = from !== 'photos' && ctx !== 'photos';
      if (from === 'writing') Writing.leave(!between);
      else if (from === 'projects') Projects.leave(!between);
      if (ctx === 'writing') Writing.enter(!between);
      else if (ctx === 'projects') Projects.enter(!between);
    }
    function resume(ctx) {
      // About temporarily lifts a context without changing the navigation
      // marker. Resume explicitly so returning to the already-active context
      // still runs that context's established fly-in/arrival behavior.
      set(ctx, false);
      if (ctx === 'writing') Writing.enter(false);
      else if (ctx === 'projects') Projects.enter(false);
      else {
        document.body.classList.remove('hide-wall-chrome');
        Wall.beginIntro();
      }
    }
    items.forEach(b => b.addEventListener('click', () => go(b.dataset.context)));
    window.addEventListener('resize', () => place(false));
    set('photos', false);
    return {set, go, resume, place, active: () => active};
  })();
  window.ContextNav = ContextNav;

  /* the pill lives in the three main archive contexts and steps aside whenever
     a focused editing or inspection view takes the screen. Visibility is read
     straight from the DOM, so every path that opens or closes such a view —
     however it was triggered — keeps the pill correct. */
  const contextNavEl = document.getElementById('context-nav');
  function focusedViewOpen() {
    const vis = id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    };
    if (vis('detail-view')) return true;             // photo inspection / annotation
    if (vis('writing-view') && vis('doc-editor')) return true;   // document editing
    const projectView = document.getElementById('project-view');
    if (projectView && projectView.classList.contains('workspace-open')) return true;
    if (vis('about-view')) return true;
    if (vis('ambient-view')) return true;
    if (vis('gradient-view')) return true;
    if (vis('table-view')) return true;
    if (document.body.classList.contains('doc-picking')) return true;   // gathering pictures
    if (document.body.classList.contains('project-picking')) return true;
    if (document.body.classList.contains('project-writing-picking')) return true;
    if (vis('boot-overlay')) return true;            // still arriving
    return false;
  }
  function refreshNav() {
    const hide = focusedViewOpen();
    const wasHidden = contextNavEl.classList.contains('nav-hidden');
    contextNavEl.classList.toggle('nav-hidden', hide);
    if (wasHidden && !hide) ContextNav.place(false);   // settle the marker on return
  }
  // refresh directly, not via requestAnimationFrame: rAF is suspended while the
  // window is hidden or not painting, which would leave the pill stuck in its
  // last state — the same reason the rest of the app leans on timers here
  const navObserver = new MutationObserver(refreshNav);
  ['detail-view', 'writing-view', 'doc-editor', 'project-view', 'about-view', 'ambient-view',
   'gradient-view', 'table-view', 'boot-overlay'].forEach(id => {
    const el = document.getElementById(id);
    if (el) navObserver.observe(el, {attributes: true, attributeFilter: ['class']});
  });
  navObserver.observe(document.body, {attributes: true, attributeFilter: ['class']});
  refreshNav();

  /* wall-side keys: search, drift, and quiet retreat */
  window.addEventListener('keydown', e => {
    if (Ambient.isActive()) { Ambient.exit(); e.preventDefault(); return; }
    if (About.isOpen()) {
      if (e.key === 'Escape') { About.close(); e.preventDefault(); }
      return;
    }
    if (Detail.isOpen()) return;             // the workspace has its own keys
    if (Writing.isOpen()) return;            // writing mode owns its own keys
    if (Projects.isOpen()) {                 // project canvas → index → photos
      if (e.key === 'Escape') {
        if (!Projects.handleEscape()) ContextNav.go('photos');
        e.preventDefault();
      }
      return;
    }
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    if (e.key === '/') { openSearch(); e.preventDefault(); }
    else if (e.key === 'p') Ambient.enter();
    else if (e.key.toLowerCase() === 'f' && gradientView.classList.contains('hidden') &&
             tableView.classList.contains('hidden'))
      Wall.fitAll(true);               // the same gesture as `overview`
    else if (e.key === 'Escape') {
      if (!gradientView.classList.contains('hidden'))
        fadeViewOut(gradientView);
      else if (!tableView.classList.contains('hidden'))
        fadeViewOut(tableView);
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
