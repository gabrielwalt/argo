// TASK-START READ-ONLY-IN-EFFECT CHECKPOINT — frames.ts half. dispatch.ts's
// runDispatcherTaskStart spawns its classification frame with TASK_START_TOOLS,
// a separate array from ROLE_TOOLS.dispatcher (even though the two are currently
// identical in content) — these tests pin the composition of both so a future edit
// can't silently reintroduce a write tool (write_file/edit_file) into
// classification. `bash` is present in both (2026 review, reversing an earlier
// removal) — it CAN write, but classification stays read-only in EFFECT via the
// checkpoint's own prompt framing plus agent.ts patching this role's `bash`
// description to the read-only variant (frames.ts's patchBashForReadOnly), not via
// omitting the tool. No Ollama, no ledger, no fs — plain array membership checks.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ROLE_TOOLS,
  TASK_START_TOOLS,
  ROLE_IDENTITY,
  ROLE_INSTRUCTIONS,
  ROLE_MAX_ITERATIONS,
  PROGRESS_CHECK_ITERATIONS,
  PROGRESS_CHECK_MESSAGES,
  patchBashForReadOnly,
} from './frames.js'

test('TASK_START_TOOLS keeps bash for investigation, but excludes direct write tools', () => {
  // bash is included so the Dispatcher can grep, cat, ls, run tests to understand
  // behaviour. write_file/edit_file are excluded — the prompt's read-only framing
  // (plus the read-only bash description patch, see patchBashForReadOnly tests
  // below) is the guard, not the absence of bash itself.
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
  // Read-only by construction: messages/expand are the only actions the ledger
  // TOOL accepts (tools/index.ts) — the harness's own ledger.recordMessage calls
  // are separate direct calls from agent.ts's pushCtx, never reachable through
  // this tool. Keeping it is what lets the read-only checkpoint still "look up
  // prior work instead of assuming."
  assert.equal(TASK_START_TOOLS.includes('ledger'), true)
})

test('TASK_START_TOOLS is bash + read-only tools plus conclude', () => {
  assert.deepEqual([...TASK_START_TOOLS].sort(), ['bash', 'conclude', 'fetch_url', 'ledger', 'read_file', 'web_search'])
})

test('ROLE_TOOLS.dispatcher has bash (investigation only) and no write_file — the Dispatcher never implements anything', () => {
  // 2026 review: bash is back in ROLE_TOOLS.dispatcher's own default contents
  // (reversing an earlier removal) — the Dispatcher still never writes/edits
  // (write_file/edit_file absent), and its own prompt plus the read-only bash
  // description patch (patchBashForReadOnly) keep bash to investigation in effect.
  assert.equal(ROLE_TOOLS.dispatcher.includes('bash'), true)
  assert.equal(ROLE_TOOLS.dispatcher.includes('write_file'), false)
})

test('ROLE_TOOLS.planner has bash (investigation only) and no write_file/edit_file', () => {
  assert.equal(ROLE_TOOLS.planner.includes('bash'), true)
  assert.equal(ROLE_TOOLS.planner.includes('write_file'), false)
  assert.equal(ROLE_TOOLS.planner.includes('edit_file'), false)
})

// ── patchBashForReadOnly — the read-only-role bash description patch ───────────────

test('patchBashForReadOnly replaces only the bash tool\'s description, leaving every other tool untouched', () => {
  const tools = [
    { type: 'function' as const, function: { name: 'bash', description: 'read-write description', parameters: {} } },
    { type: 'function' as const, function: { name: 'read_file', description: 'unrelated', parameters: {} } },
  ]
  const patched = patchBashForReadOnly(tools, 'read-only description')
  assert.equal(patched.find(t => t.function.name === 'bash')!.function.description, 'read-only description')
  assert.equal(patched.find(t => t.function.name === 'read_file')!.function.description, 'unrelated')
})

test('patchBashForReadOnly is a no-op (same content) when there is no bash tool in the array', () => {
  const tools = [{ type: 'function' as const, function: { name: 'read_file', description: 'unrelated', parameters: {} } }]
  const patched = patchBashForReadOnly(tools, 'read-only description')
  assert.deepEqual(patched, tools)
})

// ── Planner prompts: ROLE_IDENTITY (message 1, [system]) + ROLE_INSTRUCTIONS
// (message 3, [system]) replace the old single-block systemPromptFor. Lean and
// role-specific: no tool descriptions (Ollama's own `tools` parameter already
// shows those), no filesystem/environment/memory/git mentions. The `conclude`-
// based ITERATIVE design — no TASK:/TEST:/DONE line convention, no separate
// "re-planning round" request (adaptation is just what happens on the next detail
// call). The Planner is called once for an overall plan (an ordered list of
// sub-tasks, its `conclude` answer), then resumed repeatedly to produce one fully
// self-contained Implementer assignment at a time, also delivered via `conclude`.

