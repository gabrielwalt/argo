// Pure unit tests for the schema-constrained control-plane extraction layer (src/schema.ts).
// No network, no Ollama, no filesystem — every network-touching entry point is exercised
// only through its pure parse function, plus one stubbed-`fetch` test per entry point to
// prove the null-on-failure wiring end to end. Failure paths are tested hardest (per the
// task brief): non-conformant output, empty steps, <think>-wrapped output, HTTP failure —
// each must still resolve to null, never a fabricated decision.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_START_SCHEMA,
  TESTER_VERDICT_SCHEMA,
  BOSS_VERDICT_SCHEMA,
  buildExtractionRequest,
  looksLikeNoDecision,
  parseExtractedTaskStart,
  parseExtractedTesterVerdict,
  parseExtractedBossVerdict,
  extractTaskStart,
  extractTesterVerdict,
  extractBossVerdict,
  NO_DECISION_SENTINEL,
  NO_VERDICT_SENTINEL,
} from './schema.js'
import { config } from './config.js'

// ── config flag ─────────────────────────────────────────────────────────────────────

test('schemaControlPlane is OFF by default — the baseline pipeline stays byte-identical', () => {
  assert.equal(config.schemaControlPlane, false)
})

// ── request builder (pure) ──────────────────────────────────────────────────────────

test('buildExtractionRequest shapes the Ollama /api/chat request: think:false, no tools, schema in format', () => {
  const req = buildExtractionRequest('task_start', 'qwen3.6:latest', 'do step one then step two')
  assert.equal(req.model, 'qwen3.6:latest')
  assert.equal(req.think, false)
  assert.equal(req.stream, false)
  assert.equal(req.format, TASK_START_SCHEMA)
  assert.equal(req.messages.length, 2)
  assert.equal(req.messages[0].role, 'system')
  assert.equal(req.messages[1].role, 'user')
  assert.equal(req.messages[1].content, 'do step one then step two')
  assert.ok(!('tools' in req), 'must never carry tools — this is a verdict-only turn (HYPOTHESIS-LEDGER.md probe)')
  assert.ok(req.options.temperature < 0.2, 'restatement should be at least as deterministic as the existing critic calls')
})

test('buildExtractionRequest picks the right schema per kind', () => {
  assert.equal(buildExtractionRequest('task_start', 'm', 'x').format, TASK_START_SCHEMA)
  assert.equal(buildExtractionRequest('tester_verdict', 'm', 'x').format, TESTER_VERDICT_SCHEMA)
  assert.equal(buildExtractionRequest('boss_verdict', 'm', 'x').format, BOSS_VERDICT_SCHEMA)
})

// ── looksLikeNoDecision (pure pre-check) ────────────────────────────────────────────

test('looksLikeNoDecision flags language that means there is nothing to restate', () => {
  for (const s of [
    'I am giving up on this, it is too ambiguous.',
    'I was unable to complete this within budget.',
    'There is no valid task graph I can produce from this.',
    'Insufficient information to proceed — I need more context to plan this properly.',
  ]) {
    assert.equal(looksLikeNoDecision(s), true, s)
  }
})

test('looksLikeNoDecision does not flag ordinary decision prose', () => {
  for (const s of [
    'TRIVIAL: fixed the off-by-one in query.js line 42',
    'Step 1: implement the parser. Step 2: add tests.',
    'OBJECTIVE: add pagination to the /users endpoint',
  ]) {
    assert.equal(looksLikeNoDecision(s), false, s)
  }
})

// ── parseExtractedTaskGraph / extractTaskGraph — REMOVED (2026-09, "iterative
// planner"). The Planner no longer produces a JSON task graph at all (dispatch.ts's
// module header) — it returns a rough plan as plain text, then is resumed repeatedly
// to detail one task at a time via a TASK:/TEST:/DONE text convention
// (dispatch.ts's parseNextTask, not schema-constrained). schema.ts dropped
// TASK_GRAPH_SCHEMA/ExtractedTaskStep/ExtractedTaskGraph/parseExtractedTaskGraph/
// extractTaskGraph entirely; there is nothing graph-shaped left to test here.

// ── parseExtractedTaskStart ─────────────────────────────────────────────────────────

test('parseExtractedTaskStart accepts a clean classification', () => {
  const v = parseExtractedTaskStart('{"mode":"objective","text":"add pagination to the users endpoint"}')
  assert.deepEqual(v, { mode: 'objective', text: 'add pagination to the users endpoint' })
})

test('parseExtractedTaskStart rejects an invalid mode, a blank text, and the sentinel', () => {
  assert.equal(parseExtractedTaskStart('{"mode":"urgent","text":"x"}'), null)
  assert.equal(parseExtractedTaskStart('{"mode":"answer","text":""}'), null)
  assert.equal(parseExtractedTaskStart(`{"mode":"objective","text":"${NO_DECISION_SENTINEL}"}`), null)
})

