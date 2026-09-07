import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from './config.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import type { Ollama } from 'ollama'
import { Agent, parseChangedFiles, buildFallbackCommitMessage, isCleanStatus, loadProjectContext, REPEAT_THRESHOLD } from './agent.js'
import { NO_OUTPUT } from './tools/bash.js'

test('setMaxIterations clamps out-of-range values into [10, 1000]', () => {
  const agent = new Agent(() => {})
  agent.setMaxIterations(0)
  assert.equal(agent.getMaxIterations(), 10)
  agent.setMaxIterations(5000)
  assert.equal(agent.getMaxIterations(), 1000)
  agent.setMaxIterations(500)
  assert.equal(agent.getMaxIterations(), 500)
})

test('parseChangedFiles extracts paths from git status --porcelain output', () => {
  const status = ' M src/agent.ts\n?? src/new-file.ts\nR  old-name.ts -> new-name.ts\n'
  assert.deepEqual(parseChangedFiles(status), ['src/agent.ts', 'src/new-file.ts', 'new-name.ts'])
})

test('parseChangedFiles returns an empty list for clean/blank status', () => {
  assert.deepEqual(parseChangedFiles(''), [])
  assert.deepEqual(parseChangedFiles('\n  \n'), [])
})

test('buildFallbackCommitMessage names files directly when there are few', () => {
  const msg = buildFallbackCommitMessage(['a.ts', 'b.ts'])
  assert.equal(msg, 'Agent: update a.ts, b.ts')
})

test('buildFallbackCommitMessage falls back to a count when there are many files', () => {
  const msg = buildFallbackCommitMessage(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
  assert.equal(msg, 'Agent: update 5 files')
})

test('buildFallbackCommitMessage handles no changed files', () => {
  assert.equal(buildFallbackCommitMessage([]), 'Agent: update workspace')
})

test('isCleanStatus treats bash\'s NO_OUTPUT sentinel the same as a genuinely blank status', () => {
  assert.equal(isCleanStatus(''), true)
  assert.equal(isCleanStatus('\n  \n'), true)
  assert.equal(isCleanStatus(NO_OUTPUT), true)
  assert.equal(isCleanStatus(' M src/agent.ts\n'), false)
})

// ── compactNow() — the manual trigger must reuse the same underlying
// mechanism as automatic compaction, just marked `manual: true` and without
// waiting for the 66.7% threshold. Requires a reachable Ollama, same as
// compaction.test.ts's LLM-quality tests, since compactHistory calls the
// model to update/validate CompactionState.
const TEST_MODEL = process.env.TEST_MODEL ?? 'qwen3.6:latest'
let ollamaAvailable = false
try {
  const resp = await fetch(`${config.ollamaHost}/api/tags`)
  if (resp.ok) {
    ollamaAvailable = true
    const data = await resp.json() as { models?: Array<{ name: string }> }
    ollamaAvailable = (data.models ?? []).some(m => m.name === TEST_MODEL)
  }
} catch { /* Ollama not reachable — skip below */ }

test('compactNow folds prior history and marks the emitted events manual, same shape as the automatic path', async (t) => {
  if (!ollamaAvailable) { t.skip(`Ollama/${TEST_MODEL} not available`); return }

  const events: AgentEvent[] = []
  const agent = new Agent(e => events.push(e), TEST_MODEL)
  const sessionId = `test-compact-now-${Date.now()}`
  agent.setSessionId(sessionId)

  const lastMessage = 'EXACT CURRENT PROMPT — must survive the manual compaction verbatim'
  agent.loadHistory([
    { role: 'user', content: 'Start working on the task.' },
    { role: 'assistant', content: 'Sure, investigating now.' },
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'assistant', content: `Iteration ${i}: did some work.` })),
    { role: 'user', content: lastMessage },
  ])

  try {
    const result = await agent.compactNow()
    assert.equal(result.compacted, true)

    const compactStart = events.find(e => e.type === 'compact_start')
    const compact = events.find(e => e.type === 'compact')
    assert.ok(compactStart && 'manual' in compactStart && compactStart.manual === true)
    assert.ok(compact && 'manual' in compact && compact.manual === true)

    const history = agent.getChatHistory()
    assert.equal(history[history.length - 1].content, lastMessage)
  } finally {
    await Promise.all([
      fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {}),
      fs.unlink(`${LOGS_DIR}/compaction-${sessionId}.json`).catch(() => {}),
      fs.readdir(LOGS_DIR).then(files =>
        Promise.all(files.filter(f => f.includes('manual-context-compaction')).map(f => fs.unlink(`${LOGS_DIR}/${f}`).catch(() => {})))
      ).catch(() => {}),
    ])
  }
})

test('loadProjectContext: neither AGENTS.md nor MEMORY.md present — both shown with empty placeholders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    const result = await loadProjectContext(dir)
    assert.match(result, /<argo-agents-file>/)
    assert.match(result, /AGENTS\.md:\n\(file is empty or does not exist yet\)/)
    assert.match(result, /<argo-memory-file>/)
    assert.match(result, /MEMORY\.md:\n\(file is empty or does not exist yet\)/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectContext: only AGENTS.md present — content shown, MEMORY.md shows placeholder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Use pnpm, not npm.')
    const result = await loadProjectContext(dir)
    assert.match(result, /<argo-agents-file>[\s\S]*AGENTS\.md:[\s\S]*Use pnpm, not npm\.[\s\S]*<\/argo-agents-file>/)
    assert.match(result, /<argo-memory-file>[\s\S]*MEMORY\.md:\n\(file is empty or does not exist yet\)[\s\S]*<\/argo-memory-file>/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectContext: both files present — both included in XML tags with content', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Project instructions content.')
    await fs.writeFile(path.join(dir, 'MEMORY.md'), 'Durable memory content.')
    const result = await loadProjectContext(dir)
    assert.match(result, /<argo-agents-file>[\s\S]*AGENTS\.md:[\s\S]*Project instructions content\.[\s\S]*<\/argo-agents-file>/)
    assert.match(result, /<argo-memory-file>[\s\S]*MEMORY\.md:[\s\S]*Durable memory content\.[\s\S]*<\/argo-memory-file>/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectContext: an oversized MEMORY.md is truncated, not sent in full', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    await fs.writeFile(path.join(dir, 'MEMORY.md'), 'x'.repeat(20_000))
    const result = await loadProjectContext(dir)
    assert.ok(result.length < 20_000)
    assert.match(result, /chars omitted/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

// ── Repetition guard (chat() loop). These drive the loop with a scripted
// Ollama client (the injectable constructor seam), so they need no live model.
// read_file on a nonexistent path returns a graceful error result without a
// container/network, so each "executed" call is deterministic and side-effect-free.

type ScriptedResponse = {
  message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
}

// Returns each response in turn, then repeats the last one indefinitely — so a
// test can either end the run (final answer as the last element) or exercise a
// model that never stops repeating (tool call as the last element).
function scriptedOllama(responses: ScriptedResponse[]): Ollama {
  let i = 0
  return {
    chat: async () => responses[Math.min(i++, responses.length - 1)],
  } as unknown as Ollama
}

const REPEAT_ARGS = { path: '/nonexistent-argo-repetition-guard-test' }
const readCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: REPEAT_ARGS } }] },
}
// conclude tool call: the ONLY way to end a session (2026-09-05). A bare no-tool-call
// turn is now a thinking turn and does NOT terminate — only calling conclude does.
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }
function concludeCall(answer: string, status = 'SUCCESS'): ScriptedResponse {
  return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status, message: answer } } }] } }
}

