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
    let layouts = [], layoutSequence = 0;
    let releaseSlow;
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    let savedMeta = null;
    const photos = Array.from({length: 20}, (_, i) => ({id: 'p' + i,
      x: i % 4 * 316, y: Math.floor(i / 4) * 244, w: 270, h: 180}));
    const wall = {root: '/test/photos', linked: true, count: 12, shown: 12,
      flags: Object.fromEntries(photos.map(p => [p.id, {tags: ['test'], rating: 5, camera: 'Leica', film: 'Portra'}])),
      clusters: [{folder: 'filtered', label: 'filtered', x: 0, y: -200, photos}]};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname === '/api/locations') return route.fulfill({json: ['London', 'Los Angeles', 'Paris']});
        if (pathname === '/api/layouts') {
          const {name, rows, ids} = request.postDataJSON();
          const previous = layouts.find(item => item.name.toLowerCase() === name.toLowerCase());
          layouts = layouts.filter(item => item !== previous);
          layouts.push({id: previous ? previous.id : String(++layoutSequence), name, rows, ids}); layouts = layouts.slice(-10);
          return route.fulfill({json: {ok: true, layouts}});
        }
        if (pathname === '/api/layouts/delete') {
          layouts = layouts.filter(item => item.id !== request.postDataJSON().id);
          return route.fulfill({json: {ok: true, layouts}});
        }
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
        else if (pathname === '/api/wall') {
          const savedLayout = layouts.find(item => item.id === new URL(request.url()).searchParams.get('layout'));
          const url = new URL(request.url());
          const visible = savedLayout ? photos.filter(p => savedLayout.ids.includes(p.id)) :
            [...url.searchParams.keys()].length ? photos.slice(0, 12) : photos;
          data = {...structuredClone(wall), shown: visible.length,
            clusters: [{...wall.clusters[0], photos: visible}], tagOrder: savedLayout ? savedLayout.ids : savedOrder, layouts, savedLayout};
        }
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
      assert.equal(await page.locator('#filter-rows').inputValue(), group === 'stars' ? '4' : '1', 'row count carries across filters');
      await settle();
      for (const count of [1, 2, 3, 4, 5]) {
        await page.locator('#filter-rows').evaluate((el, count) => { el.value = count; el.dispatchEvent(new Event('input', {bubbles: true})); }, String(count));
        const geometry = await page.evaluate(() => Wall.debug().placements.filter(p => Wall.orderedIds().includes(p.id)));
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
    await page.locator('#btn-filter').click();
    await page.locator('.fb-star').nth(3).click();
    await page.locator('#btn-filter').click();
    await page.locator('#rows-control').waitFor({state: 'visible'});
    await page.locator('#filter-rows').evaluate(el => { el.value = 3; el.dispatchEvent(new Event('input', {bubbles: true})); });
    const snapshot = await page.evaluate(() => Wall.orderedIds());
    await page.locator('#save-layout').click();
    await page.locator('#layout-name').fill('cancelled');
    await page.keyboard.press('Escape');
    assert.equal(layouts.length, 0);
    assert.equal(await page.locator('#rows-control').isVisible(), true);
    for (let i = 0; i < 11; i++) {
      await page.locator('#save-layout').click();
      await page.locator('#layout-name').fill('layout ' + i);
      await page.keyboard.press('Enter');
      await page.locator('#layout-name').waitFor({state: 'hidden'});
    }
    assert.equal(layouts.length, 10);
    assert.equal(layouts[0].name, 'layout 1');
    const overwrittenId = layouts[9].id;
    await page.locator('#save-layout').click();
    const nameBox = await page.locator('#layout-name').boundingBox();
    const saveBox = await page.locator('#save-layout').boundingBox();
    assert.ok(nameBox.y + nameBox.height <= saveBox.y, 'name sits above save layout');
    await page.locator('#layout-name').fill('layout 10');
    await page.locator('#save-layout').click();
    await page.locator('#layout-name').waitFor({state: 'hidden'});
    assert.equal(layouts.length, 10);
    assert.equal(layouts[9].id, overwrittenId);
    await page.reload();
    await page.locator('#boot-overlay').waitFor({state: 'hidden'});
    await page.locator('#btn-filter').click();
    await page.locator('[data-group="layouts"]').click();
    assert.equal(await page.locator('#fb-layout-list button').count(), 10);
    await page.locator('#fb-layout-list button').last().click();
    await page.waitForFunction(() => document.getElementById('filter-rows').value === '3' && !document.getElementById('rows-control').classList.contains('hidden'));
    assert.equal(await page.locator('#filter-rows').inputValue(), '3');
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), snapshot);
    assert.equal(await page.evaluate(() => new Set(Wall.debug().placements.filter(p => Wall.orderedIds().includes(p.id)).map(p => p.ty)).size), 3);
    await page.locator('#filter-rows').evaluate(el => { el.value = 5; el.dispatchEvent(new Event('input', {bubbles: true})); });
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), snapshot);
    await page.locator('#btn-filter').click();
    await page.locator('#fb-layout-list button').last().click();
    await page.waitForFunction(() => document.getElementById('filter-rows').value === '3');
    assert.equal(await page.locator('#filter-rows').inputValue(), '3');
    await page.locator('#btn-filter').click();
    await page.locator('#fb-layout-list button').last().click({button: 'right'});
    await page.getByRole('menuitem', {name: 'delete layout layout 10', exact: true}).click();
    await page.locator('#rows-control').waitFor({state: 'hidden'});
    assert.equal(layouts.length, 9);
    layouts = [{id: 'add-test', name: 'add test', rows: 3, ids: photos.slice(0, 9).map(p => p.id)}];
    const openSaved = async () => {
      await page.locator('#btn-filter').click();
      if (!(await page.locator('#fb-layout-list button').isVisible())) await page.locator('[data-group="layouts"]').click();
      await page.locator('#fb-layout-list button').click();
      await page.locator('#rows-control').waitFor({state: 'visible'}); await settle();
    };
    await page.reload(); await page.locator('#boot-overlay').waitFor({state: 'hidden'});
    await openSaved();
    await page.locator('#add-layout-images').click();
    await page.locator('#layout-add-done').waitFor({state: 'visible'});
    await page.waitForFunction(() => Wall.orderedIds().length === 20); await settle();
    assert.equal(await page.locator('#rows-control').isVisible(), false);
    assert.equal(await page.locator('#btn-overview').isVisible(), true);
    assert.equal(await page.locator('#btn-filter').isVisible(), true);
    assert.equal(await page.locator('#btn-view').isVisible(), true);
    const clickPhoto = async id => {
      await settle(); const p = (await points()).find(p => p.id === id);
      await page.mouse.click(p.x, p.y); await settle();
    };
    const pixel = async id => {
      const p = (await points()).find(p => p.id === id);
      return page.locator('#wall-canvas').evaluate((canvas, p) => {
        const dpr = canvas.width / canvas.clientWidth;
        return [...canvas.getContext('2d').getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data];
      }, p);
    };
    await page.waitForFunction(() => {
      const {cam, W, H, placements} = Wall.debug(), p = placements.find(p => p.id === 'p9');
      const canvas = document.getElementById('wall-canvas'), dpr = canvas.width / canvas.clientWidth;
      const pixel = canvas.getContext('2d').getImageData(Math.round(((p.tx - cam.x) * cam.s + W / 2) * dpr),
        Math.round(((p.ty - cam.y) * cam.s + H / 2) * dpr), 1, 1).data;
      return pixel[0] === 146 && pixel[1] === 121 && pixel[2] === 102;
    });
    await settle();
    const beforeOverlay = await pixel('p9');
    await clickPhoto('p9');
    const afterOverlay = await pixel('p9');
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(afterOverlay[c] - (beforeOverlay[c] * .75 + 255 * .25)) < 3, `selection has a 25% white overlay: ${beforeOverlay} -> ${afterOverlay}`);
    await clickPhoto('p9'); await clickPhoto('p9');
    for (const id of ['p10', 'p11', 'p12']) await clickPhoto(id);
    assert.equal(await page.evaluate(() => Detail.isOpen()), false);
    await page.locator('#btn-filter').click();
    if (!(await page.locator('.fb-star').first().isVisible())) await page.locator('[data-group="stars"]').click();
    await page.locator('.fb-star').nth(3).click();
    await page.locator('#btn-filter').click(); await page.locator('#btn-overview').click();
    await page.waitForFunction(() => Wall.orderedIds().length === 20);
    await page.locator('#layout-add-done').click();
    await page.locator('#rows-control').waitFor({state: 'visible'});
    const addedOrder = ['p0','p1','p2','p9','p12','p3','p4','p5','p10','p6','p7','p8','p11'];
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), addedOrder);
    assert.deepEqual(layouts[0].ids, addedOrder);
    assert.equal(await page.locator('#filter-rows').inputValue(), '3');
    await page.reload(); await page.locator('#boot-overlay').waitFor({state: 'hidden'}); await openSaved();
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), addedOrder);
    await page.locator('#add-layout-images').click();
    await page.waitForFunction(() => Wall.orderedIds().length === 20); await clickPhoto('p13');
    await page.keyboard.press('Escape'); await page.locator('#rows-control').waitFor({state: 'visible'});
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), addedOrder, 'Escape cancels additions');
    await page.keyboard.press('Escape');
    await page.locator('#btn-filter').click();
    if (!(await page.locator('.fb-star').first().isVisible())) await page.locator('[data-group="stars"]').click();
    await page.locator('.fb-star').nth(3).click(); await page.locator('#btn-filter').click();
    await page.locator('#rows-control').waitFor({state: 'visible'});
    const draftBase = await page.evaluate(() => Wall.orderedIds());
    await page.locator('#add-layout-images').click();
    await page.waitForFunction(() => Wall.orderedIds().length === 20);
    for (const id of ['p12','p13','p14','p15','p16','p17']) await clickPhoto(id);
    await page.locator('#layout-add-done').click(); await page.locator('#rows-control').waitFor({state: 'visible'});
    const draftOrder = [...draftBase.slice(0,4),'p12','p15',...draftBase.slice(4,8),'p13','p16',...draftBase.slice(8,12),'p14','p17'];
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), draftOrder, 'unsaved filters can add more than four prints');
    await page.locator('#filter-rows').evaluate(el => { el.value = 2; el.dispatchEvent(new Event('input', {bubbles: true})); });
    assert.deepEqual(await page.evaluate(() => Wall.orderedIds()), draftOrder, 'added photos survive a row change');
    await page.locator('#save-layout').click(); await page.locator('#layout-name').fill('expanded filter');
    await page.keyboard.press('Enter'); await page.locator('#layout-name').waitFor({state: 'hidden'});
    assert.deepEqual(layouts.find(item => item.name === 'expanded filter').ids, draftOrder);
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
