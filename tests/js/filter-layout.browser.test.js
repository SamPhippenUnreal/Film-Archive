'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Every filter reflows 1-5 rows, pair swaps stay isolated, and locations complete with Tab', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [];
    let savedOrder = [];
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    let savedMeta = null;
    const photos = Array.from({length: 12}, (_, i) => ({id: 'p' + i,
      x: i % 4 * 316, y: Math.floor(i / 4) * 244, w: 270, h: 180}));
    const wall = {root: '/test/photos', linked: true, count: 12, shown: 12,
      flags: Object.fromEntries(photos.map(p => [p.id, {tags: ['test'], rating: 5, camera: 'Leica', film: 'Portra'}])),
      clusters: [{folder: 'filtered', label: 'filtered', x: 0, y: -200, photos}]};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/locations') return route.fulfill({json: ['London', 'Los Angeles', 'Paris']});
        if (pathname.endsWith('/meta') && request.method() === 'POST') { savedMeta = request.postDataJSON(); return route.fulfill({json: {ok: true}}); }
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
    assert.equal(await page.locator('#rows-control').isVisible(), false);
    const settle = () => page.evaluate(() => { for (let i = 0; i < 100; i++) Wall.step(); });
    const points = () => page.evaluate(() => {
      const {cam, W, H, placements} = Wall.debug();
      return placements.map(p => ({id: p.id, x: (p.tx - cam.x) * cam.s + W / 2,
        y: (p.ty - cam.y) * cam.s + H / 2}));
    });
    for (const group of ['stars', 'tags', 'camera', 'film', 'search']) {
      await page.locator('#btn-filter').click();
      if (group === 'search') {
        await page.locator('#btn-search').click(); await page.locator('#search-input').fill('p');
      } else {
        const groupButton = page.locator(`[data-group="${group}"]`);
        const choices = group === 'stars' ? page.locator('.fb-star').nth(3) : page.locator(`#fb-${group === 'tags' ? 'tag' : group}-list button`).first();
        if (!(await choices.isVisible())) await groupButton.click();
        await choices.click();
        await page.locator('#btn-filter').click();
      }
      await page.locator('#rows-control').waitFor({state: 'visible'});
      await settle();
      for (const count of [1, 2, 3, 4, 5]) {
        await page.locator('#filter-rows').evaluate((el, count) => { el.value = count; el.dispatchEvent(new Event('input', {bubbles: true})); }, String(count));
        const geometry = await page.evaluate(() => Wall.debug().placements);
        assert.equal(new Set(geometry.map(p => p.ty)).size, count, `${group}: exact row count`);
        assert.ok(geometry.every(p => p.w === 270 && p.h === 180));
        await settle();
      }
      await page.locator('#filter-rows').evaluate(el => { el.value = 1; el.dispatchEvent(new Event('input', {bubbles: true})); });
      await settle();
      const before = await page.evaluate(() => Wall.orderedIds());
      const pts = await points();
      const a = pts.find(p => p.id === before[0]), b = pts.find(p => p.id === before[1]), c = pts.find(p => p.id === before[2]);
      await page.mouse.move(a.x, a.y); await page.mouse.down();
      await page.mouse.move(b.x, b.y, {steps: 8});
      await page.mouse.move(c.x, c.y, {steps: 8});
      const expected = before.slice(); [expected[0], expected[2]] = [expected[2], expected[0]];
      assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), expected, `${group}: intermediate hover restores other photos`);
      await page.mouse.up(); await page.waitForTimeout(100);
      assert.deepEqual(savedOrder, expected, `${group}: order saved`);
      await page.keyboard.press('Escape');
      await page.locator('#rows-control').waitFor({state: 'hidden'});
    }
    await page.evaluate(() => Detail.show('p0'));
    await page.locator('#f-location').fill('lo');
    await page.waitForFunction(() => document.querySelectorAll('#location-suggest button').length === 2);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#location-suggest button.active').textContent(), 'London');
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#location-suggest button.active').textContent(), 'Los Angeles');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#f-location').inputValue(), 'Los Angeles');
    await page.waitForTimeout(100);
    assert.equal(savedMeta.location, 'Los Angeles');
    assert.equal(await page.locator('#location-suggest').isVisible(), false);
    await page.locator('#f-location').fill('par');
    await page.locator('#location-suggest button').click();
    assert.equal(await page.locator('#f-location').inputValue(), 'Paris');
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
