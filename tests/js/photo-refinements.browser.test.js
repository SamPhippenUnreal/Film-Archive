'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Cluster whitespace drag, uniform dropdowns, global tag deletion, and Escape overview', {timeout: 90000}, async () => {
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
        else if (pathname === '/api/wall') { lastWallQuery = new URL(request.url()).search; data = {...structuredClone(wall), tagOrder: savedOrder}; }
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
    const initial = await page.evaluate(() => Wall.debug());
    const points = await page.evaluate(() => {
      const {cam, W, H, placements} = Wall.debug();
      const a = placements.find(p => p.id === 'a'), b = placements.find(p => p.id === 'b');
      const sx = x => (x - cam.x) * cam.s + W / 2;
      const sy = y => (y - cam.y) * cam.s + H / 2;
      return {gap: {x: sx((a.tx + a.w / 2 + b.tx - b.w / 2) / 2), y: sy(a.ty)},
        photo: {x: sx(a.tx), y: sy(a.ty)}};
    });
    await page.mouse.move(points.gap.x, points.gap.y); await page.mouse.down();
    await page.mouse.move(points.gap.x + 55, points.gap.y + 25, {steps: 10}); await page.mouse.up();
    const after = await page.evaluate(() => Wall.debug());
    assert.equal(after.cam.x, initial.cam.x, 'cluster drag does not pan the wall');
    assert.equal(after.cam.y, initial.cam.y);
    const dx = after.placements[0].tx - initial.placements[0].tx;
    assert.ok(dx > 10, 'whitespace drag moves cluster');
    assert.ok(Math.abs(after.placements[1].tx - initial.placements[1].tx - dx) < 1e-6);
    assert.equal(offsets.length, 1, 'cluster movement is saved');
    assert.equal(await page.evaluate(() => Detail.isOpen()), false);
    await page.mouse.click(points.photo.x + 55, points.photo.y + 25, {button: 'right'});
    assert.equal(await page.locator('#wall-context').count(), 0, 'photo right-click menu is removed');
    // Dragging a print in overview carries the same cluster; a click still inspects.
    const movedPhoto = {x: points.photo.x + 55, y: points.photo.y + 25};
    await page.mouse.move(movedPhoto.x, movedPhoto.y); await page.mouse.down();
    await page.mouse.move(movedPhoto.x + 30, movedPhoto.y + 10, {steps: 6}); await page.mouse.up();
    assert.equal(await page.evaluate(() => Detail.isOpen()), false);
    assert.equal(offsets.length, 2);
    await page.mouse.click(movedPhoto.x + 30, movedPhoto.y + 10);
    await page.waitForFunction(() => Detail.isOpen());
    await page.keyboard.press('Escape'); await page.locator('#detail-view').waitFor({state: 'hidden'});
    const styles = await page.evaluate(() => {
      const fields = ['fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingBottom', 'textAlign', 'color'];
      return ['[data-group="stars"]', '#btn-search', '#fb-clear', '#btn-chronological', '#btn-gradient', '#btn-ambient'].map(sel => {
        const style = getComputedStyle(document.querySelector(sel));
        return fields.map(k => style[k]);
      });
    });
    styles.slice(1).forEach(style => assert.deepEqual(style, styles[0], 'dropdown actions match filter labels'));
    await page.locator('#btn-filter').click(); await page.locator('[data-group="tags"]').click();
    await page.locator('#fb-tag-list button').click();
    await page.waitForTimeout(300);
    assert.ok(lastWallQuery.includes('tag=test'));
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.equal(lastWallQuery, '', 'one Escape clears the tag while its dropdown is still open');
    assert.equal(await page.locator('#filter-bar').evaluate(el => el.inert), true);
    await page.locator('#btn-filter').click();
    await page.locator('#fb-tag-list button').click();
    await page.locator('#btn-search').click(); await page.locator('#search-input').fill('example');
    await page.waitForTimeout(450);
    assert.ok(lastWallQuery.includes('tag=test') && lastWallQuery.includes('q=example'));
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
    assert.equal(lastWallQuery, '', 'Escape in search clears all filters');
    await page.locator('#btn-filter').click();
    await page.locator('#fb-tag-list button').click({button: 'right'});
    await page.locator('#tag-context-menu button').click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#tag-context-menu button').isEnabled(), true, 'failed deletion offers retry');
    assert.equal(deleted, null);
    failDelete = false;
    await page.locator('#tag-context-menu button').click();
    await page.waitForTimeout(300);
    assert.deepEqual(deleted, {root: '/test/photos', tag: 'test'});
    assert.equal(await page.locator('#fb-tag-list button').count(), 0, 'deleted tag disappears');
    assert.equal(await page.locator('#fb-tag-list').innerText(), 'no tags yet');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
