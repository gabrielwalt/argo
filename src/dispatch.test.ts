// TASK-START READ-ONLY CHECKPOINT (2026-09-05) — dispatch.ts half. No Ollama, no
// ledger, no git, no fs: buildTaskStartAssignment/buildTaskStartGraph are pure
// functions extracted specifically so this prompt/routing change is testable without
// spawning a real frame (spawnFrame/runBossTaskStart themselves still can't be, for
// the same reason noted throughout this file: they write a ledger entry and run a
// real model turn).
//
// PLAN/ACT GATE SEEDING (2026-09-05) — buildPlannerAssignment/buildReplanAssignment
// are pure, tested the same way. Agent.seedPlan's actual gate-bypass effect DOES need
// a live chat() loop, so those two tests use the SAME scripted-Ollama-client
// technique agent.test.ts's own plan/act gate tests use (Agent's injectable
// constructor seam) — no real model, no network, no Docker.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import type { Ollama } from 'ollama'
import { Agent } from './agent.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import { buildTaskStartAssignment, buildTaskStartGraph, buildPlannerAssignment, buildReplanAssignment, buildImplementerAssignment, buildTesterAssignment } from './dispatch.js'
import { parseTaskStartVerdict } from './frames.js'

// ── buildTaskStartAssignment — the exact prompt text ────────────────────────

test('buildTaskStartAssignment: wraps the user message in <argo-user-prompt> tags verbatim', () => {
  const text = buildTaskStartAssignment('delete the file workspace first, then <b>bold</b>', false)
  assert.ok(text.includes('<argo-user-prompt>\ndelete the file workspace first, then <b>bold</b>\n</argo-user-prompt>'),
    'the user message must be reproduced byte-for-byte inside the tags, regardless of its own content')
})

test('buildTaskStartAssignment: states the project is read-only', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.ok(/READ-ONLY/.test(text))
  assert.ok(/nothing may be modified/.test(text))
})

