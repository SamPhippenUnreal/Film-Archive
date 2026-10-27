'use strict';
// Run with Playwright available to Node:
//   node --test tests/js/project-interactions.browser.test.js
// PLAYWRIGHT_CHANNEL may select an installed browser (e.g. msedge).
// All requests use in-memory fixtures or repository static files. No archive,
// running application, linked folder, or user metadata is accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');
const positions = {
  center: {x: 365, y: 283, width: 144, height: 108, z: 1},
  right: {x: 624, y: 280, width: 144, height: 108, z: 2},
  left: {x: 96, y: 280, width: 120, height: 90, z: 3},
  up: {x: 360, y: 88, width: 144, height: 108, z: 4},
  down: {x: 360, y: 472, width: 144, height: 108, z: 5},
  far: {x: 888, y: 280, width: 144, height: 108, z: 6},
  document: {x: 535, y: 275, width: 60, height: 80, z: 7},
};
const files = Object.keys(positions).map(id => ({id, name: id + '.png',
  kind: id === 'document' ? 'file' : 'image',
  preview_url: '/fixture/preview/' + id, full_image_url: '/fixture/full/' + id}));
const project = {id: 'fixture', title: 'Navigation fixture', cover_url: '/fixture/preview/center'};
const colors = {center: '#ae633e', right: '#497366', left: '#405884',
  up: '#918046', down: '#976a85', far: '#555555'};
const tile = id => `.project-file[data-file-id="${id}"]`;

async function fixture(browser, reducedMotion = 'no-preference') {
  const page = await browser.newPage({viewport: {width: 1400, height: 1000}, reducedMotion});
  const errors = [], writes = [], imageRequests = [];
  let previewActive = 0, previewPeak = 0;
  let releaseFull;
  const fullGate = new Promise(resolve => { releaseFull = resolve; });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url()), pathname = url.pathname;
    if (pathname.startsWith('/api/')) {
      let data = {ok: true};
      if (request.method() !== 'GET') writes.push({path: pathname, body: request.postDataJSON()});
      else if (pathname === '/api/status') data = {linked: false, phase: 'ready'};
      else if (pathname === '/api/wall') data = {linked: false, count: 0, shown: 0, folders: [], flags: {}};
      else if (pathname === '/api/project/status') data = {linked: true, root: 'fixture'};
      else if (pathname === '/api/project/projects') data = {projects: [project], layout: {fixture: {x: 100, y: 100, z: 1}}};
      else if (pathname === '/api/project/projects/fixture') data = {project, files, positions};
      else if (pathname === '/api/tags') data = [];
      return route.fulfill({json: data});
    }
    if (pathname.startsWith('/fixture/')) {
      imageRequests.push({path: pathname, size: Number(url.searchParams.get('size'))});
      if (pathname.startsWith('/fixture/preview/') && url.searchParams.has('size')) {
        previewActive++; previewPeak = Math.max(previewPeak, previewActive);
        await new Promise(resolve => setTimeout(resolve, 25));
        previewActive--;
      }
      if (pathname === '/fixture/full/right') await fullGate;
      const id = pathname.split('/').pop();
      return route.fulfill({contentType: 'image/svg+xml', body:
        `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${colors[id] || '#777'}"/></svg>`});
    }
    const assets = {'/': 'app/static/index.html',
      '/assets/archive-v3.css': 'app/static/style.css',
      '/assets/writing-model-v2.js': 'app/static/js/writing-model.js',
      '/assets/writing-v4.js': 'app/static/js/writing.js',
      '/assets/pointer-head.svg': 'icons/pointer-head.svg'};
    const relative = assets[pathname] || (pathname.startsWith('/static/') ? 'app' + pathname : null);
    if (!relative || relative.includes('..')) return route.fulfill({status: 404, body: ''});
    try {
      const body = await fs.readFile(path.join(root, relative));
      const contentType = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css')
        ? 'text/css' : relative.endsWith('.html') ? 'text/html' : relative.endsWith('.svg')
          ? 'image/svg+xml' : 'image/png';
      return route.fulfill({contentType, body});
    } catch { return route.fulfill({status: 404, body: ''}); }
  });
  await page.goto('http://archive.test/');
  await page.locator('#boot-overlay').waitFor({state: 'hidden'});
  await page.locator('[data-context="projects"]').click();
  await page.locator('.project-cover').dblclick();
  await page.locator(tile('center')).waitFor({state: 'visible'});
  await page.waitForFunction(() => [...document.querySelectorAll('.project-file-image img')]
    .every(image => image.complete && image.naturalWidth));
  return {page, errors, writes, imageRequests, previewPeak: () => previewPeak, releaseFull};
}
async function placement(page) {
  return page.locator('.project-file').evaluateAll(elements => Object.fromEntries(elements.map(el =>
    [el.dataset.fileId, {x: parseFloat(el.style.left), y: parseFloat(el.style.top),
      width: parseFloat(el.style.width), height: parseFloat(el.querySelector('.project-file-media').style.height)}])));
}
async function inspected(page, id) {
  await page.waitForFunction(id => document.getElementById('f-title').value === id + '.png', id);
  assert.equal(await page.locator('#detail-view').isVisible(), true);
  assert.equal(await page.locator('#project-workspace').isVisible(), true);
}
async function openImage(page, id) {
  await page.locator(tile(id)).dblclick();
  await inspected(page, id);
}
async function closeImage(page) {
  await page.keyboard.press('Escape');
  await page.locator('#detail-view').waitFor({state: 'hidden'});
  assert.equal(await page.locator('#project-workspace').isVisible(), true, 'Escape returns to the same project');
}

