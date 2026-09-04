import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { SessionLogger, readLog, readLogEvents, LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'

// Every AgentEvent variant must produce non-empty, type-specific Markdown —
// otherwise a new event type can silently vanish from the persisted .md
// trace while still appearing in the .jsonl (see logger.ts's toMarkdown()
// switch and its compile-time `never` exhaustiveness guard).
const sampleEvents: AgentEvent[] = [
  { type: 'start', model: 'test-model', query: 'do the thing', options: {} },
  { type: 'message', role: 'user', content: 'USER_CONTENT_MARKER' },
  { type: 'message', role: 'assistant', content: 'ASSISTANT_CONTENT_MARKER' },
  { type: 'iteration', current: 3, max: 1000 },
  { type: 'ollama_request', iteration: 1, message_count: 5, model: 'test-model' },
  { type: 'token_usage', prompt_tokens: 1234, generated_tokens: 56, num_ctx: 32768 },
  { type: 'thought', content: 'THOUGHT_CONTENT_MARKER' },
  { type: 'tool_call', tool: 'bash', args: { command: 'echo hi' } },
  { type: 'tool_result', tool: 'bash', output: 'TOOL_OUTPUT_MARKER', duration_ms: 42 },
  { type: 'git_commit', hash: 'abc1234', message: 'COMMIT_MESSAGE_MARKER' },
  { type: 'done', content: 'DONE_CONTENT_MARKER' },
  { type: 'error', message: 'ERROR_MESSAGE_MARKER' },
  { type: 'warning', message: 'WARNING_MESSAGE_MARKER' },
  { type: 'compact_start', messageCount: 10, contextUsagePct: 0.7 },
  {
    type: 'compact',
    summary: 'COMPACT_SUMMARY_MARKER',
    messagesBefore: 10,
    messagesAfter: 4,
    contextUsagePct: 0.7,
    rangeDescription: 'RANGE_DESCRIPTION_MARKER',
    validated: true,
  },
]

const writtenFilenames: string[] = []
after(async () => {
  await Promise.all(writtenFilenames.flatMap(f => [
    fs.unlink(`${LOGS_DIR}/${f}.jsonl`).catch(() => {}),
    fs.unlink(`${LOGS_DIR}/${f}.md`).catch(() => {}),
  ]))
})

for (const event of sampleEvents) {
  test(`toMarkdown() renders a non-empty, type-specific case for '${event.type}'`, async () => {
    const logger = new SessionLogger(`logger-test-${event.type}`, 'test-model', {})
    logger.log(event)
    await logger.flush()
    const filename = logger.getFilename()
    writtenFilenames.push(filename)

    const log = await readLog(filename)
    assert.ok(log, 'expected the flushed log to be readable')
    assert.ok(log!.md.length > 0, `expected non-empty markdown for '${event.type}'`)

    // Every event above carries a distinctive value somewhere in its fields —
    // assert at least one of them made it into the rendered Markdown, so this
    // catches a case that renders *something* generic but drops the content.
    const distinctiveValues = Object.values(event).filter((v): v is string =>
      typeof v === 'string' && v !== event.type
    )
    if (distinctiveValues.length > 0) {
      assert.ok(
        distinctiveValues.some(v => log!.md.includes(v)),
        `expected markdown for '${event.type}' to include one of ${JSON.stringify(distinctiveValues)}\ngot:\n${log!.md}`
      )
    }
  })
}

// readLogEvents is the server-side contract the UI's replay + live-dedup depends
// on: each replayed event must carry the per-run __seq that the live SSE stream
// also carries, and the __meta__ line must never leak into the event stream.
test('readLogEvents attaches the per-run __seq to each event and skips the meta line', async () => {
  const logger = new SessionLogger('logger-test-readlogevents', 'test-model', {})
  const events: AgentEvent[] = [
    { type: 'message', role: 'user', content: 'FIRST_MARKER' },
    { type: 'start', model: 'test-model', query: 'q', options: {} },
    { type: 'thought', content: 'SECOND_MARKER' },
    { type: 'done', content: 'THIRD_MARKER' },
  ]
  for (const e of events) logger.log(e)
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const replayed = await readLogEvents(filename)
  assert.ok(replayed, 'expected readLogEvents to return events')
  // Same count/order as logged — and since the file carries a __meta__ header
  // line, an equal length proves the meta line was skipped, not replayed.
  assert.equal(replayed!.length, events.length)
  assert.deepEqual(replayed!.map(e => e.type), ['message', 'start', 'thought', 'done'])
  // Per-run seq, 1-based and monotonic — the exact key the browser dedupes on.
  assert.deepEqual(replayed!.map(e => e.__seq), [1, 2, 3, 4])
  const first = replayed![0]
  assert.ok(first.type === 'message' && first.content === 'FIRST_MARKER', 'event content must survive intact')
})

// ── Rendering dedupe (readability fix — .md ONLY, the .jsonl is never touched) ────────
// SessionLogger emits the same text through several events by design (the query as both
// `__meta__.query` and a `message`/role:'user' event; a model's final turn as its last
// `thought`, its `message`/role:'assistant', and `done`) — real logs showed this printing
// the same content two or three times before any of it was read. Every test below checks
// a specific dedupe rule against the rendered .md while confirming the underlying .jsonl
// (via readLogEvents) still carries every event untouched.
test('toMarkdown collapses a trailing thought that is byte-identical to the final answer', async () => {
  const logger = new SessionLogger('logger-test-dedupe-identical', 'test-model', {})
  logger.log({ type: 'thought', content: 'IDENTICAL_ANSWER_MARKER' })
  logger.log({ type: 'message', role: 'assistant', content: 'IDENTICAL_ANSWER_MARKER' })
  logger.log({ type: 'done', content: 'IDENTICAL_ANSWER_MARKER' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.equal(log!.md.includes('💭 Thought'), false, 'the duplicate thought block must be dropped')
  assert.equal((log!.md.match(/IDENTICAL_ANSWER_MARKER/g) ?? []).length, 1, 'the text must survive exactly once, under Final Answer')
  assert.ok(log!.md.includes('## ✅ Final Answer'))
  assert.ok(log!.md.includes('*Run finished* ·'), 'done must not repeat the content a third time')

  const events = await readLogEvents(filename)
  assert.deepEqual(events!.map(e => e.type), ['thought', 'message', 'done'], 'the jsonl record is untouched regardless of what the .md renders')
})

test('toMarkdown collapses a trailing thought that is a PREFIX of a longer final answer', async () => {
  const logger = new SessionLogger('logger-test-dedupe-prefix', 'test-model', {})
  logger.log({ type: 'thought', content: 'PREFIX_REASONING_MARKER' })
  logger.log({ type: 'message', role: 'assistant', content: 'PREFIX_REASONING_MARKER plus a formatted verdict line TAIL_MARKER' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.equal(log!.md.includes('💭 Thought'), false, 'a thought that is the leading part of the final answer is still a duplicate')
  assert.equal((log!.md.match(/PREFIX_REASONING_MARKER/g) ?? []).length, 1)
  assert.ok(log!.md.includes('TAIL_MARKER'), 'the extra content beyond the thought must survive — only the OVERLAP is redundant')
})

test('toMarkdown keeps a thought that is genuinely different from the final answer', async () => {
  const logger = new SessionLogger('logger-test-dedupe-different', 'test-model', {})
  logger.log({ type: 'thought', content: 'DIFFERENT_THOUGHT_MARKER exploring approach A' })
  logger.log({ type: 'message', role: 'assistant', content: 'DIFFERENT_FINAL_MARKER after switching to approach B' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.ok(log!.md.includes('💭 Thought'), 'a genuinely distinct thought must never be suppressed — only the trailing, provably-identical case is')
  assert.ok(log!.md.includes('DIFFERENT_THOUGHT_MARKER'))
  assert.ok(log!.md.includes('DIFFERENT_FINAL_MARKER'))
})

test('toMarkdown treats a whitespace-only difference as the same duplicate case', async () => {
  const logger = new SessionLogger('logger-test-dedupe-whitespace', 'test-model', {})
  logger.log({ type: 'thought', content: 'WS_MARKER   spread\n\nacross   lines' })
  logger.log({ type: 'message', role: 'assistant', content: 'WS_MARKER spread across lines' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.equal(log!.md.includes('💭 Thought'), false, 'normalised whitespace must still compare equal')
  assert.equal((log!.md.match(/WS_MARKER/g) ?? []).length, 1)
})

test('toMarkdown never suppresses a thought against an empty final answer', async () => {
  const logger = new SessionLogger('logger-test-dedupe-empty-final', 'test-model', {})
  logger.log({ type: 'thought', content: 'SHOULD_SURVIVE_MARKER' })
  logger.log({ type: 'message', role: 'assistant', content: '' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.ok(log!.md.includes('💭 Thought'), 'an empty final answer "starts with" nothing real — a non-empty thought must not be dropped against it')
  assert.ok(log!.md.includes('SHOULD_SURVIVE_MARKER'))
})

test('toMarkdown preserves done content when there is no preceding final-answer message (an aborted run)', async () => {
  const logger = new SessionLogger('logger-test-dedupe-abort', 'test-model', {})
  logger.log({ type: 'thought', content: 'ABORT_THOUGHT_MARKER' })
  logger.log({ type: 'done', content: 'Stopped.' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.ok(log!.md.includes('💭 Thought'), 'nothing to compare an aborted run\'s thought against, so it must stay')
  assert.ok(log!.md.includes('*Run finished* — Stopped.'), 'the ONLY place this outcome text appears must not be dropped')
})

test('the header table Query cell is a short single-line excerpt; the full query still appears once under User', async () => {
  const longQuery = `Line one of the request.\nLine two, with a literal | pipe character in it.\n${'x'.repeat(300)}`
  const logger = new SessionLogger(longQuery, 'test-model', {})
  logger.log({ type: 'message', role: 'user', content: longQuery })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  const queryLine = log!.md.split('\n').find(l => l.startsWith('| **Query** |'))
  assert.ok(queryLine, 'expected a Query row in the header table')
  assert.ok(queryLine!.length < 200, `expected a short excerpt, got ${queryLine!.length} chars: ${queryLine}`)
  assert.ok(queryLine!.includes('\\|'), 'a literal | inside the excerpt must be escaped, or it breaks the table')
  assert.ok(log!.md.includes(longQuery), 'the full, untruncated query must still appear once, under ## 💬 User')
  assert.ok(log!.md.includes('## 💬 User'))
})
