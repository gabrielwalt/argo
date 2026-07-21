import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { config } from './config.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import { Agent, parseChangedFiles, buildFallbackCommitMessage } from './agent.js'

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