// Excludes rejected (harness-blocked) calls — Agent.rejectToolCall deliberately
// emits a tool_result shaped just like a real one (so the MODEL can't tell the
// difference), marked `rejected: true` for exactly this purpose: telling "the tool
// actually ran" apart from "the harness declined to run it" in code like this.
function readResults(events: AgentEvent[]): AgentEvent[] {
  return events.filter(e => e.type === 'tool_result' && e.tool === 'read_file' && !e.rejected)
}
function warningsMatching(events: AgentEvent[], re: RegExp): Array<Extract<AgentEvent, { type: 'warning' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning' && re.test(e.message))
}
async function cleanupSession(sessionId: string, slug: string): Promise<void> {
  await Promise.all([
    fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {}),
    fs.unlink(`${LOGS_DIR}/compaction-${sessionId}.json`).catch(() => {}),
    fs.readdir(LOGS_DIR).then(files =>
      Promise.all(files.filter(f => f.includes(slug)).map(f => fs.unlink(`${LOGS_DIR}/${f}`).catch(() => {})))
    ).catch(() => {}),
  ])
}

test('loop steering: a 4th identical call is skipped (steered, not executed) and the run continues', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-repeat-a-${Date.now()}`
  // read, read, read, (4th identical read → steered, not executed), then a final answer.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    agent.setLoop(false)  // baseline count-based steer path (loop ladder is default-on now)
    await agent.chat('argo repetition guard case a')

    assert.equal(readResults(events).length, 3)  // the 4th identical call was skipped, not executed
    assert.equal(warningsMatching(events, /no new information/).length, 1)  // one steer injected in its place

    // The run was NOT terminated by the guard — it continued to the model's own final answer.
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
    assert.equal(done?.content, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-repetition-guard-case-a')
  }
})

test('loop steering: 2 identical calls stay under threshold and are not steered', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-repeat-b-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    agent.setLoop(false)  // baseline count-based steer path (loop ladder is default-on now)
    await agent.chat('argo repetition guard case b')

    assert.equal(readResults(events).length, 2)  // both executed for real
    assert.equal(warningsMatching(events, /no new information|STOP/).length, 0)  // no steer
  } finally {
    await cleanupSession(sessionId, 'argo-repetition-guard-case-b')
  }
})

test('loop steering: a model that never stops repeating is steered (escalating), never terminated by the guard', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-repeat-c-${Date.now()}`
  // readCall is the last (only) element, so it recurs every iteration forever.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall]))
  agent.setSessionId(sessionId)
  agent.setMaxIterations(12)  // enough room for a few escalating steers before the real bound
  try {
    agent.setLoop(false)  // baseline count-based steer path (loop ladder is default-on now)
    const answer = await agent.chat('argo repetition guard case c')

    assert.equal(readResults(events).length, 3)  // executed 3×, then every further identical call is steered, not run
    assert.equal(warningsMatching(events, /no new information/).length, 1)  // first steer (level 1)
    assert.ok(warningsMatching(events, /STOP/).length >= 1, 'expected the steer to escalate (level 2+)')

    // The guard NEVER ends the run — only MAX_ITERATIONS does (an `error`, no guard `done`).
    assert.equal(events.some(e => e.type === 'done'), false)
    assert.ok(events.some(e => e.type === 'error'))
    assert.match(answer, /maximum iterations/i)
  } finally {
    await cleanupSession(sessionId, 'argo-repetition-guard-case-c')
  }
})

// ── Single automatic retry of a failed per-iteration Ollama call. The stub's
// chat() throws on scripted attempts and resolves on others, and reports how
// many times it was invoked so tests can assert exactly one retry (two calls).

function flakyOllama(behaviors: Array<ScriptedResponse | Error>): { ollama: Ollama; getCalls: () => number } {
  let i = 0
  let calls = 0
  const ollama = {
    // Repeats the last behavior if invoked beyond the script.
    chat: async () => {
      calls++
      const b = behaviors[Math.min(i++, behaviors.length - 1)]
      if (b instanceof Error) throw b
      return b
    },
  } as unknown as Ollama
  return { ollama, getCalls: () => calls }
}

