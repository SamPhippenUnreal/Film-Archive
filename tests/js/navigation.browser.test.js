'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Navigation layers, blank-paper exits, keyboard access, and stale loads', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [];
    let releaseSlow;
    let holdNext = false, releaseNext;
    const nextLoad = new Promise(resolve => { releaseNext = resolve; });
    const slow = new Promise(resolve => { releaseSlow = resolve; });
    const wall = {linked: true, count: 2, shown: 2, flags: {}, clusters: [{folder: 'roll', label: 'roll', x: 0, y: 0,
      photos: [{id: 'a', x: 0, y: 0, w: 200, h: 150}, {id: 'b', x: 260, y: 0, w: 200, h: 150}]}]};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        if (pathname.startsWith('/api/photo/') && request.method() === 'GET') {
          const id = pathname.split('/').pop();
          if (id === 'slow') await slow;
          if (id === 'b' && holdNext) await nextLoad;
          return route.fulfill({json: {photo: {id, filename: id + '.png', folder: 'roll', width: 400, height: 300}, meta: {}, annotations: {}}});
        }
        if (pathname === '/api/gradient') return route.fulfill({json: {order: [{id: 'a', h: .2, s: .5, l: .5}, {id: 'b', h: .4, s: .5, l: .5}]}});
        let data = {ok: true};
        if (pathname === '/api/status') data = {linked: false, phase: 'ready'};
        else if (pathname === '/api/wall') data = wall;
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
    assert.equal(await page.locator('#mouse-trail-toggle').count(), 0);
    await page.keyboard.press('Control+f');
    assert.equal(await page.locator('#search-input').evaluate(el => el === document.activeElement), true);
    await page.keyboard.press('Escape');
    await page.locator('#btn-filter').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#filter-bar').evaluate(el => el.classList.contains('hidden') && el.inert), true);

    await page.evaluate(() => { void Detail.show('slow'); });
    await page.keyboard.press('Escape');
    releaseSlow();
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => Detail.isOpen()), false, 'late loads cannot reopen inspection');

    await page.evaluate(() => Detail.show('a'));
    await page.locator('#detail-view').waitFor({state: 'visible'});
    await page.waitForTimeout(450);
    await page.evaluate(() => {
      Detail.setSequence(['a', 'b']);
      window.viewerFades = [];
      new MutationObserver(() => {
        if (document.querySelector('#detail-view').classList.contains('fading')) window.viewerFades.push(true);
      }).observe(document.querySelector('#detail-view'), {attributes: true, attributeFilter: ['class']});
    });
    holdNext = true;
    await page.locator('#f-notes').fill('keep this note during navigation');
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(60);
    assert.equal(await page.locator('#detail-view').evaluate(el => getComputedStyle(el).opacity), '1', 'slow metadata keeps inspection opaque');
    releaseNext(); holdNext = false;
    await page.waitForFunction(() => !document.querySelector('#nav-prev').classList.contains('hidden'));
    await page.locator('#f-title').focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.querySelector('#nav-prev').classList.contains('hidden'));
    await page.locator('#f-notes').focus();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => !document.querySelector('#nav-prev').classList.contains('hidden'));
    await page.locator('#f-title').focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('#nav-prev').classList.contains('hidden'));
    await page.locator('#nav-next').click();
    await page.waitForFunction(() => !document.querySelector('#nav-prev').classList.contains('hidden'));
    await page.locator('#nav-prev').click();
    await page.waitForFunction(() => document.querySelector('#nav-prev').classList.contains('hidden'));
    assert.deepEqual(await page.evaluate(() => window.viewerFades), [], 'keys and buttons never fade through to overview');
    await page.mouse.move(25, 150); await page.mouse.down();
    await page.mouse.move(70, 185, {steps: 5}); await page.mouse.up();
    assert.equal(await page.evaluate(() => Detail.isOpen()), true, 'blank drag pans without exiting');
    await page.keyboard.press('0');
    await page.locator('#f-notes').fill('a note worth keeping');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => Detail.isOpen()), true, 'first Escape leaves the text field');
    await page.keyboard.press('Escape');
    await page.locator('#detail-view').waitFor({state: 'hidden'});

    await page.evaluate(() => Detail.show('a'));
    await page.keyboard.press('i');
    await page.mouse.click(25, 150);
    assert.equal(await page.evaluate(() => Detail.isOpen()), true, 'annotation on surrounding paper remains possible');
    await page.keyboard.press('v');
    await page.mouse.click(25, 150);
    await page.locator('#detail-view').waitFor({state: 'hidden'});

    // Real wall hit-testing and shift selection open the light table.
    const points = await page.evaluate(data => {
      Wall.setData(data, false); Wall.fitAll(false); Wall.step();
      const {cam, W, H} = Wall.debug();
      return data.clusters[0].photos.map(p => ({x: (p.x + p.w / 2 - cam.x) * cam.s + W / 2,
        y: (p.y + p.h / 2 - cam.y) * cam.s + H / 2}));
    }, wall);
    await page.keyboard.down('Shift');
    for (const point of points) await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Shift');
    assert.equal(await page.evaluate(() => Wall.selection().length), 2);
    await page.locator('#table-open').click();
    await page.locator('.table-print').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Detail.isOpen() && document.querySelector('#btn-back').textContent.includes('light table'));
    await page.mouse.click(25, 150);
    await page.locator('#detail-view').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#table-view').isVisible(), true);
    await page.mouse.click(25, 150);
    await page.locator('#table-view').waitFor({state: 'hidden'});

    await page.locator('#btn-view').click();
    await page.locator('#btn-gradient').click();
    await page.locator('#gradient-grid img').first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#btn-back').textContent.includes('gradient'));
    await page.keyboard.press('Escape');
    await page.locator('#detail-view').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#gradient-view').isVisible(), true);
    await page.keyboard.press('Escape');
    await page.locator('#gradient-view').waitFor({state: 'hidden'});

    await page.locator('#wordmark-btn').click();
    await page.keyboard.press('Escape');
    await page.locator('#about-view').waitFor({state: 'hidden'});
    assert.equal(await page.locator('#context-nav, #writing-view, #project-view').count(), 0);
    assert.deepEqual(errors, []);
    await page.close();
  } finally { await browser.close(); }
});
