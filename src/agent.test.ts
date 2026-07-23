import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from './config.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import type { Ollama } from 'ollama'
import { Agent, parseChangedFiles, buildFallbackCommitMessage, isCleanStatus, loadProjectContext } from './agent.js'
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

test('repetition guard: a 4th identical tool call is intervened, not executed a 4th time', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-repeat-a-${Date.now()}`
  // read, read, read, (4th identical read → intervention), then a final answer.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    await agent.chat('argo repetition guard case a')

    assert.equal(readResults(events).length, 3)  // the 4th identical call was blocked
    assert.equal(warningsMatching(events, /repeated 3 times with no new information/).length, 1)

    // One warning, then a clean model-produced final answer — not a forced stop.
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
    assert.equal(done?.content, 'Final answer.')
  } finally {
    await cleanupSession(sessionId, 'argo-repetition-guard-case-a')
  }
})

test('repetition guard: 2 identical calls stay under threshold and do not intervene', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-repeat-b-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  try {
    await agent.chat('argo repetition guard case b')

    assert.equal(readResults(events).length, 2)  // both executed for real
    assert.equal(warningsMatching(events, /repeated \d+ times with no new information/).length, 0)
  } finally {
    await cleanupSession(sessionId, 'argo-repetition-guard-case-b')
  }
})

test('repetition guard: repeating again after the warning ends the run cleanly instead of looping', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-repeat-c-${Date.now()}`
  // The model never stops repeating: readCall is the last element, so it recurs
  // for every subsequent iteration. Escalation must terminate the run.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall]))
  agent.setSessionId(sessionId)
  agent.setMaxIterations(10)  // safety net: if escalation failed, the run would hit max iterations (an `error`), not hang
  try {
    const answer = await agent.chat('argo repetition guard case c')

    assert.equal(readResults(events).length, 3)  // never executed a 4th time
    assert.equal(warningsMatching(events, /repeated 3 times with no new information/).length, 1)  // first (and only) warning
    assert.equal(warningsMatching(events, /repeated again after a warning/).length, 1)  // escalation

    // Ended via `done`, not by exhausting iterations.
    assert.ok(events.some(e => e.type === 'done'))
    assert.equal(events.some(e => e.type === 'error'), false)
    assert.match(answer, /even after a warning/)
  } finally {
    await cleanupSession(sessionId, 'argo-repetition-guard-case-c')
  }
})
