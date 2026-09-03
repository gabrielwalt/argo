const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CircularBuffer, BufferFullError, BufferEmptyError } = require('../src/circular-buffer');

test('reading empty buffer should fail', () => {
  const buf = new CircularBuffer(1);
  assert.throws(() => buf.read(), BufferEmptyError);
});

test('can read an item just written', () => {
  const buf = new CircularBuffer(1);
  buf.write(1);
  assert.equal(buf.read(), 1);
});

test('each item may only be read once', () => {
  const buf = new CircularBuffer(1);
  buf.write(1);
  assert.equal(buf.read(), 1);
  assert.throws(() => buf.read(), BufferEmptyError);
});

test('items are read in the order they are written', () => {
  const buf = new CircularBuffer(2);
  buf.write(1);
  buf.write(2);
  assert.equal(buf.read(), 1);
  assert.equal(buf.read(), 2);
});

test('full buffer can\'t be written to', () => {
  const buf = new CircularBuffer(1);
  buf.write(1);
  assert.throws(() => buf.write(2), BufferFullError);
});

test('a read frees up capacity for another write', () => {
  const buf = new CircularBuffer(1);
  buf.write(1);
  assert.equal(buf.read(), 1);
  buf.write(2);
  assert.equal(buf.read(), 2);
});

test('read position is maintained even across multiple writes', () => {
  const buf = new CircularBuffer(3);
  buf.write(1);
  buf.write(2);
  assert.equal(buf.read(), 1);
  buf.write(3);
  assert.equal(buf.read(), 2);
  assert.equal(buf.read(), 3);
});

test('items cleared out of buffer can\'t be read', () => {
  const buf = new CircularBuffer(1);
  buf.write(1);
  buf.clear();
  assert.throws(() => buf.read(), BufferEmptyError);
});

test('clear frees up capacity for another write', () => {
  const buf = new CircularBuffer(1);
  buf.write(1);
  buf.clear();
  buf.write(2);
  assert.equal(buf.read(), 2);
});

test('clear does nothing on empty buffer', () => {
  const buf = new CircularBuffer(1);
  buf.clear();
  buf.write(1);
  assert.equal(buf.read(), 1);
});

test('overwrite acts like write on non-full buffer', () => {
  const buf = new CircularBuffer(2);
  buf.write(1);
  buf.overwrite(2);
  assert.equal(buf.read(), 1);
  assert.equal(buf.read(), 2);
});

test('overwrite replaces the oldest item on full buffer', () => {
  const buf = new CircularBuffer(2);
  buf.write(1);
  buf.write(2);
  buf.overwrite(3);
  assert.equal(buf.read(), 2);
  assert.equal(buf.read(), 3);
});

test('overwrite replaces the oldest item remaining in buffer following a read', () => {
  const buf = new CircularBuffer(3);
  buf.write(1);
  buf.write(2);
  buf.write(3);
  assert.equal(buf.read(), 1);
  buf.write(4);
  buf.overwrite(5);
  assert.equal(buf.read(), 3);
  assert.equal(buf.read(), 4);
  assert.equal(buf.read(), 5);
});

test('initial clear does not affect wrapping around', () => {
  const buf = new CircularBuffer(2);
  buf.clear();
  buf.write(1);
  buf.write(2);
  buf.overwrite(3);
  buf.overwrite(4);
  assert.equal(buf.read(), 3);
  assert.equal(buf.read(), 4);
  assert.throws(() => buf.read(), BufferEmptyError);
});
