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
