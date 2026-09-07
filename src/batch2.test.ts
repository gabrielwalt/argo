// Deterministic unit tests for the frame-boundary cap-hit fix (H13) and the
// loop-recovery ladder's structured level field (H16). Originally part of a larger
// "batch 2" (H13-H17) — H14 (resume-preserves-state for a task ledger that no
// longer exists), H15 (MEMORY.md write-boundary filtering — memory.ts removed), and
// H17 (per-frame mechanism policy — tasks/memory/grounding/layout toggles removed)
// no longer apply now that the Tester agent, harness task sequencing, memory
// retrieval, and the grounding/layout critics are gone. H13 and H16 are both
// role-independent mechanisms that survive unchanged.
//
// No Ollama, no network, no container, no git: every model turn comes from a
// scripted Ollama double (the same technique agent.test.ts uses).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import type { Ollama } from 'ollama'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent, Role } from './types.js'
import { Agent } from './agent.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS } from './frames.js'
import { deriveFrameResult } from './dispatch.js'

// ── shared scaffolding (mirrors agent.test.ts's helpers, kept local so that file
// stays untouched by this batch) ────────────────────────────────────────────────
type ScriptedResponse = {
  message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
}

// Returns each response in turn, then repeats the last one indefinitely.
function scriptedOllama(responses: ScriptedResponse[]): Ollama {
  let i = 0
  return {
    chat: async () => responses[Math.min(i++, responses.length - 1)],
  } as unknown as Ollama
}

function readCallTo(p: string): ScriptedResponse {
  return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: p } } }] } }
}
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }

async function cleanupSession(sessionId: string, slug: string): Promise<void> {
  await Promise.all([
    fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {}),
    fs.readdir(LOGS_DIR).then(files =>
      Promise.all(files.filter(f => f.includes(slug)).map(f => fs.unlink(`${LOGS_DIR}/${f}`).catch(() => {}))),
    ).catch(() => {}),
  ])
}

function warningEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'warning' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
}

// ── H13 — a cap-hit must report `partial`, never `success` ────────────────────────

// A frame that never stops calling tools: `budget + 2` DISTINCT read_file calls, so the
// loop-recovery ladder never blocks anything and the run's only possible ending is the
// iteration cap.
function neverConcludes(budget: number): Ollama {
  const responses: ScriptedResponse[] = []
  for (let i = 0; i < budget + 2; i++) responses.push(readCallTo(`/nonexistent-argo-h13-${i}`))
  return scriptedOllama(responses)
}

for (const role of ['planner', 'implementer', 'dispatcher'] as Role[]) {
  test(`H13: a ${role} frame that hits its iteration cap derives status 'partial', not 'success'`, async () => {
    const budget = ROLE_MAX_ITERATIONS[role]
    const events: AgentEvent[] = []
    const sessionId = `test-h13-cap-${role}-${Date.now()}`
    const agent = new Agent(e => events.push(e), 'test-model', neverConcludes(budget))
    agent.setSessionId(sessionId)
    agent.setMaxIterations(budget)
    agent.setAllowedTools(ROLE_TOOLS[role])
    agent.setRole(role)
    try {
      const answer = await agent.chat(`argo h13 cap case ${role}`)

      // The pre-existing symptom: chat() returns a NOTICE that reads like an answer, and
      // emits a terminal error event with no `done`.
      assert.match(answer, /^Reached maximum iterations \(\d+\) without a final answer\.$/)
      assert.equal(events.some(e => e.type === 'error'), true)
      assert.equal(events.some(e => e.type === 'done'), false)

      // The fact that used to be discarded at the frame boundary.
      assert.equal(agent.getLastRunOutcome(), 'cap')
      assert.equal(agent.hitIterationCap(), true)
      assert.equal(agent.getIterationCount(), budget)

      // The fix.
      const result = deriveFrameResult(`fr-${role}`, answer, agent)
      assert.equal(result.status, 'partial')
      assert.notEqual(result.status, 'success')
      const issues = result.issues ?? []
      assert.equal(issues.length, 1, 'a cap-hit records exactly one issue')
      assert.match(issues[0], /iteration cap/)
    } finally {
      await cleanupSession(sessionId, `argo-h13-cap-case-${role}`)
    }
  })
}

test('H13: a frame that concludes normally still derives success (no over-correction)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-h13-ok-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo h13 ok case')
    assert.equal(answer, 'Final answer.')
    assert.equal(agent.getLastRunOutcome(), 'ok')
    assert.equal(agent.hitIterationCap(), false)
    const result = deriveFrameResult('fr-ok', answer, agent)
    assert.equal(result.status, 'success')
    assert.equal(result.issues, undefined)
  } finally {
    await cleanupSession(sessionId, 'argo-h13-ok-case')
  }
})

test('H13: a frame whose turn ended in an error derives failed, not success', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-h13-err-${Date.now()}`
  // Every chat attempt throws — chatWithRetry retries once, then chat()'s outer catch runs.
  const ollama = { chat: async () => { throw new Error('backend exploded') } } as unknown as Ollama
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setChatRetryDelayMs(0)
  try {
    const answer = await agent.chat('argo h13 error case')
    assert.match(answer, /^Unexpected error:/)
    assert.equal(agent.getLastRunOutcome(), 'error')
    const result = deriveFrameResult('fr-err', answer, agent)
    assert.equal(result.status, 'failed')
  } finally {
    await cleanupSession(sessionId, 'argo-h13-error-case')
  }
})

// ── H16 — the loop-recovery ladder rung is emitted as a structured field ──────────

test('H16: loop-recovery warnings carry action.level (L0/L1/L2) instead of only prose', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-h16-${Date.now()}`
  const same = readCallTo('/nonexistent-argo-h16-level')
  // Per DEFAULT_LOOP_CONFIG: call 1 allowed; 2-3 L0; 4 L1; 5-6 L0; 7 L2.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    same, same, same, same, same, same, same, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  try {
    await agent.chat('argo h16 level case')
    const levels = warningEvents(events)
      .map(e => e.level)
      .filter((l): l is 'L0' | 'L1' | 'L2' => l !== undefined)
    assert.deepEqual(levels, ['L0', 'L0', 'L1', 'L0', 'L0', 'L2'])
    // Every ladder message carries its rung — the point of H16 is that no consumer has to
    // recover the level from this prose again.
    const ladderWarnings = warningEvents(events).filter(e => /EXACT same|context was just compacted|repeatedly looped/.test(e.message))
    assert.equal(ladderWarnings.length, 6)
    for (const w of ladderWarnings) assert.ok(w.level !== undefined, `ladder warning without a level: ${w.message.slice(0, 60)}`)
  } finally {
    await cleanupSession(sessionId, 'argo-h16-level-case')
  }
})

// ── ROLE_TOOLS: update_plan does not exist as a tool at all any more ──────────────

test('no role holds update_plan — the tool and the plan/act gate it satisfied are both gone', () => {
  assert.equal(ROLE_TOOLS.planner.includes('update_plan' as never), false)
  assert.equal(ROLE_TOOLS.implementer.includes('update_plan' as never), false)
  assert.equal(ROLE_TOOLS.dispatcher.includes('update_plan' as never), false)
  // Unchanged guarantees the rest of the harness relies on.
  assert.equal(ROLE_TOOLS.planner.includes('write_file'), false)
  assert.equal(ROLE_TOOLS.dispatcher.includes('write_file'), false)
  assert.ok(ROLE_TOOLS.planner.includes('read_file'))
})
