'use strict';
// Unit tests for the shared annotation-undo controller (PixelBrushes.createHistory),
// the one implementation every annotation surface (photograph, document, project)
// steps through. It is a pure state machine, so it runs without a browser.
const assert = require('assert');
const PixelBrushes = require('../../app/static/js/pixel-brushes.js');

// A tiny stand-in surface: an array we snapshot and restore, exactly the shape
// each context supplies (an isolated, serialisable value).
function surface(initial) {
  let state = initial.slice();
  const history = PixelBrushes.createHistory({
    limit: 3,                           // a small cap so trimming is observable
    capture: () => state.slice(),
    restore: snapshot => { state = snapshot.slice(); },
  });
  return {
    history,
    get: () => state.slice(),
    set: value => { state = value.slice(); },
  };
}

// A complete gesture that changed something is one undoable step.
{
  const s = surface([]);
  s.history.begin();
  s.set(['a']);
  s.history.commit();
  assert.deepStrictEqual(s.get(), ['a']);
  assert.strictEqual(s.history.undo(), true);
  assert.deepStrictEqual(s.get(), [], 'undo returns the pre-gesture state');
}

// A gesture that changed nothing must leave no step behind.
{
  const s = surface(['x']);
  s.history.begin();
  s.history.cancel();
  assert.strictEqual(s.history.size, 0);
  assert.strictEqual(s.history.undo(), false);
}

// Discrete edits (record) each become their own step, undone newest-first.
{
  const s = surface([]);
  s.history.record(); s.set(['a']);
  s.history.record(); s.set(['a', 'b']);
  s.history.undo();
  assert.deepStrictEqual(s.get(), ['a']);
  s.history.undo();
  assert.deepStrictEqual(s.get(), []);
  assert.strictEqual(s.history.undo(), false, 'stack is empty at the origin');
}

// The history is bounded: with a cap of 3, the oldest steps drop and only the
// three most recent gestures can be undone.
{
  const s = surface([]);
  for (let i = 1; i <= 5; i++) { s.history.record(); s.set(Array(i).fill('*')); }
  assert.strictEqual(s.history.size, 3);
  let steps = 0;
  while (s.history.undo()) steps++;
  assert.strictEqual(steps, 3, 'only the capped number of steps survive');
}

// Two surfaces keep independent histories — undo in one never reaches the other.
{
  const a = surface([]), b = surface([]);
  a.history.record(); a.set(['a']);
  b.history.record(); b.set(['b']);
  a.history.undo();
  assert.deepStrictEqual(a.get(), []);
  assert.deepStrictEqual(b.get(), ['b'], 'the other surface is untouched');
}

// clear() empties the stack.
{
  const s = surface([]);
  s.history.record(); s.set(['a']);
  s.history.clear();
  assert.strictEqual(s.history.size, 0);
  assert.strictEqual(s.history.undo(), false);
}

console.log('annotation-history: all assertions passed');
