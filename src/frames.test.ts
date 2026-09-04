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
import {
  ROLE_TOOLS,
  TASK_START_TOOLS,
  systemPromptFor,
  ROLE_MAX_ITERATIONS,
  PROGRESS_CHECK_ITERATIONS,
  PROGRESS_CHECK_MESSAGES,
} from './frames.js'

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

// ── ROLE_TOOLS.tester: DESIGN-5 (flow audit) — the Tester is back and has a live
// call site. A now-superseded claim used to live here ("dispatch.ts no longer
// spawns a Tester at all"), left over from an earlier rewrite; dispatch.ts's
// runTesterValidation spawns a real 'tester' frame (with no toolOverride, so it
// gets exactly this default) after every Implementer SUCCESS, for both the
// OBJECTIVE/Planner path and the SIMPLE fast path. ROLE_TOOLS.tester/
// ROLE_MAX_ITERATIONS.tester/ROLE_POLICY.tester/ROLE_SYSTEM_SUFFIX.tester (and
// frames.ts's own parseTesterVerdict/TESTER_VERDICT_NUDGE, which batch2.test.ts —
// off this task's write list — still exercises directly) stay defined for the same
// structural reason as before (Role, types.ts, off limits, still enumerates
// 'tester'), but that reason is no longer the ONLY one: this table entry is live.
test('ROLE_TOOLS.tester exists and is a live default — dispatch.ts spawns Tester frames with it', () => {
  assert.equal(ROLE_TOOLS.tester.includes('read_file'), true)
  assert.equal(ROLE_TOOLS.tester.includes('write_file'), false, 'the Tester never fixes directly')
})

// ── Planner system prompt: the `conclude`-based ITERATIVE design — no TASK:/
// TEST:/DONE line convention, no separate "re-planning round" request (adaptation
// is just what happens on the next detail call). There IS a Tester round — the
// harness, not the Planner, spawns one after every Implementer SUCCESS (DESIGN-5,
// flow audit); the Planner is called once for an overall plan (an ordered list of
// sub-tasks, its `conclude` answer), then resumed repeatedly to produce one fully
// self-contained Implementer assignment at a time, also delivered via `conclude`.

test('planner system prompt: describes the two-phase flow — overall plan first, then resumed to produce one assignment at a time', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('ORDERED LIST'))
  assert.ok(text.includes('resumed repeatedly'))
  assert.ok(text.includes('exactly ONE'))
  // No dangling reference to the old, now-removed graph/list/marker mechanics.
  assert.equal(text.includes('dependsOn'), false)
  assert.equal(text.includes('frameGroup'), false)
  assert.equal(text.includes('task graph'), false)
  assert.equal(text.includes('TASK:'), false)
  assert.equal(text.includes('TEST: yes'), false)
  assert.equal(text.includes('TEST: no'), false)
})

test('planner system prompt: mentions conclude as the way it delivers both the plan and each assignment', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('`conclude`'))
})

test('planner system prompt: adaptation is natural, not a separate re-planning request', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('no separate re-planning'))
})

