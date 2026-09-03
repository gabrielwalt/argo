// duedate-sort.test.js  --  EVAL DEBUG SPEC (not part of the baseline suite)
//
// A genuine latent bug in COMMITTED code (no git-revert shortcut): sortTasks by
// dueDate should keep tasks with a null dueDate LAST regardless of direction.
// Today they sort correctly in ascending order but jump to the FRONT in
// descending order, because the direction factor is applied to the null
// sentinel too. The failing test is about sorting (query.js); the fix is in how
// the null sentinel interacts with the direction factor — find the root cause
// and fix it so nulls stay last in both directions, without breaking the
// existing sort tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sortTasks } from '../src/query.js';

// Minimal task-shaped fixtures (only the fields sortTasks reads).
function t(id, dueDate) {
  return {
    id, title: id, status: 'todo', priority: 'medium',
    tags: [], assignee: null, dueDate, createdAt: '2024-01-01T00:00:00.000Z',
  };
}

const tasks = [
  t('A', '2024-03-01'),
  t('B', null),
  t('C', '2024-01-15'),
  t('D', null),
  t('E', '2024-02-10'),
];

test('sortTasks by dueDate asc: dates ascending, nulls last', () => {
  const ids = sortTasks(tasks, { by: 'dueDate', dir: 'asc' }).map((x) => x.id);
  assert.deepEqual(ids, ['C', 'E', 'A', 'B', 'D']);
});

test('sortTasks by dueDate desc: dates descending, nulls STILL last', () => {
  const ids = sortTasks(tasks, { by: 'dueDate', dir: 'desc' }).map((x) => x.id);
  assert.deepEqual(ids, ['A', 'E', 'C', 'B', 'D']);
});
