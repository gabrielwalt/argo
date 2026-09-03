const { test } = require('node:test');
const assert = require('node:assert/strict');
const { transpose } = require('../src/transpose');

test('empty string', () => {
  assert.deepEqual(transpose([]), []);
});

test('two characters in a row', () => {
  assert.deepEqual(transpose(["A1"]), ["A", "1"]);
});

test('two characters in a column', () => {
  assert.deepEqual(transpose(["A", "1"]), ["A1"]);
});

test('simple', () => {
  assert.deepEqual(transpose(["ABC", "123"]), ["A1", "B2", "C3"]);
});

test('single line', () => {
  assert.deepEqual(transpose(["Single line."]), ["S", "i", "n", "g", "l", "e", " ", "l", "i", "n", "e", "."]);
});

test('first line longer than second line', () => {
  assert.deepEqual(transpose(["The fourth line.", "The fifth line."]), ["TT", "hh", "ee", "  ", "ff", "oi", "uf", "rt", "th", "h ", " l", "li", "in", "ne", "e.", "."]);
});

test('second line longer than first line', () => {
  assert.deepEqual(transpose(["The first line.", "The second line."]), ["TT", "hh", "ee", "  ", "fs", "ie", "rc", "so", "tn", " d", "l ", "il", "ni", "en", ".e", " ."]);
});

test('mixed line length', () => {
  assert.deepEqual(transpose(["The longest line.", "A long line.", "A longer line.", "A line."]), ["TAAA", "h   ", "elll", " ooi", "lnnn", "ogge", "n e.", "glr", "ei ", "snl", "tei", " .n", "l e", "i .", "n", "e", "."]);
});

test('square', () => {
  assert.deepEqual(transpose(["HEART", "EMBER", "ABUSE", "RESIN", "TREND"]), ["HEART", "EMBER", "ABUSE", "RESIN", "TREND"]);
});

test('rectangle', () => {
  assert.deepEqual(transpose(["FRACTURE", "OUTLINED", "BLOOMING", "SEPTETTE"]), ["FOBS", "RULE", "ATOP", "CLOT", "TIME", "UNIT", "RENT", "EDGE"]);
});

test('triangle', () => {
  assert.deepEqual(transpose(["T", "EE", "AAA", "SSSS", "EEEEE", "RRRRRR"]), ["TEASER", " EASER", "  ASER", "   SER", "    ER", "     R"]);
});

test('jagged triangle', () => {
  assert.deepEqual(transpose(["11", "2", "3333", "444", "555555", "66666"]), ["123456", "1 3456", "  3456", "  3 56", "    56", "    5"]);
});
