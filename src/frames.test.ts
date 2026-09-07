// TASK-START READ-ONLY CHECKPOINT — frames.ts half. dispatch.ts's runBossTaskStart
// spawns its classification frame with TASK_START_TOOLS instead of ROLE_TOOLS.boss;
// these tests pin the composition of both so a future edit can't silently
// reintroduce a write path into classification. No Ollama, no ledger, no fs — plain
// array membership checks.

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
})

test('TASK_START_TOOLS keeps investigation and grounding tools', () => {
  assert.equal(TASK_START_TOOLS.includes('read_file'), true)
  assert.equal(TASK_START_TOOLS.includes('web_search'), true)
  assert.equal(TASK_START_TOOLS.includes('fetch_url'), true)
})

test('TASK_START_TOOLS keeps ledger — the tool itself exposes no write action', () => {
  // Read-only by construction: get_goal/get_recent/get_conclusion/get_frame_trail/
  // expand are the only actions the ledger TOOL accepts (tools/index.ts) — the
  // harness's own ledger.setObjective/recordDelegation calls are separate direct
  // module calls, never reachable through this tool. Keeping it is what lets the
  // read-only checkpoint still "look up prior work instead of assuming."
  assert.equal(TASK_START_TOOLS.includes('ledger'), true)
})

test('TASK_START_TOOLS includes bash for investigation plus read-only tools and conclude', () => {
  assert.deepEqual([...TASK_START_TOOLS].sort(), ['bash', 'conclude', 'fetch_url', 'ledger', 'read_file', 'web_search'])
})

test('ROLE_TOOLS.boss has bash but no write_file — the Boss verifies, never fixes directly', () => {
  // The classification-only restriction applies to task-start ALONE (dispatch.ts
  // passes TASK_START_TOOLS as a one-off override to spawnFrame there). This test
  // guards ROLE_TOOLS.boss's own default contents.
  assert.equal(ROLE_TOOLS.boss.includes('bash'), true)
  assert.equal(ROLE_TOOLS.boss.includes('write_file'), false)
})

// ── Planner system prompt: the `conclude`-based ITERATIVE design — no TASK:/
// TEST:/DONE line convention, no separate "re-planning round" request (adaptation
// is just what happens on the next detail call). The Planner is called once for an
// overall plan (an ordered list of sub-tasks, its `conclude` answer), then resumed
// repeatedly to produce one fully self-contained Implementer assignment at a time,
// also delivered via `conclude`.

test('planner system prompt: describes the two-phase flow — overall plan first, then resumed to produce one assignment at a time', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('ordered list'))
  assert.ok(text.includes('resumed for each unit'))
  assert.ok(text.includes('exactly one'))
  // No dangling reference to the old, now-removed graph/list/marker mechanics.
  assert.equal(text.includes('dependsOn'), false)
  assert.equal(text.includes('frameGroup'), false)
  assert.equal(text.includes('task graph'), false)
  // TASK is now a section title in the structured prompt, so only check for the old marker convention.
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

test('planner system prompt: does not mention a Tester (there is none)', () => {
  const text = systemPromptFor('planner')
  assert.equal(/\bTester\b/.test(text), false)
})

test('planner system prompt: still states it never writes or edits (matches the assignment prompt\'s READ-ONLY statement)', () => {
  const text = systemPromptFor('planner')
  assert.ok(text.includes('you never write or edit anything'))
})

// ── Planner read-only framing — the Planner's tool list has no bash, write_file,
// or edit_file (ROLE_TOOLS.planner above), and its own system prompt says so
// explicitly. Mirrors the Boss task-start checkpoint's own explicit "READ-ONLY"
// framing.

test('planner system prompt: explicitly states it is READ-ONLY and points at read_file for investigation', () => {
  const text = systemPromptFor('planner')
  assert.ok(/READ-ONLY/.test(text))
  assert.ok(text.includes('Use read_file to inspect files'))
})

// ── update_plan does not exist as a tool at all any more — the plan/act gate and
// the update_plan tool were removed along with harness task sequencing.

test('no role in ROLE_TOOLS holds update_plan — the tool does not exist any more', () => {
  for (const role of ['planner', 'implementer', 'boss'] as const) {
    assert.equal(ROLE_TOOLS[role].includes('update_plan' as never), false, `${role} must not have update_plan`)
  }
})

