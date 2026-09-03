import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeService } from './helpers.js';

// Independent of export.js/onEvent — only needs TaskService.getAuditLog().
test('getAuditLog records a create entry', () => {
  const svc = makeService();
  const task = svc.create({ title: 'First task' });
  const log = svc.getAuditLog();
  assert.equal(log.length, 1);
  assert.equal(log[0].action, 'create');
  assert.equal(log[0].taskId, task.id);
});

test('getAuditLog records update, transition, and remove, in order, without dropping earlier entries', () => {
  const svc = makeService();
  const task = svc.create({ title: 'First task' });
  svc.update(task.id, { title: 'Renamed' });
  svc.transition(task.id, 'in_progress');
  svc.remove(task.id);
  const log = svc.getAuditLog();
  assert.deepEqual(log.map(e => e.action), ['create', 'update', 'transition', 'remove']);
  assert.ok(log.every(e => e.taskId === task.id));
});

test('getAuditLog does NOT record a failed operation (e.g. a rejected transition)', () => {
  const svc = makeService();
  const task = svc.create({ title: 'First task' });
  assert.throws(() => svc.transition(task.id, 'done')); // todo -> done is not a legal direct transition
  const log = svc.getAuditLog();
  assert.deepEqual(log.map(e => e.action), ['create']); // the failed transition must not appear
});
