import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportTasksToCsv } from '../src/export.js';

// Fully independent of TaskService — pure function over plain task objects.
test('exportTasksToCsv produces a header row plus one row per task, comma-joined', () => {
  const tasks = [
    { id: 'T-0001', title: 'First task', status: 'todo', priority: 'medium' },
    { id: 'T-0002', title: 'Second task', status: 'in_progress', priority: 'high' },
  ];
  const csv = exportTasksToCsv(tasks);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'id,title,status,priority');
  assert.equal(lines[1], 'T-0001,First task,todo,medium');
  assert.equal(lines[2], 'T-0002,Second task,in_progress,high');
  assert.equal(lines.length, 3);
});

test('exportTasksToCsv quotes a title containing a comma', () => {
  const csv = exportTasksToCsv([{ id: 'T-0001', title: 'Fix bug, then ship', status: 'todo', priority: 'low' }]);
  const line = csv.trim().split('\n')[1];
  assert.equal(line, 'T-0001,"Fix bug, then ship",todo,low');
});

test('exportTasksToCsv on an empty list is just the header', () => {
  assert.equal(exportTasksToCsv([]).trim(), 'id,title,status,priority');
});
