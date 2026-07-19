/* ————————————————————————————————————————————————
   projects mode: a second archive, linked to its own folder of drawings,
   paintings and other project materials — kept strictly independent of the
   photo archive, so linking or switching one never touches the other.

   For now the context is otherwise empty: it establishes the folder-linking
   foundation and the quiet enter/leave language shared with Writing, ready for
   project-specific features to grow into later.
   ———————————————————————————————————————————————— */

const Projects = (() => {
  const $ = id => document.getElementById(id);
  const view = $('project-view');
  const folderBtn = $('proj-btn-folder');
  const folderName = $('proj-folder-name');
  const folderBar = $('proj-folder-bar');
  const folderInput = $('proj-folder-input');
  const folderError = $('proj-folder-error');
  const emptyTitle = $('proj-empty-title');
  const emptySub = $('proj-empty-sub');

  let open = false;
  let linked = false;

  /* ————————————————— entering / leaving the projects context ————————————— */

  // `animateWall` is false when arriving from (or leaving to) another overlay
  // context — the wall is already lifted and covered, so it stays put and only
  // the two overlays cross-fade. Mirrors Writing's enter/leave exactly.
  function enter(animateWall = true) {
    if (open) return;
    open = true;
    document.body.classList.add('hide-wall-chrome');
    if (animateWall) Wall.beginOutro(() => {});
    view.classList.add('veiled', 'arriving');
    view.classList.remove('hidden');
    void view.offsetWidth;                 // settle the starting styles
    setTimeout(() => view.classList.remove('veiled'), 20);
    refresh();
  }

  function leave(animateWall = true) {
    if (!open) return;
    open = false;
    closeFolderBar();
    if (animateWall) {
      document.body.classList.remove('hide-wall-chrome');
      Wall.beginIntro();
    }
    // leave on the base .5s transition, never the 1.2s arrival curve, so the
    // fade-out is fully complete before `hidden` lands (see Writing.leave)
    view.classList.remove('arriving');
    view.classList.add('veiled');
    setTimeout(() => {
      view.classList.add('hidden');
      view.classList.remove('veiled');
    }, 520);
  }

  /* ————————————————— status + empty state ————————————————— */

  async function refresh() {
    let s;
    try { s = await API.projectStatus(); } catch { return; }
    linked = !!(s && s.linked);
    folderName.textContent = (s && s.root) || '';
    updateEmpty();
  }

  function updateEmpty() {
    if (linked) {
      emptyTitle.textContent = 'no project materials yet';
      emptySub.innerHTML =
        'this folder is linked — drawings, paintings and other project ' +
        'materials placed here<br>will gather as the projects archive grows';
    } else {
      emptyTitle.textContent = 'no folder linked';
      emptySub.innerHTML =
        'use <button class="link-btn" id="proj-empty-folder-btn">folder</button> ' +
        'in the top-left corner to choose the folder<br>that holds your ' +
        'drawings, paintings and other project materials';
    }
    const b = $('proj-empty-folder-btn');
    if (b) b.addEventListener('click', chooseFolder);
  }

  /* ————————————————— folder: an independent link ————————————————— */

  function hasNativePicker() {
    return !!(window.pywebview && window.pywebview.api &&
              typeof window.pywebview.api.pick_folder === 'function');
  }
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

  async function linkFolder(path, setErr) {
    if (!path) return false;
    if (setErr) setErr('linking…');
    let res;
    try { res = await API.setProjectRoot(path); }
    catch { if (setErr) setErr('could not reach the app'); return false; }
    if (!res || !res.ok) {
      if (setErr) setErr((res && res.error) || 'that folder could not be found');
      return false;
    }
    await refresh();
    return true;
  }

  async function submitFolder() {
    const path = folderInput.value.trim();
    if (!path) { closeFolderBar(); return; }
    const ok = await linkFolder(path, t => { folderError.textContent = t; });
    if (ok) { closeFolderBar(); folderInput.value = ''; }
  }

  async function chooseFolder() {
    if (!hasNativePicker()) {
      folderBar.classList.contains('hidden')
        ? openFolderBar() : closeFolderBar();
      return;
    }
    let path;
    try { path = await window.pywebview.api.pick_folder(); }
    catch { path = null; }
    if (!path) return;
    const ok = await linkFolder(path);
    if (!ok) {
      openFolderBar();
      folderInput.value = path;
      folderError.textContent = 'that folder could not be linked';
    }
  }

  folderBtn.addEventListener('click', chooseFolder);
  $('proj-folder-open').addEventListener('click', submitFolder);
  $('proj-folder-cancel').addEventListener('click', closeFolderBar);
  folderInput.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Enter') submitFolder();
    else if (ev.key === 'Escape') closeFolderBar();
  });

  return {enter, leave, isOpen: () => open, refresh};
})();
