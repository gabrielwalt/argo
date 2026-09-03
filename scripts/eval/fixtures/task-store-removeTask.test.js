// Eval fixture (seeded by scripts/eval-e2e.mjs). Fails at baseline because
// removeTask does not exist yet; passes once the agent implements + exports it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { removeTask } = await import('../src/task-store.js');

test('removeTask returns a new array without the matching id and does not mutate the input', () => {
  const before = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const after = removeTask(before, 2);
  assert.deepEqual(after.map((t) => t.id), [1, 3]);
  assert.equal(before.length, 3, 'must NOT mutate the input array');
});

test('removeTask leaves the list unchanged when the id is absent', () => {
  assert.deepEqual(removeTask([{ id: 1 }, { id: 5 }], 9).map((t) => t.id), [1, 5]);
});
