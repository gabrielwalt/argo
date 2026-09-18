import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'http'
import { app, parseFrameRole, frameIdFromHistoryFilename, buildDiskContextMessages, mergeFrameSummaries, chooseActiveFrame, mergeWithDeleted, type FrameSummary } from './server.js'
import type { LedgerMessage } from './types.js'
import { config } from './config.js'

// server.ts's Express app, listening on an ephemeral port — no startServer()
// (no history loading, no session bookkeeping needed for these route-level
// checks). installAuth(app) already ran at import time since config.inContainer
// is false in this environment, so every route below is really auth-gated,
// matching production behavior.
let baseUrl: string
let server: Server

before(async () => {
  config.workspacePath = process.cwd()
  server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => new Promise<void>(resolve => server.close(() => resolve())))

const authHeaders = () => ({ 'X-Argo-Password': config.password })

// ── auth.ts's requireAuth, exercised through the real app ─────────

test('a request with no credentials is not treated as authenticated', async () => {
  const resp = await fetch(`${baseUrl}/history`, { redirect: 'manual' })
  assert.notEqual(resp.status, 200)
})

test('the correct X-Argo-Password header is accepted', async () => {
  const resp = await fetch(`${baseUrl}/history`, { headers: authHeaders() })
  assert.equal(resp.status, 200)
})

test('an incorrect X-Argo-Password header is rejected', async () => {
  // redirect: 'manual' — otherwise fetch follows requireAuth's redirect to
  // /login and reports *that* page's 200, masking the actual gate decision.
  const resp = await fetch(`${baseUrl}/history`, { headers: { 'X-Argo-Password': 'definitely-wrong' }, redirect: 'manual' })
  assert.notEqual(resp.status, 200)
})

// ── /git-diff/:hash — the regex guard is the only thing standing between
// this route's `git show ${hash}` string interpolation (run via exec(), a
// real shell) and command injection. These tests exist so a future change
// that loosens or drops the guard fails a test instead of only ever
// surfacing as a real exploit.

test('GET /git-diff/:hash rejects a hash containing a shell command separator', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/${encodeURIComponent('abcd; touch pwned')}`, { headers: authHeaders() })
  assert.equal(resp.status, 400)
})

test('GET /git-diff/:hash rejects a hash containing command substitution', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/${encodeURIComponent('$(whoami)')}`, { headers: authHeaders() })
  assert.equal(resp.status, 400)
})

test('GET /git-diff/:hash rejects a hash with a redirect/pipe metacharacter', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/${encodeURIComponent('abcd|cat /etc/passwd')}`, { headers: authHeaders() })
  assert.equal(resp.status, 400)
})

test('GET /git-diff/:hash accepts a well-formed short hash (passes the format guard)', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/abcd1234`, { headers: authHeaders() })
  // Not necessarily 200 — this hash may not exist in the repo at test time —
  // just confirms it wasn't rejected by the format guard itself.
  assert.notEqual(resp.status, 400)
})

// ── Frame context backend (GET /frames, GET /context) — pure functions ──
// No fs, no Ollama: these are the "id resolution, disk-recovery mapping, ordering,
// active-frame choice" pieces called out as the testable logic in the task brief.
// Real disk state in this dev environment's LOGS_DIR (leftover history-*.json from
// unrelated past runs) makes exact-count assertions against the real /frames route
// unreliable, which is exactly why this logic is exercised here in isolation instead.

test('parseFrameRole: recognises all three frame roles from a real frameId shape', () => {
  assert.equal(parseFrameRole('dispatcher-mtmm1gcc-1'), 'dispatcher')
  assert.equal(parseFrameRole('planner-mtmm1gcc-2'), 'planner')
  assert.equal(parseFrameRole('implementer-mtmm1gcc-3'), 'implementer')
})

test('parseFrameRole: the shared `agent` instance\'s own session id (ISO-derived, hyphenated) is not a frame', () => {
  assert.equal(parseFrameRole('2026-09-04T07-03-37'), null)
})

test('parseFrameRole: a prefix that is not one of the three known roles is not a frame', () => {
  assert.equal(parseFrameRole('orchestrator-mtmm1gcc-1'), null)
  // 'tester' no longer maps to a role — the Tester agent was removed.
  assert.equal(parseFrameRole('tester-mtmm1gcc-4'), null)
})

test('frameIdFromHistoryFilename: extracts the id from history-<id>.json', () => {
  assert.equal(frameIdFromHistoryFilename('history-implementer-mtmm1gcc-3.json'), 'implementer-mtmm1gcc-3')
})

