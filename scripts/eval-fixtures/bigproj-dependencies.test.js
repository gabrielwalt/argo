// dependencies.test.js  --  EVAL FEATURE SPEC (not part of the baseline suite)
//
// Feature: task dependencies with topological scheduling + cycle detection.
//
// This spec imports ONLY things that already exist in the baseline. It fails
// today purely because the following TaskService methods are not implemented
// yet (calling them throws "is not a function"):
//
//   addDependency(taskId, dependsOnId)  -> task
//   removeDependency(taskId, dependsOnId) -> task
//   getDependencies(taskId)  -> string[]   (direct prerequisites, in add order)
//   getDependents(taskId)    -> string[]   (tasks that directly depend on it)
//   scheduleOrder()          -> string[]   (topological order, insertion tie-break)
//   readyTasks()             -> task[]     (not done, all prerequisites done)
//
// Semantics: `addDependency(X, Y)` means "X depends on Y", i.e. Y must be
// completed before X. A correct implementation must reject self-dependencies,
// duplicates, unknown ids, and any edge that would introduce a cycle.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTaskService } from '../src/service.js';
import { createIdGenerator } from '../src/ids.js';
import { ConflictError, NotFoundError } from '../src/errors.js';

function makeService() {
  // Deterministic ids: A=T-0001, B=T-0002, C=T-0003, D=T-0004
  return createTaskService({ idGen: createIdGenerator('T') });
}

/**
 * Build the diamond graph:  A -> B -> D  and  A -> C -> D
 * (edges point from prerequisite to dependent).
 */
function diamond() {
  const svc = makeService();
  const a = svc.create({ title: 'A' });
  const b = svc.create({ title: 'B' });
  const c = svc.create({ title: 'C' });
  const d = svc.create({ title: 'D' });
  svc.addDependency(b.id, a.id);
  svc.addDependency(c.id, a.id);
  svc.addDependency(d.id, b.id);
  svc.addDependency(d.id, c.id);
  return { svc, ids: { a: a.id, b: b.id, c: c.id, d: d.id } };
}

test('addDependency records a prerequisite on the task', () => {
  const svc = makeService();
  const a = svc.create({ title: 'A' });
  const b = svc.create({ title: 'B' });
  const updated = svc.addDependency(b.id, a.id);
  assert.deepEqual(updated.dependsOn, [a.id]);
});

test('getDependencies and getDependents expose both edge directions', () => {
  const { svc, ids } = diamond();
  assert.deepEqual(svc.getDependencies(ids.d), [ids.b, ids.c]);
  assert.deepEqual(svc.getDependencies(ids.a), []);
  assert.deepEqual(svc.getDependents(ids.a), [ids.b, ids.c]);
  assert.deepEqual(svc.getDependents(ids.d), []);
});

test('scheduleOrder returns a topological order with insertion tie-break', () => {
  const { svc, ids } = diamond();
  assert.deepEqual(svc.scheduleOrder(), [ids.a, ids.b, ids.c, ids.d]);
});

test('removeDependency drops a single edge', () => {
  const { svc, ids } = diamond();
  const updated = svc.removeDependency(ids.d, ids.b);
  assert.deepEqual(updated.dependsOn, [ids.c]);
  assert.deepEqual(svc.getDependencies(ids.d), [ids.c]);
});

test('readyTasks lists only tasks whose prerequisites are all done', () => {
  const { svc, ids } = diamond();
  // Initially only A (no prerequisites) is ready.
  assert.deepEqual(svc.readyTasks().map((t) => t.id), [ids.a]);

  // Complete A -> B and C become ready, D still blocked.
  svc.transition(ids.a, 'in_progress');
  svc.transition(ids.a, 'done');
  assert.deepEqual(svc.readyTasks().map((t) => t.id), [ids.b, ids.c]);
});

test('addDependency rejects a self-dependency', () => {
  const svc = makeService();
  const a = svc.create({ title: 'A' });
  assert.throws(() => svc.addDependency(a.id, a.id), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.code, 'SELF_DEPENDENCY');
    return true;
  });
});

test('addDependency rejects a duplicate edge', () => {
  const svc = makeService();
  const a = svc.create({ title: 'A' });
  const b = svc.create({ title: 'B' });
  svc.addDependency(b.id, a.id);
  assert.throws(() => svc.addDependency(b.id, a.id), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.code, 'DUPLICATE_DEPENDENCY');
    return true;
  });
});

test('addDependency rejects unknown task ids', () => {
  const svc = makeService();
  const a = svc.create({ title: 'A' });
  assert.throws(() => svc.addDependency(a.id, 'T-9999'), NotFoundError);
  assert.throws(() => svc.addDependency('T-9999', a.id), NotFoundError);
});

test('addDependency rejects an edge that would create a cycle', () => {
  const { svc, ids } = diamond();
  // A currently transitively precedes D; making A depend on D closes a cycle.
  assert.throws(() => svc.addDependency(ids.a, ids.d), (err) => {
    assert.ok(err instanceof ConflictError);
    assert.equal(err.code, 'DEPENDENCY_CYCLE');
    return true;
  });
});