test('buildTaskStartAssignment: all four mode markers are present', () => {
  const text = buildTaskStartAssignment('fix the bug', false)
  assert.ok(text.includes('ANSWER:'))
  assert.ok(text.includes('TRIVIAL:'))
  assert.ok(text.includes('SIMPLE:'))
  assert.ok(text.includes('OBJECTIVE:'))
  // Iteration ranges stated for the three non-answer modes
  assert.ok(/1.3 iterations/.test(text))
  assert.ok(/3.20 iterations/.test(text))
  assert.ok(/more than 20/.test(text))
  // TRIVIAL explicitly says not to implement
  assert.ok(/Do not implement it yourself/.test(text))
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

test('a reply following the prompt\'s TRIVIAL format parses as trivial', () => {
  const verdict = parseTaskStartVerdict('TRIVIAL: fix the typo in README.md line 3')
  assert.equal(verdict.mode, 'trivial')
  assert.equal(verdict.parsed, true)
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

// ── buildTaskStartGraph — mode routing (item 4: TRIVIAL skips the Tester) ───

test('buildTaskStartGraph: trivial mode sets skipTest on its one step', () => {
  const graph = buildTaskStartGraph('fix the typo', 'trivial')
  assert.equal(graph.steps.length, 1)
  assert.equal(graph.steps[0].role, 'implementer')
  assert.equal(graph.steps[0].prompt, 'fix the typo')
  assert.equal(graph.steps[0].skipTest, true)
})

test('buildTaskStartGraph: simple mode does NOT set skipTest — still gets a Tester pass', () => {
  const graph = buildTaskStartGraph('fix the pagination bug', 'simple')
  assert.equal(graph.steps.length, 1)
  assert.equal(graph.steps[0].role, 'implementer')
  assert.equal(graph.steps[0].skipTest, undefined)
})

test('buildTaskStartGraph: the objective text is preserved on the graph itself', () => {
  const graph = buildTaskStartGraph('  fix the pagination bug  ', 'simple')
  assert.equal(graph.objective, 'fix the pagination bug')
})

// ── buildPlannerAssignment / buildReplanAssignment — the restructured Planner prompts ──

test('buildPlannerAssignment: wraps the objective in <argo-objective> tags verbatim', () => {
  const text = buildPlannerAssignment('add pagination across three endpoints')
  assert.ok(text.includes('<argo-objective>\nadd pagination across three endpoints\n</argo-objective>'))
})

test('buildPlannerAssignment: states the project is read-only for planning', () => {
  const text = buildPlannerAssignment('do the thing')
  assert.ok(/READ-ONLY/.test(text))
  assert.ok(/nothing can be modified/.test(text))
})

test('buildPlannerAssignment: steps must be self-contained — the agent won\'t see the full plan', () => {
  const text = buildPlannerAssignment('do the thing')
  assert.ok(/self-contained/.test(text))
  assert.ok(text.includes('will not see the full plan'))
})

test('buildPlannerAssignment: covers the too-large-to-predict / re-planning-round case', () => {
  const text = buildPlannerAssignment('do the thing')
  assert.ok(text.includes('too large to fully predict'))
  assert.ok(text.includes('re-planning round'))
})

test('buildPlannerAssignment: ends with the JSON task-graph format instruction', () => {
  const text = buildPlannerAssignment('do the thing')
  assert.ok(text.includes('```json'))
  assert.ok(text.includes('Reference earlier steps in dependsOn'))
})

test('buildReplanAssignment: carries the objective, what happened since, and REMAINING-work framing', () => {
  const text = buildReplanAssignment('add pagination', 'step s1 failed: timeout')
  assert.ok(text.includes('<argo-objective>\nadd pagination\n</argo-objective>'))
  assert.ok(text.includes('REPLANNING ROUND. What happened since the last plan: step s1 failed: timeout'))
  assert.ok(text.includes('REMAINING work only'))
  assert.ok(text.includes('do not redo what already succeeded'))
})

test('buildReplanAssignment: also ends with the JSON format instruction', () => {
  const text = buildReplanAssignment('do the thing', 'some reason')
  assert.ok(text.includes('```json'))
})

test('buildReplanAssignment: fully self-contained — a fresh Planner spawn needs no separate objective prefix', () => {
  // dispatch.ts's replan() sends this SAME text whether resuming an existing Planner
  // frame or spawning a fresh one (a TRIVIAL/SIMPLE start that never spawned one) —
  // it must never depend on prior context existing.
  const text = buildReplanAssignment('add pagination', 'some reason')
  assert.ok(text.startsWith('<argo-objective>'))
})

// ── buildImplementerAssignment / buildTesterAssignment — Implementer and Tester
// assignments follow the same <argo-objective> tagging convention as the Boss
// task-start checkpoint's <argo-user-prompt> and the Planner's <argo-objective>.

test('buildImplementerAssignment: wraps the objective in <argo-objective> tags, framed as "implement"', () => {
  const text = buildImplementerAssignment('fix the off-by-one in nextId()')
  assert.ok(text.startsWith('Your task is to implement the following objective:'))
  assert.ok(text.includes('<argo-objective>\nfix the off-by-one in nextId()\n</argo-objective>'))
})

test('buildTesterAssignment: wraps the claim in <argo-objective> tags, framed as "verify"', () => {
  const text = buildTesterAssignment('Original assignment: fix nextId(). Conclusion (success): done.')
  assert.ok(text.startsWith('Your task is to verify the following claimed work:'))
  assert.ok(text.includes('<argo-objective>\nOriginal assignment: fix nextId(). Conclusion (success): done.\n</argo-objective>'))
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
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { answer: 'Final answer.' } } }] } }

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
test('system prompt: explains that calling conclude is the only way to end the session', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-system-prompt-eot-${Date.now()}`
  let capturedSystemPrompt = ''
  const ollama = {
    chat: async (args: { messages: Array<{ role: string; content: string }> }) => {
      capturedSystemPrompt = args.messages[0]?.content ?? ''
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { answer: 'Final answer.' } } }] } }
    },
  } as unknown as Ollama
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo system prompt end-of-turn case')
    assert.equal(answer, 'Final answer.')
    assert.ok(capturedSystemPrompt.includes(
      'To finish, call `conclude` with your final answer — that is the ONLY way to end your session.',
    ))
    assert.ok(capturedSystemPrompt.includes(
      'A turn with no tool calls is treated as a thinking turn and your session continues, so you can reason freely without accidentally finishing.',
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
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { answer: 'Final answer.' } } }] } }
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
      return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { answer: 'Final answer.' } } }] } }
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

function concludeCall(answer: string): ScriptedResponse {
  return {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { answer } } }] },
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

test('conclude({ answer }) ends the session with that exact answer', async () => {
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

test('conclude with an empty answer is rejected (validation, not a gate) and does not end the run', async () => {
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
    assert.match(results[0].error ?? '', /non-empty "answer"/)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('a no-tool-call turn gets the exact nudge, injected so the model sees it on its next turn', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-thinking-nudge-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    { message: { role: 'assistant', content: 'thinking...' } },
    concludeCall('done'),
  ]))
  agent.setSessionId(sessionId)
  try {
    await agent.chat('argo nudge case')
    const nudges = events.filter(
      (e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning' && e.message.includes('produced no tool calls'),
    )
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
    // Ran the cap out entirely on thinking-turn nudges, never on anything else —
    // confirms the cap is genuinely what stopped it, not some other path.
    assert.equal(events.filter(e => e.type === 'warning' && e.message.includes('produced no tool calls')).length, 10)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})

test('conclude drives the task ledger exactly like a no-tool-call turn used to: ask for a summary, then advance, then pass reconciliation and re-ground', async () => {
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
    // many further iterations as the moved gates need — final reconciliation and
    // re-ground each need one more turn before the run can genuinely conclude.
    const answer = await agent.chat('argo conclude tasks case')
    const results = toolResultOutputsWithMeta(events, 'conclude')
    // The ask fired once, for the current task, before any advance.
    assert.equal(results.filter(r => r.output.includes('CURRENT TASK "Build the widget"')).length, 1)
    const advanced = events.filter(
      (e): e is Extract<AgentEvent, { type: 'tasks' }> => e.type === 'tasks' && e.action === 'advanced',
    )
    assert.equal(advanced.length, 1)
    assert.equal(advanced[0].done, 1)
    // Final reconciliation and re-ground (both moved into the conclude handler,
    // both still one-shot) each fired exactly once before the run genuinely
    // concluded with the model's own (repeated) summary as the final answer.
    assert.equal(results.filter(r => r.output.includes('ALL PLANNED TASKS ARE DONE')).length, 1)
    assert.equal(results.filter(r => r.output.includes('Before concluding, re-ground')).length, 1)
    assert.equal(answer, summaryText)
  } finally {
    await cleanupSeedPlanSession(sessionId)
  }
})