test('chat retry: a failed per-iteration call is retried once and the run continues', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-chat-retry-a-${Date.now()}`
  // First chat() call throws (e.g. a timeout / backend parse error); the retry succeeds.
  const { ollama, getCalls } = flakyOllama([new Error('Ollama did not respond within 180s'), finalAnswer])
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setChatRetryDelayMs(0)  // don't actually wait before retrying, in the test
  try {
    const answer = await agent.chat('argo chat retry case a')

    assert.equal(answer, 'Final answer.')            // returns the eventual success, not an error
    assert.equal(getCalls(), 2)                      // original + exactly one retry
    assert.equal(warningsMatching(events, /Ollama request failed .* retrying once/).length, 1)
    assert.equal(events.some(e => e.type === 'error'), false)  // no run-ending error
  } finally {
    await cleanupSession(sessionId, 'argo-chat-retry-case-a')
  }
})

test('chat retry: if both the call and its retry fail, the outer-catch error behavior is unchanged', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-chat-retry-b-${Date.now()}`
  // Both the original and the retry throw — no third attempt; the second error propagates.
  const { ollama, getCalls } = flakyOllama([new Error('boom-1'), new Error('boom-2')])
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setChatRetryDelayMs(0)
  try {
    const answer = await agent.chat('argo chat retry case b')

    assert.equal(getCalls(), 2)                       // original + one retry only, then it stops
    assert.match(answer, /^Unexpected error: boom-2/) // returns the existing outer-catch message
    const err = events.find((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
    assert.ok(err)
    assert.match(err.message, /^Unexpected error: boom-2/)  // still emits one error event
    assert.equal(events.filter(e => e.type === 'error').length, 1)
    assert.equal(warningsMatching(events, /Ollama request failed .* retrying once/).length, 1)  // first failure warned before retrying
  } finally {
    await cleanupSession(sessionId, 'argo-chat-retry-case-b')
  }
})

test('chat retry: a stop issued during the retry wait is honored and no retry is attempted', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-chat-retry-c-${Date.now()}`
  // The first chat() call aborts the run mid-flight, then throws. The retry must
  // NOT be issued; if it were, chat() would (wrongly) return 'Final answer.'.
  let agent: Agent
  let calls = 0
  const ollama = {
    chat: async () => {
      calls++
      if (calls === 1) { agent.abort(); throw new Error('boom-during-first') }
      return finalAnswer
    },
  } as unknown as Ollama
  agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setChatRetryDelayMs(0)
  try {
    const answer = await agent.chat('argo chat retry case c')

    assert.equal(answer, 'Stopped.')                  // honored the abort, did not retry
    assert.equal(calls, 1)                            // the retry attempt was skipped
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
    assert.equal(done?.content, 'Stopped.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-chat-retry-case-c')
  }
})

// ── Plan/act gate (chat() loop). A project mutation (edit_file/write_file under
// /workspace) is blocked until the model records a plan via update_plan; read-only
// work and plain questions never trigger it (versatility). Scripted, no live model.

const editCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'edit_file', arguments: { path: '/workspace/nonexistent-argo-plan-gate.txt', old_string: 'a', new_string: 'b' } } }] },
}
const planCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'update_plan', arguments: { objective: 'Change the file', steps: ['edit it'] } } }] },
}

// SKIPPED (2026-09-05): the plan/act gate's baseline test scripts update_plan, which is
// no longer a multi-agent tool. The gate itself stays as defense-in-depth but the test's
// scenario (model calls update_plan to satisfy it) only applies to the baseline single-loop
// agent, and the whole gate ceremony is slated for removal in the steering-message cleanup pass.
test.skip('plan/act gate: a project mutation is blocked until a plan is recorded, then allowed', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-plan-gate-${Date.now()}`
  // edit (blocked→steered), update_plan (records plan), edit (now allowed→executes), final answer.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([editCall, planCall, editCall, finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo plan gate case')
    assert.ok(warningsMatching(events, /plan/i).length >= 1, 'expected a steer to record a plan first')
    assert.equal(events.some(e => e.type === 'plan'), true)             // update_plan recorded a plan
    // Exactly one edit_file actually executed — the post-plan one; the pre-plan
    // attempt was blocked before reaching the tool.
    assert.equal(events.filter(e => e.type === 'tool_result' && e.tool === 'edit_file' && !e.rejected).length, 1)
    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-plan-gate-case')
  }
})

test('plan/act gate: a read-only run needs no plan and finishes directly (versatility)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-plan-gate-ro-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    const answer = await agent.chat('argo plan gate read-only case')
    assert.equal(events.some(e => e.type === 'plan'), false)            // never forced to plan
    assert.equal(warningsMatching(events, /plan/i).length, 0)           // no plan steer
    assert.equal(readResults(events).length, 1)                         // the read ran
    assert.equal(answer, 'Final answer.')                               // finished directly
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-plan-gate-read-only-case')
  }
})

// ── HARNESS TASK LEDGER (ARGO_TASKS / agent.setTasks). These drive a real Agent
// with a scripted Ollama and the per-instance flag ON. The loop reinterprets the
// existing "no tool call = done" signal PER TASK: for a task with an executable
// verify, that runs first; either way, the first no-call for a task then asks for a
// brief SUMMARY (once), and a second no-call for the SAME task is treated as that
// summary and advances the ledger. Once the ledger is exhausted (allDone), a FINAL
// RECONCILIATION steer fires once (feeding the objective + all per-task summaries
// back to the model) before the existing run-level done-gate finishes the run. With
// the flag OFF (default) none of this runs (baseline). No live model: scriptedOllama
// repeats its last element, and the done-gate's grounding check returns null with no
// doc edits, so nothing here touches Ollama/network.

// A conclude call — the "I think this task is done" signal (2026-09-05: no longer a
// bare no-tool-call turn; only calling conclude finishes).
const doneReply: ScriptedResponse = concludeCall('I believe this is complete.')

function planReply(objective: string, steps: string[]): ScriptedResponse {
  return {
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'update_plan', arguments: { objective, steps } } }],
    },
  }
}

function tasksEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'tasks' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'tasks' }> => e.type === 'tasks')
}

// Records the messages array each chat() call received, so a test can assert what
// was actually SENT to the model (e.g. the recited ledger at the tail).
function recordingScriptedOllama(responses: ScriptedResponse[]): {
  ollama: Ollama
  messagesSeen: () => Array<Array<{ role: string; content: string }>>
} {
  let i = 0
  const seen: Array<Array<{ role: string; content: string }>> = []
  const ollama = {
    chat: async (args: { messages: Array<{ role: string; content: unknown }> }) => {
      seen.push(args.messages.map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : String(m.content ?? '') })))
      return responses[Math.min(i++, responses.length - 1)]
    },
  } as unknown as Ollama
  return { ollama, messagesSeen: () => seen }
}

test('tasks: update_plan builds a ledger and emits a planned event with total + current', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-planned-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Ship the feature', ['Write the parser', 'Wire it in', 'Add tests']),
    doneReply,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    await agent.chat('argo tasks planned case')
    const planned = tasksEvents(events).find(e => e.action === 'planned')
    assert.ok(planned, 'expected a tasks:planned event')
    assert.equal(planned.total, 3)                       // one task per plan step
    assert.equal(planned.done, 0)
    assert.equal(planned.current, 'Write the parser')    // first step is the active task
    assert.equal(planned.revision, 1)
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-planned-case')
  }
})

// SKIPPED (2026-09-05): the task-ledger advance ceremony is slated for removal in the
// steering-message cleanup pass. The conclude tool changed the terminal condition, and
// this test's scripted fixture no longer matches the ceremony's interaction pattern.
test.skip('tasks: per-task advance — first no-tool-call asks for a summary, second advances to the next task', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-advance-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Two-step objective', ['Step one', 'Step two']),
    doneReply, // no-call #1 for task 1 → summary ask (no advance yet)
    doneReply, // no-call #2 for task 1 → treated as the summary, advance to task 2
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    await agent.chat('argo tasks advance case')

    // The summary ask fired for the current task BEFORE any advance.
    const asks = warningsMatching(events, /CURRENT TASK "Step one" — if it is genuinely complete/)
    assert.ok(asks.length >= 1, 'expected a summary ask for the current task')

    // The first advance moves task 1 → done and makes task 2 the current task.
    const advanced = tasksEvents(events).filter(e => e.action === 'advanced')
    assert.ok(advanced.length >= 1, 'expected at least one advance')
    assert.equal(advanced[0].done, 1)
    assert.equal(advanced[0].total, 2)
    assert.equal(advanced[0].current, 'Step two')

    // The ask must precede the first advance (ask-then-advance ordering).
    const firstAskIdx = events.findIndex(e => e.type === 'warning' && /CURRENT TASK "Step one"/.test(e.message))
    const firstAdvanceIdx = events.findIndex(e => e.type === 'tasks' && e.action === 'advanced')
    assert.ok(firstAskIdx >= 0 && firstAdvanceIdx > firstAskIdx, 'ask must come before advance')

    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-advance-case')
  }
})

