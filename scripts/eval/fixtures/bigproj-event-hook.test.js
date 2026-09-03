import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTaskService } from '../src/service.js';

// Independent of export.js/audit log — only needs the constructor's onEvent hook.
test('onEvent fires for create, update, transition, and remove with the task id as payload', () => {
  const events = [];
  const svc = createTaskService({ onEvent: (name, payload) => events.push({ name, payload }) });
  const task = svc.create({ title: 'First task' });
  svc.update(task.id, { title: 'Renamed' });
  svc.transition(task.id, 'in_progress');
  svc.remove(task.id);
  assert.deepEqual(events.map(e => e.name), ['create', 'update', 'transition', 'remove']);
  assert.ok(events.every(e => e.payload.taskId === task.id));
});

test('a service constructed without onEvent still works normally (the hook is optional)', () => {
  const svc = createTaskService();
  assert.doesNotThrow(() => svc.create({ title: 'No hook here' }));
});
