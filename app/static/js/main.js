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
  filterBar.inert = filterBar.classList.contains('hidden');
  function closeFilters() { filterBar.classList.add('hidden'); filterBar.inert = true; document.getElementById('btn-filter').setAttribute('aria-expanded', 'false'); }
  const fbStars = [...document.querySelectorAll('.fb-star')];
  const fbMode = document.getElementById('fb-mode');
  const fbTagList = document.getElementById('fb-tag-list');

  let booted = false;
  let lastShown = -1;
  let scanBusy = false;
  let pollTimer = null;
  let archiveRoot = null;
  let wallFlags = {};   // photo_id -> flags (rating, tags…) — latest wall read
  function kick() { clearTimeout(pollTimer); poll(); }
  let wallMode = 'folders';
  const filter = {tags: [], stars: 0, camera: null, film: null, q: ''};
  let selectedLayout = null, savedLayouts = [];
  const filterActive = () =>
    !!(selectedLayout || filter.tags.length || filter.stars || filter.camera || filter.film ||
       filter.q.trim());

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

  const rowsControl = document.getElementById('rows-control');
  const rowsSlider = document.getElementById('filter-rows');
  const rowsValue = document.getElementById('rows-value');
  let currentRows = 4;
  let activeLayoutKey = null;
  rowsSlider.addEventListener('input', () => {
    rowsValue.value = rowsSlider.value;
    currentRows = Number(rowsSlider.value);
    Wall.setRows(rowsSlider.value);
  });
  let wallRequest = 0;
  async function refreshWall(animate = true, restoreLayout = false) {
    const request = ++wallRequest;
    if (filterActive()) wallMode = 'folders';
    const data = await API.wall({...filter, layout: selectedLayout, mode: wallMode});
    if (request !== wallRequest) return data;
    archiveRoot = data.root || null;
    savedLayouts = data.layouts || [];
    if (!data.savedLayout) selectedLayout = null;
    renderLayoutList();
    wallFlags = data.flags || {};
    document.getElementById('btn-chronological').setAttribute('aria-pressed', String(wallMode === 'chronological'));
    const normalized = {tags: [...filter.tags].map(t => t.toLowerCase()).sort(),
      stars: filter.stars, camera: filter.camera || '', film: filter.film || '', q: filter.q.trim().toLowerCase().replace(/\s+/g, ' ')};
    if (selectedLayout) normalized.layout = selectedLayout;
    activeLayoutKey = filterActive() ? JSON.stringify([data.root || folderName.textContent, normalized]) : null;
    if (restoreLayout && data.savedLayout) currentRows = data.savedLayout.rows;
    rowsControl.classList.toggle('hidden', !activeLayoutKey);
    rowsSlider.value = currentRows;
    rowsValue.value = rowsSlider.value;
    Wall.setReorderContext(activeLayoutKey, filter.tags, data.root, normalized);
    if (restoreLayout && data.savedLayout) Wall.restoreOrder(data.savedLayout.ids);
    Wall.setRows(rowsSlider.value, false);
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

  const layoutForm = document.getElementById('layout-form');
  const layoutName = document.getElementById('layout-name');
  const layoutNameField = document.getElementById('layout-name-field');
  const layoutSave = document.getElementById('save-layout');
  let layoutSnapshot = null;
  function closeLayoutName() {
    layoutNameField.classList.add('hidden');
    layoutName.value = '';
    document.getElementById('layout-error').textContent = '';
    layoutSnapshot = null;
  }
  layoutName.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); closeLayoutName(); layoutSave.focus(); }
  });
  document.addEventListener('pointerdown', e => {
    if (!layoutForm.contains(e.target)) closeLayoutName();
  }, true);
  layoutForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (!activeLayoutKey || !Wall.orderedIds().length) return;
    if (layoutNameField.classList.contains('hidden')) {
      layoutSnapshot = {root: archiveRoot, rows: Number(rowsSlider.value), ids: Wall.orderedIds()};
      layoutNameField.classList.remove('hidden'); layoutName.focus(); return;
    }
    const name = layoutName.value.trim();
    if (!name) return;
    const snapshot = layoutSnapshot;
    const button = layoutSave;
    button.disabled = true;
    try {
      const response = await fetch('/api/layouts', {method: 'POST',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...snapshot, name})});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error('save failed');
      if (archiveRoot === snapshot.root) { savedLayouts = data.layouts; renderLayoutList(); }
      closeLayoutName();
    } catch { document.getElementById('layout-error').textContent = 'layout could not be saved · try again'; }
    finally { button.disabled = false; }
  });

  function renderLayoutList() {
    const list = document.getElementById('fb-layout-list');
    list.replaceChildren();
    document.getElementById('fbh-layouts').textContent = savedLayouts.find(item => item.id === selectedLayout)?.name || '';
    if (!savedLayouts.length) {
      const empty = document.createElement('span');
      empty.className = 'fb-none'; empty.textContent = 'no saved layouts'; list.appendChild(empty);
    }
    for (const item of savedLayouts) {
      const button = document.createElement('button');
      button.className = 'tag-chip' + (item.id === selectedLayout ? ' active' : '');
      button.textContent = item.name;
      button.addEventListener('click', () => {
        selectedLayout = item.id;
        filter.tags = []; filter.stars = 0; filter.camera = null; filter.film = null; filter.q = '';
        clearTimeout(searchTimer); searchInput.value = ''; searchInput.classList.add('hidden');
        renderStarFilter(); closeFilters();
        refreshWall(true, true).then(() => Wall.fitAll(true));
      });
      button.addEventListener('contextmenu', e => openLayoutMenu(e, item));
      list.appendChild(button);
    }
  }

  function openLayoutMenu(event, item) {
    openTagMenu(event, item.name);
    const button = tagMenu.querySelector('button').cloneNode(true);
    button.textContent = 'delete layout'; button.title = `delete “${item.name}”`;
    button.setAttribute('aria-label', `delete layout ${item.name}`);
    const root = archiveRoot;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/layouts/delete', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({root, id: item.id})});
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error('delete failed');
        closeTagMenu();
        if (archiveRoot !== root) return;
        savedLayouts = data.layouts;
        if (selectedLayout === item.id) { selectedLayout = null; await clearFilters(); }
        renderLayoutList();
      } catch { wallStatus.textContent = 'layout could not be deleted · try again'; button.disabled = false; }
    });
    tagMenu.replaceChildren(button); button.focus({preventScroll: true});
  }

  const tagMenu = document.createElement('div');
  tagMenu.id = 'tag-context-menu';
  tagMenu.className = 'archive-context-menu hidden';
  tagMenu.setAttribute('role', 'menu');
  document.body.appendChild(tagMenu);
  function closeTagMenu() { tagMenu.classList.add('hidden'); }
  function openTagMenu(event, name) {
    event.preventDefault(); event.stopPropagation();
    const root = archiveRoot;
    const button = document.createElement('button');
    button.className = 'quiet'; button.setAttribute('role', 'menuitem');
    button.textContent = 'delete tag';
    button.setAttribute('aria-label', `delete ${name} from all photographs`);
    button.title = `remove “${name}” from every tagged photograph`;
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch('/api/tags/delete', {method: 'POST',
          headers: {'Content-Type': 'application/json'}, body: JSON.stringify({root, tag: name})});
        if (!response.ok || !(await response.json()).ok) throw new Error('delete failed');
        closeTagMenu();
        if (archiveRoot !== root) return;
        filter.tags = filter.tags.filter(t => t.toLowerCase() !== name.toLowerCase());
        await refreshWall();
        Wall.fitAll(true);
      } catch {
        wallStatus.textContent = 'tag could not be deleted · try again';
        button.disabled = false;
      }
    });
    tagMenu.replaceChildren(button);
    tagMenu.classList.remove('hidden');
    const rect = tagMenu.getBoundingClientRect();
    tagMenu.style.left = Math.max(12, Math.min(event.clientX, innerWidth - rect.width - 12)) + 'px';
    tagMenu.style.top = Math.max(12, Math.min(event.clientY, innerHeight - rect.height - 12)) + 'px';
    button.focus({preventScroll: true});
  }
  document.addEventListener('pointerdown', e => {
    if (!tagMenu.contains(e.target)) closeTagMenu();
  }, true);
  tagMenu.addEventListener('contextmenu', e => e.preventDefault());

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
        selectedLayout = null;
        // tags gather: click adds another, click again lets it go
        const i = filter.tags.findIndex(
          t => t.toLowerCase() === name.toLowerCase());
        if (i >= 0) filter.tags.splice(i, 1);
        else filter.tags.push(name);
        // Tag selection opens the editable tag group rather than leaving
        // Chronological's fixed date order active underneath the filter.
        wallMode = 'folders';
        refreshWall().then(() => Wall.fitAll(true));
      });
      chip.addEventListener('contextmenu', e => openTagMenu(e, name));
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
        selectedLayout = null;
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
    selectedLayout = null;
    const n = i + 1;
    filter.stars = (filter.stars === n) ? 0 : n;
    renderStarFilter();
    refreshWall().then(() => Wall.fitAll(true));
  }));

  function clearFilters(mode = 'folders') {
    selectedLayout = null;
    wallMode = mode;
    clearTimeout(searchTimer);
    filter.tags = []; filter.stars = 0; filter.camera = null;
    filter.film = null; filter.q = '';
    searchInput.value = ''; searchInput.classList.add('hidden'); searchInput.blur();
    closeFilters(); closeViewMenu(); closeTagMenu();
    Wall.clearSelection();
    renderStarFilter();
    return refreshWall().then(() => Wall.fitAll(true));
  }
  document.getElementById('fb-clear').addEventListener('click', () => clearFilters());

  // the filter list hangs just beneath its own word, not the screen edge
  const filterBtn = document.getElementById('btn-filter');
  function placeFilterBar() {
    const r = filterBtn.getBoundingClientRect();
    filterBar.style.right =
      Math.max(12, window.innerWidth - r.right - 2) + 'px';
  }
  filterBtn.addEventListener('click', () => {
    closeViewMenu();
    placeFilterBar();
    filterBar.classList.toggle('hidden');
    filterBar.inert = filterBar.classList.contains('hidden');
    filterBtn.setAttribute('aria-expanded', String(!filterBar.inert));
  });
  window.addEventListener('resize', () => {
    if (!filterBar.classList.contains('hidden')) placeFilterBar();
  });
  // the list folds away when the eye moves on — any press outside it
  document.addEventListener('pointerdown', e => {
    if (filterBar.classList.contains('hidden')) return;
    if (filterBar.contains(e.target) || filterBtn.contains(e.target) || tagMenu.contains(e.target)) return;
    closeFilters();
  }, true);

  document.getElementById('btn-chronological').addEventListener('click', () => clearFilters('chronological'));
  const viewMenu = document.getElementById('view-menu');
  const viewButton = document.getElementById('btn-view');
  function closeViewMenu() {
    viewMenu.classList.add('hidden'); viewMenu.inert = true;
    viewButton.setAttribute('aria-expanded', 'false');
  }
  viewButton.addEventListener('click', () => {
    const opening = viewMenu.classList.contains('hidden');
    closeFilters();
    viewMenu.classList.toggle('hidden', !opening); viewMenu.inert = !opening;
    viewButton.setAttribute('aria-expanded', String(opening));
  });
  document.addEventListener('pointerdown', e => {
    if (!viewMenu.contains(e.target) && !viewButton.contains(e.target)) closeViewMenu();
  }, true);
  viewMenu.addEventListener('click', e => { if (e.target.closest('button')) closeViewMenu(); });

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
    wallMode = 'folders';
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
    .addEventListener('click', () => filterActive() || wallMode !== 'folders' ? clearFilters() : Wall.fitAll(true));

  /* ——— search: one quiet line beneath the wordmark ——— */

  const searchInput = document.getElementById('search-input');
  let searchTimer = null;

  function openSearch() {
    closeFilters();
    searchInput.classList.remove('hidden');
    searchInput.focus();
  }
  function closeSearch() {
    clearTimeout(searchTimer);
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
      selectedLayout = null;
      refreshWall().then(() => Wall.fitAll(true));
    }, 260);
  });
  searchInput.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { clearFilters(); }
    else if (ev.key === 'Enter') searchInput.blur();
  });
  searchInput.addEventListener('blur', () => {
    if (!searchInput.value.trim() && !filter.q)
      searchInput.classList.add('hidden');
  });

  /* ——— a shared quiet veil: whole views fade in on open, away on close ——— */

  const fadeTimers = new WeakMap(), returnFocus = new WeakMap();
  function fadeViewIn(el) {
    clearTimeout(fadeTimers.get(el));
    if (el.classList.contains('hidden') || el.classList.contains('veiled'))
      returnFocus.set(el, document.activeElement);
    el.inert = false;
    el.classList.add('veiled');
    el.classList.remove('hidden');
    void el.offsetWidth;                 // settle the starting styles
    el.classList.remove('veiled');
  }
  function fadeViewOut(el, ms = 460) {
    if (el.classList.contains('hidden') || el.classList.contains('veiled')) return;
    clearTimeout(fadeTimers.get(el));
    el.inert = true;
    el.classList.add('veiled');
    fadeTimers.set(el, setTimeout(() => {
      el.classList.add('hidden');
      el.classList.remove('veiled');
      const target = returnFocus.get(el);
      if (target && target.isConnected && target.getClientRects().length &&
          (document.activeElement === document.body || el.contains(document.activeElement)))
        target.focus({preventScroll: true});
    }, ms));
  }

  // A click on the surrounding paper goes back; dragging across it, a middle
  // button pan, or a click on an actual control does not.
  function blankPaperExit(el, targets, close) {
    let press = null;
    el.addEventListener('pointerdown', e => {
      press = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey &&
        targets.includes(e.target) ? {id: e.pointerId, x: e.clientX, y: e.clientY} : null;
    });
    el.addEventListener('pointerup', e => {
      const start = press; press = null;
      if (start && start.id === e.pointerId && targets.includes(e.target) &&
          Math.hypot(e.clientX - start.x, e.clientY - start.y) < 5) close();
    });
    el.addEventListener('pointercancel', () => { press = null; });
  }

  function inspectableImage(img, id, ids, backLabel) {
    img.tabIndex = 0;
    img.setAttribute('role', 'button');
    img.setAttribute('aria-label', 'inspect photograph');
    img.title = 'inspect photograph · enter';
    img.decoding = 'async';
    const inspect = () => {
      Detail.setSequence(ids);
      Detail.show(id, {backLabel});
    };
    img.addEventListener('click', inspect);
    img.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault(); e.stopPropagation(); inspect();
    });
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
      inspectableImage(img, id, ids, 'light table');
      tableRow.appendChild(img);
    }
    fadeViewIn(tableView);
  }
  document.getElementById('table-open').addEventListener('click', openTable);
  document.getElementById('table-clear')
    .addEventListener('click', () => Wall.clearSelection());
  document.getElementById('table-back')
    .addEventListener('click', () => fadeViewOut(tableView));
  blankPaperExit(tableView, [tableView, tableRow], () => fadeViewOut(tableView));

  /* ——— gradient shelf: every photograph, ordered by colour ——— */

  const gradientView = document.getElementById('gradient-view');
  const gradientGrid = document.getElementById('gradient-grid');
  const gradientButton = document.getElementById('btn-gradient');
  let gradientRequest = 0, gradientPending = false;

  function closeGradient() {
    gradientRequest++;
    gradientPending = false;
    gradientButton.disabled = false;
    gradientButton.removeAttribute('aria-busy');
    fadeViewOut(gradientView);
  }

  async function openGradient() {
    if (gradientPending) return;
    const request = ++gradientRequest;
    gradientPending = true;
    gradientButton.disabled = true;
    gradientButton.setAttribute('aria-busy', 'true');
    let d;
    try {
      const response = await fetch('/api/gradient');
      if (!response.ok) throw new Error('gradient unavailable');
      d = await response.json();
    } catch {
      if (request === gradientRequest) wallStatus.textContent = 'colour field could not be read · try again';
      return;
    } finally {
      if (request === gradientRequest) {
        gradientPending = false; gradientButton.disabled = false;
        gradientButton.removeAttribute('aria-busy');
      }
    }
    if (request !== gradientRequest || window.ContextNav.active() !== 'photos') return;
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
      inspectableImage(img, it.id, ids, 'gradient');
      gradientGrid.appendChild(img);
    }
    fadeViewIn(gradientView);
    requestAnimationFrame(() => gradientGrid.classList.add('here'));
  }
  document.getElementById('btn-gradient').addEventListener('click', openGradient);
  document.getElementById('gradient-back')
    .addEventListener('click', closeGradient);
  blankPaperExit(gradientView, [gradientView, gradientGrid], closeGradient);

  /* ——— ambient drift: the archive as a living frame ——— */

  const Ambient = (() => {
    const view = document.getElementById('ambient-view');
    const imgs = [document.createElement('img'), document.createElement('img')];
    imgs.forEach(im => view.appendChild(im));
    const DWELL = 8500, XFADE = 2600;
    const BLEED = 10, PAN = 16, PAN_DURATION = 60000;
    const drifts = new Map();
    let cur = 0, order = [], idx = 0, timer = null;
    let active = false, token = 0, failedImages = 0;
    const emptyMessage = document.createElement('p');
    emptyMessage.className = 'ambient-empty hidden';
    emptyMessage.setAttribute('role', 'status');
    view.appendChild(emptyMessage);

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
      b.setAttribute('aria-label', `${i} stars and up`);
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
      starBtns.forEach((s, i) => {
        s.classList.toggle('on', i < starFilter);
        s.setAttribute('aria-pressed', String(i + 1 === starFilter));
      });
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
      idx = 0; failedImages = 0;
      emptyMessage.classList.toggle('hidden', order.length > 0);
      emptyMessage.textContent = 'no photographs at this rating · choose another star';
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

    function fillFrame(im) {
      if (!im.naturalWidth || !im.naturalHeight) return;
      const rot = Number(im.dataset.rotation) || 0;
      const turned = rot % 2;
      const width = turned ? im.naturalHeight : im.naturalWidth;
      const height = turned ? im.naturalWidth : im.naturalHeight;
      // Cover both screen dimensions with a uniform scale. Reserve the pan
      // travel as well as ten pixels on every edge, including at its endpoints.
      const scale = Math.max((view.clientWidth + 2 * (BLEED + PAN)) / width,
                             (view.clientHeight + 2 * (BLEED + PAN)) / height);
      im.style.width = im.naturalWidth * scale + 'px';
      im.style.height = im.naturalHeight * scale + 'px';
      drifts.get(im)?.cancel();
      const direction = imgs.indexOf(im) ? 1 : -1;
      const transform = distance =>
        `translate(-50%, -50%) translate(${distance}px, ${distance}px) rotate(${rot * 90}deg)`;
      im.style.transform = transform(-PAN * direction);
      drifts.set(im, im.animate([
        {transform: transform(-PAN * direction)},
        {transform: transform(PAN * direction)},
      ], {duration: PAN_DURATION, easing: 'linear', fill: 'forwards'}));
    }
    window.addEventListener('resize', () => {
      if (active) imgs.forEach(im => { if (im.complete) fillFrame(im); });
    });

    async function slide() {
      if (!active || !order.length || document.hidden) return;
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
      im.onload = () => {
        if (!active || t !== token) return;
        failedImages = 0;
        emptyMessage.classList.add('hidden');
        im.dataset.rotation = rot;
        fillFrame(im);
        void im.offsetWidth;   // settle the starting styles
        im.style.transition =
          `opacity ${XFADE}ms cubic-bezier(.45,0,.55,1)`;
        im.style.opacity = '1';
        old.style.transition =
          `opacity ${XFADE}ms cubic-bezier(.45,0,.55,1)`;
        old.style.opacity = '0';
        timer = setTimeout(slide, DWELL);
      };
      im.onerror = () => {
        if (!active || t !== token) return;
        if (++failedImages < order.length) timer = setTimeout(slide, 350);
        else {
          emptyMessage.textContent = 'these photographs could not be opened · esc to return';
          emptyMessage.classList.remove('hidden');
        }
      };
      im.src = '/image/' + id;
    }

    function enter() {
      // re-entering always begins with every otherwise-eligible image visible
      starFilter = 0;
      renderStars();
      order = pool();
      if (!order.length) return;
      idx = 0; failedImages = 0;
      clearTimeout(timer); clearTimeout(hideTimer);
      emptyMessage.classList.add('hidden');
      active = true;
      token++;
      drifts.forEach(animation => animation.cancel());
      drifts.clear();
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
      drifts.forEach(animation => animation.pause());
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
    view.addEventListener('pointerdown', e => { if (e.button === 0) exit(); });
    document.addEventListener('visibilitychange', () => {
      if (!active) return;
      clearTimeout(timer);
      if (!document.hidden) timer = setTimeout(slide, 250);
    });
    return {enter, exit, isActive: () => active};
  })();
  document.getElementById('btn-ambient')
    .addEventListener('click', () => Ambient.enter());

  // About returns to the photo wall after its existing fly-out transition.
  window.ContextNav = {active: () => 'photos', resume() {
    document.body.classList.remove('hide-wall-chrome');
    Wall.beginIntro();
  }};

  const IDLE_MS = 4 * 60 * 1000;
  let idleTimer;
  const heldPointers = new Set();
  function resetIdle() {
    clearTimeout(idleTimer);
    if (document.hidden || !document.hasFocus()) return;
    idleTimer = setTimeout(() => {
      if (!Ambient.isActive() && !document.hidden && document.hasFocus() &&
          !heldPointers.size && booted && Wall.orderedIds().length) {
        document.activeElement.blur();
        closeFilters(); closeViewMenu(); closeTagMenu();
        Ambient.enter();
      }
    }, IDLE_MS);
  }
  for (const type of ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'keydown', 'input', 'wheel'])
    window.addEventListener(type, resetIdle, {capture: true, passive: true});
  window.addEventListener('pointerdown', e => heldPointers.add(e.pointerId), true);
  for (const type of ['pointerup', 'pointercancel'])
    window.addEventListener(type, e => heldPointers.delete(e.pointerId), true);
  window.addEventListener('blur', () => { heldPointers.clear(); clearTimeout(idleTimer); });
  window.addEventListener('focus', resetIdle);
  document.addEventListener('visibilitychange', resetIdle);
  resetIdle();

  /* wall-side keys: search, drift, and quiet retreat */
  window.addEventListener('keydown', e => {
    // An inspector can close synchronously earlier in this same event. Its
    // consumed Escape must not also back out of the canvas underneath it.
    if (e.defaultPrevented || (e.key === 'Escape' && e.repeat)) return;
    if (Ambient.isActive()) {
      if (e.key === 'Escape' || (!e.ctrlKey && !e.metaKey && !e.altKey &&
          !['Shift', 'Control', 'Alt', 'Meta', 'Tab'].includes(e.key) &&
          !document.activeElement.closest('#ambient-stars'))) {
        Ambient.exit(); e.preventDefault();
      }
      return;
    }
    if (About.isOpen()) {
      if (e.key === 'Escape') { About.close(); e.preventDefault(); }
      return;
    }
    if (Detail.isOpen()) return;
    const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) ||
      document.activeElement.isContentEditable;
    if (e.key === 'Escape') {
      if (gradientPending || !gradientView.classList.contains('hidden')) closeGradient();
      else if (!tableView.classList.contains('hidden')) fadeViewOut(tableView);
      else if (!folderBar.classList.contains('hidden')) closeFolderBar();
      else clearFilters();
      e.preventDefault(); return;
    }
    if (!gradientView.classList.contains('hidden') || !tableView.classList.contains('hidden')) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      openSearch(); e.preventDefault(); return;
    }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '/') { openSearch(); e.preventDefault(); }
    else if (e.key === 'p') Ambient.enter();
    else if (e.key.toLowerCase() === 'f' || e.key === '0') {
      Wall.fitAll(true); e.preventDefault();
    }
  });

  /* A single global pointer echo, shared by every context. It only wakes for
     real mouse movement, carries a bounded handful of samples, and stops its
     animation frame as soon as those samples fade. */
  const MouseTrail = (() => {
    const cv = document.getElementById('mouse-trail-canvas');
    const g = cv.getContext('2d');
    // `any-pointer`, not `pointer`: a touchscreen laptop can report a coarse
    // *primary* pointer while a mouse is plugged in, which used to switch the
    // echo off for a user who plainly has one
    const fine = matchMedia('(any-pointer: fine)');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const SURFACE = 384;
    let frame = 0, last = null, samples = [];
    const icon = new Image(); icon.src = '/assets/pointer-head.svg';

    const effective = () => fine.matches && !reduced.matches && !document.hidden;
    function sync() {
      if (!effective()) clear();
    }
    function size() {
      const dpr = Math.min(1.5, devicePixelRatio || 1);
      cv.width = Math.max(1, Math.round(SURFACE * dpr));
      cv.height = Math.max(1, Math.round(SURFACE * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, SURFACE, SURFACE);
    }
    function clear() {
      samples = []; last = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0; g.clearRect(0, 0, SURFACE, SURFACE);
    }
    const TRAIL_LIFE = 290;
    const MAX_SAMPLES = 32;
    // The silhouette's tip within its own 0..64 viewBox — matching the cursor
    // hotspot — so each stamped copy trails from the same point the pointer
    // touches, and the drawn shape follows the true path rather than a line.
    const TIP_X = 10.7 / 64, TIP_Y = 9.8 / 64;
    function draw(now) {
      frame = 0;
      g.clearRect(0, 0, SURFACE, SURFACE);
      // samples are appended in time order, so the expired ones sit at the
      // front — trim them in place instead of allocating a new array each frame
      let cut = 0;
      while (cut < samples.length && now - samples[cut].t >= TRAIL_LIFE) cut++;
      if (cut) samples.splice(0, cut);
      if (!(icon.complete && icon.naturalWidth)) {
        if (samples.length && effective()) frame = requestAnimationFrame(draw);
        return;
      }
      const newest = samples[samples.length - 1];
      const originX = newest ? newest.x - SURFACE / 2 : 0;
      const originY = newest ? newest.y - SURFACE / 2 : 0;
      cv.style.transform = `translate3d(${originX}px, ${originY}px, 0)`;
      // Carry the whole pointer-head silhouette along the motion path. Densely
      // interpolated, low-opacity copies overlap under the canvas blur into one
      // continuous shape-aware smudge — never a stepped chain of distinct icons
      // and never a thin line. Newer and faster samples read a little stronger.
      g.shadowBlur = 4; g.shadowColor = 'rgba(184,185,181,.26)';
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        const life = Math.max(0, 1 - (now - s.t) / TRAIL_LIFE);
        if (life <= 0) continue;
        g.globalAlpha = life * life * Math.min(.17, .055 + s.speed * .05);
        const size = Math.min(18, 12 + s.speed * 1.4);
        g.drawImage(icon, s.x - originX - size * TIP_X, s.y - originY - size * TIP_Y, size, size);
      }
      g.shadowBlur = 0;
      g.globalAlpha = 1;
      if (samples.length && effective()) frame = requestAnimationFrame(draw);
    }
    function appendPoint(x, y, t) {
      if (!last) { last = {x, y, t}; return; }
      const distance = Math.hypot(x - last.x, y - last.y);
      const dt = Math.max(4, t - last.t);
      const speed = Math.min(3.6, distance / dt);
      const steps = Math.max(1, Math.min(12, Math.ceil(distance / 4)));
      if (speed > .055) {
        for (let step = 1; step <= steps; step++) {
          const q = step / steps;
          samples.push({
            x: last.x + (x - last.x) * q,
            y: last.y + (y - last.y) * q,
            t: last.t + dt * q,
            speed,
          });
        }
        if (samples.length > MAX_SAMPLES)
          samples.splice(0, samples.length - MAX_SAMPLES);
      }
      last = {x, y, t};
    }
    function move(e) {
      if (!effective() || e.pointerType && e.pointerType !== 'mouse') return;
      const now = performance.now();
      let events = [e];
      try {
        const coalesced = e.getCoalescedEvents && e.getCoalescedEvents();
        if (coalesced && coalesced.length) events = coalesced;
      } catch {}
      for (const point of events) {
        const stamp = Number.isFinite(point.timeStamp) &&
          Math.abs(now - point.timeStamp) < 10000 ? point.timeStamp : now;
        appendPoint(point.clientX, point.clientY, stamp);
      }
      if (samples.length && !frame) frame = requestAnimationFrame(draw);
    }
    window.addEventListener('pointermove', move, {passive: true});
    window.addEventListener('resize', size);
    window.addEventListener('blur', clear);
    window.addEventListener('pagehide', clear);
    document.addEventListener('visibilitychange', () => { if (document.hidden) clear(); });
    for (const query of [fine, reduced]) {
      if (query.addEventListener) query.addEventListener('change', sync);
      else if (query.addListener) query.addListener(sync);
    }
    size(); sync();
    return {clear};
  })();
  window.MouseTrail = MouseTrail;

  renderStarFilter();
  Splash.onDone(() => Wall.beginIntro());
  Splash.start();
  // if reading the archive runs long, let a quiet status line surface
  setTimeout(() => {
    if (!Splash.isDone()) bootStatus.classList.add('show');
  }, 4000);
  poll();
})();