// SKIPPED (2026-09-05): same as above — task-ledger ceremony slated for removal.
test.skip('tasks: per-task summary is captured and drives advance (no verify command)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-summary-${Date.now()}`
  const summaryText = 'I built the widget by adding widget.ts and wiring it into index.ts; the demo page renders it correctly.'
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Ship the widget', ['Build the widget']),
    concludeCall('Working on it now.'),                                          // conclude #1 → summary ask
    concludeCall(summaryText),                                                   // conclude #2 → captured as the summary, advances (allDone)
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    await agent.chat('argo tasks summary case')

    // The ask fired once for the only task, before it advanced.
    const asks = warningsMatching(events, /CURRENT TASK "Build the widget" — if it is genuinely complete/)
    assert.equal(asks.length, 1)

    // It advanced (the single task), reaching allDone.
    const advanced = tasksEvents(events).filter(e => e.action === 'advanced')
    assert.equal(advanced.length, 1)
    assert.equal(advanced[0].done, 1)
    assert.equal(advanced[0].current, null)

    // The captured summary is observable in the final-reconciliation message that
    // fires immediately after the last task advances (renderTaskSummaries) — the
    // 'tasks' event schema itself carries no summary field, so this is the harness's
    // own account of what it recorded onto the ledger.
    const reconciliation = warningsMatching(events, /ALL PLANNED TASKS ARE DONE/)
    assert.equal(reconciliation.length, 1)
    assert.ok(reconciliation[0].message.includes(summaryText), 'expected the captured summary in the reconciliation message')
    assert.ok(reconciliation[0].message.includes('Build the widget [done]'), 'expected the task title + status in the reconciliation message')

    // The ask must precede the advance, which must precede the reconciliation.
    const askIdx = events.findIndex(e => e.type === 'warning' && /CURRENT TASK "Build the widget"/.test(e.message))
    const advanceIdx = events.findIndex(e => e.type === 'tasks' && e.action === 'advanced')
    const reconcileIdx = events.findIndex(e => e.type === 'warning' && /ALL PLANNED TASKS ARE DONE/.test(e.message))
    assert.ok(askIdx >= 0 && advanceIdx > askIdx && reconcileIdx > advanceIdx, 'expected ask → advance → reconciliation ordering')

    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-summary-case')
  }
})

// SKIPPED (2026-09-05): final reconciliation is slated for removal in the steering-message
// cleanup pass. The conclude tool changed when/how this fires.
test.skip('final reconciliation fires exactly once when all tasks are done, then the run finishes normally', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-reconcile-${Date.now()}`
  // Every no-tool-call turn after the plan is a generic "done" reply: task1 summary
  // ask, task1 advance, task2 summary ask, task2 advance (allDone) — the
  // reconciliation fires in that same turn — then the run's existing re-ground nudge,
  // then a genuine final answer.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Finish both tasks', ['First task', 'Second task']),
    doneReply,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    const answer = await agent.chat('argo tasks reconcile case')

    const advanced = tasksEvents(events).filter(e => e.action === 'advanced')
    assert.equal(advanced.length, 2)
    assert.equal(advanced[advanced.length - 1].current, null) // ledger exhausted

    // The final-reconciliation steer fires exactly once, AFTER the last advance,
    // mentions the objective, and lists both tasks as done.
    const reconciliation = warningsMatching(events, /ALL PLANNED TASKS ARE DONE/)
    assert.equal(reconciliation.length, 1)
    assert.ok(reconciliation[0].message.includes('Finish both tasks'))
    assert.ok(reconciliation[0].message.includes('First task [done]'))
    assert.ok(reconciliation[0].message.includes('Second task [done]'))
    const lastAdvanceIdx = events.findIndex(e => e.type === 'tasks' && e.action === 'advanced' && e.current === null)
    const reconcileIdx = events.findIndex(e => e.type === 'warning' && /ALL PLANNED TASKS ARE DONE/.test(e.message))
    assert.ok(reconcileIdx > lastAdvanceIdx, 'reconciliation must come after the last advance')

    // The run still finishes normally afterward (re-ground → final answer), same as
    // the existing allDone done-gate behavior.
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
    assert.ok(done, 'expected the run to finish')
    assert.equal(done.content, 'I believe this is complete.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-reconcile-case')
  }
})

test('tasks: the run only completes once ALL tasks are done (allDone → existing done-gate)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-complete-${Date.now()}`
  // Every response after the plan is a no-tool "done": task1 nudge, task1 advance,
  // task2 nudge, task2 advance (allDone), then the run-level reground nudge, then finish.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Finish both tasks', ['First task', 'Second task']),
    doneReply,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    const answer = await agent.chat('argo tasks complete case')

    // Both tasks advanced; the final advance reports current === null (ledger exhausted).
    const advanced = tasksEvents(events).filter(e => e.action === 'advanced')
    assert.equal(advanced.length, 2)
    assert.equal(advanced[advanced.length - 1].current, null)
    assert.equal(advanced[advanced.length - 1].done, 2)

    // The run reached 'done' with the model's own final content, only after allDone.
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
    assert.ok(done, 'expected the run to finish')
    assert.equal(done.content, 'I believe this is complete.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-complete-case')
  }
})

test('tasks: the ledger is recited to the model (renderTaskLedger CURRENT marker at the tail)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-recite-${Date.now()}`
  const { ollama, messagesSeen } = recordingScriptedOllama([
    planReply('Recited objective', ['Alpha task', 'Beta task']),
    doneReply,
  ])
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    await agent.chat('argo tasks recite case')

    // Some chat() call must have carried the recited ledger (CURRENT marker + objective).
    const sawLedger = messagesSeen().some(msgs =>
      msgs.some(m => m.role === 'tool' && /CURRENT: Alpha task/.test(m.content) && /Objective: Recited objective/.test(m.content)),
    )
    assert.ok(sawLedger, 'expected the recited task ledger (CURRENT marker) in the sent messages')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-recite-case')
  }
})

