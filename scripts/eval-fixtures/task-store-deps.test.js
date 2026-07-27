// Eval fixture (seeded by scripts/eval-e2e.mjs). A COMPLEX, multi-part feature:
// task dependencies with readiness + cycle detection. Fails at baseline (the three
// functions don't exist); passes only once the agent implements them correctly —
// genuine graph reasoning (reachability for cycles), readiness logic, immutability,
// and error handling. A real long-horizon coding task.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { addDependency, getReadyTasks, hasCycle } = await import('../src/task-store.js');

const ids = (arr) => arr.map((t) => t.id).sort((a, b) => a - b);

test('getReadyTasks: a not-done task with no dependencies is ready; a done task is not', () => {
  const tasks = [
    { id: 1, title: 'a', done: false },
    { id: 2, title: 'b', done: true },
  ];
  assert.deepEqual(ids(getReadyTasks(tasks)), [1]);
});

test('getReadyTasks: a task is ready only when every dependency is done', () => {
  const tasks = [
    { id: 1, title: 'root', done: true },
    { id: 2, title: 'mid', done: false, deps: [1] },       // dep done → ready
    { id: 3, title: 'blocked', done: false, deps: [2] },   // dep (2) not done → not ready
    { id: 4, title: 'multi', done: false, deps: [1, 2] },  // dep 2 not done → not ready
  ];
  assert.deepEqual(ids(getReadyTasks(tasks)), [2]);
});

test('addDependency adds a dep, returns a new array, and does not mutate the input', () => {
  const before = [{ id: 1, title: 'a', done: false }, { id: 2, title: 'b', done: false }];
  const after = addDependency(before, 2, 1); // task 2 depends on task 1
  assert.deepEqual(after.find((t) => t.id === 2).deps, [1]);
  assert.equal(before.find((t) => t.id === 2).deps, undefined, 'must NOT mutate the input');
});

test('addDependency throws on a self-dependency', () => {
  assert.throws(() => addDependency([{ id: 1, title: 'a', done: false }], 1, 1));
});

test('addDependency throws when it would create a cycle', () => {
  let tasks = [{ id: 1, title: 'a', done: false }, { id: 2, title: 'b', done: false }];
  tasks = addDependency(tasks, 1, 2);              // 1 → 2 (ok)
  assert.throws(() => addDependency(tasks, 2, 1)); // 2 → 1 would close the cycle
});

test('addDependency throws when a referenced task id does not exist', () => {
  const tasks = [{ id: 1, title: 'a', done: false }];
  assert.throws(() => addDependency(tasks, 1, 99));
  assert.throws(() => addDependency(tasks, 99, 1));
});

test('hasCycle distinguishes acyclic from cyclic dependency graphs', () => {
  const acyclic = [
    { id: 1, done: false },
    { id: 2, done: false, deps: [1] },
    { id: 3, done: false, deps: [1, 2] },
  ];
  assert.equal(hasCycle(acyclic), false);
  const cyclic = [
    { id: 1, done: false, deps: [3] },
    { id: 2, done: false, deps: [1] },
    { id: 3, done: false, deps: [2] }, // 1→3→2→1
  ];
  assert.equal(hasCycle(cyclic), true);
});
