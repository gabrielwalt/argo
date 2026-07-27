import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Ollama } from 'ollama'
import type { ModelOptions } from './types.js'
import { config } from './config.js'
import { isTestOrSpecPath, parseCritique, coerceCritique, runCritic } from './critic.js'

const OPTS = {} as unknown as ModelOptions

// A minimal Ollama stand-in whose chat() returns a canned raw reply. Never hits
// the network — the whole point is to exercise the critic's parse/steer logic.
function mockOllama(content: string): Ollama {
  return { chat: async () => ({ message: { content } }) } as unknown as Ollama
}

test('critic is OFF by default — the baseline loop path is unchanged', () => {
  // With no ARGO_CRITIC in the env, the flag must be false so the actor-critic
  // never engages and the baseline behavior is byte-identical.
  assert.equal(config.critic, false)
})

test('isTestOrSpecPath flags test/spec files (the immutable oracle) and nothing else', () => {
  for (const p of [
    'test/effort.test.js',
    '/workspace/test/effort.test.js',
    'tests/foo.js',
    '__tests__/bar.ts',
    'src/service.spec.ts',
    'src/query.test.mjs',
    'pkg/foo_test.go',
    'app/models_test.py',
    'conftest.py',
  ]) {
    assert.equal(isTestOrSpecPath(p), true, `expected TEST/SPEC: ${p}`)
  }
  for (const p of [
    'src/service.js',
    'src/query.js',
    'src/validation.ts',
    'README.md',
    'testing-utils/helper.js', // a "testing-utils" dir is NOT a test path
    '',
  ]) {
    assert.equal(isTestOrSpecPath(p), false, `expected SOURCE: ${p}`)
  }
})

test('parseCritique reads a clean JSON verdict', () => {
  const c = parseCritique('{"verdict":"revise","gamed_oracle":true,"issues":["edited test/effort.test.js"],"guidance":"Revert the test edit; implement in src/service.js."}')
  assert.ok(c)
  assert.equal(c.verdict, 'revise')
  assert.equal(c.gamed_oracle, true)
  assert.deepEqual(c.issues, ['edited test/effort.test.js'])
})

test('parseCritique tolerates <think> blocks and code fences (reasoning/qwen output)', () => {
  const raw = '<think>the agent tried to edit a test file, that is tampering</think>\n```json\n{"verdict":"revise","gamed_oracle":true,"issues":[],"guidance":"stop"}\n```'
  const c = parseCritique(raw)
  assert.ok(c)
  assert.equal(c.gamed_oracle, true)
  assert.equal(c.verdict, 'revise')
})

test('parseCritique extracts the JSON object amid surrounding prose', () => {
  const c = parseCritique('Here is my verdict: {"verdict":"ok","gamed_oracle":false,"issues":[],"guidance":""} — done.')
  assert.ok(c)
  assert.equal(c.verdict, 'ok')
})

test('parseCritique returns null on unparseable output so the caller fails OPEN', () => {
  assert.equal(parseCritique('no json here'), null)
  assert.equal(parseCritique(''), null)
})

test('coerceCritique: gamed_oracle:true forces verdict "revise" even if the model said "ok"', () => {
  // Safety-critical: a tamper flag must never slip through as an "ok" completion.
  const c = coerceCritique({ verdict: 'ok', gamed_oracle: true, issues: [], guidance: '' })
  assert.equal(c.verdict, 'revise')
  assert.equal(c.gamed_oracle, true)
})

test('coerceCritique coerces loose booleans and stringifies issues', () => {
  const c = coerceCritique({ verdict: 'revise', gamed_oracle: 'true', issues: ['x', 2], guidance: 'g' })
  assert.equal(c.gamed_oracle, true)
  assert.deepEqual(c.issues, ['x', '2'])
})

test('runCritic flags an attempted test-file edit as gamed_oracle:true / revise', async () => {
  const ollama = mockOllama('{"verdict":"revise","gamed_oracle":true,"issues":["attempted edit to test/effort.test.js"],"guidance":"Revert the attempted test edit; implement in src/service.js and src/query.js so the unchanged tests judge it."}')
  const c = await runCritic(ollama, 'qwen3.6:latest', OPTS, {
    checkpoint: 'pre-done',
    objective: 'add estimateMinutes across validation/service/query',
    planSteps: ['implement in src/service.js', 'add query helpers'],
    filesEdited: [{ path: 'test/effort.test.js', testOrSpec: true }],
    latestOutput: '# tests 6\n# pass 3\n# fail 3',
    recentActionTrace: ['edit_file test/effort.test.js [attempt failed]'],
  })
  assert.ok(c)
  assert.equal(c.gamed_oracle, true)
  assert.equal(c.verdict, 'revise')
})

test('runCritic passes a clean "ok" verdict through', async () => {
  const ollama = mockOllama('{"verdict":"ok","gamed_oracle":false,"issues":[],"guidance":""}')
  const c = await runCritic(ollama, 'qwen3.6:latest', OPTS, {
    checkpoint: 'post-plan', objective: 'x', planSteps: [], filesEdited: [], latestOutput: '', recentActionTrace: [],
  })
  assert.ok(c)
  assert.equal(c.verdict, 'ok')
  assert.equal(c.gamed_oracle, false)
})

test('runCritic returns null when the model output is unparseable (caller fails OPEN)', async () => {
  const ollama = mockOllama('sorry, I cannot produce a verdict')
  const c = await runCritic(ollama, 'qwen3.6:latest', OPTS, {
    checkpoint: 'on-stall', objective: 'x', planSteps: [], filesEdited: [], latestOutput: '', recentActionTrace: [],
  })
  assert.equal(c, null)
})
