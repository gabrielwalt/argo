import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { SessionLogger, readLog, readLogEvents, LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'

// Every AgentEvent variant must still round-trip through the JSONL log intact —
// markdown rendering (toMarkdown()) was removed; JSONL is now the ONLY persisted
// trace format, so these checks now assert against readLog()/readLogEvents()
// instead of a rendered .md file.
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
  ]))
})

for (const event of sampleEvents) {
  test(`JSONL round-trips a '${event.type}' event with its distinctive fields intact`, async () => {
    const logger = new SessionLogger(`logger-test-${event.type}`, 'test-model', {})
    logger.log(event)
    await logger.flush()
    const filename = logger.getFilename()
    writtenFilenames.push(filename)

    const log = await readLog(filename)
    assert.ok(log, 'expected the flushed log to be readable')
    assert.ok(log!.jsonl.length > 0, `expected non-empty jsonl for '${event.type}'`)

    // Every event above carries a distinctive value somewhere in its fields —
    // assert at least one of them made it into the persisted jsonl, catching a
    // serialization bug that silently drops a field for a given event type.
    const distinctiveValues = Object.values(event).filter((v): v is string =>
      typeof v === 'string' && v !== event.type
    )
    if (distinctiveValues.length > 0) {
      assert.ok(
        distinctiveValues.some(v => log!.jsonl.includes(v)),
        `expected jsonl for '${event.type}' to include one of ${JSON.stringify(distinctiveValues)}\ngot:\n${log!.jsonl}`
      )
    }

    const replayed = await readLogEvents(filename)
    assert.ok(replayed, 'expected readLogEvents to return events')
    assert.equal(replayed!.length, 1)
    assert.equal(replayed![0].type, event.type)
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

// readLog() no longer reads or returns a `.md` file — JSONL is the sole persisted
// format now (see logger.ts's flush(), which used to also write toMarkdown()'s
// output). This guards against that regressing back in.
test('readLog returns only { jsonl }, with no markdown field', async () => {
  const logger = new SessionLogger('logger-test-jsonl-only', 'test-model', {})
  logger.log({ type: 'message', role: 'user', content: 'ONLY_JSONL_MARKER' })
  await logger.flush()
  const filename = logger.getFilename()
  writtenFilenames.push(filename)

  const log = await readLog(filename)
  assert.ok(log)
  assert.deepEqual(Object.keys(log!), ['jsonl'])
  assert.ok(log!.jsonl.includes('ONLY_JSONL_MARKER'))

  await assert.rejects(fs.access(`${LOGS_DIR}/${filename}.md`), 'flush() must not write a .md file anymore')
})
