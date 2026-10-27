'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Chronological gathers the whole wall, animates existing nodes, and returns to folders', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [];
    let savedOrder = [], lastWallQuery = '', deleted = null, failDelete = true;
    const offsets = [];
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const wall = {root: '/test/photos', linked: true, count: 2, shown: 2, flags: {a: {tags: ['test']}, b: {tags: ['test']}}, clusters: [{folder: 'roll', label: 'roll', x: 0, y: 0,
      photos: [{id: 'a', x: 0, y: 0, w: 200, h: 150}, {id: 'b', x: 260, y: 0, w: 200, h: 150}]}]};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/folder/offset') { offsets.push(request.postDataJSON()); return route.fulfill({json: {ok: true}}); }
        if (pathname === '/api/tags/delete') {
          if (failDelete) return route.fulfill({status: 500, json: {ok: false}});
          deleted = request.postDataJSON();
          Object.values(wall.flags).forEach(f => { f.tags = f.tags.filter(t => t !== deleted.tag); });
          return route.fulfill({json: {ok: true, changed: 2}});
        }
        if (pathname === '/api/wall/order') { savedOrder = request.postDataJSON().ids; return route.fulfill({json: {ok: true}}); }
        if (pathname.startsWith('/api/photo/') && request.method() === 'GET') {
          const id = pathname.split('/').pop();
          if (id === 'slow') await slow;
          return route.fulfill({json: {photo: {id, filename: id + '.png', folder: 'roll', width: 400, height: 300}, meta: {}, annotations: {}}});
        }
        if (pathname === '/api/gradient') return route.fulfill({json: {order: [{id: 'a', h: .2, s: .5, l: .5}, {id: 'b', h: .4, s: .5, l: .5}]}});
        let data = {ok: true};
        if (pathname === '/api/status') data = {linked: false, phase: 'ready'};
        else if (pathname === '/api/wall') { lastWallQuery = new URL(request.url()).search; data = {...structuredClone(wall), tagOrder: savedOrder}; if (new URL(request.url()).searchParams.get('mode') === 'chronological') { data.mode = 'chronological'; data.clusters[0].folder = '__chronological__'; data.clusters[0].label = 'chronological'; data.clusters[0].photos.reverse(); data.clusters[0].photos.forEach((p, i) => { p.x = i * 246 - 123; p.y = 0; }); } }
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
    await page.locator('#btn-filter').click(); await page.locator('[data-group="tags"]').click();
    await page.locator('#fb-tag-list button').click();
    await page.locator('#btn-view').click();
    assert.equal(await page.locator('#view-menu button').first().innerText(), 'chronological');
    await page.locator('#btn-chronological').click();
    await page.waitForFunction(() => Wall.orderedIds()[0] === 'b');
    assert.ok(lastWallQuery.includes('mode=chronological'));
    assert.ok(!lastWallQuery.includes('tag='), 'chronological starts with the whole archive');
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['b', 'a']);
    assert.equal(await page.locator('#btn-chronological').getAttribute('aria-pressed'), 'true');
    const moving = await page.evaluate(() => Wall.debug());
    assert.equal(moving.nodes, 2, 'existing nodes are reused rather than replaced');
    assert.ok(moving.placements.some(p => Math.abs(p.x - p.tx) > 1), 'prints glide to new targets');
    await page.waitForTimeout(900);
    assert.equal(await page.evaluate(() => Detail.isOpen()), false);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => Wall.orderedIds()[0] === 'a');
    assert.equal(lastWallQuery, '');
    assert.equal(await page.locator('#btn-chronological').getAttribute('aria-pressed'), 'false');
    await page.locator('#btn-view').click(); await page.locator('#btn-chronological').click();
    await page.waitForFunction(() => Wall.orderedIds()[0] === 'b');
    await page.locator('#btn-overview').click();
    await page.waitForFunction(() => Wall.orderedIds()[0] === 'a');
    // Tag selection leaves the fixed chronological view and restores the
    // editable tag layout, with independent left/right/middle gestures.
    await page.locator('#btn-view').click(); await page.locator('#btn-chronological').click();
    await page.waitForFunction(() => Wall.orderedIds()[0] === 'b');
    await page.locator('#btn-filter').click();
    if (await page.locator('[data-content="tags"]').evaluate(el => el.classList.contains('hidden')))
      await page.locator('[data-group="tags"]').click();
    await page.locator('#fb-tag-list button').click();
    await page.waitForFunction(() => document.querySelector('#btn-chronological').getAttribute('aria-pressed') === 'false');
    assert.ok(lastWallQuery.includes('tag=test') && !lastWallQuery.includes('mode='));
    await page.locator('#btn-filter').click();
    await page.waitForTimeout(600);
    const point = id => page.evaluate(id => {
      const {cam, W, H, placements} = Wall.debug(), p = placements.find(p => p.id === id);
      return {x: (p.tx - cam.x) * cam.s + W / 2, y: (p.ty - cam.y) * cam.s + H / 2};
    }, id);
    const a = await point('a'), b = await point('b');
    await page.mouse.move(a.x, a.y); await page.mouse.down();
    await page.mouse.move(b.x, b.y, {steps: 12});
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['b', 'a']);
    await page.mouse.up(); await page.waitForTimeout(500);
    assert.deepEqual(savedOrder, ['b', 'a']);
    assert.equal(await page.evaluate(() => Detail.isOpen()), false);
    const from = await point('b');
    const beforeGroup = await page.evaluate(() => Wall.debug());
    await page.mouse.move(from.x, from.y); await page.mouse.down({button: 'right'});
    await page.mouse.move(from.x + 40, from.y + 20, {steps: 8}); await page.mouse.up({button: 'right'});
    const afterGroup = await page.evaluate(() => Wall.debug());
    assert.ok(afterGroup.placements[0].tx > beforeGroup.placements[0].tx + 10);
    assert.equal(afterGroup.cam.x, beforeGroup.cam.x);
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), ['b', 'a']);
    const panFrom = await point('b');
    await page.mouse.move(panFrom.x, panFrom.y); await page.mouse.down({button: 'middle'});
    await page.mouse.move(panFrom.x + 40, panFrom.y + 20, {steps: 8}); await page.mouse.up({button: 'middle'});
    const afterPan = await page.evaluate(() => Wall.debug());
    assert.ok(Math.abs(afterPan.cam.x - afterGroup.cam.x) > 10);
    assert.equal(afterPan.placements[0].tx, afterGroup.placements[0].tx);
    const scale = afterPan.goal.s;
    await page.mouse.wheel(0, -200); await page.waitForTimeout(150);
    assert.ok(await page.evaluate(old => Wall.debug().goal.s > old, scale));
    assert.equal(offsets.length, 0, 'tag gestures do not change folder layout');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
