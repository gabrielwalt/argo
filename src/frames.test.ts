// TASK-START READ-ONLY CHECKPOINT (2026-09-05) — frames.ts half. dispatch.ts's
// runBossTaskStart now spawns its classification frame with TASK_START_TOOLS instead
// of ROLE_TOOLS.boss; these tests pin the composition of both so a future edit can't
// silently reintroduce a write path into classification, or silently strip `bash` from
// the Boss's OTHER checkpoints (standup/final), which still legitimately need it to
// run tests. No Ollama, no ledger, no fs — plain array membership checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLE_TOOLS, TASK_START_TOOLS, systemPromptFor } from './frames.js'

test('TASK_START_TOOLS has no write capability at all', () => {
  assert.equal(TASK_START_TOOLS.includes('bash'), false, 'bash was the only path the Boss had to touch the workspace')
  assert.equal(TASK_START_TOOLS.includes('write_file'), false)
  assert.equal(TASK_START_TOOLS.includes('edit_file'), false)
  assert.equal(TASK_START_TOOLS.includes('browser_fetch'), false)
  assert.equal(TASK_START_TOOLS.includes('update_plan'), false)
})

test('TASK_START_TOOLS keeps investigation and grounding tools', () => {
  assert.equal(TASK_START_TOOLS.includes('read_file'), true)
  assert.equal(TASK_START_TOOLS.includes('web_search'), true)
  assert.equal(TASK_START_TOOLS.includes('fetch_url'), true)
})

test('TASK_START_TOOLS keeps ledger — the tool itself exposes no write action', () => {
  // Read-only by construction: get_goal/get_plan/get_recent/get_conclusion/
  // get_frame_trail/expand are the only actions the ledger TOOL accepts
  // (tools/index.ts) — the harness's own ledger.setObjective/setPlan/
  // recordDelegation calls are separate direct module calls, never reachable
  // through this tool. Keeping it is what lets the read-only checkpoint still
  // "look up prior work instead of assuming."
  assert.equal(TASK_START_TOOLS.includes('ledger'), true)
})

test('TASK_START_TOOLS is exactly five tools (read-only + conclude), not a filtered copy of ROLE_TOOLS.boss', () => {
  assert.deepEqual([...TASK_START_TOOLS].sort(), ['conclude', 'fetch_url', 'ledger', 'read_file', 'web_search'])
})

test('ROLE_TOOLS.boss (the Boss\'s OTHER checkpoints — standup, final) still has bash', () => {
  // The classification-only restriction applies to task-start ALONE (dispatch.ts
  // passes TASK_START_TOOLS as a one-off override to spawnFrame there) — every other
  // Boss checkpoint still spawns with ROLE_TOOLS.boss and legitimately needs bash to
  // run tests during standup/final verification. This guards against "fixing"
  // ROLE_TOOLS.boss directly instead of using the override, which would silently take
  // bash away from checkpoints that still need it.
  assert.equal(ROLE_TOOLS.boss.includes('bash'), true)
  assert.equal(ROLE_TOOLS.boss.includes('write_file'), false, 'unchanged pre-existing guarantee — the Boss verifies, never fixes directly')
})

// ── Planner system prompt consistency with dispatch.ts's assignment prompts
// (buildPlannerAssignment/buildReplanAssignment, 2026-09-05) — the system prompt
// used to say a too-large-to-predict plan should "say so explicitly" and expect to
// be "resumed later with what happened so far", while the new assignment prompt
// instructs a structural mechanism instead: "include a final step that requests a
// re-planning round... resumed with what each agent produced." A model reading both
// would get two different instructions for the same situation — fixed here.

test('planner system prompt: the too-large-to-predict guidance matches the replanning mechanic (no contradiction)', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('include a final step that requests a re-planning round'))
  assert.ok(text.includes('resumed later with what each agent produced'))
  // The old, now-inconsistent wording must not linger alongside the new mechanic.
  assert.equal(text.includes('say so explicitly'), false)
})

test('planner system prompt: still states it never writes or edits (matches the assignment prompt\'s READ-ONLY statement)', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('you never write or edit anything'))
})

// ── update_plan removed as a callable tool for every multi-agent role (2026-09-05) ──
// dispatch.ts's spawnFrame now seeds every Implementer's plan (Agent.seedPlan) before
// chat() runs, so no multi-agent role ever needs to set or refine its own plan.
// NOTE for the cone: src/batch2.test.ts's existing test
// "H17: the Planner no longer holds update_plan; the Implementer still does"
// asserts `ROLE_TOOLS.implementer.includes('update_plan') === true` (line ~497) —
// that file is not on this task's write list, so that assertion now needs updating
// to `false` to match. Flagged in the report; not fixed here.

test('ROLE_TOOLS.implementer no longer holds update_plan', () => {
  assert.equal(ROLE_TOOLS.implementer.includes('update_plan'), false)
})

test('no role in ROLE_TOOLS holds update_plan — it is a harness-internal mechanism now, not a callable tool', () => {
  for (const role of ['planner', 'implementer', 'tester', 'boss'] as const) {
    assert.equal(ROLE_TOOLS[role].includes('update_plan'), false, `${role} must not have update_plan`)
  }
})

// ── conclude: every role gets it (2026-09-06) — "no tool call = done" is gone,
// so every agent needs an explicit way to finish, unlike update_plan which was
// always role-specific.

test('every role in ROLE_TOOLS holds conclude', () => {
  for (const role of ['planner', 'implementer', 'tester', 'boss'] as const) {
    assert.equal(ROLE_TOOLS[role].includes('conclude'), true, `${role} must have conclude`)
  }
})

test('TASK_START_TOOLS (the read-only classification checkpoint) also holds conclude', () => {
  // Without it the checkpoint could investigate forever but never actually
  // classify — a turn with no tool calls no longer ends anything either.
  assert.equal(TASK_START_TOOLS.includes('conclude'), true)
})
