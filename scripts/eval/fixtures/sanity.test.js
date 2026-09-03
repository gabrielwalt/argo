const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hasCloseElements, fracPart, countVowelsY } = require('../src/sanity');

test('hasCloseElements: true when two elements are within threshold', () => {
  assert.equal(hasCloseElements([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.3), true);
});
test('hasCloseElements: false when no pair is close enough', () => {
  assert.equal(hasCloseElements([1.0, 2.0, 3.9, 4.0, 5.0, 2.2], 0.05), false);
});
test('hasCloseElements: false on an empty or single-element list', () => {
  assert.equal(hasCloseElements([], 0.5), false);
  assert.equal(hasCloseElements([5.0], 0.5), false);
});

test('fracPart: extracts the fractional part', () => {
  assert.equal(fracPart(3.75), 0.75);
  assert.equal(fracPart(1.0), 0);
  assert.equal(fracPart(0.5), 0.5);
});

test('countVowelsY: counts vowels, plus a trailing y', () => {
  assert.equal(countVowelsY('abcdy'), 2); // a, trailing y
});
test('countVowelsY: a leading/middle y does not count', () => {
  assert.equal(countVowelsY('yabcd'), 1); // just 'a'
});
test('countVowelsY: case-insensitive, including the trailing Y', () => {
  assert.equal(countVowelsY('ACEDY'), 3); // A, E, trailing Y
});
