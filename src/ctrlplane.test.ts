// SCHEMA-CONSTRAINED CONTROL PLANE — pipeline wiring tests (config.schemaControlPlane).
//
// REMOVED (2026-09, "iterative planner" — see dispatch.ts's module header). This file
// used to exercise dispatch.ts's `graphFromPlanner` directly: the Planner produced a
// JSON task graph, a cheap regex parse tried first, and — on failure — one bounded,
// schema-constrained `fetch` call to Ollama restated the SAME decision as strict JSON,
// stubbable with no live Agent/Ollama because that recovery path never called
// resumeFrame at all (see the old file's own header comment).
//
// The owner's new architecture deletes the Planner's JSON task graph entirely — it
// now returns a rough plan as plain text on its first call, then is RESUMED
// repeatedly to detail one task at a time via a plain TASK:/TEST:/DONE text
// convention (dispatch.ts's parseNextTask). `graphFromPlanner`,
// `PLANNER_FORMAT_INSTRUCTION`/`PLANNER_FORMAT_RETRY_NUDGE`, and schema.ts's whole
// task-graph extraction subsystem (`extractTaskGraph`, `TASK_GRAPH_SCHEMA`,
// `ExtractedTaskStep`/`ExtractedTaskGraph`, `parseExtractedTaskGraph`) are gone with
// it — there is nothing graph-shaped left to restate, so no schema-constrained
// recovery path was added for the new TASK:/TEST:/DONE format either (a deliberate,
// out-of-scope-for-this-change decision — see /shared/argo-ui/ITERATIVE-PLANNER.md).
//
// What replaces graphFromPlanner is dispatch.ts's `detailNextTask`: cheap regex parse
// (`parseNextTask`, pure, tested directly in dispatch.test.ts) tried first, then ONE
// plain-text format-retry nudge via `resumeFrame` (a REAL agent.chat() call, unlike
// the old schema branch), then `PlanningFailed`. Because the retry now always goes
// through a live Agent turn rather than a stubbable `fetch`, `detailNextTask` itself
// falls into the same "needs a live model, cannot be unit tested here" category as
// `spawnFrame`/`resumeFrame` throughout dispatch.ts (see that file's own comments) —
// there is no lightweight, network-only seam left to test it through, so no
// replacement test file was written for the orchestration itself. `parseNextTask`'s
// pure parsing logic (including "never fail open to DONE" and "TASK: checked before
// DONE") is covered directly in dispatch.test.ts instead.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PlanningFailed } from './dispatch.js'

test('PlanningFailed is still exported and remains a real Error subclass (the Planner\'s one hard-stop, unchanged by the iterative-planner rewrite)', () => {
  const err = new PlanningFailed('the Planner never produced a readable TASK/DONE line')
  assert.ok(err instanceof Error)
  assert.ok(err instanceof PlanningFailed)
  assert.equal(err.message, 'the Planner never produced a readable TASK/DONE line')
})
