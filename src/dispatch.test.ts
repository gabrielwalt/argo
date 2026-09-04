// TASK-START READ-ONLY CHECKPOINT (2026-09-05) — dispatch.ts half. No Ollama, no
// ledger, no git, no fs: buildTaskStartAssignment is a pure function extracted
// specifically so this prompt/routing change is testable without spawning a real
// frame (spawnFrame/runBossTaskStart themselves still can't be, for the same reason
// noted throughout this file: they write a ledger entry and run a real model turn).
//
// PLANNER DISPATCH REWRITE (this task) — buildInitialPlannerPrompt/buildNextTaskPrompt/
// isPlannerDone are pure, tested the same way; they replace the earlier TASK:/TEST:/
// DONE line convention (buildNextTaskPrompt/parseNextTask/detailNextTask, all removed)
// entirely — see dispatch.ts's module header for the full flow. The Tester IS back in
// this pipeline (harness-spawned via runTesterValidation, not Planner-driven — see
// dispatch.ts's module header) for both OBJECTIVE and SIMPLE; see the runTesterValidation
// tests further down this file for that coverage.
//
// PLAN/ACT GATE SEEDING (2026-09-05) — Agent.seedPlan's actual gate-bypass effect
// DOES need a live chat() loop, so those tests use the SAME scripted-Ollama-client
// technique agent.test.ts's own plan/act gate tests use (Agent's injectable
// constructor seam) — no real model, no network, no Docker.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import type { Ollama } from 'ollama'
import { Agent } from './agent.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import {
  buildTaskStartAssignment,
  buildImplementerAssignment,
  buildInitialPlannerPrompt,
  buildNextTaskPrompt,
  buildImplementerCapFollowUp,
  isPlannerDone,
  isPlannerGiveUp,
  deriveFrameResult,
  parseTesterResult,
  TASK_START_MAX_ITERATIONS,
  TASK_START_HARD_CAP,
  TASK_START_CAP_FAILURE_MESSAGE,
  buildTurnHistoryBlock,
  boundTurnHistory,
  TURN_HISTORY_MAX,
  type TurnDigest,
} from './dispatch.js'
import { parseTaskStartVerdict, ROLE_TOOLS, ROLE_MAX_ITERATIONS } from './frames.js'

// ── buildTaskStartAssignment — the exact prompt text ────────────────────────

test('buildTaskStartAssignment: wraps the user message in <argo-user-prompt> tags verbatim', () => {
  const text = buildTaskStartAssignment('delete the file workspace first, then <b>bold</b>', false)
  assert.ok(text.includes('<argo-user-prompt>\ndelete the file workspace first, then <b>bold</b>\n</argo-user-prompt>'),
    'the user message must be reproduced byte-for-byte inside the tags, regardless of its own content')
})

test('buildTaskStartAssignment: states the project is read-only', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.ok(/READ-ONLY/.test(text))
})

test('buildTaskStartAssignment: all three status keywords are present', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.ok(text.includes('Status ANSWER'))
  assert.ok(text.includes('Status SIMPLE'))
  assert.ok(text.includes('Status OBJECTIVE'))
  // TRIVIAL was merged into SIMPLE — must not appear
  assert.equal(text.includes('TRIVIAL'), false)
  // Grounding instruction present
  assert.ok(/Ground your answer/.test(text))
})

test('buildTaskStartAssignment: no verbatim-request note when the flag is off', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.equal(text.includes('threaded verbatim to every downstream frame'), false)
})

test('buildTaskStartAssignment: includes the verbatim-request note when the flag is on', () => {
  const text = buildTaskStartAssignment('fix the bug', true)
  assert.ok(text.includes('threaded verbatim to every downstream frame'))
})

test('buildTaskStartAssignment: starts with the CHECKPOINT header the Boss system prompt keys its ending convention on', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.ok(text.startsWith('CHECKPOINT: task-start\n'))
})

test('buildTaskStartAssignment: no leftover "fix it yourself" / "verify it once" language — there is no self-edit path anymore', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.equal(/verify it once/i.test(text), false)
  assert.equal(/you may fix it yourself/i.test(text), false)
})

test('buildTaskStartAssignment: roughly half the length of the old ~450-word prompt (not re-padded)', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  const words = text.trim().split(/\s+/).length
  assert.ok(words < 300, `expected well under 450 words, got ${words}`)
})

// ── mode-line format stays compatible with frames.ts's parser ──────────────
// The prompt instructs a format; the parser (frames.ts, unchanged by this task)
// reads it back. Nothing previously asserted the two actually agree — a rewritten
// prompt drifting from what parseTaskStartVerdict expects would fail silently
// (parsed: false, falls back to 'objective') rather than as a loud test failure.

test('a reply following the prompt\'s ANSWER format parses as answer', () => {
  const verdict = parseTaskStartVerdict('The current version is 4.2.\nANSWER: 4.2')
  assert.deepEqual(verdict, { mode: 'answer', text: '4.2', parsed: true })
})

test('TRIVIAL is no longer recognized — falls through to objective (merged into SIMPLE)', () => {
  const verdict = parseTaskStartVerdict('TRIVIAL: fix the typo in README.md line 3')
  assert.equal(verdict.mode, 'objective')
  assert.equal(verdict.parsed, false)
})

test('a reply following the prompt\'s SIMPLE format parses as simple', () => {
  const verdict = parseTaskStartVerdict('SIMPLE: fix the off-by-one in paginate()')
  assert.equal(verdict.mode, 'simple')
  assert.equal(verdict.parsed, true)
})

test('a reply following the prompt\'s OBJECTIVE format parses as objective', () => {
  const verdict = parseTaskStartVerdict('OBJECTIVE: add pagination across three endpoints')
  assert.equal(verdict.mode, 'objective')
  assert.equal(verdict.parsed, true)
})

// ── Boss classification: soft budget 10, hard cap 20 (2026-09) ─────────────
// The prompt still STATES 10 iterations (buildTaskStartAssignment already asserts
// this above); the actual enforced cap given to spawnFrame is a separate, larger
// constant so a classification a few turns over its stated budget still gets to
// conclude instead of being force-ended exactly on the model's own deadline.

test('TASK_START_HARD_CAP is strictly greater than the prompt\'s stated TASK_START_MAX_ITERATIONS', () => {
  assert.equal(TASK_START_MAX_ITERATIONS, 10)
  assert.equal(TASK_START_HARD_CAP, 20)
  assert.ok(TASK_START_HARD_CAP > TASK_START_MAX_ITERATIONS)
})