// ── conclude: every role gets it — "no tool call = done" is gone, so every agent
// needs an explicit way to finish.

test('every role in ROLE_TOOLS holds conclude', () => {
  for (const role of ['planner', 'implementer', 'boss'] as const) {
    assert.equal(ROLE_TOOLS[role].includes('conclude'), true, `${role} must have conclude`)
  }
})

test('TASK_START_TOOLS (the read-only classification checkpoint) also holds conclude', () => {
  // Without it the checkpoint could investigate forever but never actually
  // classify — a turn with no tool calls no longer ends anything either.
  assert.equal(TASK_START_TOOLS.includes('conclude'), true)
})

// ── ITERATION LIMITS AND PROGRESS NUDGES ────────────────────────────────────────────

test('ROLE_MAX_ITERATIONS: planner=40, implementer=160, boss=15', () => {
  assert.equal(ROLE_MAX_ITERATIONS.planner, 40)
  assert.equal(ROLE_MAX_ITERATIONS.implementer, 160)
  assert.equal(ROLE_MAX_ITERATIONS.boss, 15)
})

test('PROGRESS_CHECK_ITERATIONS: planner escalates at 20/30, strictly below its 40-iteration cap', () => {
  assert.deepEqual(PROGRESS_CHECK_ITERATIONS.planner, [20, 30])
  for (const n of PROGRESS_CHECK_ITERATIONS.planner!) {
    assert.ok(n < ROLE_MAX_ITERATIONS.planner, `${n} must be below the hard cap ${ROLE_MAX_ITERATIONS.planner}`)
  }
})

test('PROGRESS_CHECK_ITERATIONS: implementer escalates at 100/120/140, strictly below its 160-iteration cap', () => {
  assert.deepEqual(PROGRESS_CHECK_ITERATIONS.implementer, [100, 120, 140])
  for (const n of PROGRESS_CHECK_ITERATIONS.implementer!) {
    assert.ok(n < ROLE_MAX_ITERATIONS.implementer, `${n} must be below the hard cap ${ROLE_MAX_ITERATIONS.implementer}`)
  }
})

test('PROGRESS_CHECK_ITERATIONS: no entry for boss — it keeps the generic fraction-based mechanism', () => {
  assert.equal(PROGRESS_CHECK_ITERATIONS.boss, undefined)
})

test('PROGRESS_CHECK_MESSAGES is index-aligned with PROGRESS_CHECK_ITERATIONS for every role that has an entry', () => {
  assert.equal(PROGRESS_CHECK_MESSAGES.planner!.length, PROGRESS_CHECK_ITERATIONS.planner!.length)
  assert.equal(PROGRESS_CHECK_MESSAGES.implementer!.length, PROGRESS_CHECK_ITERATIONS.implementer!.length)
})

test('PROGRESS_CHECK_MESSAGES: planner messages match the brief\'s exact wording and escalate in tone (gentle, then firmer)', () => {
  const [gentle, firmer] = PROGRESS_CHECK_MESSAGES.planner!
  assert.equal(
    gentle,
    'IMPORTANT — 20 iterations used. Wrap up your analysis and call conclude with your result.',
  )
  assert.equal(
    firmer,
    'IMPORTANT — 30 iterations used, approaching the hard limit. You MUST call conclude NOW with your best result.',
  )
})

test('PROGRESS_CHECK_MESSAGES: implementer messages match the brief\'s exact wording and escalate in tone', () => {
  const [soft, firmer, strongest] = PROGRESS_CHECK_MESSAGES.implementer!
  assert.equal(
    soft,
    'IMPORTANT — 100 iterations used. Start wrapping up your work. Call conclude with a ' +
      'summary of what you accomplished, what didn\'t work, and what\'s left to do.',
  )
  assert.equal(
    firmer,
    'IMPORTANT — 120 iterations used. You MUST wrap up now. Call conclude with what you accomplished and ' +
      'what remains.',
  )
  assert.equal(
    strongest,
    'IMPORTANT — 140 iterations used, approaching the hard limit. Finish IMMEDIATELY. Call conclude with your ' +
      'final status — what was done, what failed, and what\'s left.',
  )
})
