import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import { SessionLogger, readLog, LOGS_DIR } from './logger.js'
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