test('frameIdFromHistoryFilename: null for the shared `agent` instance\'s bare history.json', () => {
  assert.equal(frameIdFromHistoryFilename('history.json'), null)
})

test('frameIdFromHistoryFilename: null for unrelated LOGS_DIR files', () => {
  assert.equal(frameIdFromHistoryFilename('current-session.txt'), null)
  assert.equal(frameIdFromHistoryFilename('compaction-implementer-mtmm1gcc-3.json'), null)
  assert.equal(frameIdFromHistoryFilename('2026-09-04T07-03-37_some-query.jsonl'), null)
})

test('buildDiskContextMessages: reconstructs role/content/chars from a raw history array', () => {
  const result = buildDiskContextMessages([
    { role: 'system', content: 'you are helpful' },
    { role: 'user', content: 'hello' },
  ])
  assert.equal(result.messageCount, 2)
  assert.equal(result.totalChars, 'you are helpful'.length + 'hello'.length)
  assert.deepEqual(result.messages[0], { role: 'system', content: 'you are helpful', chars: 15, ts: null })
  assert.equal(result.messages.every(m => m.ts === null), true, 'disk-recovered messages never fabricate a timestamp')
})

test('buildDiskContextMessages: never truncates, even far past the old 4000-char cap — matches agent.ts getContext()', () => {
  const long = 'x'.repeat(4500)
  const result = buildDiskContextMessages([{ role: 'assistant', content: long }])
  assert.equal(result.messages[0].chars, 4500)
  assert.equal(result.messages[0].content, long)
})

test('buildDiskContextMessages: non-array input yields an empty context, not a throw', () => {
  assert.deepEqual(buildDiskContextMessages(null), { messages: [], messageCount: 0, totalChars: 0 })
  assert.deepEqual(buildDiskContextMessages('not an array'), { messages: [], messageCount: 0, totalChars: 0 })
})

function ledgerMsg(id: string, role: LedgerMessage['role'], content: string): LedgerMessage {
  return { id, role, content }
}

test('mergeWithDeleted: every ledger message still live comes back unchanged, all marked not-deleted', () => {
  const ledgerMessages = [ledgerMsg('a', 'user', 'hi'), ledgerMsg('b', 'assistant', 'hello')]
  const liveMessages = [
    { id: 'a', role: 'user', content: 'hi', chars: 2, ts: 100 },
    { id: 'b', role: 'assistant', content: 'hello', chars: 5, ts: 200 },
  ]
  const merged = mergeWithDeleted(ledgerMessages, liveMessages)
  assert.deepEqual(merged, [
    { id: 'a', role: 'user', content: 'hi', chars: 2, ts: 100, deleted: false },
    { id: 'b', role: 'assistant', content: 'hello', chars: 5, ts: 200, deleted: false },
  ])
})

test('mergeWithDeleted: a ledger message no longer live is shown deleted, in its original chronological position', () => {
  // Ledger has A, B, C, D in that order; B and D were later fully removed from
  // live history (e.g. B superseded, D a spent failed-attempt pair) — live only
  // has A and C left, in the same relative order.
  const ledgerMessages = [
    ledgerMsg('a', 'assistant', 'A content'),
    ledgerMsg('b', 'assistant', 'B content — removed from live'),
    ledgerMsg('c', 'tool', 'C content'),
    ledgerMsg('d', 'tool', 'D content — removed from live'),
  ]
  const liveMessages = [
    { id: 'a', role: 'assistant', content: 'A content', chars: 9, ts: 1 },
    { id: 'c', role: 'tool', content: 'C content', chars: 9, ts: 3 },
  ]
  const merged = mergeWithDeleted(ledgerMessages, liveMessages)
  assert.equal(merged.length, 4)
  assert.deepEqual(merged.map(m => [m.id, m.deleted]), [
    ['a', false], ['b', true], ['c', false], ['d', true],
  ])
  assert.equal(merged[1].content, 'B content — removed from live')
  assert.equal(merged[1].ts, null, 'a deleted entry never fabricates a timestamp')
  assert.equal(merged[3].content, 'D content — removed from live')
})

test('mergeWithDeleted: a deleted entry is never truncated either, even far past the old 4000-char cap', () => {
  const long = 'y'.repeat(4500)
  const merged = mergeWithDeleted([ledgerMsg('gone', 'assistant', long)], [])
  assert.equal(merged[0].deleted, true)
  assert.equal(merged[0].chars, 4500)
  assert.equal(merged[0].content, long)
})