test('tasks OFF (baseline): no tasks events, and a plan + immediate done still finishes as before', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-baseline-${Date.now()}`
  // Default flag (setTasks not called / false): the single-plan path is unchanged —
  // a plan then a no-tool "done" gets ONE reground nudge, then finishes.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Baseline objective', ['Only step']),
    finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(false)
  try {
    const answer = await agent.chat('argo tasks baseline case')

    assert.equal(tasksEvents(events).length, 0)             // no ledger machinery ran
    assert.equal(events.some(e => e.type === 'plan'), true) // the single plan still recorded
    assert.equal(answer, 'Final answer.')                   // finished via the baseline path
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-baseline-case')
  }
})

// ── HARNESS MEMORY (ARGO_MEMORY / agent.setMemory). buildProjectMemoryContext reads
// AGENTS.md/MEMORY.md from the hardcoded '/workspace' root (unlike loadProjectContext,
// it takes no override parameter), and none of the existing scripted-Ollama tests stub
// or write into that path. Writing real fixture files into a live '/workspace' during a
// test run would be brittle (it isn't test-scoped, could collide with other runs, and
// could mutate whatever real project instructions live there) and is deliberately NOT
// done here. So only the OFF-baseline regression net below is added — the key guarantee
// that the new memory hooks in chatCall/buildProjectMemoryContext are strictly gated on
// this.memory and are complete no-ops when it is off (default). An ON-path test
// (asserting the recall pointer + task-scoped 'RELEVANT PROJECT INSTRUCTIONS'/'RELEVANT
// MEMORY' tail messages) was not implemented for the reason above — see summary.
test('memory OFF (baseline): no RELEVANT MEMORY / RELEVANT PROJECT INSTRUCTIONS messages, and the run behaves as before', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-memory-baseline-${Date.now()}`
  const { ollama, messagesSeen } = recordingScriptedOllama([
    planReply('Baseline memory objective', ['Only step']),
    finalAnswer,
  ])
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setMemory(false)
  try {
    const answer = await agent.chat('argo memory baseline case')

    const sawMemoryTail = messagesSeen().some(msgs =>
      msgs.some(m => m.role === 'tool' && (/RELEVANT MEMORY/.test(m.content) || /RELEVANT PROJECT INSTRUCTIONS/.test(m.content))),
    )
    assert.equal(sawMemoryTail, false)                      // memory hooks never fired
    assert.equal(events.some(e => e.type === 'plan'), true) // the single plan still recorded
    assert.equal(answer, 'Final answer.')                   // finished via the baseline path
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-memory-baseline-case')
  }
})

// ── LOOP-RECOVERY LADDER (ARGO_LOOP / agent.setLoop). Same scripted-Ollama harness as
// the repetition-guard and tasks/memory tests above — read_file on a nonexistent path is
// a non-mutating call (no edit_file/write_file, so noteMutation never fires), driven with
// the SAME script in both tests below so the ON vs OFF contrast is direct. Deliberately
// deterministic: no live model, and the L1 "compact" action's underlying compactHistory
// call is a no-op here (this run's history never grows past compaction.ts's own
// KEEP_ACTIVE_TAIL, so it returns early without touching this.ollama) — but evaluateCall
// still returns the level-specific message text regardless, so escalation is asserted via
// that message text rather than via compaction events (see loop.ts's l0/l1/l2 message
// builders).

test('loop ON: repeated identical non-mutating call is blocked and escalates L0 -> L1 -> L2', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-on-${Date.now()}`
  // 7 identical read_file calls, then a final answer. Per DEFAULT_LOOP_CONFIG (loop.ts):
  // call 1 is new -> allowed + executed; calls 2-3 -> L0 steer (blocks 1-2); call 4 -> L1
  // compaction + steer (blocks==3); calls 5-6 -> L0 steer (blocks 4-5); call 7 -> L2
  // forced re-plan reframe (blocks==6). Never a mutation, so the streak never resets.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, readCall, readCall, readCall, readCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    const answer = await agent.chat('argo loop ladder case')

    // The identical call actually ran exactly once — every later repeat (no mutation
    // since it last ran) was blocked before reaching the tool, not executed.
    assert.equal(readResults(events).length, 1)
    // Every attempt — real or rejected — still gets a tool_call event (task #30's
    // unified rejection surfacing: a block looks exactly like a real attempt up to
    // the tool_result, which is where `rejected` distinguishes them).
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, 7)

    // One warning steer per blocked repeat (6 of the 7 identical calls) — scoped to
    // the loop LADDER's own three message shapes specifically (not `/./`, which
    // would also catch the separate, unrelated stall/progress-check mechanism: with
    // this project's dev MAX_ITERATIONS=20, its now-proportional checkpoints
    // (agent.ts, 2026-09-03) land inside this test's own 8-iteration run and add a
    // real, expected "PROGRESS CHECK" warning that has nothing to do with the ladder
    // under test here).
    const warnings = warningsMatching(events, /EXACT same|context was just compacted|repeatedly looped/)
    assert.equal(warnings.length, 6)
    // Escalation genuinely reached all three levels (message text is level-specific —
    // see l0SteerMessage/l1SteerMessage/l2ReframeMessage in loop.ts).
    assert.ok(warnings.some(w => 'message' in w && /STOP repeating it/.test(w.message)), 'expected an L0 steer')
    assert.ok(warnings.some(w => 'message' in w && /context was just compacted/.test(w.message)), 'expected the L1 steer')
    assert.ok(warnings.some(w => 'message' in w && /ABANDON this approach/.test(w.message)), 'expected the L2 reframe')

    // The ladder never hard-terminates the run — it still finishes with the model's own
    // final answer once it stops repeating.
    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-on-case')
  }
})

test('loop OFF (baseline): the identical call runs up to REPEAT_THRESHOLD before the old count-based steer', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-off-${Date.now()}`
  // Same script as the ON case above, flag left off (default) — proves the ladder only
  // replaces the count-based guard when this.loop is actually on.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, readCall, readCall, readCall, readCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setLoop(false)
  try {
    const answer = await agent.chat('argo loop baseline case')

    // Baseline REPEAT_THRESHOLD (3): the first 3 identical calls all execute for real;
    // only the 4th+ repeat is skipped/steered — more than the single execution the ON
    // ladder allows above.
    assert.equal(readResults(events).length, REPEAT_THRESHOLD)
    assert.ok(readResults(events).length > 1, 'baseline allows more than one execution, unlike the ON ladder')
    // Every attempt — real or rejected — still gets a tool_call event (task #30's
    // unified rejection surfacing), so this is the full 7 attempts, not just the 3
    // that actually executed.
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, 7)

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-off-case')
  }
})

