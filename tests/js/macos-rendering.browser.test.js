'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Mac cursor coverage, bounded trail, Retina cache stability and shared shadows', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 2600, height: 1600}, deviceScaleFactor: 2});
    const errors = [];
    let savedOrder = [];
    const wallRequests = [];
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const photos = Array.from({length: 24}, (_, i) => ({id: 'sample-' + i,
      x: (i % 6) * 316, y: Math.floor(i / 6) * 244, w: 270, h: 180}));
    const wall = {root: '/test/photos', linked: true, count: 24, shown: 24, flags: {},
      clusters: [{folder: 'roll', label: 'roll', x: 790, y: -124, photos}]};
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
      if (pathname.startsWith('/image/') || pathname.startsWith('/thumb/')) {
        if (pathname.startsWith('/image/')) wallRequests.push(request.url());
        const width = pathname.startsWith('/image/') ? Number(new URL(request.url()).searchParams.get('edge') || 1600) : 512;
        const height = Math.round(width * 2 / 3);
        return route.fulfill({contentType: 'image/svg+xml', body:
          `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#927966"/></svg>`});
      }
      const assets = {'/': 'app/static/index.html', '/assets/archive-v3.css': 'app/static/style.css',
        '/assets/writing-model-v2.js': 'app/static/js/writing-model.js',
        '/assets/writing-v4.js': 'app/static/js/writing.js', '/assets/pointer-head.svg': 'icons/pointer-head-macos.svg'};
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
    const cursors = await page.evaluate(() => ['#btn-view', '#btn-filter', '#wordmark-btn', '.wordmark-icon', '.wordmark-icon path', '#btn-chronological'].map(sel => getComputedStyle(document.querySelector(sel)).cursor));
    cursors.forEach(cursor => assert.equal(cursor, cursors[0]));
    assert.ok(cursors[0].includes('5 5'), 'cursor uses scaled hotspot');
    const asset = await page.evaluate(() => fetch('/assets/pointer-head.svg').then(response => response.text()));
    assert.ok(asset.includes('width="32" height="32"'));
    await page.mouse.move(100, 100); await page.mouse.move(400, 400, {steps: 20});
    const trail = await page.locator('#mouse-trail-canvas').evaluate(el => ({w: el.width, h: el.height}));
    assert.equal(trail.w, 576); assert.equal(trail.h, 576);
    const retina = await page.locator('#wall-canvas').evaluate(el => ({w: el.width, h: el.height}));
    assert.equal(retina.w, 5200); assert.equal(retina.h, 3200);
    await page.waitForFunction(() => Wall.debug().fullRasters >= 24);
    const before = await page.evaluate(() => Wall.debug());
    assert.equal(before.fullCacheSize, 24, 'all visible Retina photos remain cached');
    assert.equal(before.fullLoads, 24, 'each preview level loaded once');
    assert.equal(wallRequests.length, 24);
    wallRequests.forEach(url => assert.ok(url.includes('?edge=1024'), 'medium wall must never fetch full TIFF conversion'));
    assert.ok(before.fullCachePixels < 24 * 1600 * 1067, 'wall retains display-sized rasters instead of every full original');
    const after = await page.evaluate(() => {
      for (let i = 0; i < 100; i++) Wall.step();
      return Wall.debug();
    });
    assert.equal(after.fullLoads, before.fullLoads, 'idle draws cannot reload visible images');
    assert.equal(after.shadowRasters, before.shadowRasters, 'same-sized prints reuse cached shadows');
    assert.equal(after.fullCacheSize, 24);
    assert.equal(after.dpr, 2, 'Retina resolution stays intact');
    await page.mouse.move(700, 500); await page.mouse.down({button: 'middle'});
    await page.mouse.move(730, 520, {steps: 8}); await page.mouse.up({button: 'middle'});
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => Wall.debug().fullLoads), before.fullLoads, 'panning reuses visible image rasters');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
