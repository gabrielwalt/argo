const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventBus } = require('../src/event-bus');

test('off() removes only the specified handler, others for the same event still fire', () => {
  const bus = new EventBus();
  const calls = [];
  const a = () => calls.push('a');
  const b = () => calls.push('b');
  bus.on('ping', a);
  bus.on('ping', b);
  bus.off('ping', a);
  bus.emit('ping');
  assert.deepEqual(calls, ['b']);
});

test('emit still reaches a handler that was never removed', () => {
  const bus = new EventBus();
  const calls = [];
  bus.on('ping', () => calls.push('x'));
  bus.emit('ping');
  bus.emit('ping');
  assert.deepEqual(calls, ['x', 'x']);
});

test('off() on a handler that was never registered is a no-op', () => {
  const bus = new EventBus();
  const calls = [];
  const a = () => calls.push('a');
  bus.on('ping', a);
  bus.off('ping', () => {});
  bus.emit('ping');
  assert.deepEqual(calls, ['a']);
});