test('the prompt itself still states the soft budget (10), not the hard cap (20)', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.ok(text.includes(`hard budget of ${TASK_START_MAX_ITERATIONS} iterations`))
  // Note: the OBJECTIVE mode's own "more than 20 iterations" threshold is unrelated
  // prose that happens to share TASK_START_HARD_CAP's value — checking the specific
  // "hard budget of 20" phrase (not a bare "20 iterations" substring) avoids a false
  // positive against that unrelated line.
  assert.equal(text.includes(`hard budget of ${TASK_START_HARD_CAP} iterations`), false)
})

test('TASK_START_CAP_FAILURE_MESSAGE is a plain user-facing failure, not the raw agent.ts cap-hit string', () => {
  assert.equal(/^Could not classify/.test(TASK_START_CAP_FAILURE_MESSAGE), true)
  assert.equal(/Reached maximum iterations/.test(TASK_START_CAP_FAILURE_MESSAGE), false)
})

// ── buildImplementerAssignment — TRIVIAL/SIMPLE fast path, unchanged shape ─────

test('buildImplementerAssignment: wraps the objective in <argo-objective> tags, framed as "implement"', () => {
  const text = buildImplementerAssignment('fix the off-by-one in nextId()')
  assert.ok(text.startsWith('CHECKPOINT: iteration-1\n'))
  assert.ok(text.includes('Your task is to implement the following objective:'))
  assert.ok(text.includes('<argo-objective>\nfix the off-by-one in nextId()\n</argo-objective>'))
})

// ── buildInitialPlannerPrompt — VERBATIM per this task's brief ─────────────────

test('buildInitialPlannerPrompt: contains the objective, PLAN status, and READ-ONLY instruction', () => {
  const text = buildInitialPlannerPrompt('add pagination across three endpoints')
  assert.ok(text.includes('<argo-objective>\nadd pagination across three endpoints\n</argo-objective>'))
  assert.ok(text.includes('status PLAN'))
  assert.ok(text.includes('READ-ONLY'))
  assert.ok(text.includes('20 iterations'))
})

// ── buildNextTaskPrompt — VERBATIM per this task's brief, two shapes ───────────

test('buildNextTaskPrompt(null): contains the three status keywords and self-contained instruction', () => {
  const text = buildNextTaskPrompt(null, 1)
  assert.ok(text.startsWith('CHECKPOINT: task-1\n'))
  assert.ok(text.includes('According to your plan'))
  assert.ok(text.includes('IMPLEMENT'))
  assert.ok(text.includes('SUCCESS'))
  assert.ok(text.includes('FAIL'))
  assert.ok(text.includes('fully self-contained'))
  assert.ok(text.includes('20 iterations'))
})

test('buildNextTaskPrompt(message): contains the completed message tag and three status keywords', () => {
  const text = buildNextTaskPrompt('Added the --count flag; all existing tests pass.', 2)
  assert.ok(text.startsWith('CHECKPOINT: task-2\n'))
  assert.ok(text.includes('<argo-implemented>\nAdded the --count flag; all existing tests pass.\n</argo-implemented>'))
  assert.ok(text.includes('IMPLEMENT'))
  assert.ok(text.includes('SUCCESS'))
  assert.ok(text.includes('FAIL'))
  assert.ok(text.includes('20 iterations'))
})

test('buildNextTaskPrompt: null vs a completed message select genuinely different prompts, not just a filled-in blank', () => {
  const first = buildNextTaskPrompt(null, 1)
  const later = buildNextTaskPrompt('done', 2)
  assert.notEqual(first, later)
  assert.ok(first.includes('According to your plan'))
  assert.ok(later.includes('The previous implementation agent concluded with:'))
})

// ── isPlannerDone — the natural-language completion heuristic ─────────────────
// No TASK:/TEST:/DONE marker any more: the Planner's `conclude` answer is read
// straight through. isPlannerDone is the ONLY signal the dispatch loop uses to
// stop asking for more tasks, so it is tested against both the phrasings the
// prompt itself invites ("conclude that the objective is complete") and a set of
// realistic self-contained assignments that must NOT be mistaken for completion.

test('isPlannerDone: recognizes the phrasing the prompt itself asks for', () => {
  assert.equal(isPlannerDone('The objective is complete.'), true)
  assert.equal(isPlannerDone('The objective is now complete — all endpoints support pagination.'), true)
})

test('isPlannerDone: recognizes common completion phrasings', () => {
  assert.equal(isPlannerDone('No further implementation is needed.'), true)
  assert.equal(isPlannerDone('All planned work is done; the feature is fully implemented and tested.'), true)
  assert.equal(isPlannerDone('Nothing more needs to be done — every sub-task from the plan has been completed.'), true)
  assert.equal(isPlannerDone('The implementation fully addresses the original objective.'), true)
})

test('isPlannerDone: a real, concrete self-contained assignment is NOT mistaken for completion', () => {
  const assignment =
    'Implement input validation in src/parseArgs.ts: reject a negative --count value with a clear error ' +
    'message instead of silently accepting it. The CLI currently accepts any integer, including negatives, ' +
    'which then causes an out-of-bounds slice further down the pipeline. Add a check right after parsing ' +
    'and cover it with a unit test in src/parseArgs.test.ts. Do not change any other flag handling.'
  assert.equal(isPlannerDone(assignment), false)
})

test('isPlannerDone: a short but genuinely actionable reply is not mistaken for completion (contains an implementation verb)', () => {
  assert.equal(isPlannerDone('Fix the typo on line 12 of README.md.'), false)
})

test('isPlannerDone: a short reply with no implementation verb reads as a wrap-up, not an assignment', () => {
  assert.equal(isPlannerDone('Looks good, nothing else to do here.'), true)
})

test('isPlannerDone: empty or blank text is never treated as done (conclude itself rejects an empty answer)', () => {
  assert.equal(isPlannerDone(''), false)
  assert.equal(isPlannerDone('   '), false)
})

// ── Agent.seedPlan — the plan/act gate is bypassed for a SEEDED frame, unchanged for
// everyone else. Scripted-Ollama-client style, matching agent.test.ts's own plan/act
// gate tests exactly (Agent's injectable constructor seam) — no live model.

type ScriptedResponse = {
  message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
}

function scriptedOllama(responses: ScriptedResponse[]): Ollama {
  let i = 0
  return { chat: async () => responses[Math.min(i++, responses.length - 1)] } as unknown as Ollama
}

// Targets a NONEXISTENT file — the point is whether the call reaches the tool at
// all (gate-blocked vs. attempted), not whether the edit itself succeeds on disk;
// agent.test.ts's own plan/act gate fixture uses the identical shape for the same
// reason.
const editCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: { path: '/workspace/nonexistent-argo-seedplan-gate.txt', old_string: 'a', new_string: 'b' } } }] },
}
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }

async function cleanupSeedPlanSession(sessionId: string): Promise<void> {
  await Promise.all([
    fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {}),
    fs.unlink(`${LOGS_DIR}/compaction-${sessionId}.json`).catch(() => {}),
  ])
}

