const { test } = require('node:test');
const assert = require('node:assert/strict');
const { greet } = require('../src/greeting');

test('greets by name', () => {
  assert.equal(greet('Bob'), 'Hello, Bob!');
});

test('greets a different name', () => {
  assert.equal(greet('Ada'), 'Hello, Ada!');
});
