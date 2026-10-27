'use strict';
// Isolated browser regression: static app assets + in-memory archive fixtures.
// No running app, real documents, linked folders, or metadata are accessed.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..');

test('Writing imports, pagination, group undo, and failed-save recovery', {timeout: 90000}, async () => {
  const browser = await chromium.launch({headless: true,
    ...(process.env.PLAYWRIGHT_CHANNEL ? {channel: process.env.PLAYWRIGHT_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport: {width: 1400, height: 1000}});
    const errors = [], writes = [];
    let failSave = false;
    const doc = {id: 'fixture', title: 'Writing fixture', content: '<div>Opening words.</div>', groups: {}, annotations: {}, rating: 0, tags: ''};
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      if (pathname.startsWith('/api/')) {
        let data = {ok: true};
        if (pathname === '/api/writing/documents/fixture' && request.method() === 'POST') {
          const payload = request.postDataJSON(); writes.push(payload);
          if (failSave) return route.fulfill({status: 503, json: {ok: false, error: 'fixture write unavailable'}});
          Object.assign(doc, payload); data = {id: doc.id};
        } else if (pathname === '/api/writing/documents/fixture') data = doc;
        else if (pathname === '/api/writing/documents') data = {documents: [doc]};
        else if (pathname === '/api/writing/stacks') data = {stacks: []};
        else if (pathname === '/api/writing/status') data = {linked: true, root: 'fixture'};
        else if (pathname === '/api/status') data = {linked: false, phase: 'ready'};
        else if (pathname === '/api/wall') data = {linked: false, count: 0, shown: 0, folders: [], flags: {}};
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
    await page.locator('[data-context="writing"]').click();
    await page.locator('.doc-card').click();
    await page.locator('#doc-flow').waitFor({state: 'visible'});

    // Cancel before the outgoing transition timer fires must keep the editor.
    await page.locator('.doc-mode[data-mode="picture"]').click();
    await page.waitForFunction(() => Writing.isPicking());
    await page.locator('#doc-pick-cancel').click({force: true});
    await page.waitForTimeout(380);
    assert.equal(await page.locator('#doc-editor').isVisible(), true);
    assert.equal(await page.locator('#doc-flow').textContent(), 'Opening words.');

    await page.locator('.doc-mode[data-mode="picture"]').click();
    await page.waitForFunction(() => Writing.isPicking());
    // Exercise the public wall-to-Writing selection callback; image bytes and
    // the Place UI are real, while the fixture has no user photo wall.
    assert.equal(await page.evaluate(() => Writing.onPickClick('photo-one')), true);
    await page.locator('#doc-pick-commit').click({force: true});
    await page.waitForFunction(() => {
      const image = document.querySelector('#doc-flow .doc-group img');
      return image && image.complete && image.naturalWidth;
    });
    await page.waitForTimeout(380);
    assert.equal(await page.locator('#doc-editor').isVisible(), true);
    assert.equal(await page.locator('#doc-flow .doc-group').count(), 1);
    assert.equal(await page.locator('#doc-flow').getAttribute('contenteditable'), 'true');
    await page.locator('#doc-group-bw').click();
    const groupBeforeDelete = await page.evaluate(() => Writing.flushSave());
    assert.equal(groupBeforeDelete, true);
    const savedGroups = structuredClone(doc.groups);
    await page.locator('#doc-group-remove').click();
    assert.equal(await page.locator('#doc-flow .doc-group').count(), 0);
    await page.keyboard.press('Control+z');
    assert.equal(await page.locator('#doc-flow .doc-group').count(), 1);
    assert.equal(await page.locator('#doc-flow .doc-group').evaluate(el => el.classList.contains('bw')), true);
    await page.evaluate(() => Writing.flushSave());
    assert.deepEqual(doc.groups, savedGroups, 'undo restores picture membership and layout metadata');

    // Long prose and nested lists must remain between every page's margins;
    // serializing and reopening must preserve the exact text and list count.
    const content = '<div>' + 'A careful sentence with some words. '.repeat(260) + '</div>' +
      '<ul class="dash-list"><li>' + 'A long list item. '.repeat(150) +
      '<ul><li>' + 'Nested list words. '.repeat(130) + '</li></ul></li><li>Final item.</li></ul>';
    const expected = await page.evaluate(content => {
      const flow = document.getElementById('doc-flow'); flow.innerHTML = content;
      flow.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertFromPaste'}));
      return flow.textContent;
    }, content);
    await page.waitForTimeout(300);
    const layout = await page.evaluate(() => {
      const flow = document.getElementById('doc-flow'), top = flow.getBoundingClientRect().top;
      const walker = document.createTreeWalker(flow, NodeFilter.SHOW_TEXT);
      const bad = []; let node;
      while ((node = walker.nextNode())) {
        const range = document.createRange(); range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (!rect.height) continue;
          const y = rect.top - top, end = rect.bottom - top, page = Math.floor((y + 1) / 1082);
          if (end > page * 1082 + 865) bad.push({y, end, text: node.data.slice(0, 30)});
        }
      }
      return {pages: document.querySelectorAll('#doc-paper .doc-page').length, bad, text: flow.textContent};
    });
    assert.ok(layout.pages > 3, 'long writing creates multiple pages');
    assert.deepEqual(layout.bad, [], 'all rendered lines stay within printable page margins');
    assert.equal(layout.text, expected, 'pagination never duplicates or removes text');
    assert.equal(await page.evaluate(() => Writing.flushSave()), true);
    const persisted = doc.content;
    assert.equal((persisted.match(/<li>/g) || []).length, 3, 'pagination preserves nested list structure');
    assert.doesNotMatch(persisted, /page-spacer|doc-cont|data-page-split|caret-marker/);
    await page.locator('#doc-to-archive').click();
    await page.locator('#doc-editor').waitFor({state: 'hidden'});
    await page.locator('.doc-card').click();
    await page.locator('#doc-editor').waitFor({state: 'visible'});
    assert.equal(await page.locator('#doc-flow').textContent(), expected);

    // An application-level write failure must never close/discard the edit.
    await page.evaluate(() => {
      const flow = document.getElementById('doc-flow');
      flow.lastElementChild.append(' Last unsaved words.');
      flow.dispatchEvent(new InputEvent('input', {bubbles: true}));
    });
    failSave = true;
    await page.locator('#doc-to-archive').click();
    await page.waitForFunction(() => document.getElementById('doc-save-hint').textContent.startsWith('not saved'));
    assert.equal(await page.locator('#doc-editor').isVisible(), true);
    assert.match(await page.locator('#doc-flow').textContent(), /Last unsaved words\./);
    failSave = false;
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.getElementById('doc-save-hint').textContent === 'saved');
    await page.locator('#doc-to-archive').click();
    await page.locator('#doc-editor').waitFor({state: 'hidden'});
    assert.match(doc.content, /Last unsaved words\./);
    assert.ok(writes.length >= 4);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