test('seedPlan: a FIRST-turn edit_file call is not gate-blocked once the plan is seeded', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-seedplan-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([editCall, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.seedPlan('Change the file')
  try {
    const answer = await agent.chat('argo seed-plan case')
    // No plan-gate steer at all — the seeded plan means the model's FIRST tool call
    // reaches the tool directly, never forced through update_plan first.
    assert.equal(events.some(e => e.type === 'plan'), false, 'seedPlan must not itself emit a plan event')
    assert.equal(events.filter(e => e.type === 'tool_result' && e.tool === 'edit_file' && e.rejected).length, 0)
    assert.equal(events.filter(e => e.type === 'tool_result' && e.tool === 'edit_file' && !e.rejected).length, 1)
    assert.equal(answer, 'Final answer.')
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('seedPlan: WITHOUT it, the identical first-turn edit_file is still gate-blocked (the gate itself is unchanged)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-seedplan-baseline-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([editCall, finalAnswer]))
  agent.setSessionId(sessionId)
  // No seedPlan call — confirms seeding is opt-in and the underlying gate
  // (isProjectMutation && !this.currentPlan, agent.ts) was NOT weakened or made
  // conditional by adding seedPlan.
  try {
    await agent.chat('argo seed-plan baseline case')
    assert.equal(events.filter(e => e.type === 'tool_result' && e.tool === 'edit_file' && e.rejected).length, 1)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── update_plan: trace visibility + no-op suppression (2026-09-05) ─────────
// agent.test.ts already covers the plan/act gate end to end and isn't on this task's
// write list — these two fixes are tested here instead, via the same
// scripted-Ollama-client technique. this.tasks is turned off on every Agent below
// (setTasks(false)) to isolate what's under test: the harness task-ledger's own
// per-task verify/summary flow is orthogonal to update_plan's own event emission
// and no-op detection, and is already covered by agent.test.ts's own task-ledger
// tests — entangling it here would only make these tests slower and less targeted.

function updatePlanCall(objective: string, steps: string[]): ScriptedResponse {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'update_plan', arguments: { objective, steps } } }],
    },
  }
}

function toolResultOutputs(events: AgentEvent[], tool: string): string[] {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === tool)
    .map(e => e.output)
}

