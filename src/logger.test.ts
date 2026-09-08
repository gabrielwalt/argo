import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { LOGS_DIR, readLog, readLogEvents, listLogs } from './logger.js'
import type { AgentEvent } from './types.js'

// SessionLogger (the JSONL writer) and all session-tracking bookkeeping
// (current-session pointer, registry, resume) have been removed entirely — the
// ledger (ledger.ts, .argo/sessions.json + .argo/frames/*.jsonl) is now the only
// durable session record. What remains in logger.ts is READ-ONLY: server.ts's
// legacy replay path for OLD (pre-ledger) run logs that happen to still be on
// disk. These tests write fixture `.jsonl` files directly (mimicking exactly the
// shape the old SessionLogger used to write) rather than driving a writer that no
// longer exists.

const writtenFiles: string[] = []
after(async () => {
  await Promise.all(writtenFiles.map(f => fs.unlink(f).catch(() => {})))
})

/** Writes a fixture .jsonl file in the exact shape the old SessionLogger produced:
 *  a `__meta__` header line followed by one `{ ts, seq, event }` line per event. */
async function writeFixtureLog(filename: string, meta: Record<string, unknown>, events: AgentEvent[]): Promise<void> {
  await fs.mkdir(LOGS_DIR, { recursive: true })
  const file = path.join(LOGS_DIR, `${filename}.jsonl`)
  const lines: string[] = []
  lines.push(JSON.stringify({ ts: new Date().toISOString(), event: { type: '__meta__', filename, ...meta } }))
  events.forEach((event, i) => {
    lines.push(JSON.stringify({ ts: new Date().toISOString(), seq: i + 1, event }))
  })
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf-8')
  writtenFiles.push(file)
}

test('readLog returns the raw jsonl content for an existing fixture file', async () => {
  const filename = `logger-test-readlog-${Date.now()}`
  await writeFixtureLog(filename, { query: 'q', model: 'test-model', options: {}, startedAt: new Date().toISOString(), toolCalls: 0, status: 'done' }, [
    { type: 'message', role: 'user', content: 'READLOG_MARKER' },
  ])

  const log = await readLog(filename)
  assert.ok(log)
  assert.deepEqual(Object.keys(log!), ['jsonl'])
  assert.ok(log!.jsonl.includes('READLOG_MARKER'))
})

test('readLog returns null for a nonexistent file', async () => {
  const log = await readLog(`logger-test-does-not-exist-${Date.now()}`)
  assert.equal(log, null)
})

test('readLogEvents skips the __meta__ line and attaches per-run __seq to each event', async () => {
  const filename = `logger-test-readlogevents-${Date.now()}`
  const events: AgentEvent[] = [
    { type: 'message', role: 'user', content: 'FIRST_MARKER' },
    { type: 'start', model: 'test-model', query: 'q', options: {} },
    { type: 'error', message: 'SECOND_MARKER' },
  ]
  await writeFixtureLog(filename, { query: 'q', model: 'test-model', options: {}, startedAt: new Date().toISOString(), toolCalls: 0, status: 'done' }, events)

  const replayed = await readLogEvents(filename)
  assert.ok(replayed, 'expected readLogEvents to return events')
  assert.equal(replayed!.length, 3)
  assert.deepEqual(replayed!.map(e => e.type), ['message', 'start', 'error'])
  assert.deepEqual(replayed!.map(e => e.__seq), [1, 2, 3])
  const first = replayed![0]
  assert.ok(first.type === 'message' && first.content === 'FIRST_MARKER', 'event content must survive intact')
})

test('readLogEvents returns null for a nonexistent file', async () => {
  const events = await readLogEvents(`logger-test-does-not-exist-${Date.now()}`)
  assert.equal(events, null)
})

test('listLogs reads the __meta__ header of every .jsonl file in LOGS_DIR', async () => {
  const filename = `logger-test-listlogs-${Date.now()}`
  await writeFixtureLog(filename, {
    query: 'LISTLOGS_QUERY_MARKER', model: 'test-model', options: {},
    startedAt: new Date().toISOString(), toolCalls: 2, status: 'done',
  }, [{ type: 'message', role: 'user', content: 'hi' }])

  const logs = await listLogs()
  const meta = logs.find(l => l.filename === filename)
  assert.ok(meta, 'expected listLogs to include the fixture file')
  assert.equal(meta!.query, 'LISTLOGS_QUERY_MARKER')
  assert.equal(meta!.toolCalls, 2)
})