test('parseExtractedTaskStart rejects malformed input', () => {
  assert.equal(parseExtractedTaskStart('garbage'), null)
  assert.equal(parseExtractedTaskStart('{}'), null)
})

// ── parseExtractedTesterVerdict ─────────────────────────────────────────────────────

test('parseExtractedTesterVerdict accepts release with no reason', () => {
  assert.deepEqual(parseExtractedTesterVerdict('{"verdict":"release"}'), { verdict: 'release' })
})

test('parseExtractedTesterVerdict accepts redo with a reason', () => {
  assert.deepEqual(
    parseExtractedTesterVerdict('{"verdict":"redo","reason":"re-run test/query.test.js and fix filterTasks"}'),
    { verdict: 'redo', reason: 're-run test/query.test.js and fix filterTasks' },
  )
})

test('parseExtractedTesterVerdict rejects redo with no reason — never invents a followUp', () => {
  assert.equal(parseExtractedTesterVerdict('{"verdict":"redo"}'), null)
  assert.equal(parseExtractedTesterVerdict('{"verdict":"redo","reason":"   "}'), null)
})

test('parseExtractedTesterVerdict rejects an invalid verdict and the "no verdict" sentinel', () => {
  assert.equal(parseExtractedTesterVerdict('{"verdict":"approve"}'), null)
  assert.equal(parseExtractedTesterVerdict(`{"verdict":"redo","reason":"${NO_VERDICT_SENTINEL}"}`), null)
})

// ── parseExtractedBossVerdict ───────────────────────────────────────────────────────

test('parseExtractedBossVerdict accepts none with no reason', () => {
  assert.deepEqual(parseExtractedBossVerdict('{"verdict":"none"}'), { verdict: 'none' })
})

test('parseExtractedBossVerdict accepts inject/restart/escalate only WITH a reason', () => {
  assert.deepEqual(parseExtractedBossVerdict('{"verdict":"inject","reason":"check the null case"}'), { verdict: 'inject', reason: 'check the null case' })
  assert.equal(parseExtractedBossVerdict('{"verdict":"inject"}'), null)
  assert.equal(parseExtractedBossVerdict('{"verdict":"restart"}'), null)
  assert.equal(parseExtractedBossVerdict('{"verdict":"escalate"}'), null)
})

test('parseExtractedBossVerdict rejects an invalid verdict and the sentinel', () => {
  assert.equal(parseExtractedBossVerdict('{"verdict":"approve"}'), null)
  assert.equal(parseExtractedBossVerdict(`{"verdict":"escalate","reason":"${NO_VERDICT_SENTINEL}"}`), null)
})

// ── network wiring: each entry point must resolve null on every failure mode ────────
// Stubs global.fetch directly (no Ollama client involved in this module at all) and
// restores it afterward so other test files are unaffected.

function withStubbedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = global.fetch
  global.fetch = impl
  return fn().finally(() => {
    global.fetch = original
  })
}

test('extractTaskStart returns null on non-conformant output and recovers a clean one', async () => {
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: 'not json' } }) })) as unknown as typeof fetch,
    async () => {
      assert.equal(await extractTaskStart('qwen3.6:latest', 'OBJECTIVE: add pagination'), null)
    },
  )
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: '{"mode":"objective","text":"add pagination to /users"}' } }) })) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskStart('qwen3.6:latest', 'OBJECTIVE: add pagination to /users')
      assert.deepEqual(result, { mode: 'objective', text: 'add pagination to /users' })
    },
  )
})

test('extractTesterVerdict returns null on HTTP failure and on a redo with no reason', async () => {
  await withStubbedFetch(
    (async () => ({ ok: false, status: 503, statusText: 'unavailable' })) as unknown as typeof fetch,
    async () => {
      assert.equal(await extractTesterVerdict('qwen3.6:latest', 'RELEASE'), null)
    },
  )
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: '{"verdict":"redo"}' } }) })) as unknown as typeof fetch,
    async () => {
      assert.equal(await extractTesterVerdict('qwen3.6:latest', 'this needs another look'), null)
    },
  )
})

test('extractBossVerdict returns null on a thrown network error and recovers a clean escalate', async () => {
  await withStubbedFetch(
    (() => { throw new TypeError('fetch failed') }) as unknown as typeof fetch,
    async () => {
      assert.equal(await extractBossVerdict('qwen3.6:latest', 'ESCALATE: two tests still fail'), null)
    },
  )
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: '{"verdict":"escalate","reason":"two tests still fail"}' } }) })) as unknown as typeof fetch,
    async () => {
      const result = await extractBossVerdict('qwen3.6:latest', 'ESCALATE: two tests still fail')
      assert.deepEqual(result, { verdict: 'escalate', reason: 'two tests still fail' })
    },
  )
})