test('project inspection, selection cleanup, and stable snapping', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const {page, errors, writes, imageRequests, previewPeak, releaseFull} = await fixture(browser);
    await page.waitForTimeout(350);
    const levels = imageRequests.filter(r => r.size);
    assert.ok(levels.length >= 6, 'canvas uses sized previews');
    assert.ok(levels.every(r => [160, 320, 800, 1600, 2560].includes(r.size)));
    assert.ok(previewPeak() <= 4, 'preview requests are bounded');
    assert.equal(imageRequests.some(r => r.path.startsWith('/fixture/full/')), false, 'canvas never requests full originals');
    const original = await placement(page);
    await openImage(page, 'center');
    for (const [key, id] of [['ArrowRight', 'right'], ['ArrowRight', 'far'],
      ['ArrowRight', 'far'], ['ArrowLeft', 'right'], ['ArrowLeft', 'center'],
      ['ArrowUp', 'up'], ['ArrowDown', 'center'], ['ArrowDown', 'down'],
      ['ArrowUp', 'center'], ['ArrowLeft', 'left']]) {
      await page.keyboard.press(key);
      await inspected(page, id);
    }
    // The full image requested earlier must not overwrite the latest image.
    await page.waitForTimeout(250);
    const beforeLateImage = await page.locator('#detail-canvas').evaluate(el => el.toDataURL());
    releaseFull();
    await page.waitForTimeout(250);
    assert.equal(await page.locator('#detail-canvas').evaluate(el => el.toDataURL()), beforeLateImage);
    await closeImage(page);
    // Holding Escape generates repeats; they must not also leave the project.
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    // A new deliberate Escape still goes back to the index.
    assert.equal(await page.locator('#project-workspace').isVisible(), false);
    await page.locator('.project-cover').dblclick();
    await openImage(page, 'center');
    await page.keyboard.down('Escape');
    await page.keyboard.down('Escape');
    await page.keyboard.up('Escape');
    await page.locator('#detail-view').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#project-workspace').isVisible(), true);
    assert.deepEqual(await placement(page), original, 'inspection leaves the layout untouched');

    // Drag a marquee around exactly two prints, then clean and restore them.
    const leftBox = await page.locator(tile('left')).boundingBox();
    const centerBox = await page.locator(tile('center')).boundingBox();
    await page.mouse.move(leftBox.x - 12, leftBox.y - 12);
    await page.mouse.down();
    await page.mouse.move(centerBox.x + centerBox.width + 12, centerBox.y + centerBox.height + 12, {steps: 12});
    await page.mouse.up();
    assert.equal(await page.locator('.project-file.selected').count(), 2);
    await page.locator('#proj-btn-clean').click();
    const cleaned = await placement(page);
    for (const id of Object.keys(original)) {
      if (id === 'left' || id === 'center') {
        assert.notDeepEqual(cleaned[id], original[id]);
        assert.equal(cleaned[id].width, original[id].width);
        assert.equal(cleaned[id].height, original[id].height);
      } else assert.deepEqual(cleaned[id], original[id], `clean leaves ${id} untouched`);
    }
    const cleanHeight = await page.locator(tile('center')).evaluate(el => el.offsetHeight);
    const cleanGap = cleaned.left.y === cleaned.center.y
      ? cleaned.left.x - cleaned.center.x - cleaned.center.width
      : cleaned.left.y - cleaned.center.y - cleanHeight;
    assert.equal(cleanGap, 26, 'mixed-size prints have a fixed edge gap');
    await page.locator('#proj-btn-clean').click();
    assert.deepEqual(await placement(page), original, 'messy restores only the cleaned subset');
    await page.waitForTimeout(750);

    // With no selection Clean still tidies the whole canvas.
    const viewport = await page.locator('#project-viewport').boundingBox();
    await page.mouse.click(viewport.x + 20, viewport.y + 20);
    assert.equal(await page.locator('.project-file.selected').count(), 0);
    await page.locator('#proj-btn-clean').click();
    const allClean = await placement(page);
    assert.notDeepEqual(allClean.far, original.far);
    const rows = new Map();
    for (const id of ['center', 'right', 'left', 'up', 'down', 'far']) {
      const item = allClean[id];
      if (!rows.has(item.y)) rows.set(item.y, []);
      rows.get(item.y).push(item);
    }
    assert.ok([...rows.values()].some(row => row.length > 1));
    for (const row of rows.values()) {
      row.sort((a,b) => a.x-b.x);
      for (let i=1;i<row.length;i++) assert.equal(row[i].x-row[i-1].x-row[i-1].width, 26);
    }
    await page.locator('#proj-btn-clean').click();
    await page.waitForTimeout(750);

    await page.locator('#proj-btn-snapping').click();
    await page.waitForTimeout(250);
    const aligned = await placement(page);
    for (const id of ['left', 'center', 'right']) {
      assert.equal(aligned[id].x % 24, 0);
      assert.equal(aligned[id].y % 24, 0);
    }
    // Crossing former zoom thresholds never changes stored position or size.
    for (const delta of [450, 400, -1300, -300, 550]) {
      await page.mouse.move(700, 500);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(100);
      assert.deepEqual(await placement(page), aligned);
    }
    // At a non-default zoom, a real drag settles to the same 24-unit grid.
    const box = await page.locator(tile('center')).boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 41, box.y + box.height / 2 + 29, {steps: 8});
    await page.mouse.up();
    await page.waitForTimeout(250);
    const dragged = await placement(page);
    assert.notDeepEqual(dragged.center, aligned.center);
    assert.equal(dragged.center.x % 24, 0);
    assert.equal(dragged.center.y % 24, 0);
    assert.deepEqual(dragged.right, aligned.right);

    // Reload a legacy off-grid layout while the snapping preference is on.
    // A click cannot alter that placement; a group drag preserves its offsets.
    await page.reload();
    await page.locator('#boot-overlay').waitFor({state: 'hidden'});
    await page.locator('[data-context="projects"]').click();
    await page.locator('.project-cover').dblclick();
    await page.waitForFunction(() => [...document.querySelectorAll('.project-file-image img')]
      .length === 6 && [...document.querySelectorAll('.project-file-image img')]
      .every(image => image.complete && image.naturalWidth));
    assert.deepEqual(await placement(page), original, 'rendering preserves a legacy layout');
    await page.locator(tile('left')).click();
    await page.locator(tile('center')).click({modifiers: ['Control']});
    assert.deepEqual(await placement(page), original, 'selection does not snap the legacy layout');
    const groupBox = await page.locator(tile('center')).boundingBox();
    await page.mouse.move(groupBox.x + 30, groupBox.y + 30);
    await page.mouse.down();
    await page.mouse.move(groupBox.x + 85, groupBox.y + 69, {steps: 8});
    await page.mouse.up();
    await page.waitForTimeout(250);
    const movedGroup = await placement(page);
    assert.equal(movedGroup.center.x - movedGroup.left.x, original.center.x - original.left.x);
    assert.equal(movedGroup.center.y - movedGroup.left.y, original.center.y - original.left.y);
    assert.notDeepEqual(movedGroup.center, original.center);
    assert.deepEqual(movedGroup.right, original.right);
    await page.locator(tile('center')).click({button: 'right'});
    assert.equal(await page.locator('#project-clean-selection').textContent(), 'clean selection');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#project-context').isVisible(), false);
    assert.equal(await page.locator('#project-workspace').isVisible(), true);
    await page.keyboard.press('Control+a');
    assert.equal(await page.locator('.project-file.selected').count(), 7);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.project-file.selected').count(), 0);
    assert.equal(await page.locator('#project-workspace').isVisible(), true);
    await page.keyboard.press('0');
    await page.locator(tile('center')).click({button: 'right'});
    await page.locator('#project-inspect').click();
    await inspected(page, 'center');
    await closeImage(page);
    assert.deepEqual(errors, [], 'no browser runtime errors');
    assert.equal(writes.some(write => write.path.startsWith('/api/photo/')), false);
    if (process.env.PROJECT_TEST_SCREENSHOT) await page.screenshot({path: process.env.PROJECT_TEST_SCREENSHOT});
    await page.close();

    const reduced = await fixture(browser, 'reduce');
    reduced.releaseFull();
    await openImage(reduced.page, 'center');
    await reduced.page.keyboard.press('ArrowRight');
    await inspected(reduced.page, 'right');
    await closeImage(reduced.page);
    assert.deepEqual(reduced.errors, []);
    await reduced.page.close();
  } finally { await browser.close(); }
});
