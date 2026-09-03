// effort.test.js  --  EVAL FEATURE SPEC (not part of the baseline suite)
//
// Feature: effort estimates (estimateMinutes) + capacity aggregation. This spec
// imports only things that already exist in the baseline; it fails today because
// `estimateMinutes` is not a recognised field and these are not implemented yet:
//   - validation/create/update accept an integer estimateMinutes >= 0 (default 0)
//   - TaskService.setEstimate(id, minutes) -> updated task
//   - TaskService.getEstimate(id) -> number (default 0)
//   - query.totalEstimate(tasks) -> number
//   - query.remainingEffort(tasks) -> number            (sum over not-done tasks)
//   - query.estimateByAssignee(tasks) -> object          (not-done effort per
//        assignee; a null assignee is keyed as "unassigned")

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTaskService } from '../src/service.js';
import { createIdGenerator } from '../src/ids.js';
import { ValidationError, NotFoundError } from '../src/errors.js';
import { totalEstimate, remainingEffort, estimateByAssignee } from '../src/query.js';

function makeService() {
  return createTaskService({ idGen: createIdGenerator('T') });
}

// A task can only reach "done" via the state machine (todo -> in_progress -> done).
function complete(svc, id) {
  svc.transition(id, 'in_progress');
  svc.transition(id, 'done');
}

test('create accepts a non-negative integer estimateMinutes and defaults it to 0', () => {
  const svc = makeService();
  const a = svc.create({ title: 'A', estimateMinutes: 90 });
  assert.equal(a.estimateMinutes, 90);
  const b = svc.create({ title: 'B' });
  assert.equal(b.estimateMinutes, 0);
});

test('create and update reject an invalid estimateMinutes with ValidationError', () => {
  const svc = makeService();
  assert.throws(() => svc.create({ title: 'X', estimateMinutes: -5 }), ValidationError);
  assert.throws(() => svc.create({ title: 'Y', estimateMinutes: 1.5 }), ValidationError);
  assert.throws(() => svc.create({ title: 'Z', estimateMinutes: 'lots' }), ValidationError);
  const ok = svc.create({ title: 'ok' });
  assert.throws(() => svc.update(ok.id, { estimateMinutes: -1 }), ValidationError);
});

test('setEstimate updates the estimate and getEstimate reads it (default 0)', () => {
  const svc = makeService();
  const t = svc.create({ title: 'T' });
  assert.equal(svc.getEstimate(t.id), 0);
  const updated = svc.setEstimate(t.id, 120);
  assert.equal(updated.estimateMinutes, 120);
  assert.equal(svc.getEstimate(t.id), 120);
});

test('setEstimate validates its argument and the task id', () => {
  const svc = makeService();
  const t = svc.create({ title: 'T' });
  assert.throws(() => svc.setEstimate(t.id, -1), ValidationError);
  assert.throws(() => svc.setEstimate(t.id, 2.5), ValidationError);
  assert.throws(() => svc.setEstimate('T-9999', 10), NotFoundError);
});

test('totalEstimate and remainingEffort aggregate across tasks', () => {
  const svc = makeService();
  svc.create({ title: 'A', estimateMinutes: 30 });
  const b = svc.create({ title: 'B', estimateMinutes: 60 });
  svc.create({ title: 'C', estimateMinutes: 10 });
  complete(svc, b.id);                       // b no longer counts toward remaining
  const tasks = svc.list();
  assert.equal(totalEstimate(tasks), 100);
  assert.equal(remainingEffort(tasks), 40);  // 30 + 10 (b done, excluded)
});

test('estimateByAssignee sums not-done effort per assignee, null -> unassigned', () => {
  const svc = makeService();
  svc.create({ title: 'A', assignee: 'alice', estimateMinutes: 30 });
  const a2 = svc.create({ title: 'A2', assignee: 'alice', estimateMinutes: 20 });
  svc.create({ title: 'B', assignee: 'bob', estimateMinutes: 45 });
  svc.create({ title: 'U', estimateMinutes: 15 });   // null assignee
  complete(svc, a2.id);                               // excluded from remaining
  assert.deepEqual(estimateByAssignee(svc.list()), { alice: 30, bob: 45, unassigned: 15 });
});
