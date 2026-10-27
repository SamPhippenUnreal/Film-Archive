'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Photo-only menus, tag drag persistence, cancellation, and idle ambient', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [];
    let savedOrder = [];
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const wall = {root: '/test/photos', linked: true, count: 2, shown: 2, flags: {a: {tags: ['test']}, b: {tags: ['test']}}, clusters: [{folder: 'roll', label: 'roll', x: 0, y: 0,
      photos: [{id: 'a', x: 0, y: 0, w: 200, h: 150}, {id: 'b', x: 260, y: 0, w: 200, h: 150}]}]};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/wall/order') { savedOrder = request.postDataJSON().ids; return route.fulfill({json: {ok: true}}); }
        if (pathname.startsWith('/api/photo/') && request.method() === 'GET') {
          const id = pathname.split('/').pop();
          if (id === 'slow') await slow;
          return route.fulfill({json: {photo: {id, filename: id + '.png', folder: 'roll', width: 400, height: 300}, meta: {}, annotations: {}}});
        }
        if (pathname === '/api/gradient') return route.fulfill({json: {order: [{id: 'a', h: .2, s: .5, l: .5}, {id: 'b', h: .4, s: .5, l: .5}]}});
        let data = {ok: true};
        if (pathname === '/api/status') data = {linked: false, phase: 'ready'};
        else if (pathname === '/api/wall') data = {...structuredClone(wall), tagOrder: savedOrder};
        else if (pathname === '/api/tags') data = [];
        return route.fulfill({json: data});
      }
      if (pathname.startsWith('/image/') || pathname.startsWith('/thumb/'))
        return route.fulfill({contentType: 'image/svg+xml', body:
          '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#927966"/></svg>'});
      const assets = {'/': 'app/static/index.html', '/assets/archive-v3.css': 'app/static/style.css',
        '/assets/writing-model-v2.js': 'app/static/js/writing-model.js',
        '/assets/writing-v4.js': 'app/static/js/writing.js', '/assets/pointer-head.svg': 'icons/pointer-head.svg'};
      const relative = assets[pathname] || (pathname.startsWith('/static/') ? 'app' + pathname : null);
      if (!relative || relative.includes('..')) return route.fulfill({status: 404, body: ''});
      try {
        const body = await fs.readFile(path.join(root, relative));
        const contentType = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css'
          : relative.endsWith('.html') ? 'text/html' : relative.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
        return route.fulfill({contentType, body});
      } catch { return route.fulfill({status: 404, body: ''}); }
    });
    await page.goto('http://archive.test/');
    await page.locator('#boot-overlay').waitFor({state: 'hidden'});
    await page.waitForTimeout(2800);
    assert.equal(await page.locator('#context-nav, #writing-view, #project-view').count(), 0);
    assert.equal(await page.locator('.wall-controls').innerText(), 'overview\n·\nfilter\n·\nview');
    await page.locator('#btn-filter').click();
    assert.equal(await page.locator('#filter-bar .fb-row').first().innerText(), 'search');
    await page.locator('#btn-search').click();
    assert.equal(await page.locator('#search-input').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.locator('#btn-filter').click();
    await page.locator('[data-group="tags"]').click();
    await page.locator('#fb-tag-list button').click();
    await page.locator('#btn-filter').click();
    await page.waitForTimeout(800);
    const point = id => page.evaluate(id => {
      const {cam, W, H, placements} = Wall.debug(), p = placements.find(p => p.id === id);
      return {x: (p.tx - cam.x) * cam.s + W / 2, y: (p.ty - cam.y) * cam.s + H / 2};
    }, id);
    const a = await point('a'), b = await point('b');
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, {steps: 12});
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['b', 'a'], 'photos swap during the drag');
    await page.mouse.up();
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => Detail.isOpen()), false, 'dragging does not open inspection');
    assert.deepEqual(savedOrder, ['b', 'a']);
    // A polling refresh keeps the saved ordering.
    await page.evaluate(data => Wall.setData(data, false), wall);
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['b', 'a']);
    const from = await point('b'), to = await point('a');
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, {steps: 10});
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['b', 'a'], 'Escape cancels a reorder');
    await page.waitForTimeout(500);
    const click = await point('b'); await page.mouse.click(click.x, click.y);
    await page.waitForFunction(() => Detail.isOpen());
    await page.keyboard.press('Escape');
    await page.locator('#detail-view').waitFor({state: 'hidden'});
    await page.locator('#btn-view').click(); await page.locator('#btn-ambient').click();
    await page.locator('#ambient-view').waitFor({state: 'visible'});
    await page.keyboard.press('Escape'); await page.locator('#ambient-view').waitFor({state: 'hidden'});
    await page.clock.install();
    await page.mouse.move(10, 80);
    await page.clock.fastForward(239000);
    assert.equal(await page.locator('#ambient-view').evaluate(el => el.classList.contains('hidden')), true);
    await page.mouse.move(20, 80);
    await page.clock.fastForward(239000);
    assert.equal(await page.locator('#ambient-view').evaluate(el => el.classList.contains('hidden')), true, 'activity restarts the four-minute delay');
    await page.clock.fastForward(1100);
    assert.equal(await page.locator('#ambient-view').evaluate(el => el.classList.contains('hidden')), false, 'four minutes of inactivity starts ambient');
    await page.keyboard.press('Escape');
    await page.clock.runFor(700);
    await page.evaluate(() => Detail.show('a'));
    await page.clock.runFor(700);
    await page.mouse.move(25, 80);
    await page.clock.fastForward(240100);
    assert.equal(await page.locator('#ambient-view').evaluate(el => el.classList.contains('hidden')), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => Detail.isOpen()), true, 'ambient exits without closing the underlying photo');
    await page.clock.runFor(700);
    await page.keyboard.press('Escape');
    await page.clock.runFor(700);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, value: true});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(300000);
    assert.equal(await page.locator('#ambient-view').evaluate(el => el.classList.contains('hidden')), true, 'background time does not start ambient');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable: true, value: false});
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.fastForward(239000);
    assert.equal(await page.locator('#ambient-view').evaluate(el => el.classList.contains('hidden')), true, 'returning gives a full four-minute delay');
    // Reloading preserves the tag ordering without affecting the full wall.
    await page.reload();
    await page.locator('#boot-overlay').waitFor({state: 'hidden'});
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['a', 'b']);
    await page.locator('#btn-filter').click(); await page.locator('[data-group="tags"]').click();
    await page.locator('#fb-tag-list button').click();
    await page.waitForFunction(() => Wall.orderedIds()[0] === 'b');
    // Exercise mixed landscape/portrait rows and inspect their rendered result.
    await page.keyboard.press('Escape');
    await page.clock.runFor(700);
    const many = await page.evaluate(() => {
      const photos = Array.from({length: 36}, (_, i) => ({id: 'sample-' + i,
        x: (i % 9) * 316, y: Math.floor(i / 9) * 244,
        w: 270, h: 180}));
      return {clusters: [WallOrder.arrange({folder: 'test', label: 'an aligned roll', x: 1264, y: -124, rowCount: 4, photos}, [])], flags: {}};
    });
    await page.evaluate(data => { Wall.setReorderContext(null); Wall.setData(data, false); Wall.fitAll(false); Wall.step(); }, many);
    await page.clock.runFor(1000);
    if (process.env.ARCHIVE_TEST_SCREENSHOT)
      await page.screenshot({path: process.env.ARCHIVE_TEST_SCREENSHOT});
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