// DESIGN-5 (flow audit): the Planner suffix used to say "there is no separate Tester
// agent any more" and told the Planner to instruct Implementers to test their own
// work — false: the harness spawns a real Tester after every Implementer SUCCESS
// (dispatch.ts's runTesterValidation). Fixed to remove both the false claim and the
// self-test instruction; the Planner is not told the details of how testing works.
test('planner system prompt: does not claim there is no Tester, and does not tell Implementers to test their own work', () => {
  const text = systemPromptFor('planner')
  assert.equal(/no separate Tester/.test(text), false)
  assert.equal(text.includes('test its own work'), false)
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

// ── ITERATION LIMITS AND PROGRESS NUDGES ────────────────────────────────────────────
// ROLE_MAX_ITERATIONS.planner stays 40 (already matched the brief); implementer is
// raised 60->80 to leave real room after the new 50/60/70 escalation below. Boss is
// untouched — its own soft-10/hard-20 classification budget lives in dispatch.ts
// (TASK_START_MAX_ITERATIONS/TASK_START_HARD_CAP), not here. Tester raised 20->40
// (owner directive, superseding the flow audit's "Tester has no soft/hard split"
// finding) — buildTesterAssignment (dispatch.ts) still states the 20-iteration prompt
// budget verbatim; 40 here is now the real hard cap, mirroring the Planner's own
// soft-20/hard-40 split.

test('ROLE_MAX_ITERATIONS: planner=40 (unchanged), implementer=80 (raised), tester=40 (raised, soft/hard split), boss untouched', () => {
  assert.equal(ROLE_MAX_ITERATIONS.planner, 40)
  assert.equal(ROLE_MAX_ITERATIONS.implementer, 80)
  assert.equal(ROLE_MAX_ITERATIONS.tester, 40)
  assert.equal(ROLE_MAX_ITERATIONS.boss, 15)
})

test('PROGRESS_CHECK_ITERATIONS: planner escalates at 20/30, strictly below its 40-iteration cap', () => {
  assert.deepEqual(PROGRESS_CHECK_ITERATIONS.planner, [20, 30])
  for (const n of PROGRESS_CHECK_ITERATIONS.planner!) {
    assert.ok(n < ROLE_MAX_ITERATIONS.planner, `${n} must be below the hard cap ${ROLE_MAX_ITERATIONS.planner}`)
  }
})

test('PROGRESS_CHECK_ITERATIONS: implementer escalates at 50/60/70, strictly below its 80-iteration cap', () => {
  assert.deepEqual(PROGRESS_CHECK_ITERATIONS.implementer, [50, 60, 70])
  for (const n of PROGRESS_CHECK_ITERATIONS.implementer!) {
    assert.ok(n < ROLE_MAX_ITERATIONS.implementer, `${n} must be below the hard cap ${ROLE_MAX_ITERATIONS.implementer}`)
  }
})

test('PROGRESS_CHECK_ITERATIONS: tester escalates at 20/30, strictly below its 40-iteration cap, matching the Planner\'s pattern', () => {
  assert.deepEqual(PROGRESS_CHECK_ITERATIONS.tester, [20, 30])
  assert.deepEqual(PROGRESS_CHECK_ITERATIONS.tester, PROGRESS_CHECK_ITERATIONS.planner)
  for (const n of PROGRESS_CHECK_ITERATIONS.tester!) {
    assert.ok(n < ROLE_MAX_ITERATIONS.tester, `${n} must be below the hard cap ${ROLE_MAX_ITERATIONS.tester}`)
  }
})

test('PROGRESS_CHECK_ITERATIONS: no entry for boss — it keeps the generic fraction-based mechanism', () => {
  assert.equal(PROGRESS_CHECK_ITERATIONS.boss, undefined)
})

test('PROGRESS_CHECK_MESSAGES is index-aligned with PROGRESS_CHECK_ITERATIONS for every role that has an entry', () => {
  assert.equal(PROGRESS_CHECK_MESSAGES.planner!.length, PROGRESS_CHECK_ITERATIONS.planner!.length)
  assert.equal(PROGRESS_CHECK_MESSAGES.implementer!.length, PROGRESS_CHECK_ITERATIONS.implementer!.length)
  assert.equal(PROGRESS_CHECK_MESSAGES.tester!.length, PROGRESS_CHECK_ITERATIONS.tester!.length)
})

test('PROGRESS_CHECK_MESSAGES: tester messages mirror the Planner\'s wording, "analysis" swapped for "validation"', () => {
  assert.equal(
    PROGRESS_CHECK_MESSAGES.tester![0],
    'PROGRESS CHECK: 20 iterations in. Wrap up your validation and call conclude with your result.',
  )
  assert.equal(
    PROGRESS_CHECK_MESSAGES.tester![1],
    'PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.',
  )
  // Second rung is byte-identical to the Planner's own — only the first differs.
  assert.equal(PROGRESS_CHECK_MESSAGES.tester![1], PROGRESS_CHECK_MESSAGES.planner![1])
})

test('PROGRESS_CHECK_MESSAGES: planner messages match the brief\'s exact wording and escalate in tone (gentle, then firmer)', () => {
  const [gentle, firmer] = PROGRESS_CHECK_MESSAGES.planner!
  assert.equal(
    gentle,
    'PROGRESS CHECK: 20 iterations in. Wrap up your analysis and call conclude with your result.',
  )
  assert.equal(
    firmer,
    'PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.',
  )
})

test('PROGRESS_CHECK_MESSAGES: implementer messages match the brief\'s exact wording and escalate in tone', () => {
  const [soft, firmer, strongest] = PROGRESS_CHECK_MESSAGES.implementer!
  assert.equal(
    soft,
    'PROGRESS CHECK: 50 iterations in and not finished. Start wrapping up your work. Call conclude with a ' +
      'summary of what you accomplished, what didn\'t work, and what\'s left to do.',
  )
  assert.equal(
    firmer,
    'PROGRESS CHECK: 60 iterations in. You must wrap up now. Call conclude with what you accomplished and ' +
      'what remains.',
  )
  assert.equal(
    strongest,
    'PROGRESS CHECK: 70 iterations. Finish immediately. Call conclude with your final status — what was ' +
      'done, what failed, and what\'s left.',
  )
})