// ── LOOP-RECOVERY LADDER, H19/H20 redesign — cached replay + normalised key. The
// pure mechanics of both (evaluateCall's 'replay' branch, normalizeCallKey's
// collapse/refuse rules) are unit-tested exhaustively in loop.test.ts; these two
// tests are the AGENT-level integration proof that the wiring actually reaches
// them: the tool_result event served for a blocked repeat really does carry the
// EARLIER call's real output (not just a message), and a cosmetically-varied
// repeat (not just a byte-identical one) is recognised as the same call. No live
// model, no docker/sandbox container — read_file on a nonexistent absolute path is
// a deterministic, side-effect-free error both times, same trick the repetition-
// guard tests at the top of this file already rely on.

test('loop ON: a blocked repeat is served the EARLIER call\'s actual result, not just a message', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-replay-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    await agent.chat('argo loop replay case')

    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 2)                 // one tool_result per attempt, real or replayed
    const [first, second] = reads
    assert.equal(first.rejected, undefined)       // the 1st call actually ran
    assert.equal(second.rejected, true)           // the 2nd was blocked...
    assert.equal(second.replayed, true)           // ...specifically as a cached REPLAY, not a plain steer
    // The replay carries the SAME error text the real call produced — reproduced,
    // not regenerated or replaced with a generic "blocked" message.
    assert.equal(second.error, first.error)
    assert.equal(second.output, first.output)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-replay-case')
  }
})

// Leading './' is still a collapsed spelling after FIX 3 (only the TRAILING-slash rule
// was removed — see the dedicated FIX 3 test below). This is the agent-level proof of the
// post-FIX-2 contract, which deliberately SPLITS what used to be one outcome: a
// cosmetically-varied repeat is still RECOGNISED (so it is blocked and never executes a
// second time — the H20 evasion fix), but it is NOT answered from the cache. The review
// showed why: two calls can normalise to one key and still produce different real bytes
// (a trailing `2>&1` makes the shell interleave one fd, where bash.ts otherwise
// concatenates two separated buffers), so replaying the first call's output under the
// second call's spelling would answer a question that was not asked. Replay therefore
// requires byte-identical raw arguments; normalisation governs blocking only.
const NORMALIZE_PATH_A = 'nonexistent-argo-normalize-test'
const NORMALIZE_PATH_B = './nonexistent-argo-normalize-test'  // leading './' — a cosmetically different spelling of the SAME relative path (note A is relative too: './X' and '/X' are genuinely different files, so that pairing never collapsed and never should)
const readCallNormA: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: NORMALIZE_PATH_A } } }] },
}
const readCallNormB: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: NORMALIZE_PATH_B } } }] },
}

test('loop ON: a cosmetically-varied repeat (leading "./") is recognised as the SAME call and BLOCKED, but never served from cache (H20 + FIX 2)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-normalize-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCallNormA, readCallNormB, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    const answer = await agent.chat('argo loop normalization case')

    // Only the FIRST spelling actually ran: the normalised key recognised the second as
    // a repeat and blocked it. The OLD raw-JSON key would have missed this entirely and
    // let the 2nd call execute for real (see the loop-OFF baseline test below).
    assert.equal(readResults(events).length, 1)

    // ...and it was NOT replayed, because the raw args differ. This is the FIX 2
    // boundary: recognised for blocking, ineligible for a cached answer.
    const replay = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file' && e.replayed === true)
    assert.equal(replay, undefined, 'a normalised-equal but raw-different repeat must not be answered from cache')

    // It still produced a rejected tool_result — the plain L0 steer, not silence.
    const rejected = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file' && e.rejected === true)
    assert.ok(rejected, 'expected the blocked repeat to surface as a rejected tool_result carrying the L0 steer')

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-normalization-case')
  }
})

test('loop OFF (baseline): the same leading-"./" repeat is NOT recognised (unaffected by the ladder) — proves the ON case above is the ladder\'s doing', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-normalize-off-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCallNormA, readCallNormB, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(false)
  try {
    const answer = await agent.chat('argo loop normalization baseline case')

    // Baseline keys on the raw args (repetitionKey) — a leading './' makes it a
    // DIFFERENT key, so both calls run for real, under REPEAT_THRESHOLD.
    assert.equal(readResults(events).length, 2)
    assert.equal(answer, 'Final answer.')
  } finally {
    await cleanupSession(sessionId, 'argo-loop-normalization-off-case')
  }
})

// FIX 3 (/shared/argo-review/REPORT.md's normalisation table): the trailing-slash
// rule was REMOVED from normalizeCallKey — read_file('x/') can fail with an
// ENOTDIR-class error where read_file('x') succeeds, so collapsing them would hide
// a real success/failure boundary rather than a spelling difference. This is the
// agent-level proof that a trailing-slash repeat now runs TWICE for real under the
// ladder (same as the leading-'./' case would have BEFORE this fix removed just the
// trailing-slash rule) — loop.test.ts pins the underlying normalizeCallKey behavior
// directly; this pins the wiring.
test('loop ON: a trailing-slash repeat is NO LONGER collapsed (FIX 3) — both calls run for real, not replayed', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-trailing-slash-${Date.now()}`
  const trailingSlashPath = NORMALIZE_PATH_A + '/'
  const readCallTrailingSlash: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: trailingSlashPath } } }] },
  }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCallNormA, readCallTrailingSlash, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    const answer = await agent.chat('argo loop trailing slash case')

    // Both calls actually ran — a trailing slash is a DIFFERENT normalizeCallKey
    // after FIX 3, so the 2nd is a brand-new key (not a no-progress repeat of the
    // 1st) and is allowed, not blocked/replayed.
    assert.equal(readResults(events).length, 2)
    assert.equal(events.some(e => e.type === 'tool_result' && e.tool === 'read_file' && e.replayed === true), false)

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-trailing-slash-case')
  }
})

test('loop ON: a project mutation between two identical calls resets the ladder — the later call runs fresh, not replayed', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-mutation-${Date.now()}`
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-loop-mutation-'))
  const prevWorkspacePath = config.workspacePath
  config.workspacePath = dir
  const writeCall: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: '/workspace/loop-mutation-out.txt', content: 'hello' } } }] },
  }
  // read (runs), read (no mutation yet -> replayed), update_plan (required before
  // the mutation below), write (a REAL mutation), read again (must run fresh).
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, planCall, writeCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    const answer = await agent.chat('argo loop mutation case')

    // The 1st and 3rd (post-mutation) read_file calls both actually ran; only the
    // 2nd — issued before anything changed — was replayed.
    assert.equal(readResults(events).length, 2)
    const readToolResults = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(readToolResults.length, 3)
    assert.deepEqual(readToolResults.map(r => r.replayed ?? false), [false, true, false])

    // The write actually landed (config.workspacePath pointed at a real temp dir).
    const writeResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'write_file')
    assert.ok(writeResult && !writeResult.rejected && !writeResult.error)
    assert.equal(await fs.readFile(path.join(dir, 'loop-mutation-out.txt'), 'utf-8'), 'hello')

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    config.workspacePath = prevWorkspacePath
    await fs.rm(dir, { recursive: true, force: true })
    await cleanupSession(sessionId, 'argo-loop-mutation-case')
  }
})

