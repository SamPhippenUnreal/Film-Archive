/* ————————————————————————————————————————————————
   writing mode: a quiet paginated writing workspace embedded in the archive.

   Documents are untitled, US-Letter, paginated. They hold text + formatting,
   annotations, inserted image groups (with their own black-&-white / layout
   state), a star rating and tags. Everything autosaves into Writing Mode's own
   cache domain (see docstore.py) — the image archive is never touched.

   The visual/motion language is borrowed straight from the rest of the app:
   the same bottom bar, the same quiet stars and tag chips, the same brush
   colours, and the same enter/leave float-and-fade the About page uses.
   ———————————————————————————————————————————————— */

const Writing = (() => {
  // Writing uses the photograph workspace's actual brush implementation.
  const {COLORS, COLOR_NAMES, CELL} = PixelBrushes;

  // US Letter at 96 css-px/inch, with fixed one-inch margins and 1.5 spacing —
  // none of these are user-editable, by design
  const PPI = 96;
  const PAGE_W = Math.round(8.5 * PPI);   // 816
  const PAGE_H = Math.round(11 * PPI);    // 1056
  const MARGIN = PPI;                     // 96 — fixed margin, not editable
  const GAP = 26;                         // the visible separation between pages

  const $ = id => document.getElementById(id);
  const view = $('writing-view');
  const archiveEl = $('doc-archive');
  const editorEl = $('doc-editor');
  const strip = $('doc-strip');
  const stripWrap = $('doc-strip-wrap');
  const flow = $('doc-flow');
  const paper = $('doc-paper');
  const scroll = $('doc-scroll');
  const annoCanvas = $('doc-anno-canvas');
  const actx = annoCanvas.getContext('2d');

  let open = false;            // writing mode active (archive or editor)
  let docs = [];               // the full list, newest first
  let allTags = [];            // tags currently in use across the photo archive
  const dfilter = {stars: 0, tags: [], q: ''};

  let cur = null;              // the open document, or null in the archive
  let mode = 'text';           // 'text' | 'annotate'
  let dirty = false, saveTimer = null;
  let stripReturn = 0;         // remembered horizontal scroll of the archive

  /* ————————————————— entering / leaving writing mode ————————————————— */

  function enter() {
    if (open) return;
    open = true;
    document.body.classList.add('hide-wall-chrome');
    // the clusters lift away exactly as they do for the About page…
    Wall.beginOutro(() => {});
    view.classList.add('veiled', 'arriving');
    view.classList.remove('hidden');
    showArchive(false);
    void view.offsetWidth;                 // settle the starting styles
    // …and the workspace fades in over their leaving (timer, not rAF, so the
    // fade still completes even if the window is momentarily hidden)
    setTimeout(() => view.classList.remove('veiled'), 20);
    loadDocs();
  }

  function leave() {
    if (!open) return;
    open = false;
    closeEditor(true);
    document.body.classList.remove('hide-wall-chrome');
    view.classList.add('veiled');
    setTimeout(() => {
      view.classList.add('hidden');
      view.classList.remove('veiled', 'arriving');
    }, 480);
    Wall.beginIntro();          // and the archive drifts back
  }

  function showArchive(animate = true) {
    editorEl.classList.add('hidden');
    hideGroupControls();
    archiveEl.classList.remove('hidden');
    if (animate) {
      archiveEl.classList.add('fading');
      setTimeout(() => archiveEl.classList.remove('fading'), 20);
    }
    // restore the place in the horizontal line the reader left from
    setTimeout(() => { stripWrap.scrollLeft = stripReturn; }, 0);
  }

  /* ————————————————— the document archive (a horizontal line) ————————— */

  async function loadDocs() {
    try {
      const [d, tags] = await Promise.all([API.documents(), API.tags()]);
      docs = d.documents || [];
      allTags = tags || [];
    } catch { docs = []; }
    renderStrip();
    renderDocFilterLists();
  }

  function matches(doc) {
    if (dfilter.stars && (doc.rating || 0) < dfilter.stars) return false;
    if (dfilter.tags.length) {
      const mine = new Set(parseTags(doc.tags).map(t => t.toLowerCase()));
      for (const t of dfilter.tags)
        if (!mine.has(t.toLowerCase())) return false;
    }
    if (dfilter.q) {
      const hay = docPlainText(doc);
      for (const w of dfilter.q.toLowerCase().split(/\s+/))
        if (w && !hay.includes(w)) return false;
    }
    return true;
  }

  // CSS cannot reliably divide a responsive length by the 816px source page
  // width to produce a unitless transform scale. Measure each flex item instead
  // so the full-size page always fits its card and cannot cover its neighbours.
  const cardScaleObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      const inner = entry.target.querySelector('.doc-card-inner');
      if (inner && entry.contentRect.width)
        inner.style.transform = `scale(${entry.contentRect.width / PAGE_W})`;
    }
  });

  function renderStrip() {
    // keep the create button; rebuild the cards after it
    [...strip.querySelectorAll('.doc-card')].forEach(c => {
      cardScaleObserver.unobserve(c);
      c.remove();
    });
    const shown = docs.filter(matches);
    for (const doc of shown) strip.appendChild(buildCard(doc));
    $('doc-empty').classList.toggle('hidden', docs.length !== 0);
  }

  function buildCard(doc) {
    const card = document.createElement('div');
    card.className = 'doc-card';
    card.dataset.id = doc.id;
    const inner = document.createElement('div');
    inner.className = 'doc-card-inner';
    renderDocInto(inner, doc);
    card.appendChild(inner);
    cardScaleObserver.observe(card);
    // small quiet marks beneath the card: rating + tag dots, like a print
    const marks = document.createElement('div');
    marks.className = 'doc-card-marks';
    if (doc.rating)
      marks.appendChild(Object.assign(document.createElement('span'),
        {className: 'doc-card-stars', textContent: '★'.repeat(doc.rating)}));
    for (const t of parseTags(doc.tags)) {
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(t);
      marks.appendChild(dot);
    }
    card.appendChild(marks);

    card.addEventListener('click', () => { if (!picking) openDoc(doc.id); });
    card.addEventListener('contextmenu', e => {
      e.preventDefault();
      showContext(e.clientX, e.clientY, doc.id);
    });
    // fade/glide in, the archive's own appearance language (a timer, not rAF,
    // so the card still appears if the window happens to be hidden)
    setTimeout(() => card.classList.add('here'), 20);
    return card;
  }

  // render a document (pages, text, image groups, annotations) into a
  // fixed-width US-Letter column; the archive card scales the whole thing down
  function renderDocInto(container, doc, {editable = false} = {}) {
    container.style.width = PAGE_W + 'px';
    const holder = editable ? flow : document.createElement('div');
    if (!editable) {
      holder.className = 'doc-flow-static';
      holder.innerHTML = doc.content || '';
      renderGroups(holder, doc);
    }
    if (!editable) {
      const pageWrap = document.createElement('div');
      pageWrap.className = 'doc-paper-static';
      pageWrap.style.width = PAGE_W + 'px';
      pageWrap.appendChild(holder);
      const cv = document.createElement('canvas');
      cv.className = 'doc-anno-static';
      pageWrap.appendChild(cv);
      container.appendChild(pageWrap);
      // paginate + draw annotations once images have their sizes
      const paint = () => {
        const pages = paginate(pageWrap, holder);
        drawAnnotations(cv, doc, pages.total);
      };
      paint();
      // images arriving change the height; repaint when they do
      holder.querySelectorAll('img').forEach(im => {
        if (!im.complete) im.addEventListener('load', paint, {once: true});
      });
    }
  }

  /* pagination: lay page rectangles behind a continuous flow. The page count
     grows out of the content height, so text spilling past one 8.5×11 sheet
     reveals another directly below it, with the same margins on every page. */
  function paginate(paperEl, flowEl) {
    const flowH = flowEl.scrollHeight;
    const perPage = PAGE_H - 2 * MARGIN;          // usable height inside margins
    const total = Math.max(1, Math.ceil(flowH / perPage));
    const height = total * PAGE_H + (total - 1) * GAP;
    paperEl.style.height = height + 'px';
    // (re)build the page backgrounds
    [...paperEl.querySelectorAll('.doc-page')].forEach(p => p.remove());
    for (let i = 0; i < total; i++) {
      const pg = document.createElement('div');
      pg.className = 'doc-page';
      pg.style.top = i * (PAGE_H + GAP) + 'px';
      paperEl.insertBefore(pg, paperEl.firstChild);
    }
    return {total, height};
  }

  /* ————————————————— image groups ————————————————— */

  function renderGroups(root, doc) {
    for (const el of root.querySelectorAll('.doc-group')) {
      const gid = el.dataset.gid;
      const g = (doc.groups || {})[gid];
      el.setAttribute('contenteditable', 'false');
      el.innerHTML = '';
      if (!g || !g.images || !g.images.length) { el.remove(); continue; }
      el.classList.toggle('bw', !!g.bw);
      const cols = Math.max(1, Math.min(g.images.length, g.layout || g.images.length));
      const grid = document.createElement('div');
      grid.className = 'doc-group-grid';
      grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
      for (const pid of g.images) {
        const im = document.createElement('img');
        im.src = '/image/' + pid;
        im.draggable = false;
        grid.appendChild(im);
      }
      el.appendChild(grid);
    }
  }

  /* ————————————————— shared pixel annotations ————————————————— */

  // Convert Claude's older path-based document strokes once, preserving their
  // visible ink while moving them onto the photograph brush's cell model.
  function addLegacyStrokes(data, ink, wig) {
    for (const s of (data && data.strokes) || []) {
      if (s.tool !== 'ink' && s.tool !== 'wiggly') continue;
      const target = s.tool === 'wiggly' ? wig : ink;
      const stamp = (x, y) => {
        for (const [cx, cy] of PixelBrushes.cellsAround(x, y,
          Math.max(1, s.size || 3))) target.set(cx + ',' + cy, s.color || 0);
      };
      const pts = s.pts || [];
      if (pts.length) stamp(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++)
        PixelBrushes.strokeLine(pts[i - 1][0], pts[i - 1][1],
          pts[i][0], pts[i][1], stamp);
    }
  }

  function annotationMaps(data) {
    const maps = PixelBrushes.mapsFrom(data);
    addLegacyStrokes(data, maps.ink, maps.wig);
    return maps;
  }

  function drawAnnotations(cv, doc, pages) {
    const height = pages * PAGE_H + (pages - 1) * GAP;
    const dpr = window.devicePixelRatio || 1;
    cv.width = PAGE_W * dpr; cv.height = height * dpr;
    cv.style.width = PAGE_W + 'px'; cv.style.height = height + 'px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, PAGE_W, height);
    const {ink, wig} = annotationMaps(doc.annotations);
    const brushView = {toScreen: (x, y) => [x, y], scale: 1,
                       width: PAGE_W, height, now: performance.now()};
    PixelBrushes.paintInk(g, ink, brushView);
    PixelBrushes.paintWiggly(g, wig, brushView);
  }

  /* ————————————————— opening / closing a document ————————————————— */

  async function openDoc(id) {
    stripReturn = stripWrap.scrollLeft;
    let doc;
    try { doc = await API.document(id); } catch { return; }
    if (!doc || !doc.id) return;
    cur = doc;
    cur.groups = (cur.groups && typeof cur.groups === 'object') ? cur.groups : {};
    loadDocumentAnnotations(cur.annotations);
    // the other documents fade away as this one opens
    archiveEl.classList.add('leaving');
    setTimeout(() => archiveEl.classList.add('hidden'), 320);
    editorEl.classList.remove('hidden');
    editorEl.classList.add('fading');
    setTimeout(() => editorEl.classList.remove('fading'), 20);

    flow.innerHTML = doc.content || '';
    renderGroups(flow, doc);
    setMode('text');
    renderDocStars();
    renderDocTags();
    dirty = false;
    // paginate synchronously (reading scrollHeight forces the layout we need);
    // never gate this on requestAnimationFrame, which is suspended while the
    // window is hidden — the pages must exist the moment the document opens
    repaginate();
    scroll.scrollTop = 0;
    ensureAnnoLoop();
  }

  function closeEditor(silent) {
    if (!cur) return;
    flushSave(true);
    stopAnnoLoop();
    cur = null;
    hideGroupControls();
    $('doc-tags-pop').classList.add('hidden');
    archiveEl.classList.remove('leaving');
    if (!silent) showArchive(true);
  }

  function backToArchive() {
    closeEditor(false);
    loadDocs();                 // pick up the just-edited card's new look
  }

  /* ————————————————— pagination in the editor ————————————————— */

  let repaginatePending = false;
  function repaginate() {
    if (!cur) return;
    const pages = paginate(paper, flow);
    // annotations cover the whole writing workspace, including outside paper
    sizeAnnoCanvas();
    positionGroupControls();
  }
  // coalesce rapid edits with a timer, not requestAnimationFrame — timers still
  // fire when the window is hidden, so pagination never silently stalls
  function scheduleRepaginate() {
    if (repaginatePending) return;
    repaginatePending = true;
    setTimeout(() => { repaginatePending = false; repaginate(); }, 0);
  }

  function sizeAnnoCanvas() {
    const width = editorEl.clientWidth || window.innerWidth;
    const height = editorEl.clientHeight || window.innerHeight;
    const dpr = window.devicePixelRatio || 1;
    annoCanvas.width = width * dpr; annoCanvas.height = height * dpr;
    annoCanvas.style.width = width + 'px';
    annoCanvas.style.height = height + 'px';
    drawEditorAnnotations();
  }

  function drawEditorAnnotations() {
    if (!cur) return {wiggly: false, future: false};
    const dpr = window.devicePixelRatio || 1;
    actx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const width = annoCanvas.width / dpr, height = annoCanvas.height / dpr;
    actx.clearRect(0, 0, width, height);
    const cr = annoCanvas.getBoundingClientRect();
    const pr = paper.getBoundingClientRect();
    const brushView = {
      toScreen: (x, y) => [pr.left - cr.left + x, pr.top - cr.top + y],
      scale: 1, width, height, now: performance.now(),
    };
    PixelBrushes.paintInk(actx, docInk, brushView);
    const wiggly = PixelBrushes.paintWiggly(actx, docWig, brushView);
    const future = PixelBrushes.paintFuture(actx, docFuture, brushView);
    if (performance.now() < docSizePreviewUntil) {
      const d = (2 * (brushSize - 1) + 1) * CELL;
      actx.strokeStyle = 'rgba(110,110,105,0.55)';
      actx.lineWidth = 1;
      actx.strokeRect(docLastMouse.x - d / 2, docLastMouse.y - d / 2, d, d);
    }
    return {wiggly, future};
  }

  /* Match the image workspace's animation cadence: future pixels animate while
     alive; wiggly pixels wake only for their next 125ms boil frame. */
  let annoRaf = 0, annoWigTimer = null;
  function ensureAnnoLoop() {
    if (annoRaf || !cur) return;
    annoRaf = requestAnimationFrame(() => {
      annoRaf = 0;
      if (!cur) return;
      const live = drawEditorAnnotations();
      if (live.future || performance.now() < docSizePreviewUntil) ensureAnnoLoop();
      if (live.wiggly && !annoWigTimer)
        annoWigTimer = setTimeout(() => {
          annoWigTimer = null; ensureAnnoLoop();
        }, 125);
    });
  }
  function stopAnnoLoop() {
    cancelAnimationFrame(annoRaf); annoRaf = 0;
    clearTimeout(annoWigTimer); annoWigTimer = null;
  }

  /* ————————————————— text editing ————————————————— */

  flow.addEventListener('input', () => { markDirty(); scheduleRepaginate(); });
  // keep pasted content plain, so a document never inherits foreign styling
  flow.addEventListener('paste', e => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text');
    document.execCommand('insertText', false, text);
  });
  // "- " at the start of a line becomes a bullet list, word-processor style.
  // (No stopPropagation: the writing key handler must still see Escape to
  // back out, and it already ignores ordinary typing while the flow is focused.)
  flow.addEventListener('keydown', e => {
    if (e.key === ' ') {
      const r = window.getSelection();
      if (r && r.rangeCount) {
        const node = r.focusNode;
        const txt = node && node.textContent ? node.textContent : '';
        if ((txt === '-' || txt === '*') && r.focusOffset === txt.length) {
          e.preventDefault();
          if (node.nodeType === 3) node.textContent = '';
          document.execCommand('insertUnorderedList');
          markDirty();
        }
      }
    }
  });

  /* ——— protect image groups from ordinary text deletion (§10) ———
     An image group is a contenteditable=false block; the editor would happily
     let a Backspace at its boundary swallow it. We intercept any delete whose
     target range touches a group: instead of removing it, the caret is parked
     at the end of the nearest text above the group. A group is only ever
     removed through its explicit remove action (Delete/Backspace while it is
     selected, or its context control). */
  function isGroupNode(nd) {
    if (!nd || nd.nodeType !== 1) return null;
    if (nd.classList && nd.classList.contains('doc-group')) return nd;
    const last = nd.lastElementChild;
    if (last && last.classList && last.classList.contains('doc-group')) return last;
    return null;
  }
  // getTargetRanges() yields StaticRanges (no methods) — rebuild a live Range
  // and test intersection against each group block
  function rangeTouchesGroup(sr) {
    let range;
    try {
      range = document.createRange();
      range.setStart(sr.startContainer, sr.startOffset);
      range.setEnd(sr.endContainer, sr.endOffset);
    } catch { return null; }
    for (const el of flow.querySelectorAll('.doc-group')) {
      try { if (range.intersectsNode(el)) return el; } catch {}
    }
    return null;
  }
  // structural check: is a group the node a backspace/delete would cross into?
  function groupAcrossCaret(forward) {
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    let { startContainer: n, startOffset: o } = r;
    const atEdge = forward
      ? (n.nodeType === 3 ? o === n.textContent.length : o === n.childNodes.length)
      : o === 0;
    if (n.nodeType === 1 && !atEdge) {
      const c = n.childNodes[forward ? o : o - 1];
      return isGroupNode(c);
    }
    if (!atEdge) return null;              // deletion stays inside this text node
    let node = n;
    const sib = forward ? 'nextSibling' : 'previousSibling';
    while (node && node !== flow && !node[sib]) node = node.parentNode;
    if (!node || node === flow) return null;
    return isGroupNode(node[sib]);
  }
  function parkCaretAboveGroup(grp) {
    const sel = window.getSelection();
    const r = document.createRange();
    let prev = grp.previousSibling;
    while (prev && prev.nodeType === 3 && !prev.textContent.trim())
      prev = prev.previousSibling;
    if (prev) { r.selectNodeContents(prev); r.collapse(false); }
    else { r.setStartBefore(grp); r.collapse(true); }
    sel.removeAllRanges();
    sel.addRange(r);
  }
  flow.addEventListener('beforeinput', e => {
    if (!e.inputType || !e.inputType.startsWith('delete')) return;
    const ranges = e.getTargetRanges ? e.getTargetRanges() : [];
    let grp = ranges && ranges[0] ? rangeTouchesGroup(ranges[0]) : null;
    // fallback for a collapsed caret sitting just beside a group
    if (!grp) grp = groupAcrossCaret(e.inputType === 'deleteContentForward');
    if (grp) {
      // a group is removed only through its explicit remove action, never by
      // ordinary text deletion; park the caret at the text above instead
      e.preventDefault();
      if (e.inputType === 'deleteContentBackward') parkCaretAboveGroup(grp);
    }
  });

  function markDirty() { dirty = true; scheduleSave(); }

  function fmt(cmd, val) {
    flow.focus();
    document.execCommand(cmd, false, val || null);
    markDirty();
    scheduleRepaginate();
  }
  // clicking any text tool must not steal the selection from the flow
  view.querySelector('.doc-bar-tools[data-tools="text"]')
    .addEventListener('mousedown', e => {
      if (e.target.closest('button')) e.preventDefault();
    });
  // bold / italic / underline via inline tags (styleWithCSS off), so bold is a
  // <b> element that CSS renders as Helvetica Neue *Regular* over the Light body
  function inlineFmt(cmd) {
    flow.focus();
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(cmd, false, null);
    markDirty();
    scheduleRepaginate();
  }
  $('doc-bold').addEventListener('click', () => inlineFmt('bold'));
  $('doc-italic').addEventListener('click', () => inlineFmt('italic'));
  $('doc-underline').addEventListener('click', () => inlineFmt('underline'));
  $('doc-bullets').addEventListener('click', () => fmt('insertUnorderedList'));

  /* ——— point sizes, like a conventional editor ——— */
  const PT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
  const DEFAULT_PT = 12;                      // 12pt ≈ 16px at the page's 96ppi
  const ptToPx = pt => Math.round(pt * 96 / 72 * 100) / 100;
  const sizeValue = $('doc-size-value');
  const sizeDown = $('doc-size-down');
  const sizeUp = $('doc-size-up');
  let activePt = DEFAULT_PT;

  function showPointSize(pt) {
    activePt = pt;
    sizeValue.textContent = pt + ' pt';
    const i = PT_SIZES.indexOf(pt);
    sizeDown.disabled = i <= 0;
    sizeUp.disabled = i >= PT_SIZES.length - 1;
  }

  function stepPointSize(direction) {
    const i = PT_SIZES.indexOf(activePt);
    const next = PT_SIZES[Math.max(0, Math.min(PT_SIZES.length - 1,
      (i < 0 ? PT_SIZES.indexOf(DEFAULT_PT) : i) + direction))];
    showPointSize(next);
    applyFontSize(next);
  }

  showPointSize(DEFAULT_PT);
  sizeDown.addEventListener('click', () => stepPointSize(-1));
  sizeUp.addEventListener('click', () => stepPointSize(1));

  function applyFontSize(pt) {
    flow.focus();
    const px = ptToPx(pt);
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    if (sel.isCollapsed) {
      // become the active size for newly typed text
      const span = document.createElement('span');
      span.style.fontSize = px + 'px';
      span.appendChild(document.createTextNode('​'));
      const r = sel.getRangeAt(0);
      r.insertNode(span);
      r.setStart(span.firstChild, 1); r.collapse(true);
      sel.removeAllRanges(); sel.addRange(r);
    } else {
      // mark the selection, then rewrite the markers to a real px size span
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('fontSize', false, '7');
      for (const f of [...flow.querySelectorAll('font[size="7"]')]) {
        const span = document.createElement('span');
        span.style.fontSize = px + 'px';
        while (f.firstChild) span.appendChild(f.firstChild);
        f.replaceWith(span);
      }
    }
    markDirty();
    scheduleRepaginate();
  }

  // keep the size control reflecting the caret's current size
  function syncSizeControl() {
    const px = parseFloat(document.queryCommandValue
      ? getComputedStyle(caretElement() || flow).fontSize : '16') || 16;
    const pt = Math.round(px * 72 / 96);
    const nearest = PT_SIZES.reduce((best, size) =>
      Math.abs(size - pt) < Math.abs(best - pt) ? size : best, PT_SIZES[0]);
    showPointSize(nearest);
  }
  function caretElement() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let n = sel.getRangeAt(0).startContainer;
    return n.nodeType === 3 ? n.parentElement : n;
  }

  /* ——— greyscale text colour: a black-and-white colour wheel, black → grey ——— */
  const TEXT_GREYS = ['#000000', '#2e2e2e', '#565656', '#7d7d7d',
                      '#a2a2a2', '#bfbfbf', '#d2d2d2'];
  const greysWrap = $('doc-text-greys');
  const textColorWrap = $('doc-text-color');
  TEXT_GREYS.forEach(hex => {
    const b = document.createElement('button');
    b.className = 'doc-grey-swatch';
    b.style.background = hex;
    b.addEventListener('mousedown', e => e.preventDefault());
    b.addEventListener('click', () => {
      applyTextColor(hex);
      textColorWrap.classList.remove('open');
    });
    greysWrap.appendChild(b);
  });
  $('doc-text-wheel').addEventListener('mousedown', e => e.preventDefault());
  $('doc-text-wheel').addEventListener('click', () => {
    textColorWrap.classList.toggle('open');
  });
  function applyTextColor(hex) {
    flow.focus();
    document.execCommand('styleWithCSS', false, true);   // emit a colour span
    document.execCommand('foreColor', false, hex);        // selection or pending
    markDirty();
    scheduleRepaginate();
  }

  // keep the pt control showing the size at the caret
  document.addEventListener('selectionchange', () => {
    if (cur && mode === 'text' &&
        (document.activeElement === flow || flow.contains(document.activeElement)))
      syncSizeControl();
  });

  /* ————————————————— saving ————————————————— */

  function serializeContent() {
    const clone = flow.cloneNode(true);
    // groups are stored in cur.groups; keep only empty placeholders in the flow
    for (const el of clone.querySelectorAll('.doc-group')) {
      el.innerHTML = '';
      el.removeAttribute('contenteditable');
      for (const a of [...el.attributes])
        if (a.name !== 'class' && a.name !== 'data-gid')
          el.removeAttribute(a.name);
    }
    return clone.innerHTML;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flushSave(false), 1500);
  }

  function flushSave(sync) {
    clearTimeout(saveTimer);
    if (!cur) return;
    cur.content = serializeContent();
    syncDocumentAnnotations();
    const payload = {
      content: cur.content, groups: cur.groups,
      annotations: cur.annotations, rating: cur.rating || 0,
      tags: cur.tags || '',
    };
    // reflect the edit in the cached list so the archive card is up to date
    const i = docs.findIndex(d => d.id === cur.id);
    if (i >= 0) Object.assign(docs[i], payload);
    if (sync) {
      API.saveDocumentBeacon(cur.id, payload);
    } else {
      API.saveDocument(cur.id, payload).then(() => hintSaved()).catch(() => {});
    }
    dirty = false;
  }

  let hintTimer = null;
  function hintSaved() {
    const h = $('doc-save-hint');
    h.textContent = 'saved';
    h.classList.add('show');
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => h.classList.remove('show'), 1400);
  }

  /* ————————————————— rating + tags ————————————————— */

  function renderDocStars() {
    const el = $('doc-stars');
    el.innerHTML = '';
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement('button');
      b.className = 'doc-star' + (i <= (cur.rating || 0) ? ' on' : '');
      b.textContent = '★';
      b.addEventListener('click', () => {
        cur.rating = (cur.rating === i) ? 0 : i;
        renderDocStars(); markDirty();
      });
      el.appendChild(b);
    }
  }

  function renderDocTags() {
    const chips = $('doc-tag-chips');
    chips.innerHTML = '';
    for (const [i, name] of parseTags(cur.tags).entries()) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      chip.title = 'remove';
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => {
        const t = parseTags(cur.tags);
        t.splice(i, 1);
        cur.tags = t.join(', ');
        renderDocTags(); markDirty();
      });
      chips.appendChild(chip);
    }
    renderDocTagSuggest();
  }

  function renderDocTagSuggest() {
    const el = $('doc-tag-suggest');
    el.innerHTML = '';
    const typed = $('doc-tag-input').value.trim().toLowerCase();
    const mine = new Set(parseTags(cur.tags).map(t => t.toLowerCase()));
    // tags on photos are automatically available as document tags
    const opts = allTags.filter(n => !mine.has(n.toLowerCase()) &&
      (!typed || n.toLowerCase().includes(typed))).slice(0, 12);
    for (const name of opts) {
      const chip = document.createElement('button');
      chip.className = 'tag-chip';
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => { addDocTag(name); });
      el.appendChild(chip);
    }
  }

  function addDocTag(name) {
    const t = parseTags(cur.tags);
    if (!t.some(x => x.toLowerCase() === name.toLowerCase())) t.push(name);
    cur.tags = t.join(', ');
    $('doc-tag-input').value = '';
    renderDocTags(); markDirty();
  }

  $('doc-tags-btn').addEventListener('click', () => {
    $('doc-tags-pop').classList.toggle('hidden');
    if (!$('doc-tags-pop').classList.contains('hidden')) $('doc-tag-input').focus();
  });
  $('doc-tag-input').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const v = $('doc-tag-input').value.trim();
      if (v) addDocTag(v);
    }
  });
  $('doc-tag-input').addEventListener('input', renderDocTagSuggest);

  function parseTags(s) {
    return (s || '').split(',').map(t => t.trim()).filter(Boolean);
  }
  function docPlainText(doc) {
    const tmp = document.createElement('div');
    tmp.innerHTML = doc.content || '';
    return ((tmp.textContent || '') + ' ' + (doc.tags || '')).toLowerCase();
  }

  /* ————————————————— modes (text / annotate / picture) ————————————————— */

  function setMode(m) {
    if (m === 'picture') { beginPicture(); return; }
    mode = m;
    for (const b of view.querySelectorAll('.doc-mode'))
      b.classList.toggle('active', b.dataset.mode === m);
    for (const t of view.querySelectorAll('.doc-bar-tools'))
      t.classList.toggle('hidden', t.dataset.tools !== m);
    const annot = m === 'annotate';
    // only one conflicting tool is ever active: annotate freezes text editing
    flow.setAttribute('contenteditable', annot ? 'false' : 'true');
    annoCanvas.classList.toggle('live', annot);
    editorEl.classList.toggle('annotating', annot);
    if (annot) {
      hideGroupControls(); deselectGroup();
      sizeAnnoCanvas(); ensureAnnoLoop();
    } else finishDocStroke();
  }
  for (const b of view.querySelectorAll('.doc-mode'))
    b.addEventListener('click', () => setMode(b.dataset.mode));

  /* ——— annotation brushes ——— */
  let brushTool = 'ink', brushColor = 1, brushSize = 4;
  let docInk = new Map(), docWig = new Map(), docFuture = new Map();
  let docUndoStack = [], docStroke = null;
  let docLastMouse = {x: 0, y: 0}, docSizePreviewUntil = 0;

  function loadDocumentAnnotations(data) {
    const maps = annotationMaps(data);
    docInk = maps.ink; docWig = maps.wig; docFuture = new Map();
    docUndoStack = []; docStroke = null;
    if (cur) cur.annotations = PixelBrushes.serialize(docInk, docWig);
  }

  function syncDocumentAnnotations() {
    if (cur) cur.annotations = PixelBrushes.serialize(docInk, docWig);
  }

  const swatchWrap = $('doc-swatches');
  COLORS.forEach((c, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (c === '#FFFFFF' ? ' white' : '');
    b.style.background = c;
    b.title = COLOR_NAMES[i];
    b.addEventListener('click', () => setBrushColor(i));
    swatchWrap.appendChild(b);
  });
  function setBrushColor(i) {
    brushColor = i;
    [...swatchWrap.children].forEach((b, j) => b.classList.toggle('active', j === i));
    const dot = $('doc-brush-dot').firstElementChild;
    dot.style.background = COLORS[i];
    dot.classList.toggle('white', COLORS[i] === '#FFFFFF');
  }
  function setBrushSize(n) {
    brushSize = Math.max(1, Math.min(10, n));
    const dot = $('doc-brush-dot').firstElementChild;
    const px = 3 + brushSize * 1.4;
    dot.style.width = px + 'px'; dot.style.height = px + 'px';
  }
  for (const b of view.querySelectorAll('.doc-brush'))
    b.addEventListener('click', () => {
      brushTool = b.dataset.brush;
      for (const o of view.querySelectorAll('.doc-brush'))
        o.classList.toggle('active', o === b);
    });
  view.querySelector('.doc-brush').classList.add('active');
  $('doc-brush-up').addEventListener('click', () => setBrushSize(brushSize + 1));
  $('doc-brush-down').addEventListener('click', () => setBrushSize(brushSize - 1));
  $('doc-anno-undo').addEventListener('click', () => {
    const op = docUndoStack.pop();
    if (!cur || !op) return;
    if (op.type === 'stroke') {
      for (let i = op.cells.length - 1; i >= 0; i--) {
        const [key, prev] = op.cells[i];
        if (prev === null) docInk.delete(key); else docInk.set(key, prev);
      }
      for (let i = op.wigCells.length - 1; i >= 0; i--) {
        const [key, prev] = op.wigCells[i];
        if (prev === null) docWig.delete(key); else docWig.set(key, prev);
      }
    } else if (op.type === 'clear') {
      docInk = new Map(op.ink); docWig = new Map(op.wig);
    }
    syncDocumentAnnotations(); markDirty(); ensureAnnoLoop();
  });
  $('doc-anno-clear').addEventListener('click', () => {
    if (!cur || (!docInk.size && !docWig.size && !docFuture.size)) return;
    docUndoStack.push({type: 'clear', ink: [...docInk], wig: [...docWig]});
    docInk.clear(); docWig.clear(); docFuture.clear();
    syncDocumentAnnotations(); markDirty(); ensureAnnoLoop();
  });
  setBrushColor(1); setBrushSize(4);

  function annoPoint(e) {
    const r = paper.getBoundingClientRect();
    return [(e.clientX - r.left), (e.clientY - r.top)];
  }

  function docCellInBounds(cx, cy) {
    const x = cx * CELL, y = cy * CELL;
    const paperH = Math.max(PAGE_H, paper.getBoundingClientRect().height);
    const mx = PAGE_W * 0.85, my = paperH * 0.85;
    return x >= -mx && x <= PAGE_W + mx && y >= -my && y <= paperH + my;
  }

  function applyDocBrush(wx, wy) {
    for (const [cx, cy] of PixelBrushes.cellsAround(wx, wy, brushSize)) {
      if (!docCellInBounds(cx, cy)) continue;
      const key = cx + ',' + cy;
      if (brushTool === 'ink') {
        const prev = docInk.has(key) ? docInk.get(key) : null;
        if (prev === brushColor) continue;
        docStroke.cells.push([key, prev]);
        docInk.set(key, brushColor);
      } else if (brushTool === 'wiggly') {
        const prev = docWig.has(key) ? docWig.get(key) : null;
        if (prev === brushColor) continue;
        docStroke.wigCells.push([key, prev]);
        docWig.set(key, brushColor);
      } else if (brushTool === 'future') {
        docFuture.set(key, {t: performance.now(), c: brushColor});
      } else if (brushTool === 'erase') {
        if (docInk.has(key)) {
          docStroke.cells.push([key, docInk.get(key)]);
          docInk.delete(key);
        }
        if (docWig.has(key)) {
          docStroke.wigCells.push([key, docWig.get(key)]);
          docWig.delete(key);
        }
        docFuture.delete(key);
      }
    }
  }

  function finishDocStroke() {
    if (!docStroke) return;
    if (docStroke.cells.length || docStroke.wigCells.length) {
      docUndoStack.push(docStroke);
      if (docUndoStack.length > 120) docUndoStack.shift();
      syncDocumentAnnotations(); markDirty();
    }
    docStroke = null;
    ensureAnnoLoop();
  }

  annoCanvas.addEventListener('pointerdown', e => {
    if (mode !== 'annotate' || e.button !== 0) return;
    try { annoCanvas.setPointerCapture(e.pointerId); } catch {}
    const [x, y] = annoPoint(e);
    docStroke = {type: 'stroke', cells: [], wigCells: []};
    applyDocBrush(x, y);
    docStroke.last = [x, y];
    ensureAnnoLoop();
  });
  annoCanvas.addEventListener('pointermove', e => {
    if (mode !== 'annotate') return;
    const cr = annoCanvas.getBoundingClientRect();
    docLastMouse = {x: e.clientX - cr.left, y: e.clientY - cr.top};
    if (!docStroke) return;
    const [x, y] = annoPoint(e);
    PixelBrushes.strokeLine(docStroke.last[0], docStroke.last[1], x, y,
      applyDocBrush);
    docStroke.last = [x, y];
    ensureAnnoLoop();
  });
  annoCanvas.addEventListener('pointerup', finishDocStroke);
  annoCanvas.addEventListener('pointercancel', finishDocStroke);
  annoCanvas.addEventListener('wheel', e => {
    if (mode !== 'annotate') return;
    e.preventDefault();
    setBrushSize(brushSize + (e.deltaY < 0 ? 1 : -1));
    docSizePreviewUntil = performance.now() + 650;
    ensureAnnoLoop();
  }, {passive: false});

  // Text mode releases the overlay; annotate mode draws across the whole view.
  scroll.addEventListener('scroll', () => {
    if (cur) ensureAnnoLoop();
  });

  /* ————————————————— image-group selection, layout, edit, b/w, move ———— */

  let selGid = null;
  flow.addEventListener('click', e => {
    if (mode === 'annotate') return;
    const g = e.target.closest('.doc-group');
    if (g) { selectGroup(g.dataset.gid); e.stopPropagation(); }
    else deselectGroup();
  });

  function selectGroup(gid) {
    selGid = gid;
    for (const el of flow.querySelectorAll('.doc-group'))
      el.classList.toggle('selected', el.dataset.gid === gid);
    showGroupControls(gid);
  }
  function deselectGroup() {
    selGid = null;
    for (const el of flow.querySelectorAll('.doc-group'))
      el.classList.remove('selected');
    hideGroupControls();
  }

  const groupControls = $('doc-group-controls');
  const layoutSlider = $('doc-layout-slider');
  function showGroupControls(gid) {
    const g = cur.groups[gid];
    if (!g) return;
    // the slider's range is computed from this group's own image count:
    // one end = all on a single row, the other = one full-width image per row
    layoutSlider.min = 1;
    layoutSlider.max = g.images.length;
    // slider position mirrors columns; store layout as columns
    layoutSlider.value = Math.max(1, Math.min(g.images.length, g.layout || g.images.length));
    $('doc-group-bw').classList.toggle('active', !!g.bw);
    groupControls.classList.remove('hidden');
    positionGroupControls();
  }
  function hideGroupControls() { groupControls.classList.add('hidden'); }

  function positionGroupControls() {
    if (groupControls.classList.contains('hidden') || !selGid) return;
    const el = flow.querySelector(`.doc-group[data-gid="${selGid}"]`);
    if (!el) { hideGroupControls(); return; }
    const gr = el.getBoundingClientRect();
    const sr = scroll.getBoundingClientRect();
    groupControls.style.left = (gr.left + gr.width / 2) + 'px';
    groupControls.style.top = Math.min(sr.bottom - 60, gr.bottom + 8) + 'px';
  }
  scroll.addEventListener('scroll', positionGroupControls);

  layoutSlider.addEventListener('input', () => {
    if (!selGid) return;
    const g = cur.groups[selGid];
    g.layout = +layoutSlider.value;   // columns; height changes, text reflows
    const el = flow.querySelector(`.doc-group[data-gid="${selGid}"]`);
    const grid = el.querySelector('.doc-group-grid');
    grid.style.gridTemplateColumns = `repeat(${g.layout}, 1fr)`;
    scheduleRepaginate();
    markDirty();
  });
  $('doc-group-bw').addEventListener('click', () => {
    if (!selGid) return;
    const g = cur.groups[selGid];
    g.bw = !g.bw;
    flow.querySelector(`.doc-group[data-gid="${selGid}"]`).classList.toggle('bw', g.bw);
    $('doc-group-bw').classList.toggle('active', g.bw);
    markDirty();
  });
  $('doc-group-edit').addEventListener('click', () => {
    if (!selGid) return;
    beginPicture(selGid);
  });

  /* ——— dragging a whole group to a new place between the text ——— */
  let groupDrag = null;
  flow.addEventListener('pointerdown', e => {
    if (mode === 'annotate') return;
    const el = e.target.closest('.doc-group');
    if (!el || el.dataset.gid !== selGid) return;   // only a selected group moves
    e.preventDefault();
    groupDrag = {el, id: e.pointerId, moved: false};
    el.classList.add('dragging');
  });
  window.addEventListener('pointermove', e => {
    if (!groupDrag) return;
    groupDrag.moved = true;
    const caret = caretFromPoint(e.clientX, e.clientY);
    showDropCaret(caret);
  });
  window.addEventListener('pointerup', e => {
    if (!groupDrag) return;
    const {el, moved} = groupDrag;
    groupDrag = null;
    el.classList.remove('dragging');
    clearDropCaret();
    if (moved) {
      const caret = caretFromPoint(e.clientX, e.clientY);
      if (caret) {
        const range = caret;
        range.insertNode(el);          // move the group block to the drop point
        scheduleRepaginate(); markDirty();
        positionGroupControls();
      }
    }
  });

  function caretFromPoint(x, y) {
    let range = null;
    if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(x, y);
    else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) { range = document.createRange(); range.setStart(p.offsetNode, p.offset); }
    }
    if (range && !flow.contains(range.startContainer)) return null;
    return range;
  }
  let dropCaret = null;
  function showDropCaret(range) {
    clearDropCaret();
    if (!range) return;
    dropCaret = document.createElement('span');
    dropCaret.className = 'doc-drop-caret';
    try { range.insertNode(dropCaret); } catch {}
  }
  function clearDropCaret() { if (dropCaret) { dropCaret.remove(); dropCaret = null; } }

  /* ————————————————— picture: hand off to the image archive ————————————— */

  let picking = false, pickIds = [], pickForGid = null, pickReturnScroll = 0;

  function beginPicture(editGid) {
    if (!cur) return;
    flushSave(false);
    pickForGid = editGid || null;
    pickIds = editGid && cur.groups[editGid]
      ? cur.groups[editGid].images.slice() : [];
    pickReturnScroll = scroll.scrollTop;
    // float-and-fade out of the document, exactly like leaving it
    editorEl.classList.add('picking-away');
    setTimeout(() => {
      editorEl.classList.add('hidden');
      editorEl.classList.remove('picking-away');
    }, 320);
    picking = true;
    document.body.classList.remove('hide-wall-chrome');   // the wall returns
    document.body.classList.add('doc-picking');
    Wall.beginIntro();
    $('doc-instruction').classList.remove('hidden');
    $('doc-picktray').classList.remove('hidden');
    renderPickTray();
    Wall.setPick(pickIds);
  }

  // called from the wall's open handler; returns true when we've consumed the
  // click as a selection toggle instead of opening the print
  function onPickClick(id) {
    if (!picking) return false;
    const i = pickIds.indexOf(id);
    if (i >= 0) pickIds.splice(i, 1);       // deselect: it drifts back
    else pickIds.push(id);                  // select: keep insertion order
    Wall.setPick(pickIds);
    renderPickTray();
    return true;
  }

  function renderPickTray() {
    const tray = $('doc-picktray');
    tray.innerHTML = '';
    for (const id of pickIds) {
      const im = document.createElement('img');
      im.src = '/thumb/' + id + '.jpg';
      im.className = 'pick-thumb';
      im.title = 'remove';
      im.addEventListener('click', () => {
        const i = pickIds.indexOf(id);
        if (i >= 0) pickIds.splice(i, 1);
        Wall.setPick(pickIds);
        renderPickTray();
      });
      tray.appendChild(im);
      setTimeout(() => im.classList.add('here'), 20);
    }
    tray.classList.toggle('empty', pickIds.length === 0);
  }

  function commitPicture() {
    if (!picking) return;
    const ids = pickIds.slice();
    endPicture();
    if (pickForGid && cur.groups[pickForGid]) {
      if (ids.length) {
        cur.groups[pickForGid].images = ids;   // replace membership
        const el = flow.querySelector(`.doc-group[data-gid="${pickForGid}"]`);
        cur.groups[pickForGid].layout = Math.min(
          cur.groups[pickForGid].layout || ids.length, ids.length);
        renderGroups(flow, cur);
        if (el) selectGroup(pickForGid);
      } else {
        // an emptied group is removed
        const el = flow.querySelector(`.doc-group[data-gid="${pickForGid}"]`);
        if (el) el.remove();
        delete cur.groups[pickForGid];
      }
    } else if (ids.length) {
      insertGroup(ids);
    }
    pickForGid = null;
    scheduleRepaginate();
    markDirty();
  }

  function cancelPicture() {
    if (!picking) return;
    pickForGid = null;
    endPicture();
  }

  function endPicture() {
    picking = false;
    Wall.setPick([]);
    $('doc-instruction').classList.add('hidden');
    $('doc-picktray').classList.add('hidden');
    document.body.classList.remove('doc-picking');
    document.body.classList.add('hide-wall-chrome');
    Wall.beginOutro(() => {});          // the wall lifts away again
    editorEl.classList.remove('hidden');
    editorEl.classList.add('fading');
    repaginate();                        // re-lay the pages synchronously
    scroll.scrollTop = pickReturnScroll;
    setTimeout(() => editorEl.classList.remove('fading'), 20);
  }

  function insertGroup(ids) {
    const gid = 'g' + Math.random().toString(36).slice(2, 9);
    cur.groups[gid] = {images: ids, bw: false, layout: ids.length};
    const block = document.createElement('div');
    block.className = 'doc-group';
    block.dataset.gid = gid;
    block.setAttribute('contenteditable', 'false');
    // insert at the caret if it sits in the flow, else append at the end
    const sel = window.getSelection();
    let placed = false;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (flow.contains(r.startContainer)) {
        r.collapse(false); r.insertNode(block); placed = true;
      }
    }
    if (!placed) flow.appendChild(block);
    renderGroups(flow, cur);
    selectGroup(gid);
  }

  /* ————————————————— the document context menu ————————————————— */

  const contextEl = $('doc-context');
  let contextId = null;
  function showContext(x, y, id) {
    contextId = id;
    contextEl.style.left = x + 'px';
    contextEl.style.top = y + 'px';
    contextEl.classList.remove('hidden');
  }
  function hideContext() { contextEl.classList.add('hidden'); contextId = null; }
  contextEl.querySelector('[data-act="duplicate"]').addEventListener('click', async () => {
    if (!contextId) return;
    const id = contextId; hideContext();
    try { await API.duplicateDocument(id); } catch {}
    loadDocs();
  });
  contextEl.querySelector('[data-act="delete"]').addEventListener('click', async () => {
    if (!contextId) return;
    const id = contextId; hideContext();
    // deletion is permanent — no trash, undo covers everything else in the app
    try { await API.deleteDocument(id); } catch {}
    loadDocs();
  });
  document.addEventListener('pointerdown', e => {
    if (!contextEl.classList.contains('hidden') && !contextEl.contains(e.target))
      hideContext();
  }, true);

  /* ————————————————— create ————————————————— */

  $('doc-create').addEventListener('click', async () => {
    // new documents enter at the front; the existing line shifts to the right
    let doc;
    try { doc = await API.createDocument({}); } catch { return; }
    docs.unshift(doc);
    renderStrip();
    openDoc(doc.id);
  });

  /* ————————————————— the horizontal strip: wheel → sideways ————————————— */

  stripWrap.addEventListener('wheel', e => {
    // vertical wheel moves the line horizontally; trackpad horizontal already
    // scrolls the overflow natively, so only translate a dominant vertical wheel
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      stripWrap.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, {passive: false});

  // overview: gently fit the whole collection across the view, still readable
  let overview = false;
  $('doc-btn-overview').addEventListener('click', () => {
    overview = !overview;
    strip.classList.toggle('overview', overview);
    stripWrap.scrollLeft = 0;
  });

  /* ————————————————— document search + filter ————————————————— */

  const docSearch = $('doc-search-input');
  $('doc-btn-search').addEventListener('click', () => {
    docSearch.classList.toggle('hidden');
    if (!docSearch.classList.contains('hidden')) docSearch.focus();
    else { docSearch.value = ''; dfilter.q = ''; renderStrip(); }
  });
  docSearch.addEventListener('input', () => {
    dfilter.q = docSearch.value.trim();
    renderStrip();
  });
  docSearch.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') { docSearch.value = ''; dfilter.q = ''; renderStrip();
                              docSearch.classList.add('hidden'); }
  });

  const docFilterBar = $('doc-filter-bar');
  $('doc-btn-filter').addEventListener('click', () => {
    docFilterBar.classList.toggle('hidden');
  });
  view.querySelectorAll('#doc-filter-bar .fb-group').forEach(btn => {
    btn.addEventListener('click', () => {
      const c = view.querySelector(`.fb-content[data-dcontent="${btn.dataset.dgroup}"]`);
      c.classList.toggle('hidden');
      btn.classList.toggle('open', !c.classList.contains('hidden'));
    });
  });
  view.querySelectorAll('#doc-fb-stars .fb-star').forEach((s, i) => {
    s.addEventListener('click', () => {
      dfilter.stars = (dfilter.stars === i + 1) ? 0 : i + 1;
      view.querySelectorAll('#doc-fb-stars .fb-star')
        .forEach((x, j) => x.classList.toggle('on', j < dfilter.stars));
      $('dfh-stars').textContent = dfilter.stars ? `${dfilter.stars} ★ and up` : '';
      renderStrip();
    });
  });
  $('doc-fb-clear').addEventListener('click', () => {
    dfilter.stars = 0; dfilter.tags = [];
    view.querySelectorAll('#doc-fb-stars .fb-star').forEach(x => x.classList.remove('on'));
    $('dfh-stars').textContent = '';
    renderDocFilterLists();
    renderStrip();
  });

  function renderDocFilterLists() {
    // tags available for filtering are the archive's tags, matching the app's
    // shared tag vocabulary (a tag lives only while it exists on a photo)
    const list = $('doc-fb-tag-list');
    list.innerHTML = '';
    dfilter.tags = dfilter.tags.filter(t =>
      allTags.some(a => a.toLowerCase() === t.toLowerCase()));
    if (!allTags.length) {
      list.innerHTML = '<span class="fb-none">no tags yet</span>';
    }
    for (const name of allTags) {
      const chip = document.createElement('button');
      const active = dfilter.tags.some(t => t.toLowerCase() === name.toLowerCase());
      chip.className = 'tag-chip' + (active ? ' active' : '');
      const dot = document.createElement('span');
      dot.className = 'tag-dot';
      dot.style.background = tagColor(name);
      chip.appendChild(dot);
      chip.appendChild(document.createTextNode(name));
      chip.addEventListener('click', () => {
        const i = dfilter.tags.findIndex(t => t.toLowerCase() === name.toLowerCase());
        if (i >= 0) dfilter.tags.splice(i, 1); else dfilter.tags.push(name);
        $('dfh-tags').textContent = dfilter.tags.join(' · ');
        renderDocFilterLists(); renderStrip();
      });
      list.appendChild(chip);
    }
  }

  /* ————————————————— navigation buttons + keys ————————————————— */

  $('doc-to-wall').addEventListener('click', leave);
  $('doc-to-archive').addEventListener('click', backToArchive);

  // keys, only while writing mode owns the screen
  window.addEventListener('keydown', e => {
    if (!open) return;
    if (picking) {
      if (e.key === 'Enter') { commitPicture(); e.preventDefault(); }
      else if (e.key === 'Escape') { cancelPicture(); e.preventDefault(); }
      return;
    }
    const typing = /INPUT|TEXTAREA/.test(document.activeElement.tagName) ||
                   document.activeElement === flow ||
                   flow.contains(document.activeElement);
    if (!cur) {                       // in the archive
      if (e.key === 'Escape') { leave(); e.preventDefault(); }
      return;
    }
    // in the editor
    if (e.key === 'Escape') {
      if (selGid) { deselectGroup(); e.preventDefault(); }
      else if (!$('doc-tags-pop').classList.contains('hidden'))
        $('doc-tags-pop').classList.add('hidden');
      else backToArchive();
      e.preventDefault();
      return;
    }
    // the one explicit way to remove a group: Delete/Backspace while it is the
    // selected group. Handled before the typing guard so it works even while
    // the flow holds focus (selecting a group leaves the caret in the flow).
    if ((e.key === 'Delete' || e.key === 'Backspace') && selGid) {
      const el = flow.querySelector(`.doc-group[data-gid="${selGid}"]`);
      if (el) el.remove();
      delete cur.groups[selGid];
      deselectGroup(); scheduleRepaginate(); markDirty();
      e.preventDefault();
      return;
    }
    if (typing) return;
  });

  window.addEventListener('resize', () => { if (cur) scheduleRepaginate(); });
  window.addEventListener('beforeunload', () => { if (cur) flushSave(true); });

  return {
    enter, leave,
    isOpen: () => open,
    isPicking: () => picking,
    onPickClick,
  };
})();
