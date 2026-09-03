// Test cases from QuixBugs' own json_testcases/kth.json (jkoppel/QuixBugs) — real,
// verified expected outputs for this exact algorithm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { kth } = require('../src/kth');

const cases = [
  [[1, 2, 3, 4, 5, 6, 7], 4, 5],
  [[3, 6, 7, 1, 6, 3, 8, 9], 5, 7],
  [[3, 6, 7, 1, 6, 3, 8, 9], 2, 3],
  [[2, 6, 8, 3, 5, 7], 0, 2],
  [[34, 25, 7, 1, 9], 4, 34],
  [[45, 2, 6, 8, 42, 90, 322], 1, 6],
  [[45, 2, 6, 8, 42, 90, 322], 6, 322],
];

for (const [arr, k, expected] of cases) {
  test(`kth(${JSON.stringify(arr)}, ${k}) === ${expected}`, () => {
    assert.equal(kth(arr.slice(), k), expected);
  });
}