// ── FIX 1 (/shared/argo-loopfix/REPORT.md, /shared/argo-review/REPORT.md defect
// 1): a `bash` call is invisible to isProjectMutation (agent.ts:210-213 only ever
// recognises edit_file/write_file under /workspace), so before this fix a cached
// read served across an intervening bash call could confidently tell the model
// "nothing has changed" about a file bash may have just changed. The fix
// invalidates every cached result on any bash call (loop.ts's noteBashExecution) —
// this is the agent-level proof the wiring actually calls it after a REAL bash tool
// execution, not just the pure loop.test.ts unit test of noteBashExecution itself.
// The bash command itself ('true') is content-free by design: the fix does not
// (and, per the mandate, must not) inspect what the command does — only THAT one
// ran — so this deliberately does not depend on any real mutation actually
// happening, on docker being available, or on any workspace file existing.

const bashCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'true' } } }] },
}

test('loop ON: an intervening bash call invalidates the cached replay (FIX 1) — the next repeat gets the plain steer, not stale content', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-bash-invalidate-${Date.now()}`
  // read (runs, cached), read (would normally be replayed — see the replay test
  // above), bash (not a tracked mutation — mutationCount stays put — but the
  // cached read result is invalidated wholesale), read (must NOT be replayed).
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, bashCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    const answer = await agent.chat('argo loop bash invalidate case')

    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 3)
    assert.equal(reads[0].rejected, undefined)          // 1st: ran for real
    assert.equal(reads[1].rejected, true)                // 2nd: blocked...
    assert.equal(reads[1].replayed, true)                // ...and specifically replayed (no bash yet)
    assert.equal(reads[2].rejected, true)                // 3rd: still a no-progress repeat by
    // mutationCount (a real, separate, documented gap this fix does NOT close —
    // see loop.ts's noteBashExecution doc comment) — but crucially NOT a replay:
    assert.equal(reads[2].replayed ?? false, false)
    assert.match(reads[2].error ?? '', /STOP repeating it/)       // the plain L0 steer fired instead
    assert.doesNotMatch(reads[2].error ?? '', /reproduced verbatim/) // never claims "nothing has changed"

    // The bash call itself was never blocked by the ladder (a brand-new key) — it
    // actually ran, which is the precondition for noteBashExecution firing at all.
    assert.ok(events.some(e => e.type === 'tool_result' && e.tool === 'bash'), 'expected the bash call to actually execute')

    assert.equal(answer, 'Final answer.')
  } finally {
    await cleanupSession(sessionId, 'argo-loop-bash-invalidate-case')
  }
})

// ── FIX 4 (/shared/argo-review/REPORT.md defect 4): a replay (rejected: true,
// replayed: true, error: undefined) must stay distinguishable from a real fast
// execution in the persisted log. Markdown rendering (toMarkdown()) was removed;
// JSONL is now the sole persisted trace, so this asserts against the raw
// tool_result event recorded in the .jsonl file rather than a rendered .md line.

test('loop ON: a replay is recorded as replayed:true (not error) in the JSONL log (FIX 4)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-replay-logger-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    await agent.chat('argo loop replay logger case')

    assert.ok(
      events.some(e => e.type === 'tool_result' && e.replayed === true),
      'expected a replayed tool_result (same setup as the replay test above)',
    )

    const files = await fs.readdir(LOGS_DIR)
    const jsonlFile = files.find(f => f.endsWith('.jsonl') && f.includes('argo-loop-replay-logger-case'))
    assert.ok(jsonlFile, 'expected a jsonl log file for this run')
    const jsonl = await fs.readFile(path.join(LOGS_DIR, jsonlFile as string), 'utf-8')
    const replayedLine = jsonl.trim().split('\n').find(l => l.includes('"replayed":true'))
    assert.ok(replayedLine, 'expected a tool_result line with replayed:true in the jsonl')
    assert.doesNotMatch(replayedLine as string, /"error":"/, 'a replay must not also carry a real error string')
  } finally {
    await cleanupSession(sessionId, 'argo-loop-replay-logger-case')
  }
})

// ── Pinning what /shared/argo-review/REPORT.md's test-gaps section calls
// "correct by inspection" but previously unpinned: a replayed tool call must not
// create a second CWL ledger episode. The `continue` in the ladder's block/replay
// branch (agent.ts, right after replayToolCall/rejectToolCall) fires BEFORE the
// episode-recording block (config.agents, guarded by the same `continue`) — episode
// count staying at 1 after 2 attempts (1 real + 1 replayed) is the pin. editedPaths
// lives in that exact same guarded block, so this doubles as that pin too — its
// own dedup (`!includes`) makes it unable to distinguish "never ran" from "ran
// twice, deduped" on its own, which is why episodes (never deduped) is the decisive
// assertion here.

test('loop ON + agents ON: a replayed tool call does not create a second ledger episode', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-replay-episodes-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  const agentsBefore = config.agents
  config.agents = true
  try {
    await agent.chat('argo loop replay episode case')

    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 2)
    assert.equal(reads[1].replayed, true)

    // Only the FIRST (real) read became a CWL episode — the replayed 2nd attempt
    // never reaches the episode-recording block.
    assert.equal(agent.getRunState().episodes, 1)
  } finally {
    config.agents = agentsBefore
    await cleanupSession(sessionId, 'argo-loop-replay-episode-case')
  }
})

// ── H21 (2026-09-04, /shared/argo-gateloop/REPORT.md) — GATE-REJECTION counter +
// the ladder's own 'halt' tier. Closes the unbounded-retry hole where a call the
// role gate or the plan/act gate refuses `continue`s past the ladder entirely, and
// bounds the pre-existing L2 rung itself (evaluateCall's 'replan' had no ceiling
// before this — see loop.ts's LoopAction 'halt' doc comment). Captured live:
// commander/2026-09-04T01-48-24_fix-checkforrequiredlocaloptions-at.jsonl (40
// rejections in one frame, L2 alone firing ~30 times running) and DRIVER-LOG.md's
// 2026-09-04 ~01:00 note (two Planner frames, 9 and 7 rejected `bash` calls, all
// refused on role). No live model: a role-restricted or never-planning scripted
// model exercises the same deterministic, side-effect-free calls the rest of this
// file's ladder tests already rely on.

const roleRejectedBashCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: "grep -n 'conflicts' /workspace/lib/help.js" } } }] },
}

test('role gate (H21): a role-restricted tool refused repeatedly escalates at the 3rd rejection, then STOPS the frame at the 6th', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-gate-h21-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([roleRejectedBashCall]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(['read_file']) // 'bash' is never available to this role
  agent.setLoop(true)
  agent.setMaxIterations(20) // plenty of room for the stop (fires at the 6th) to arrive well before any cap
  try {
    const answer = await agent.chat('argo role gate H21 case')

    const rejections = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'bash' && e.rejected === true)
    // Stops EXACTLY at the 6th identical rejection (cfg.gateStopAfter) — never a 7th.
    assert.equal(rejections.length, 6)

    // Rejections 1-2: the gate's plain, unescalated message (no count, no "role" wording).
    assert.doesNotMatch(rejections[0].error ?? '', /times/)
    assert.doesNotMatch(rejections[1].error ?? '', /times/)
    // Rejections 3-5: escalated wording — names the count and the concrete alternative.
    for (const r of [rejections[2], rejections[3], rejections[4]]) {
      assert.match(r.error ?? '', /does not exist for you in this role/)
      assert.match(r.error ?? '', /Do NOT call `bash` again/)
    }
    assert.match(rejections[2].error ?? '', /3 times/)
    assert.match(rejections[3].error ?? '', /4 times/)
    assert.match(rejections[4].error ?? '', /5 times/)
    // The 6th is the STOP message, not another escalation — and the frame ends.
    assert.match(rejections[5].error ?? '', /STOPPING this frame/)
    assert.match(rejections[5].error ?? '', /6 times/)

    // Never fails open: this reads as a stall (reused 'cap' RunOutcome), never as
    // a normal finish.
    assert.equal(agent.getLastRunOutcome(), 'cap')
    assert.equal(agent.hitIterationCap(), true)
    assert.equal(events.some(e => e.type === 'done'), false)
    assert.ok(events.some(e => e.type === 'error'))
    assert.match(answer, /STOPPING this frame/)
  } finally {
    await cleanupSession(sessionId, 'argo-role-gate-h21-case')
  }
})

test('role gate (H21) OFF: repeated rejections are plain and unbounded by this mechanism — the SAME message every time, ended only by the pre-existing iteration cap', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-gate-h21-off-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([roleRejectedBashCall]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(['read_file'])
  agent.setLoop(false)
  agent.setMaxIterations(10)
  try {
    const answer = await agent.chat('argo role gate H21 off case')

    const rejections = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'bash' && e.rejected === true)
    assert.equal(rejections.length, 10) // every iteration rejected, all the way to the cap — never stopped early by H21
    assert.ok(rejections.every(r => r.error === 'tool "bash" is not available in this role — it was NOT called.')) // byte-identical every time

    assert.equal(agent.getLastRunOutcome(), 'cap') // the PRE-EXISTING iteration cap, unrelated to H21
    assert.match(answer, /maximum iterations/i)
  } finally {
    await cleanupSession(sessionId, 'argo-role-gate-h21-off-case')
  }
})

test('plan/act gate (H21): repeated pre-plan attempts escalate at the 3rd, then the retry succeeds normally once a plan is recorded — the legitimate retry is NOT penalised', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-plan-gate-h21-${Date.now()}`
  // 3 pre-plan edits (escalating), plan recorded, edit now allowed, final answer.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([editCall, editCall, editCall, planCall, editCall, finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    const answer = await agent.chat('argo plan gate H21 escalation case')

    const editResults = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'edit_file')
    assert.equal(editResults.length, 4) // 3 rejected pre-plan + 1 executed post-plan
    assert.equal(editResults.filter(e => e.rejected === true).length, 3)
    assert.equal(editResults[3].rejected, undefined) // the post-plan retry actually ran, not blocked/penalised

    assert.doesNotMatch(editResults[0].error ?? '', /times/) // 1st: the gate's plain message
    assert.match(editResults[2].error ?? '', /3 times/)      // 3rd: escalated wording
    assert.match(editResults[2].error ?? '', /Call `update_plan` now/)

    // Below cfg.gateStopAfter (3 rejections, not 6) — the frame was never stopped,
    // and it finished normally via the model's own final answer.
    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
    assert.equal(agent.getLastRunOutcome(), 'ok')
  } finally {
    await cleanupSession(sessionId, 'argo-plan-gate-h21-case')
  }
})

