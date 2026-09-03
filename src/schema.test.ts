// Pure unit tests for the schema-constrained control-plane extraction layer (src/schema.ts).
// No network, no Ollama, no filesystem — every network-touching entry point is exercised
// only through its pure parse function, plus one stubbed-`fetch` test per entry point to
// prove the null-on-failure wiring end to end. Failure paths are tested hardest (per the
// task brief): non-conformant output, empty steps, <think>-wrapped output, HTTP failure —
// each must still resolve to null, never a fabricated decision.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  TASK_GRAPH_SCHEMA,
  TASK_START_SCHEMA,
  TESTER_VERDICT_SCHEMA,
  BOSS_VERDICT_SCHEMA,
  buildExtractionRequest,
  looksLikeNoDecision,
  parseExtractedTaskGraph,
  parseExtractedTaskStart,
  parseExtractedTesterVerdict,
  parseExtractedBossVerdict,
  extractTaskGraph,
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
  const req = buildExtractionRequest('task_graph', 'qwen3.6:latest', 'do step one then step two')
  assert.equal(req.model, 'qwen3.6:latest')
  assert.equal(req.think, false)
  assert.equal(req.stream, false)
  assert.equal(req.format, TASK_GRAPH_SCHEMA)
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

// ── parseExtractedTaskGraph ─────────────────────────────────────────────────────────

test('parseExtractedTaskGraph accepts a clean, schema-shaped graph', () => {
  const g = parseExtractedTaskGraph('{"steps":[{"role":"implementer","prompt":"add the endpoint"},{"role":"tester","prompt":"verify it","dependsOn":["s1"]}]}')
  assert.ok(g)
  assert.equal(g.steps.length, 2)
  assert.equal(g.steps[0].role, 'implementer')
  assert.deepEqual(g.steps[1].dependsOn, ['s1'])
})

test('parseExtractedTaskGraph strips <think> blocks and code fences before parsing', () => {
  const raw = '<think>restating the plan</think>\n```json\n{"steps":[{"role":"implementer","prompt":"do it"}]}\n```'
  const g = parseExtractedTaskGraph(raw)
  assert.ok(g)
  assert.equal(g.steps.length, 1)
})

test('parseExtractedTaskGraph rejects an empty steps array — never a fabricated fallback', () => {
  assert.equal(parseExtractedTaskGraph('{"steps":[]}'), null)
})

test('parseExtractedTaskGraph rejects a step with an invalid role', () => {
  assert.equal(parseExtractedTaskGraph('{"steps":[{"role":"planner","prompt":"do it"}]}'), null)
})

test('parseExtractedTaskGraph rejects a step with a blank prompt', () => {
  assert.equal(parseExtractedTaskGraph('{"steps":[{"role":"implementer","prompt":"   "}]}'), null)
})

test('parseExtractedTaskGraph rejects the "nothing decided" sentinel — never silently a one-step plan', () => {
  assert.equal(parseExtractedTaskGraph(`{"steps":[{"role":"implementer","prompt":"${NO_DECISION_SENTINEL}"}]}`), null)
})

test('parseExtractedTaskGraph rejects malformed JSON and non-conformant shapes', () => {
  assert.equal(parseExtractedTaskGraph('not json at all'), null)
  assert.equal(parseExtractedTaskGraph(''), null)
  assert.equal(parseExtractedTaskGraph('{"steps": "not an array"}'), null)
  assert.equal(parseExtractedTaskGraph('{"other": 1}'), null)
  assert.equal(parseExtractedTaskGraph('[1,2,3]'), null)
})

test('parseExtractedTaskGraph drops empty/whitespace-only dependsOn entries but keeps real ones', () => {
  const g = parseExtractedTaskGraph('{"steps":[{"role":"implementer","prompt":"a"},{"role":"tester","prompt":"b","dependsOn":["s1","","  "]}]}')
  assert.ok(g)
  assert.deepEqual(g.steps[1].dependsOn, ['s1'])
})

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

test('extractTaskGraph returns null on a network error (fetch throws)', async () => {
  await withStubbedFetch(
    (() => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskGraph('qwen3.6:latest', 'Step 1: implement. Step 2: test.')
      assert.equal(result, null)
    },
  )
})

test('extractTaskGraph returns null on a non-OK HTTP response', async () => {
  await withStubbedFetch(
    (async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskGraph('qwen3.6:latest', 'Step 1: implement. Step 2: test.')
      assert.equal(result, null)
    },
  )
})

test('extractTaskGraph returns null when the (supposedly schema-constrained) reply is non-conformant', async () => {
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: 'Sure, here is a plan in prose, no JSON at all.' } }) })) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskGraph('qwen3.6:latest', 'Step 1: implement. Step 2: test.')
      assert.equal(result, null)
    },
  )
})

test('extractTaskGraph returns null when the reply structurally conforms but steps is empty', async () => {
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: '{"steps":[]}' } }) })) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskGraph('qwen3.6:latest', 'Step 1: implement. Step 2: test.')
      assert.equal(result, null)
    },
  )
})

test('extractTaskGraph recovers a real graph on a clean conformant reply', async () => {
  await withStubbedFetch(
    (async () => ({ ok: true, json: async () => ({ message: { content: '{"steps":[{"role":"implementer","prompt":"do it"}]}' } }) })) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskGraph('qwen3.6:latest', 'Step 1: implement it.')
      assert.ok(result)
      assert.equal(result.steps.length, 1)
    },
  )
})

test('extractTaskGraph short-circuits (no fetch at all) when the input already reads as "nothing decided"', async () => {
  let called = false
  await withStubbedFetch(
    (async () => { called = true; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch,
    async () => {
      const result = await extractTaskGraph('qwen3.6:latest', 'I am giving up, this objective is too ambiguous to plan.')
      assert.equal(result, null)
    },
  )
  assert.equal(called, false, 'must not spend a network round-trip on input that already reads as undecided')
})

test('extractTaskGraph returns null on empty/whitespace input without calling the network', async () => {
  let called = false
  await withStubbedFetch(
    (async () => { called = true; return { ok: true, json: async () => ({}) } }) as unknown as typeof fetch,
    async () => {
      assert.equal(await extractTaskGraph('qwen3.6:latest', ''), null)
      assert.equal(await extractTaskGraph('qwen3.6:latest', '   '), null)
    },
  )
  assert.equal(called, false)
})

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