test('update_plan emits tool_call/tool_result like every other tool (previously invisible in the trace)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-update-plan-visibility-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    updatePlanCall('Fix the bug', ['read the file', 'apply the fix']),
    finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(false)
  try {
    await agent.chat('argo update-plan visibility case')
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'update_plan').length, 1)
    const outputs = toolResultOutputs(events, 'update_plan')
    assert.equal(outputs.length, 1)
    assert.ok(outputs[0].includes('Plan recorded'))
    // The harness-level 'plan' event (the UI's plan card) still fires too — this
    // fix is additive, not a replacement for it.
    assert.equal(events.some(e => e.type === 'plan'), true)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('update_plan: a byte-identical second call is a no-op — no revision bump, no plan event', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-update-plan-noop-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    updatePlanCall('Fix the bug', ['read the file', 'apply the fix']),
    updatePlanCall('Fix the bug', ['read the file', 'apply the fix']),
    finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(false)
  try {
    await agent.chat('argo update-plan noop case')
    // The model DID call update_plan twice — both get their own tool_call/tool_result.
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'update_plan').length, 2)
    const outputs = toolResultOutputs(events, 'update_plan')
    assert.equal(outputs.length, 2)
    assert.ok(outputs[0].includes('Plan recorded'))
    assert.ok(outputs[1].includes('Plan unchanged'))
    // Exactly ONE 'plan' event — the second, identical call must not produce another.
    assert.equal(events.filter(e => e.type === 'plan').length, 1)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('update_plan: whitespace-only differences still count as a no-op (normalised comparison)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-update-plan-noop-ws-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    updatePlanCall('Fix   the bug', ['read the file', 'apply the fix']),
    updatePlanCall('  Fix the bug  ', ['read   the file', '  apply the fix']),
    finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(false)
  try {
    await agent.chat('argo update-plan whitespace noop case')
    assert.equal(events.filter(e => e.type === 'plan').length, 1)
    const outputs = toolResultOutputs(events, 'update_plan')
    assert.ok(outputs[1].includes('Plan unchanged'))
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('update_plan: a genuinely different plan is NOT suppressed — not a fuzzy/prefix match', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-update-plan-real-change-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    updatePlanCall('Fix the bug', ['read the file', 'apply the fix']),
    updatePlanCall('Fix the bug', ['read the file', 'apply the fix', 'run the tests']),
    finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(false)
  try {
    await agent.chat('argo update-plan real change case')
    // A real change (one more step) — TWO plan events, revision actually bumped.
    assert.equal(events.filter(e => e.type === 'plan').length, 2)
    const outputs = toolResultOutputs(events, 'update_plan')
    assert.ok(outputs[1].includes('Plan updated (revision 2)'))
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── update_plan removed as a callable tool for multi-agent roles (2026-09-05) ──
// frames.ts's ROLE_TOOLS.implementer no longer lists update_plan (frames.test.ts
// covers the table itself); this covers the RUNTIME consequence — a role-scoped
// Agent (setAllowedTools without update_plan) must never reach the harness plan
// handler for it, even for a hallucinated call the model was never offered. Before
// this fix, the `if (name === 'update_plan')` intercept ran BEFORE the role-
// availability gate, so ANY role could silently mutate the plan through a call it
// was never given — a latent bug this change also closes, not just the removal.

test('update_plan: a role-scoped Agent without it gets the STANDARD role rejection, never the harness plan handler', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-update-plan-role-gate-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    updatePlanCall('Fix the bug', ['read the file']),
    finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  // Mirrors the real post-2026-09-05 Implementer role tool set (no update_plan).
  agent.setAllowedTools(['read_file', 'write_file', 'edit_file', 'bash'])
  // seedPlan so this test isolates the ROLE gate specifically — without it, the
  // (unrelated) plan/act gate's own rejection could otherwise mask which gate fired.
  agent.seedPlan('Fix the bug')
  try {
    await agent.chat('argo update-plan role-gate case')
    // Never reached handleUpdatePlan — no 'plan' event, no "Plan recorded" output.
    assert.equal(events.some(e => e.type === 'plan'), false)
    const results = toolResultOutputsWithMeta(events, 'update_plan')
    assert.equal(results.length, 1)
    assert.equal(results[0].rejected, true)
    assert.match(results[0].error ?? '', /not available in this role/)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

function toolResultOutputsWithMeta(events: AgentEvent[], tool: string): Array<{ output: string; error?: string; rejected?: boolean }> {
  return events
    .filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === tool)
    .map(e => ({ output: e.output, error: e.error, rejected: e.rejected }))
}

// ── System prompt: explains the no-tool-call-ends-the-session convention (2026-09-05) ──
// buildSystemPrompt itself is not exported (module-private in agent.ts), so this
// captures the ACTUAL system message sent to the model via a scripted client —
// direct proof of what reaches Ollama, not just of a string constant in isolation.

// SUPERSEDED (2026-09-06): the owner replaced the "no tool call = done" convention
// with an explicit `conclude` tool (see the "conclude" section below) — the text
// this test checked for is gone from the system prompt, and the mock it used (a
// single bare no-tool-call reply, repeated forever by a real Ollama client) would
// now describe a thinking turn that never ends, not a same-iteration final answer.
// Rewritten to match: captures the same system message, but via a `conclude` call
// so the run actually finishes, and checks the NEW terminal-condition text.
test('system prompt: explains that calling conclude ends the session', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-system-prompt-eot-${Date.now()}`
  let capturedFirstMessage = ''
  const ollama = {
    chat: async (args: { messages: Array<{ role: string; content: string }> }) => {
      // System prompt is now prepended to the first user message in <argo-system-prompt>
      // tags, not sent as a separate system role message.
      capturedFirstMessage = args.messages[0]?.content ?? ''
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }
    },
  } as unknown as Ollama
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo system prompt end-of-turn case')
    assert.equal(answer, 'Final answer.')
    // System prompt is prepended to the first user message (no wrapper tags).
    assert.ok(capturedFirstMessage.includes('You are Argo, a multi-agent system'), 'first message should contain the system prompt')
    assert.ok(capturedFirstMessage.includes(
      'To finish, call `conclude` with the appropriate status keyword and your message to end your session.',
    ))
    assert.ok(capturedFirstMessage.includes(
      'conclude(status, message): end your session with a status keyword and a message.',
    ))
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── system prompt: describes ONLY the tools this role actually has (2026-09-06) ──
// buildSystemPrompt (agent.ts) used to send every role the SAME tool list regardless
// of Agent.setAllowedTools — the Planner's own prompt taught it about bash, write_file,
// edit_file, and browser_fetch, none of which it holds (frames.ts's ROLE_TOOLS.planner),
// and a real session had it try bash anyway. Proven here via ROLE_TOOLS.planner's own
// restricted set (read_file, web_search, fetch_url, ledger, conclude) — the SAME
// scripted-client technique as the test above, direct proof of what reaches the model.

test('system prompt: a role-restricted frame (Planner\'s tool set) is not told about tools it does not have', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-system-prompt-role-gate-${Date.now()}`
  let capturedSystemPrompt = ''
  const ollama = {
    chat: async (args: { messages: Array<{ role: string; content: string }> }) => {
      capturedSystemPrompt = args.messages[0]?.content ?? ''
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }
    },
  } as unknown as Ollama
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setAllowedTools(['read_file', 'web_search', 'fetch_url', 'ledger', 'conclude']) // ROLE_TOOLS.planner
  try {
    await agent.chat('argo role-gated system prompt case')
    assert.equal(capturedSystemPrompt.includes('- bash:'), false)
    assert.equal(capturedSystemPrompt.includes('- write_file:'), false)
    assert.equal(capturedSystemPrompt.includes('- edit_file:'), false)
    assert.equal(capturedSystemPrompt.includes('- browser_fetch:'), false)
    // What it DOES have is still described.
    assert.ok(capturedSystemPrompt.includes('- read_file:'))
    assert.ok(capturedSystemPrompt.includes('- web_search:'))
    assert.ok(capturedSystemPrompt.includes('- fetch_url:'))
    // The explicit read-only note is present since it has neither write_file nor edit_file.
    assert.ok(capturedSystemPrompt.includes('You have no file-modification tools in this role'))
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('system prompt: an unrestricted frame (allowedTools null, the baseline) still sees every tool', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-system-prompt-baseline-tools-${Date.now()}`
  let capturedSystemPrompt = ''
  const ollama = {
    chat: async (args: { messages: Array<{ role: string; content: string }> }) => {
      capturedSystemPrompt = args.messages[0]?.content ?? ''
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }
    },
  } as unknown as Ollama
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  try {
    await agent.chat('argo baseline system prompt case')
    for (const bullet of ['- bash:', '- read_file:', '- write_file:', '- edit_file:', '- fetch_url:', '- browser_fetch:', '- web_search:']) {
      assert.ok(capturedSystemPrompt.includes(bullet), `expected baseline prompt to include "${bullet}"`)
    }
    assert.equal(capturedSystemPrompt.includes('You have no file-modification tools in this role'), false)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── conclude: the only terminal condition now (2026-09-06) ─────────────────
// Replaces "no tool call = done". A thinking turn (no tool calls) pushes the
// model's text to context and nudges it, but never ends the run; only calling
// `conclude` does, and every gate that used to fire on the old terminal condition
// (task-ledger verify/summary/advance, final reconciliation, critic, grounding,
// layout, re-ground) now fires inside the `conclude` handler instead.

function concludeCall(answer: string, status = 'SUCCESS'): ScriptedResponse {
  return {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status, message: answer } } }] },
  }
}

test('a turn with no tool calls is a thinking turn — it does not end the session', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-thinking-turn-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    { message: { role: 'assistant', content: 'Let me think about this for a moment.' } },
    concludeCall('Done thinking — here is my answer.'),
  ]))
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo thinking turn case')
    // The run only ended once conclude was actually called, not on the earlier
    // thinking turn.
    assert.equal(answer, 'Done thinking — here is my answer.')
    assert.equal(events.some(e => e.type === 'done'), true)
    // The thinking turn's own text is captured as a thought, not silently dropped.
    assert.equal(events.some(e => e.type === 'thought' && e.content === 'Let me think about this for a moment.'), true)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('conclude({ status, message }) ends the session with the message as the answer', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-conclude-basic-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    concludeCall('The bug is fixed.'),
  ]))
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo conclude basic case')
    assert.equal(answer, 'The bug is fixed.')
    assert.equal(events.some(e => e.type === 'done' && e.content === 'The bug is fixed.'), true)
    assert.equal(events.some(e => e.type === 'message' && e.role === 'assistant' && e.content === 'The bug is fixed.'), true)
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'conclude').length, 1)
    assert.equal(events.filter(e => e.type === 'tool_result' && e.tool === 'conclude' && !e.rejected).length, 1)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('conclude with an empty message is rejected (validation, not a gate) and does not end the run', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-conclude-empty-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    concludeCall(''),
    concludeCall('Real answer this time.'),
  ]))
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo conclude empty case')
    assert.equal(answer, 'Real answer this time.')
    const results = toolResultOutputsWithMeta(events, 'conclude')
    assert.equal(results.length, 2)
    assert.match(results[0].error ?? '', /non-empty "message"/)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('a no-tool-call turn gets the nudge on the 2nd consecutive thinking turn, not the 1st', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-thinking-nudge-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    { message: { role: 'assistant', content: 'thinking...' } },       // 1st no-tool-call: silent
    { message: { role: 'assistant', content: 'still thinking...' } }, // 2nd consecutive: nudge
    concludeCall('done'),
  ]))
  agent.setSessionId(sessionId)
  try {
    await agent.chat('argo nudge case')
    const nudges = events.filter(
      (e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning' && e.message.includes('produced no tool calls'),
    )
    // Only ONE nudge — the 2nd consecutive no-tool-call turn, not the 1st
    assert.equal(nudges.length, 1)
    assert.equal(
      nudges[0].message,
      'Your turn produced no tool calls. To finish, call conclude with your final answer. To keep working, make your next tool call.',
    )
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('the iteration cap is still a hard stop when the model never calls conclude', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-cap-thinking-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    { message: { role: 'assistant', content: 'still thinking, never concluding...' } },
  ]))
  agent.setMaxIterations(10) // the setter's own documented floor — smallest legal value
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo cap thinking case')
    assert.match(answer, /Reached maximum iterations \(10\) without a final answer\./)
    assert.equal(agent.getLastRunOutcome(), 'cap')
    // Nudge fires from the 2nd consecutive no-tool-call turn onward (the 1st is
    // silent), so with 10 pure thinking turns: turn 1 silent, turns 2-10 nudged = 9.
    assert.equal(events.filter(e => e.type === 'warning' && e.message.includes('produced no tool calls')).length, 9)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('conclude drives the task ledger exactly like a no-tool-call turn used to: ask for a summary, then advance, then pass reconciliation', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-conclude-tasks-${Date.now()}`
  const summaryText = 'Built widget.ts and wired it in; demo renders correctly.'
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    updatePlanCall('Ship the widget', ['Build the widget']),
    concludeCall('Working on it now.'),
    concludeCall(summaryText),
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    // scriptedOllama repeats the LAST response (concludeCall(summaryText)) for as
    // many further iterations as the moved gates need — final reconciliation needs
    // one more turn before the run can genuinely conclude. Re-ground done-gate was
    // removed (2026-09-04, owner directive).
    const answer = await agent.chat('argo conclude tasks case')
    const results = toolResultOutputsWithMeta(events, 'conclude')
    // The ask fired once, for the current task, before any advance.
    assert.equal(results.filter(r => r.output.includes('CURRENT TASK "Build the widget"')).length, 1)
    const advanced = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tasks' }> => e.type === 'tasks' && e.action === 'advanced',
    )
    assert.equal(advanced.length, 1)
    assert.equal(advanced[0].done, 1)
    // Final reconciliation (moved into the conclude handler, one-shot) fired
    // exactly once before the run genuinely concluded.
    assert.equal(results.filter(r => r.output.includes('ALL PLANNED TASKS ARE DONE')).length, 1)
    assert.equal(answer, summaryText)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── ITERATION LIMITS AND PROGRESS NUDGES (this task) ────────────────────────────────
// frames.ts's ROLE_MAX_ITERATIONS/PROGRESS_CHECK_ITERATIONS/PROGRESS_CHECK_MESSAGES half;
// agent.ts consumes them once Agent.setRole() has been called (dispatch.ts's spawnFrame
// calls it alongside setAllowedTools/setMaxIterations — see agent.ts's roleTag field).
// Scripted-Ollama-client style, same seam as the seedPlan tests above: a "thinking" reply
// (no tool calls) never ends the run and never trips the identical-tool-call loop guard
// (that guard only watches EXECUTED tool calls), so scriptedOllama's "repeat the last
// response forever" behaviour is exactly what's needed to drive the loop all the way to
// its iteration cap with no other mechanism (task ledger, grounding, loop-recovery)
// getting in the way — none of tasks/memory/grounding/layout are turned on here.

test('ROLE_MAX_ITERATIONS: planner stays 40, implementer raised to 80 (this task)', () => {
  assert.equal(ROLE_MAX_ITERATIONS.planner, 40)
  assert.equal(ROLE_MAX_ITERATIONS.implementer, 80)
})

const thinkingTurn: ScriptedResponse = { message: { role: 'assistant', content: 'Still working on it.' } }

test('Planner role: escalating PROGRESS CHECK nudges fire at 20 and 30 before the iteration cap at 40', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-progress-planner-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([thinkingTurn]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(ROLE_TOOLS.planner)
  agent.setRole('planner')
  agent.setMaxIterations(ROLE_MAX_ITERATIONS.planner)
  try {
    const answer = await agent.chat('argo role-progress planner case')
    const warnings = events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
      .map(e => e.message)
    assert.ok(
      warnings.includes('PROGRESS CHECK: 20 iterations in. Wrap up your analysis and call conclude with your result.'),
    )
    assert.ok(
      warnings.includes('PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.'),
    )
    // The role-specific checkpoint REPLACES the generic mechanism for this frame —
    // none of the generic fraction-based STALL/PROGRESS wording should appear.
    assert.equal(warnings.some(w => w.startsWith('STALL:')), false)
    assert.equal(agent.getLastRunOutcome(), 'cap')
    assert.ok(answer.startsWith('Reached maximum iterations'))
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── Agent.resetIterations() — the Planner's per-resume iteration budget reset ───────
// (owner clarification, this task). The Planner's CONTEXT carries over on resumeFrame
// (same Agent, same history), but the iteration BUDGET must restart at 0 for each
// detail call, unlike resumeFrame's default accumulating behavior (H14, agent.ts) that
// other resume call sites (the Boss task-start marker-retry resume; a future Tester
// REDO) still rely on. resetIterations() is a small, targeted method — it zeroes
// exactly the one field (lastIterationCount) that chat()'s resume branch reads to set
// iterationBase, and only when a caller explicitly asks for it right before the next
// chat(..., { resume: true }) call.
//
// Script: 5 thinking turns + one conclude call, THEN thinkingTurn forever (scriptedOllama
// repeats the LAST array element once its own internal call counter runs past the
// array's length) — so the FIRST chat() call concludes after exactly 6 real iterations,
// and any further chat() call on the same Agent just keeps thinking forever, which is
// what's needed to observe where the iteration counter/checkpoints land on the SECOND
// (resumed) call.
function plannerTwoCallScript(): ScriptedResponse[] {
  return [thinkingTurn, thinkingTurn, thinkingTurn, thinkingTurn, thinkingTurn, concludeCall('First round result.'), thinkingTurn]
}

test('resetIterations(): WITHOUT it, a resumed call inherits the previous call\'s count — reported iteration numbers keep climbing (H14 default, unchanged for other resume sites)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reset-iterations-off-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama(plannerTwoCallScript()))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(ROLE_TOOLS.planner)
  agent.setRole('planner')
  agent.setMaxIterations(ROLE_MAX_ITERATIONS.planner)
  try {
    const firstAnswer = await agent.chat('argo planner initial round')
    assert.equal(firstAnswer, 'First round result.')
    assert.equal(agent.getIterationCount(), 6)
    // Deliberately NO resetIterations() call here — this is the pre-existing
    // accumulating behavior every OTHER resume site still depends on.
    await agent.chat('argo planner next round', { resume: true })
    const iterationEvents = events.filter((e): e is Extract<AgentEvent, { type: 'iteration' }> => e.type === 'iteration')
    // The resumed call's FIRST reported iteration continues from the prior count (6),
    // not from 1 — and its reported max is inflated by the same offset (6 + 40 = 46),
    // not the frame's own 40-iteration budget.
    const secondCallIterations = iterationEvents.slice(6) // the first 6 belong to the first call
    assert.equal(secondCallIterations[0].current, 7)
    assert.equal(secondCallIterations[0].max, 46)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('resetIterations(): called before a resumed Planner detail call, the reported iteration numbers restart at 1 and the checkpoints/cap land at the frame\'s own fresh 20/30/40', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reset-iterations-on-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama(plannerTwoCallScript()))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(ROLE_TOOLS.planner)
  agent.setRole('planner')
  agent.setMaxIterations(ROLE_MAX_ITERATIONS.planner)
  try {
    const firstAnswer = await agent.chat('argo planner initial round')
    assert.equal(firstAnswer, 'First round result.')
    assert.equal(agent.getIterationCount(), 6)
    // dispatch.ts's Planner loop calls this immediately before every resumeFrame —
    // exactly what's under test here.
    agent.resetIterations()
    const answer = await agent.chat('argo planner next round', { resume: true })
    const iterationEvents = events.filter((e): e is Extract<AgentEvent, { type: 'iteration' }> => e.type === 'iteration')
    const secondCallIterations = iterationEvents.slice(6)
    // Fresh budget: the resumed call's FIRST iteration reports 1, not 7 — and its max
    // is the frame's own 40, not 46.
    assert.equal(secondCallIterations[0].current, 1)
    assert.equal(secondCallIterations[0].max, 40)
    const warnings = events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
      .map(e => e.message)
    // The 20/30 progress checks fire at THIS call's own 20th/30th iteration, not
    // offset by the 6 iterations the first call already used.
    assert.ok(
      warnings.includes('PROGRESS CHECK: 20 iterations in. Wrap up your analysis and call conclude with your result.'),
    )
    assert.ok(
      warnings.includes('PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.'),
    )
    // The hard cap hits after exactly 40 MORE iterations, not 34 (40 - 6).
    assert.equal(agent.getLastRunOutcome(), 'cap')
    assert.ok(answer.startsWith('Reached maximum iterations (40)'))
    assert.equal(secondCallIterations.length, 40)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('Implementer role: escalating PROGRESS CHECK nudges fire at 50, 60 and 70 before the iteration cap at 80', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-progress-implementer-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([thinkingTurn]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(ROLE_TOOLS.implementer)
  agent.setRole('implementer')
  agent.setMaxIterations(ROLE_MAX_ITERATIONS.implementer)
  try {
    await agent.chat('argo role-progress implementer case')
    const warnings = events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
      .map(e => e.message)
    assert.ok(warnings.includes(
      'PROGRESS CHECK: 50 iterations in and not finished. Start wrapping up your work. Call conclude with a ' +
        'summary of what you accomplished, what didn\'t work, and what\'s left to do.',
    ))
    assert.ok(warnings.includes(
      'PROGRESS CHECK: 60 iterations in. You must wrap up now. Call conclude with what you accomplished and ' +
        'what remains.',
    ))
    assert.ok(warnings.includes(
      'PROGRESS CHECK: 70 iterations. Finish immediately. Call conclude with your final status — what was ' +
        'done, what failed, and what\'s left.',
    ))
    assert.equal(warnings.some(w => w.startsWith('STALL:')), false)
    assert.equal(agent.getLastRunOutcome(), 'cap')
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// Tester role-specific escalation (owner directive, superseding the earlier flow
// audit finding "Tester has no soft/hard split"). ROLE_MAX_ITERATIONS.tester raised
// 20->40 and PROGRESS_CHECK_ITERATIONS.tester/PROGRESS_CHECK_MESSAGES.tester added at
// [20, 30], mirroring the Planner's own pattern exactly (frames.ts) — buildTesterAssignment
// (dispatch.ts) still states the 20-iteration budget in the prompt itself; that's now
// the SOFT budget, with these two nudges making it a real mid-run steer instead of a
// number the model only reads once, and 40 the actual hard cap.
test('Tester role: escalating PROGRESS CHECK nudges fire at 20 and 30, mirroring the Planner\'s own pattern, before the iteration cap at 40', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-progress-tester-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([thinkingTurn]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(ROLE_TOOLS.tester)
  agent.setRole('tester')
  agent.setMaxIterations(ROLE_MAX_ITERATIONS.tester)
  try {
    const answer = await agent.chat('argo role-progress tester case')
    const warnings = events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
      .map(e => e.message)
    assert.ok(
      warnings.includes('PROGRESS CHECK: 20 iterations in. Wrap up your validation and call conclude with your result.'),
    )
    assert.ok(
      warnings.includes('PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.'),
    )
    // The role-specific checkpoint REPLACES the generic mechanism for this frame —
    // none of the generic fraction-based STALL wording, and no Planner-specific
    // "analysis" wording, should appear.
    assert.equal(warnings.some(w => w.startsWith('STALL:')), false)
    assert.equal(warnings.some(w => w.includes('Wrap up your analysis')), false, 'the Planner-specific wording must not leak into a Tester frame')
    assert.equal(agent.getLastRunOutcome(), 'cap')
    assert.ok(answer.startsWith('Reached maximum iterations (40)'))
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('Boss role keeps the pre-existing generic fraction-based checkpoints untouched (no entry in PROGRESS_CHECK_ITERATIONS)', async () => {
  // Regression guard for the "every other role's 0.4/0.65/0.85 scaling is untouched"
  // claim in agent.ts's stallCheckpoints comment — a Boss frame at its own iteration
  // cap should still see the GENERIC wording, not a role-specific one (there is none
  // defined for 'boss').
  const events: AgentEvent[] = []
  const sessionId = `test-role-progress-boss-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([thinkingTurn]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(ROLE_TOOLS.boss)
  agent.setRole('boss')
  agent.setMaxIterations(ROLE_MAX_ITERATIONS.boss)
  try {
    await agent.chat('argo role-progress boss case')
    const warnings = events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
      .map(e => e.message)
    assert.ok(warnings.some(w => w.startsWith('STALL:') || w.startsWith('PROGRESS CHECK:')))
    assert.equal(warnings.some(w => w.includes('Wrap up your analysis')), false, 'the Planner-specific wording must not leak into a Boss frame')
    assert.equal(warnings.some(w => w.includes('Wrap up your validation')), false, 'the Tester-specific wording must not leak into a Boss frame')
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

// ── buildImplementerCapFollowUp — the message that resumes the Planner instead of
// failing the run when an Implementer frame hits its hard iteration cap ─────────────

test('buildImplementerCapFollowUp: includes the assignment and last status, and asks for a narrower reframed task', () => {
  const text = buildImplementerCapFollowUp('Refactor the entire billing module.', 'Reached maximum iterations (80) without a final answer.')
  assert.ok(text.includes('unable to complete its task within the iteration budget'))
  assert.ok(text.includes('It was working on: Refactor the entire billing module.'))
  assert.ok(text.includes('Its last status: Reached maximum iterations (80) without a final answer.'))
  assert.ok(text.includes('too broad or complex for a single implementation pass'))
  assert.ok(text.includes('Call conclude with the revised assignment'))
  assert.ok(text.includes('conclude that the objective is complete'))
})

test('buildImplementerCapFollowUp: never mentions the generic "concluded with" framing buildNextTaskPrompt uses — this is a distinct message, not a variant', () => {
  const text = buildImplementerCapFollowUp('Some task', 'Some status')
  assert.equal(text.includes('concluded with'), false)
})

// ── UI-CLEAN-END regression guard (2026-09) ─────────────────────────────────
//
// The browser only ever leaves its busy/sailing state on an UNTAGGED (no
// __frameId) 'done' or 'error' event — app.js's handleEvent() early-returns any
// event carrying __frameId straight to the per-frame role-card path, which never
// touches setBusy/setStatus. runDispatchLoop's own try/catch (its 'start' emit
// through every return path) is the ONLY place in this file allowed to emit an
// untagged 'done' or 'error' — every per-frame lifecycle event goes through
// spawnFrame/resumeFrame's emit wrapper (frames.ts), which always tags with
// __frameId before it reaches here. If a future edit ever emits a bare
// { type: 'done' } / { type: 'error' } from inside the Planner/Implementer/Tester
// pipeline (runObjectiveViaPlanner, runTesterValidation, etc.) instead of just
// `return`-ing a string up to runDispatchLoop, the UI would see it as the WHOLE
// run finishing while frames are still in flight — this is the failure mode this
// test exists to catch before it ships again.
test('UI-CLEAN-END: only runDispatchLoop itself emits an untagged done/error event', async () => {
  const source = await fs.readFile(new URL('./dispatch.ts', import.meta.url), 'utf-8')
  // Isolate everything OUTSIDE runDispatchLoop's own body (start...end of function)
  // so its own three legitimate emit sites don't trip this check.
  const fnStart = source.indexOf('export async function runDispatchLoop(')
  assert.ok(fnStart >= 0, 'runDispatchLoop must exist')
  const fnEnd = source.indexOf('\nexport ', fnStart + 1)
  const before = source.slice(0, fnStart)
  const after = fnEnd >= 0 ? source.slice(fnEnd) : ''
  const outsideBody = before + after
  const bareEmit = /emit\(\{\s*type:\s*'(done|error)'/g
  assert.equal(bareEmit.test(outsideBody), false,
    'found an untagged done/error emit outside runDispatchLoop — every other function must ' +
    'return its result string and let runDispatchLoop emit done/error, never emit them itself')
})

// ── isPlannerGiveUp — BUG-2/BUG-3 regressions (this task) ──────────────────────────
// BUG-2: the give-up phrase list used the Unicode right single quote (U+2019) only,
// so the ASCII apostrophe (U+0027) models actually emit for "can't complete" never
// matched. BUG-3: the "give up" alternation covered give/gives/given but not the
// gerund "giving up", a natural phrasing ("I'm giving up on this task.").

test('isPlannerGiveUp: matches "can\'t complete" with the ASCII apostrophe (BUG-2)', () => {
  assert.equal(isPlannerGiveUp("I can't complete this objective."), true)
})

test('isPlannerGiveUp: still matches "can\u2019t complete" with the Unicode apostrophe', () => {
  assert.equal(isPlannerGiveUp('I can\u2019t complete this objective.'), true)
})

test('isPlannerGiveUp: matches the gerund "giving up" (BUG-3)', () => {
  assert.equal(isPlannerGiveUp("I'm giving up on this task."), true)
})

test('isPlannerGiveUp: still matches "give up" / "gives up" / "given up"', () => {
  assert.equal(isPlannerGiveUp('I give up.'), true)
  assert.equal(isPlannerGiveUp('The planner gives up here.'), true)
  assert.equal(isPlannerGiveUp('I have given up on this approach.'), true)
})

test('isPlannerGiveUp: unrelated success text does not match', () => {
  assert.equal(isPlannerGiveUp('The objective is complete and all tests pass.'), false)
})

// ── BUG-1 (CRITICAL): control-flow strings truncated at 2000 chars before the
// harness parses them ───────────────────────────────────────────────────────
//
// capSummary (frames.ts) is a head-only 2000-char cap, kept for ledger storage/
// display. Before this fix, deriveFrameResult stored ONLY that capped text as
// `.summary`, and every control-flow reader in dispatch.ts (isPlannerDone/
// isPlannerGiveUp, the next Implementer assignment, parseImplementerResult/
// parseTesterResult, and every prompt built from any of that text) read `.summary`
// — so a phrase a model puts at the END of a long message (exactly where
// isPlannerDone/isPlannerGiveUp's own phrase lists look) was silently cut off.
// deriveFrameResult now also returns `.rawSummary`, the FULL, uncapped
// finalAnswer, and every dispatch.ts control-flow call site reads that instead.
// These tests exercise the real deriveFrameResult (not a hand-built fixture), so a
// future edit that goes back to capSummary(finalAnswer) for `.rawSummary`, or reads
// `.summary` again at a control-flow site, breaks visibly here.

test('BUG-1: deriveFrameResult keeps `.summary` capped but carries the FULL text as `.rawSummary`', () => {
  const longPrefix = 'x'.repeat(2100)
  const finalAnswer = `${longPrefix} The objective is complete.`
  const agent = new Agent(() => {}, 'test-model', scriptedOllama([]))
  const result = deriveFrameResult('frame-bug1-a', finalAnswer, agent)

  // `.summary` is still capSummary's 2000-char-capped text — unchanged behavior,
  // still what gets persisted to the ledger.
  assert.equal(result.summary, `${'x'.repeat(2000)}\u2026`)
  // `.rawSummary` is the untouched, full finalAnswer — nothing trimmed.
  assert.equal(result.rawSummary, finalAnswer)
})

test('BUG-1: a Planner "done" phrase past char 2000 is invisible through `.summary` but survives through `.rawSummary`', () => {
  const longPrefix = 'x'.repeat(2100) // pushes the completion phrase well past the 2000-char cap
  const finalAnswer = `${longPrefix} The objective is complete.`
  const agent = new Agent(() => {}, 'test-model', scriptedOllama([]))
  const result = deriveFrameResult('frame-bug1-b', finalAnswer, agent)

  // This IS the bug, demonstrated directly: reading the capped text, the harness
  // would misread a genuinely finished Planner as "one more assignment" and loop.
  assert.equal(isPlannerDone(result.summary), false)
  // Reading rawSummary (what dispatch.ts's OBJECTIVE loop now actually reads),
  // the same conclude text is correctly recognized as done.
  assert.equal(isPlannerDone(result.rawSummary), true)
})

test('BUG-1: a Planner give-up phrase past char 2000 is invisible through `.summary` but survives through `.rawSummary`', () => {
  const longPrefix = 'x'.repeat(2100)
  const finalAnswer = `${longPrefix} I give up, this cannot be completed as scoped.`
  const agent = new Agent(() => {}, 'test-model', scriptedOllama([]))
  const result = deriveFrameResult('frame-bug1-c', finalAnswer, agent)

  assert.equal(isPlannerGiveUp(result.summary), false)
  assert.equal(isPlannerGiveUp(result.rawSummary), true)
})

test('BUG-1: a Tester FAIL fix-assignment longer than 2000 chars is not truncated when read via `.rawSummary`', () => {
  // The tail of the fix assignment (after char 2000) carries instructions a
  // capped read would silently drop before the next Implementer ever saw them.
  const fixBody = `${'y'.repeat(2050)} — and be sure to update the regression test too.`
  const finalAnswer = `FAIL: ${fixBody}`
  const agent = new Agent(() => {}, 'test-model', scriptedOllama([]))
  const result = deriveFrameResult('frame-bug1-d', finalAnswer, agent)

  // Reading the capped `.summary`, the trailing instruction is gone.
  const cappedParsed = parseTesterResult(result.summary)
  assert.equal(cappedParsed.passed, false)
  assert.equal(cappedParsed.fixAssignment?.includes('update the regression test'), false)

  // Reading `.rawSummary` (what runTesterValidation now actually reads), the fix
  // assignment survives intact, end to end.
  const rawParsed = parseTesterResult(result.rawSummary)
  assert.equal(rawParsed.passed, false)
  assert.equal(rawParsed.fixAssignment, fixBody.trim())
})

// ── PERSISTENT BOSS MEMORY (this task) — buildTurnHistoryBlock/boundTurnHistory ──
// Both pure, no Ollama/fs/ledger involved, same reasoning as buildTaskStartAssignment's
// own tests above: directly testable without spawning a real frame.

function digest(userMessage: string, mode: string, objective: string, outcome: string): TurnDigest {
  return { userMessage, mode, objective, outcome, timestamp: 0 }
}

test('buildTurnHistoryBlock: empty history is the empty string (byte-identical prompt on turn 1)', () => {
  assert.equal(buildTurnHistoryBlock([]), '')
})

test('buildTurnHistoryBlock: renders one entry with mode uppercased and an arrow between fields', () => {
  const text = buildTurnHistoryBlock([digest('Make the hexagons bigger', 'trivial', 'Change HEX_RADIUS', 'Changed HEX_RADIUS to 40')])
  assert.ok(text.includes('1. User: "Make the hexagons bigger"'))
  assert.ok(text.includes('TRIVIAL'))
  assert.ok(text.includes('Changed HEX_RADIUS to 40'))
})

test('buildTurnHistoryBlock: numbers entries in order, most recent last, and never mutates the input array', () => {
  const history = [
    digest('first request', 'simple', 'obj1', 'outcome1'),
    digest('second request', 'objective', 'obj2', 'outcome2'),
  ]
  const before = JSON.stringify(history)
  const text = buildTurnHistoryBlock(history)
  assert.ok(text.indexOf('1. User: "first request"') < text.indexOf('2. User: "second request"'))
  assert.equal(JSON.stringify(history), before)
})

test('buildTurnHistoryBlock: truncates a long user message/outcome to a bounded excerpt, not the raw text', () => {
  const longMessage = 'x'.repeat(500)
  const longOutcome = 'y'.repeat(500)
  const text = buildTurnHistoryBlock([digest(longMessage, 'objective', 'obj', longOutcome)])
  assert.equal(text.includes(longMessage), false)
  assert.equal(text.includes(longOutcome), false)
  assert.ok(text.includes('…'))
})

test('buildTurnHistoryBlock: ends with guidance telling the Boss to fold prior context into its objective, before any assignment text', () => {
  const text = buildTurnHistoryBlock([digest('a', 'trivial', 'b', 'c')])
  assert.ok(/incorporate that/i.test(text))
  assert.ok(text.endsWith('\n\n'))
})

test('boundTurnHistory: leaves a short history untouched', () => {
  const history = [digest('a', 'trivial', 'b', 'c')]
  assert.deepEqual(boundTurnHistory(history, TURN_HISTORY_MAX), history)
})

test('boundTurnHistory: trims to the last N entries (most recent kept), default max is 10', () => {
  const history = Array.from({ length: 15 }, (_, i) => digest(`msg${i}`, 'trivial', 'obj', 'outcome'))
  const bounded = boundTurnHistory(history)
  assert.equal(bounded.length, TURN_HISTORY_MAX)
  assert.equal(bounded[0].userMessage, 'msg5')
  assert.equal(bounded[bounded.length - 1].userMessage, 'msg14')
})

test('boundTurnHistory: a custom max is respected', () => {
  const history = Array.from({ length: 5 }, (_, i) => digest(`msg${i}`, 'trivial', 'obj', 'outcome'))
  const bounded = boundTurnHistory(history, 2)
  assert.deepEqual(bounded.map(d => d.userMessage), ['msg3', 'msg4'])
})

test('buildTaskStartAssignment itself stays untouched by the turn-history feature — the Boss prompt is locked', () => {
  // The multi-turn history block is prepended by runBossTaskStart, not baked into
  // buildTaskStartAssignment's own body — this is a regression guard on the exact
  // prompt text this task was explicitly told never to modify.
  const text = buildTaskStartAssignment('hello', false)
  assert.equal(text.startsWith('CHECKPOINT: task-start\n'), true)
  assert.equal(text.includes('Previous turns'), false)
})
