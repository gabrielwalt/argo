const { test } = require('node:test');
const assert = require('node:assert/strict');
const { paginate } = require('../src/pagination');

const items = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

test('page 1 returns the first pageSize items', () => {
  assert.deepEqual(paginate(items, 3, 1), [1, 2, 3]);
});
test('page 2 returns the next pageSize items (not the same as page 1)', () => {
  assert.deepEqual(paginate(items, 3, 2), [4, 5, 6]);
});
test('page 3 continues correctly', () => {
  assert.deepEqual(paginate(items, 3, 3), [7, 8, 9]);
});
test('the final, partial page returns only the remaining items (not empty)', () => {
  assert.deepEqual(paginate(items, 3, 4), [10]);
});
