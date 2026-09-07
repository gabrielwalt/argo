// SCHEMA-CONSTRAINED CONTROL PLANE — REMOVED. schema.ts implemented a
// schema-constrained-JSON recovery path for Boss/Tester verdict checkpoints; with the
// Tester agent removed and the Planner's task graph long gone (it now returns a plan
// as plain text, resumed repeatedly to detail one task at a time via `conclude`),
// nothing in this codebase produces a verdict shape that needs restating as strict
// JSON any more. schema.ts is kept as an empty module (this environment cannot delete
// files) and dispatch.ts's runBossTaskStart falls back to a plain resumeFrame retry
// instead of a schema-constrained extraction call.
//
// This file is kept only to assert `PlanningFailed` — the Planner's one hard-stop —
// is still exported and still a real Error subclass. Exercising the Planner's
// iterative loop beyond that needs a live model (same "needs a live model, cannot be
// unit tested here" category as spawnFrame/resumeFrame throughout dispatch.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanningFailed } from './dispatch.js'

test('PlanningFailed is still exported and remains a real Error subclass (the Planner\'s one hard-stop)', () => {
  const err = new PlanningFailed('the Planner never produced a readable answer')
  assert.ok(err instanceof Error)
  assert.ok(err instanceof PlanningFailed)
  assert.equal(err.message, 'the Planner never produced a readable answer')
})
