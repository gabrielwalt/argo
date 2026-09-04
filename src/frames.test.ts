// TASK-START READ-ONLY CHECKPOINT (2026-09-05) — frames.ts half. dispatch.ts's
// runBossTaskStart now spawns its classification frame with TASK_START_TOOLS instead
// of ROLE_TOOLS.boss; these tests pin the composition of both so a future edit can't
// silently reintroduce a write path into classification. ROLE_TOOLS.boss itself has
// no live call site any more (2026-09, "iterative planner" removed the Boss standup/
// final-verification checkpoints it used to serve — see dispatch.ts's module header
// and the test below) but is still asserted on as the Record<Role,...> default. No
// Ollama, no ledger, no fs — plain array membership checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROLE_TOOLS, TASK_START_TOOLS, systemPromptFor } from './frames.js'

test('TASK_START_TOOLS has bash for investigation but no direct write tools', () => {
  // bash is included so the Boss can grep, cat, ls, run tests to understand
  // behaviour. write_file/edit_file are excluded — the prompt's read-only framing
  // is the guard, not the tool set (bash can write, but the Boss is classifying).
  assert.equal(TASK_START_TOOLS.includes('bash'), true)
  assert.equal(TASK_START_TOOLS.includes('write_file'), false)
  assert.equal(TASK_START_TOOLS.includes('edit_file'), false)
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

test('TASK_START_TOOLS includes bash for investigation plus read-only tools and conclude', () => {
  assert.deepEqual([...TASK_START_TOOLS].sort(), ['bash', 'conclude', 'fetch_url', 'ledger', 'read_file', 'web_search'])
})

test('ROLE_TOOLS.boss still has bash (the Record<Role,...> default, currently unused in practice)', () => {
  // The classification-only restriction applies to task-start ALONE (dispatch.ts
  // passes TASK_START_TOOLS as a one-off override to spawnFrame there). NOTE
  // (2026-09, "iterative planner"): the Boss standup/final checkpoints that used to
  // be ROLE_TOOLS.boss's other real call site were removed along with the task-graph
  // execution loop they reviewed (dispatch.ts's module header) — runBossTaskStart is
  // now the ONLY place a 'boss' frame ever spawns, and it always passes
  // TASK_START_TOOLS as an override. ROLE_TOOLS.boss therefore has no live call site
  // today; it still exists only because ROLE_TOOLS: Record<Role, ToolName[]> requires
  // an entry for every role, and is a reasonable, capable default should a future
  // Boss checkpoint be added without its own override. This test still guards its
  // CONTENTS (bash present, write_file absent) so that default stays sane whenever
  // it does get used.
  assert.equal(ROLE_TOOLS.boss.includes('bash'), true)
  assert.equal(ROLE_TOOLS.boss.includes('write_file'), false, 'unchanged pre-existing guarantee — the Boss verifies, never fixes directly')
})

// ── Planner system prompt: the ITERATIVE two-phase design (2026-09) — replaces the
// earlier task-graph and flattened-task-list designs entirely. The Planner is called
// once for a rough overall plan (plain text), then resumed repeatedly to detail one
// task at a time via TASK:/TEST:/DONE, with no separate "re-planning round" request
// any more — adaptation is just what happens on the next detail call.

test('planner system prompt: describes the two-phase flow — rough plan first, then resumed to detail one task at a time', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('ROUGH OVERALL PLAN'))
  assert.ok(text.includes('resumed repeatedly'))
  assert.ok(text.includes('detail exactly ONE task'))
  // No dangling reference to the old, now-removed graph/list mechanics.
  assert.equal(text.includes('dependsOn'), false)
  assert.equal(text.includes('frameGroup'), false)
  assert.equal(text.includes('task graph'), false)
})

test('planner system prompt: states the TASK:/TEST:/DONE ending convention', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('TASK:'))
  assert.ok(text.includes('TEST: yes'))
  assert.ok(text.includes('TEST: no'))
  assert.ok(text.includes('DONE'))
})

test('planner system prompt: adaptation is natural, not a separate re-planning request', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('no separate re-planning step'))
})

test('planner system prompt: still states it never writes or edits (matches the assignment prompt\'s READ-ONLY statement)', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('you never write or edit anything'))
})

// ── Planner read-only framing (2026-09-06) — the Planner's tool list has no bash,
// write_file, or edit_file (ROLE_TOOLS.planner above), but nothing in its OWN system
// prompt said so explicitly before this — a real session had it try to use bash
// anyway. Mirrors the Boss task-start checkpoint's own explicit "READ-ONLY" framing.

test('planner system prompt: explicitly states it is READ-ONLY and points at read_file for investigation', () => {
  const text = systemPromptFor('planner')
  assert.ok(/READ-ONLY/.test(text))
  assert.ok(text.includes('Use read_file to inspect files'))
})

// ── Planner task prompts must carry AGENTS.md/MEMORY.md context forward (2026-09-06,
// still true under the iterative design) — the Implementer only sees its own task
// prompt, never the Planner's own investigation, so anything the Planner learned that
// matters for a specific task must be restated directly in that task's own prompt.

test('planner system prompt: instructs restating relevant AGENTS.md/MEMORY.md content in each task\'s own prompt', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('AGENTS.md'))
  assert.ok(text.includes('MEMORY.md'))
  assert.ok(text.includes('self-contained'))
})

test('planner system prompt: TEST: no is for tasks too small to warrant a separate Tester pass', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('Answer TEST: no only when the task is small'))
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
