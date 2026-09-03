// Test cases from QuixBugs' own json_testcases/knapsack.json (jkoppel/QuixBugs) —
// real, verified expected outputs for this exact algorithm.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { knapsack } = require('../src/knapsack');

const cases = [
  [100, [[60, 10], [50, 8], [20, 4], [20, 4], [8, 3], [3, 2]], 19],
  [40, [[30, 10], [50, 5], [10, 20], [40, 25]], 30],
  [26, [[12, 24], [7, 13], [11, 23], [8, 15], [9, 16]], 51],
  [50, [[31, 70], [10, 20], [20, 39], [19, 37], [4, 7], [3, 5], [6, 10]], 107],
  [190, [[56, 50], [59, 50], [80, 64], [64, 46], [75, 50], [17, 5]], 150],
];

for (const [capacity, items, expected] of cases) {
  test(`knapsack(${capacity}, ${JSON.stringify(items)}) === ${expected}`, () => {
    assert.equal(knapsack(capacity, items), expected);
  });
}
