// Eval fixture (seeded by scripts/eval-e2e.mjs). Fails at baseline because
// addTask does not exist yet; passes once the agent implements + exports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { addTask } = await import('../src/task-store.js');

test('addTask appends a new task with the next id, given title, done=false, and a createdAt', () => {
  const before = [{ id: 1, title: 'existing', done: true, createdAt: '2020-01-01T00:00:00.000Z' }];
  const after = addTask(before, 'write the report');
  assert.equal(after.length, 2, 'returns a list with one more task');
  assert.equal(before.length, 1, 'must NOT mutate the input array');
  const t = after[after.length - 1];
  assert.equal(t.id, 2, 'uses nextId (max id + 1)');
  assert.equal(t.title, 'write the report');
  assert.equal(t.done, false);
  assert.equal(typeof t.createdAt, 'string');
  assert.ok(!Number.isNaN(Date.parse(t.createdAt)), 'createdAt is a valid date string');
});

test('addTask on an empty list starts ids at 1', () => {
  const after = addTask([], 'first');
  assert.equal(after.length, 1);
  assert.equal(after[0].id, 1);
});
