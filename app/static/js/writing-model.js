(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WritingModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_MARKS = Object.freeze({
    bold: false, italic: false, underline: false,
    color: '', size: null,
  });

  function marks(value) {
    value = value || {};
    const size = Number(value.size);
    return {
      bold: value.bold === true,
      italic: value.italic === true,
      underline: value.underline === true,
      color: typeof value.color === 'string' ? value.color : '',
      size: Number.isFinite(size) && size > 0 ? size : null,
    };
  }

  function sameMarks(a, b) {
    a = marks(a); b = marks(b);
    return Object.keys(DEFAULT_MARKS).every(key => a[key] === b[key]);
  }

  function toggleMark(value, key) {
    const next = marks(value);
    if (!['bold', 'italic', 'underline'].includes(key)) return next;
    next[key] = !next[key];
    return next;
  }

  function setMark(value, key, nextValue) {
    const next = marks(value);
    if (!(key in DEFAULT_MARKS)) return next;
    next[key] = marks({...next, [key]: nextValue})[key];
    return next;
  }

  function mergeRuns(runs) {
    const out = [];
    for (const raw of runs || []) {
      const run = {text: String(raw.text || ''), marks: marks(raw.marks)};
      if (!run.text) continue;
      const previous = out[out.length - 1];
      if (previous && sameMarks(previous.marks, run.marks))
        previous.text += run.text;
      else out.push(run);
    }
    return out;
  }

  function insertText(runs, offset, text, activeMarks) {
    const flat = mergeRuns(runs);
    const total = flat.reduce((sum, run) => sum + run.text.length, 0);
    offset = Math.max(0, Math.min(total, Number(offset) || 0));
    const before = [], after = [];
    let cursor = 0;
    for (const run of flat) {
      const end = cursor + run.text.length;
      if (end <= offset) before.push(run);
      else if (cursor >= offset) after.push(run);
      else {
        before.push({text: run.text.slice(0, offset - cursor), marks: run.marks});
        after.push({text: run.text.slice(offset - cursor), marks: run.marks});
      }
      cursor = end;
    }
    return mergeRuns([
      ...before, {text: String(text || ''), marks: marks(activeMarks)}, ...after,
    ]);
  }

  function paginateBlocks(blocks, pageHeight) {
    const height = Math.max(1, Number(pageHeight) || 1);
    let page = 0, used = 0;
    return (blocks || []).map((raw, index) => {
      const measured = Math.max(0, Number(raw.height) || 0);
      const atomic = raw.atomic === true;
      if (used > 0 && (atomic || measured <= height) && used + measured > height) {
        page += 1; used = 0;
      }
      const startPage = page;
      used += measured;
      while (used > height) {
        used -= height;
        page += 1;
      }
      return {index, page: startPage, endPage: page, offset: used};
    });
  }

  return {
    DEFAULT_MARKS, marks, sameMarks, toggleMark, setMark,
    mergeRuns, insertText, paginateBlocks,
  };
});
