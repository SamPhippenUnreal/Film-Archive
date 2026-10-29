const {test} = require('node:test');
const assert = require('node:assert/strict');
const {append, rows} = require('../../app/static/js/wall-order.js');

test('Additions extend balanced rows without moving existing row members', () => {
  assert.deepEqual(append(['a','b','c','d'], ['e','f'], 2), ['a','b','e','c','d','f']);
  const ids = ['a','b','c','d','e','f','g','h','i'];
  assert.deepEqual(append(ids, ['j','k','l'], 3), ['a','b','c','j','d','e','f','k','g','h','i','l']);
  assert.deepEqual(append(ids, ['j','k','l','m'], 3), ['a','b','c','j','m','d','e','f','k','g','h','i','l']);
  assert.deepEqual(append(['a','b','c','d','e'], ['f','g'], 3), ['a','b','g','c','d','e','f']);
  assert.deepEqual(append(['a','b'], ['a','c','c'], 2), ['a','c','b']);
  assert.deepEqual(append(['a','b'], [], 4), ['a','b']);
});

test('Layout spacing changes each gap independently without resizing or reordering prints', () => {
  const cluster = {photos: Array.from({length: 6}, (_, i) => ({id: String(i), x: i * 316, y: 0, w: 270, h: 180}))};
  for (const [horizontal, vertical] of [[0, 0], [46, 64], [100, 150], [200, 200]]) {
    const layout = rows(cluster, 2, horizontal, vertical).photos;
    assert.deepEqual(layout.map(p => p.id), cluster.photos.map(p => p.id));
    assert.ok(layout.every(p => p.w === 270 && p.h === 180));
    assert.equal(layout[1].x - layout[0].x - 270, horizontal);
    assert.equal(layout[3].y - layout[0].y - 180, vertical);
  }
});
