// Asserts `PlanningFailed` — the Planner's one hard-stop — is exported and remains a
// real Error subclass. Exercising the Planner's iterative loop beyond that needs a
// live model (same "needs a live model, cannot be unit tested here" category as
// spawnFrame/resumeFrame throughout dispatch.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanningFailed } from './dispatch.js'

test('PlanningFailed is still exported and remains a real Error subclass (the Planner\'s one hard-stop)', () => {
  const err = new PlanningFailed('the Planner never produced a readable answer')
  assert.ok(err instanceof Error)
  assert.ok(err instanceof PlanningFailed)
  assert.equal(err.message, 'the Planner never produced a readable answer')
})
