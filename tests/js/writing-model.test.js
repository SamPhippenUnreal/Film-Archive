'use strict';
const assert = require('assert');
const model = require('../../app/static/js/writing-model.js');

let pending = model.toggleMark(model.DEFAULT_MARKS, 'bold');
pending = model.setMark(pending, 'size', 14);
assert.deepStrictEqual(pending, {
  bold: true, italic: false, underline: false, color: '', size: 14,
});

const inserted = model.insertText([
  {text: 'before after', marks: model.DEFAULT_MARKS},
], 7, 'new ', pending);
assert.strictEqual(inserted.map(run => run.text).join(''), 'before new after');
assert.strictEqual(inserted[1].marks.bold, true);
assert.strictEqual(inserted[1].marks.size, 14);

const merged = model.mergeRuns([
  {text: 'one', marks: pending}, {text: ' two', marks: pending},
]);
assert.strictEqual(merged.length, 1);
assert.strictEqual(merged[0].text, 'one two');

assert.deepStrictEqual(
  model.paginateBlocks([
    {height: 60}, {height: 50, atomic: true}, {height: 30},
  ], 100).map(item => item.page),
  [0, 1, 1],
);

console.log('writing-model: all assertions passed');
