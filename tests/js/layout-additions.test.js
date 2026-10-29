const {test} = require('node:test');
const assert = require('node:assert/strict');
const {append} = require('../../app/static/js/wall-order.js');

test('Additions extend balanced rows without moving existing row members', () => {
  assert.deepEqual(append(['a','b','c','d'], ['e','f'], 2), ['a','b','e','c','d','f']);
  const ids = ['a','b','c','d','e','f','g','h','i'];
  assert.deepEqual(append(ids, ['j','k','l'], 3), ['a','b','c','j','d','e','f','k','g','h','i','l']);
  assert.deepEqual(append(ids, ['j','k','l','m'], 3), ['a','b','c','j','m','d','e','f','k','g','h','i','l']);
  assert.deepEqual(append(['a','b','c','d','e'], ['f','g'], 3), ['a','b','g','c','d','e','f']);
  assert.deepEqual(append(['a','b'], ['a','c','c'], 2), ['a','c','b']);
  assert.deepEqual(append(['a','b'], [], 4), ['a','b']);
});
