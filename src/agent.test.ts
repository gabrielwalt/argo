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

test('loadProjectContext: neither AGENTS.md nor MEMORY.md present returns empty string, no behavior change', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    assert.equal(await loadProjectContext(dir), '')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectContext: only one of the two files present includes just that one, clearly labeled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Use pnpm, not npm.')
    const result = await loadProjectContext(dir)
    assert.match(result, /AGENTS\.md \(project instructions\)/)
    assert.match(result, /Use pnpm, not npm\./)
    assert.doesNotMatch(result, /MEMORY\.md/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('loadProjectContext: both files present are both included, each clearly labeled', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-project-context-'))
  try {
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Project instructions content.')
    await fs.writeFile(path.join(dir, 'MEMORY.md'), 'Durable memory content.')
    const result = await loadProjectContext(dir)
    assert.match(result, /AGENTS\.md \(project instructions\)[\s\S]*Project instructions content\./)
    assert.match(result, /MEMORY\.md \(durable project memory\)[\s\S]*Durable memory content\./)
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
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: 'Final answer.' } }

function readResults(events: AgentEvent[]): AgentEvent[] {
  return events.filter(e => e.type === 'tool_result' && e.tool === 'read_file')
}
function warningsMatching(events: AgentEvent[], re: RegExp): AgentEvent[] {
  return events.filter(e => e.type === 'warning' && re.test(e.message))
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

test('plan/act gate: a project mutation is blocked until a plan is recorded, then allowed', async () => {
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
    assert.equal(events.filter(e => e.type === 'tool_result' && e.tool === 'edit_file').length, 1)
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
// existing "no tool call = done" signal PER TASK: the first no-call for a task is a
// verify nudge; a second no-call for the SAME task advances the ledger. Only when
// the ledger is exhausted (allDone) does the existing run-level done-gate fire and
// finish the run. With the flag OFF (default) none of this runs (baseline). No live
// model: scriptedOllama repeats its last element, and the done-gate's grounding
// check returns null with no doc edits, so nothing here touches Ollama/network.

// A no-tool-call assistant reply — the "I think this task is done" signal.
const doneReply: ScriptedResponse = { message: { role: 'assistant', content: 'I believe this is complete.' } }

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

test('tasks: per-task advance — first no-tool-call nudges, second advances to the next task', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-tasks-advance-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    planReply('Two-step objective', ['Step one', 'Step two']),
    doneReply, // no-call #1 for task 1 → verify nudge (no advance yet)
    doneReply, // no-call #2 for task 1 → advance to task 2
  ]))
  agent.setSessionId(sessionId)
  agent.setTasks(true)
  try {
    await agent.chat('argo tasks advance case')

    // The verify nudge fired for the current task BEFORE any advance.
    const nudges = warningsMatching(events, /CURRENT TASK "Step one" — before moving on/)
    assert.ok(nudges.length >= 1, 'expected a verify nudge for the current task')

    // The first advance moves task 1 → done and makes task 2 the current task.
    const advanced = tasksEvents(events).filter(e => e.action === 'advanced')
    assert.ok(advanced.length >= 1, 'expected at least one advance')
    assert.equal(advanced[0].done, 1)
    assert.equal(advanced[0].total, 2)
    assert.equal(advanced[0].current, 'Step two')

    // The nudge must precede the first advance (verify-then-advance ordering).
    const firstNudgeIdx = events.findIndex(e => e.type === 'warning' && /CURRENT TASK "Step one"/.test(e.message))
    const firstAdvanceIdx = events.findIndex(e => e.type === 'tasks' && e.action === 'advanced')
    assert.ok(firstNudgeIdx >= 0 && firstAdvanceIdx > firstNudgeIdx, 'nudge must come before advance')

    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-tasks-advance-case')
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
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, 1)

    // One warning steer per blocked repeat (6 of the 7 identical calls).
    const warnings = warningsMatching(events, /./)
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
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, REPEAT_THRESHOLD)

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-off-case')
  }
})