function frame(overrides: Partial<FrameSummary>): FrameSummary {
  return {
    frameId: 'implementer-a-1',
    role: 'implementer',
    parentFrameId: null,
    live: true,
    startedAt: 1000,
    messageCount: 1,
    totalChars: 10,
    promptTokens: null,
    numCtx: null,
    implementerIndex: null,
    ...overrides,
  }
}

test('mergeFrameSummaries: orders oldest-first by startedAt', () => {
  const a = frame({ frameId: 'a', startedAt: 2000 })
  const b = frame({ frameId: 'b', startedAt: 1000 })
  assert.deepEqual(mergeFrameSummaries([a, b], []).map(f => f.frameId), ['b', 'a'])
})

test('mergeFrameSummaries: disk-recovered frames (startedAt: null) sort before any known timestamp', () => {
  const live = frame({ frameId: 'live', startedAt: 1000 })
  const disk = frame({ frameId: 'disk', live: false, startedAt: null })
  assert.deepEqual(mergeFrameSummaries([live], [disk]).map(f => f.frameId), ['disk', 'live'])
})

test('mergeFrameSummaries: a frameId present in both groups keeps the LIVE entry', () => {
  const live = frame({ frameId: 'dup', startedAt: 1000, promptTokens: 42 })
  const disk = frame({ frameId: 'dup', live: false, startedAt: null, promptTokens: null })
  const merged = mergeFrameSummaries([live], [disk])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].live, true)
  assert.equal(merged[0].promptTokens, 42)
})

test('chooseActiveFrame: an explicit active id wins outright', () => {
  assert.equal(chooseActiveFrame('dispatcher-a-1', [frame({ frameId: 'dispatcher-a-1' })]), 'dispatcher-a-1')
})

test('chooseActiveFrame: null with nothing live', () => {
  assert.equal(chooseActiveFrame(null, []), null)
  assert.equal(chooseActiveFrame(null, [frame({ live: false })]), null)
})

test('chooseActiveFrame: falls back to the most recently started live frame when no id is set', () => {
  const older = frame({ frameId: 'older', startedAt: 1000 })
  const newer = frame({ frameId: 'newer', startedAt: 2000 })
  assert.equal(chooseActiveFrame(null, [older, newer]), 'newer')
})

// ── /frames, /context?frame= — structural checks only (see the header comment
// above: real leftover frame history files in this dev LOGS_DIR make exact-count
// assertions unreliable, so these check SHAPE/invariants, not specific contents).

test('GET /frames returns a well-shaped, conversation-grouped list (the dispatch loop is the only execution path)', async () => {
  const resp = await fetch(`${baseUrl}/frames`, { headers: authHeaders() })
  assert.equal(resp.status, 200)
  const body = await resp.json() as {
    active: string | null
    conversations: Array<{ sessionId: string | null; current: boolean; startedAt: string | null; frames: FrameSummary[] }>
  }
  assert.ok(Array.isArray(body.conversations))
  for (const conv of body.conversations) {
    assert.equal(typeof conv.current, 'boolean')
    assert.ok(Array.isArray(conv.frames))
    for (const f of conv.frames) {
      assert.ok(['planner', 'implementer', 'dispatcher'].includes(f.role))
      assert.equal(typeof f.live, 'boolean')
    }
  }
})

test('GET /context with no frame param keeps the pre-existing shape plus the additive fields', async () => {
  const resp = await fetch(`${baseUrl}/context`, { headers: authHeaders() })
  assert.equal(resp.status, 200)
  const body = await resp.json() as Record<string, unknown>
  // Pre-existing fields (backward compatibility — an old frontend must keep working).
  for (const key of ['messages', 'messageCount', 'totalChars', 'numCtx', 'compaction', 'compactionTs']) {
    assert.ok(key in body, `missing pre-existing field: ${key}`)
  }
  assert.equal(body.frameId, null)
  assert.equal(body.role, null)
  assert.equal(body.live, false)
})

test('GET /context?frame=<unknown> is a 404 with an error body', async () => {
  const resp = await fetch(`${baseUrl}/context?frame=implementer-doesnotexist-999999`, { headers: authHeaders() })
  assert.equal(resp.status, 404)
  const body = await resp.json() as { error: string }
  assert.ok(typeof body.error === 'string' && body.error.length > 0)
})