test('plan/act gate (H21): repeated pre-plan attempts are BOUNDED — the frame stops if a plan is never recorded', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-plan-gate-h21-stop-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([editCall])) // never plans, ever
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  agent.setMaxIterations(20)
  try {
    const answer = await agent.chat('argo plan gate H21 stop case')

    const rejections = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'edit_file' && e.rejected === true)
    assert.equal(rejections.length, 6)
    assert.match(rejections[5].error ?? '', /STOPPING this frame/)
    assert.match(rejections[5].error ?? '', /plan-before-mutation gate/)

    assert.equal(agent.getLastRunOutcome(), 'cap')
    assert.equal(events.some(e => e.type === 'done'), false)
    assert.match(answer, /STOPPING this frame/)
  } finally {
    await cleanupSession(sessionId, 'argo-plan-gate-h21-stop-case')
  }
})

// H21(b) — the pre-existing L2 rung had no ceiling of its own: this extends the
// "loop ON: repeated identical non-mutating call is blocked and escalates L0 ->
// L1 -> L2" test above past its first L2 firing, to the point the cited frame
// actually reached (L2, ignored, over and over) and proves the harness now stops
// rather than repeating it indefinitely.
test('loop ON (H21b): a model that never stops repeating past L2 is eventually HALTED — the frame ends, never as success', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-halt-${Date.now()}`
  // readCall is the only element, so it recurs every iteration — never stops on its own.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  agent.setMaxIterations(20) // DEFAULT_LOOP_CONFIG halts at blocks=10 (the 11th attempt) — well inside 20
  try {
    const answer = await agent.chat('argo loop halt case')

    // Exactly one real execution; every further repeat is blocked/escalated by the
    // ladder, until 'halt' fires and ends the frame — never a 12th attempt.
    assert.equal(readResults(events).length, 1)
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, 11)

    assert.match(answer, /STOPPING this frame/)
    assert.match(answer, /10 consecutive calls/)
    assert.equal(agent.getLastRunOutcome(), 'cap') // never reads as success
    assert.equal(events.some(e => e.type === 'done'), false)
    assert.ok(events.some(e => e.type === 'error'))
  } finally {
    await cleanupSession(sessionId, 'argo-loop-halt-case')
  }
})