test('planner identity: one sentence, names the role and the two-part job (decompose + produce assignments)', () => {
  const text = ROLE_IDENTITY.planner
  assert.ok(/PLANNER/.test(text))
  assert.ok(text.includes('decompose'))
  assert.ok(text.includes('assignments'))
})

test('planner instructions: describes the two-phase flow — overall plan first, then resumed to produce one assignment at a time', () => {
  const text = ROLE_INSTRUCTIONS.planner
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

test('planner instructions: mentions conclude as the way it delivers both the plan and each assignment', () => {
  const text = ROLE_INSTRUCTIONS.planner
  assert.ok(text.includes('`conclude`'))
})

test('planner instructions: does not mention a Tester (there is none)', () => {
  const text = ROLE_INSTRUCTIONS.planner
  assert.equal(/\bTester\b/.test(text), false)
})

test('planner instructions: still states it never writes or edits (matches the assignment prompt\'s READ-ONLY statement)', () => {
  const text = ROLE_INSTRUCTIONS.planner
  assert.ok(text.includes('never write or edit anything'))
})

// ── Planner read-only framing — the Planner's tool list has bash (investigation
// only, see above) but no write_file/edit_file, and its own instructions say so
// explicitly. Mirrors the Dispatcher task-start checkpoint's own explicit
// "READ-ONLY" framing.

test('planner instructions: explicitly states it is READ-ONLY', () => {
  const text = ROLE_INSTRUCTIONS.planner
  assert.ok(/READ-ONLY/.test(text))
})

// ── Lean prompts: no tool descriptions, filesystem, environment, memory, or git
// mentions in either message — those lived in agent.ts's old buildSystemPrompt/
// loadProjectContext (both removed) and were never role-specific; Ollama's own
// `tools` parameter already shows the model its tools.

test('role prompts (identity + instructions) never mention tool descriptions, filesystem paths, or AGENTS.md/MEMORY.md', () => {
  for (const role of ['dispatcher', 'planner', 'implementer'] as const) {
    const text = `${ROLE_IDENTITY[role]}\n${ROLE_INSTRUCTIONS[role]}`
    assert.equal(/\/workspace/.test(text), false, `${role}: no /workspace mention`)
    assert.equal(/AGENTS\.md/.test(text), false, `${role}: no AGENTS.md mention`)
    assert.equal(/MEMORY\.md/.test(text), false, `${role}: no MEMORY.md mention`)
    assert.equal(/git/i.test(text), false, `${role}: no git/autocommit mention`)
    assert.equal(/Ubuntu/.test(text), false, `${role}: no environment mention`)
  }
})

// ── update_plan does not exist as a tool at all any more — the plan/act gate and
// the update_plan tool were removed along with harness task sequencing.

test('no role in ROLE_TOOLS holds update_plan — the tool does not exist any more', () => {
  for (const role of ['planner', 'implementer', 'dispatcher'] as const) {
    assert.equal(ROLE_TOOLS[role].includes('update_plan' as never), false, `${role} must not have update_plan`)
  }
})

// ── conclude: every role gets it — "no tool call = done" is gone, so every agent
// needs an explicit way to finish.

test('every role in ROLE_TOOLS holds conclude', () => {
  for (const role of ['planner', 'implementer', 'dispatcher'] as const) {
    assert.equal(ROLE_TOOLS[role].includes('conclude'), true, `${role} must have conclude`)
  }
})

test('TASK_START_TOOLS (the read-only-in-effect classification checkpoint) also holds conclude', () => {
  // Without it the checkpoint could investigate forever but never actually
  // classify — a turn with no tool calls no longer ends anything either.
  assert.equal(TASK_START_TOOLS.includes('conclude'), true)
})

// ── ITERATION LIMITS AND PROGRESS NUDGES ────────────────────────────────────────────

test('ROLE_MAX_ITERATIONS: planner=40, implementer=160, dispatcher=15', () => {
  assert.equal(ROLE_MAX_ITERATIONS.planner, 40)
  assert.equal(ROLE_MAX_ITERATIONS.implementer, 160)
  assert.equal(ROLE_MAX_ITERATIONS.dispatcher, 15)
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

test('PROGRESS_CHECK_ITERATIONS: no entry for dispatcher — it keeps the generic fraction-based mechanism', () => {
  assert.equal(PROGRESS_CHECK_ITERATIONS.dispatcher, undefined)
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
