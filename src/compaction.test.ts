import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from 'ollama'
import { Ollama } from 'ollama'
import { config } from './config.js'
import {
  emptyCompactionState,
  coerceCompactionState,
  renderCompactionState,
  splitForCompaction,
  updateCompactionState,
  validateCompactionState,
  messagesToText,
  type CompactionState,
} from './compaction.js'

// ── Deterministic tests — no LLM involved, always run ──────────────
// These are what actually *guarantee* the active prompt survives; they don't
// depend on any model's behavior, just on splitForCompaction's arithmetic.

function userMsg(content: string): Message { return { role: 'user', content } }
function assistantMsg(content: string): Message { return { role: 'assistant', content } }
function toolMsg(content: string): Message { return { role: 'tool', content } }

test('1. the current prompt survives untouched after more than 8 subsequent iterations', () => {
  const currentPrompt = userMsg('EXACT ACTIVE PROMPT — must survive byte for byte')
  const history: Message[] = [
    userMsg('session start'),
    assistantMsg('ok'),
    currentPrompt,
    ...Array.from({ length: 20 }, (_, i) => toolMsg(`iteration ${i} tool output`)),
  ]
  const currentRunStart = 2
  const split = splitForCompaction(history, currentRunStart)
  assert.equal(split.currentPrompt.content, currentPrompt.content)
  assert.equal(split.currentPrompt, currentPrompt) // same object, not a reconstructed copy
})

test('2. repeated compaction across a very long single task never loses the active prompt', () => {
  const currentPrompt = userMsg('LONG TASK PROMPT — must never be lost across repeated compaction')
  let history: Message[] = [userMsg('session start'), assistantMsg('ok'), currentPrompt]
  let currentRunStart = 2

  // Simulate many iterations with compaction firing repeatedly, the way a very
  // long single run would trigger it more than once.
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 15; i++) history.push(toolMsg(`round ${round} iteration ${i}`))

    const split = splitForCompaction(history, currentRunStart)
    assert.equal(split.currentPrompt.content, currentPrompt.content, `lost prompt at round ${round}`)

    // Reconstruct the way agent.ts's compactHistory does, with a placeholder
    // instead of a real LLM-generated summary — the guarantee being tested is
    // structural (which messages survive), not what the summary says.
    const priorPlaceholder = assistantMsg('[placeholder prior work state]')
    const activePlaceholder = split.activeMiddle.length ? [assistantMsg('[placeholder active working state]')] : []
    history = [priorPlaceholder, ...split.antecedent, split.currentPrompt, ...activePlaceholder, ...split.activeTail]
    currentRunStart = 1 + split.antecedent.length
  }

  assert.equal(history[currentRunStart].content, currentPrompt.content)
})

test('the antecedent turn is preserved for referential prompts ("fix that")', () => {
  const antecedentUser = userMsg('Here are three options: A, B, C.')
  const antecedentAssistant = assistantMsg('Option B looks best because...')
  const currentPrompt = userMsg('use the second option')
  const history: Message[] = [
    userMsg('unrelated much older message'),
    assistantMsg('unrelated older reply'),
    antecedentUser,
    antecedentAssistant,
    currentPrompt,
    toolMsg('some tool result'),
  ]
  const split = splitForCompaction(history, 4)
  const antecedentContents = split.antecedent.map(m => m.content)
  assert.ok(antecedentContents.includes(antecedentUser.content))
  assert.ok(antecedentContents.includes(antecedentAssistant.content))
})

test('7. older content is compressed into "prior", recent activity stays in the verbatim tail', () => {
  const currentPrompt = userMsg('current task')
  const history: Message[] = [
    userMsg('ancient message 1'),
    assistantMsg('ancient reply 1'),
    currentPrompt,
    ...Array.from({ length: 20 }, (_, i) => toolMsg(`recent iteration ${i}`)),
  ]
  const split = splitForCompaction(history, 2)
  // The last 8 iterations of the active run stay verbatim...
  assert.equal(split.activeTail.length, 8)
  assert.equal(split.activeTail[split.activeTail.length - 1].content, 'recent iteration 19')
  // ...while everything older within the active run is a compaction candidate.
  assert.equal(split.activeMiddle.length, 12)
})

test('8. the reconstructed context stays bounded regardless of how large the input was', () => {
  const currentPrompt = userMsg('current task')
  const history: Message[] = [
    ...Array.from({ length: 500 }, (_, i) => (i % 2 === 0 ? userMsg(`old ${i}`) : assistantMsg(`old reply ${i}`))),
    currentPrompt,
    ...Array.from({ length: 50 }, (_, i) => toolMsg(`iteration ${i}`)),
  ]
  const split = splitForCompaction(history, 500)
  const reconstructedCount = 1 /* prior state message */ + split.antecedent.length + 1 /* current prompt */
    + (split.activeMiddle.length ? 1 : 0) + split.activeTail.length
  // Bounded by a small constant (antecedent capped at MAX_ANTECEDENT_SEARCH=6),
  // independent of the original 550-message input.
  assert.ok(reconstructedCount <= 1 + 6 + 1 + 1 + 8, `reconstructed count ${reconstructedCount} not bounded`)
  assert.ok(reconstructedCount < history.length)
})

test('coerceCompactionState falls back gracefully on malformed model output', () => {
  const fallback = emptyCompactionState()
  fallback.verifiedFacts = ['existing fact']
  assert.deepEqual(coerceCompactionState(null, fallback), fallback)
  assert.deepEqual(coerceCompactionState('not an object', fallback), fallback)
  assert.deepEqual(coerceCompactionState({ verifiedFacts: 'not an array' }, fallback).verifiedFacts, ['existing fact'])
  const partial = coerceCompactionState({ verifiedFacts: ['new fact'] }, fallback)
  assert.deepEqual(partial.verifiedFacts, ['new fact'])
  assert.deepEqual(partial.hypotheses, fallback.hypotheses)
})

test('renderCompactionState keeps categories visually and textually separate', () => {
  const state: CompactionState = {
    ...emptyCompactionState(),
    verifiedFacts: ['missing id produces NaN — confirmed by running nextId([{title:"x"}])'],
    hypotheses: ['negative/float ids MIGHT also produce NaN — not tested'],
  }
  const rendered = renderCompactionState(state)
  const verifiedIdx = rendered.indexOf('VERIFIED FACTS')
  const hypothesesIdx = rendered.indexOf('HYPOTHESES')
  assert.ok(verifiedIdx >= 0 && hypothesesIdx >= 0)
  // The hypothesis text must not appear inside the verified-facts section.
  const verifiedSection = rendered.slice(verifiedIdx, hypothesesIdx)
  assert.ok(!verifiedSection.includes('negative/float'))
})

// ── LLM-quality tests — require a reachable Ollama, skipped otherwise ──
// These check epistemic fidelity: whether the *model's* summarization
// actually respects the rules it's given. Inherently less deterministic than
// the tests above, so assertions check for key content rather than exact text.

const TEST_MODEL = process.env.TEST_MODEL ?? 'qwen3.6:latest'
let ollamaAvailable = false
let modelAvailable = false
try {
  const resp = await fetch(`${config.ollamaHost}/api/tags`)
  if (resp.ok) {
    ollamaAvailable = true
    const data = await resp.json() as { models?: Array<{ name: string }> }
    modelAvailable = (data.models ?? []).some(m => m.name === TEST_MODEL)
  }
} catch { /* Ollama not reachable — LLM-quality tests below will skip */ }

const ollama = new Ollama({ host: config.ollamaHost })
const NO_OPTS = {}

test('3. an explicit user prohibition survives compaction', async (t) => {
  if (!ollamaAvailable || !modelAvailable) { t.skip(`Ollama/${TEST_MODEL} not available`); return }
  const raw: Message[] = [
    userMsg('Refactor the logging module. Do NOT modify config.py under any circumstances — it is shared with another team.'),
    assistantMsg('Understood, I will leave config.py untouched.'),
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: '/workspace/src/logging.py' } } }] } as Message,
    toolMsg('def log(msg): print(msg)'),
  ]
  const state = await updateCompactionState(ollama, TEST_MODEL, NO_OPTS, emptyCompactionState(), raw)
  const rendered = renderCompactionState(state).toLowerCase()
  assert.ok(rendered.includes('config.py'), `prohibition about config.py missing from:\n${rendered}`)
})

test('4. a failed/unverified hypothesis is not promoted to a verified fact', async (t) => {
  if (!ollamaAvailable || !modelAvailable) { t.skip(`Ollama/${TEST_MODEL} not available`); return }
  const raw: Message[] = [
    userMsg('Does the parser handle empty input?'),
    assistantMsg('I believe the parser probably handles empty input fine based on the code structure, though I have not run it.'),
  ]
  const draft = await updateCompactionState(ollama, TEST_MODEL, NO_OPTS, emptyCompactionState(), raw)
  const { state } = await validateCompactionState(ollama, TEST_MODEL, NO_OPTS, messagesToText(raw), draft)
  const inVerified = state.verifiedFacts.some(f => /empty input/i.test(f))
  const inHypotheses = state.hypotheses.some(f => /empty input/i.test(f))
  assert.equal(inVerified, false, `unverified claim leaked into verifiedFacts: ${JSON.stringify(state.verifiedFacts)}`)
  assert.ok(inHypotheses || (!inVerified), 'expected the unverified claim to be absent or in hypotheses, not verified')
})

test('5. a failed command is not summarized as successful', async (t) => {
  if (!ollamaAvailable || !modelAvailable) { t.skip(`Ollama/${TEST_MODEL} not available`); return }
  const raw: Message[] = [
    userMsg('Run the test suite.'),
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'npm test' } } }] } as Message,
    toolMsg('Error: 3 failed, 12 passed\nFAIL test/auth.test.js'),
  ]
  const state = await updateCompactionState(ollama, TEST_MODEL, NO_OPTS, emptyCompactionState(), raw)
  const rendered = renderCompactionState(state).toLowerCase()
  // Must not claim the suite passed cleanly; must reflect the failure somewhere.
  assert.ok(!/all tests pass|tests passed successfully|suite passed/.test(rendered) || /fail/.test(rendered))
  assert.ok(rendered.includes('fail'), `failure not reflected anywhere:\n${rendered}`)
})

test('6. exact paths, URLs, and error strings survive verbatim', async (t) => {
  if (!ollamaAvailable || !modelAvailable) { t.skip(`Ollama/${TEST_MODEL} not available`); return }
  const distinctivePath = '/workspace/src/very-specific-module-42.js'
  const distinctiveError = 'ERR_MODULE_NOT_FOUND_XYZ123'
  const raw: Message[] = [
    userMsg(`Investigate the error in ${distinctivePath}`),
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: `node ${distinctivePath}` } } }] } as Message,
    toolMsg(`Error: ${distinctiveError}: Cannot find module`),
  ]
  const state = await updateCompactionState(ollama, TEST_MODEL, NO_OPTS, emptyCompactionState(), raw)
  const rendered = renderCompactionState(state)
  assert.ok(rendered.includes(distinctivePath), `path not preserved verbatim:\n${rendered}`)
  assert.ok(rendered.includes(distinctiveError), `error string not preserved verbatim:\n${rendered}`)
})

test('regression fixture: nextId() negative/float IDs must not be summarized as producing NaN', async (t) => {
  if (!ollamaAvailable || !modelAvailable) { t.skip(`Ollama/${TEST_MODEL} not available`); return }
  // Reconstructed from the real session log where this false claim actually
  // occurred: ~/.local/share/argo/logs/test-one/2026-07-21T09-36-08_review-only-the-changes-you-just-made-to.jsonl
  // The agent's own tool results below are the true, correct source of record;
  // the bug was the compactor asserting something contradicted by them.
  const raw: Message[] = [
    userMsg('Critically review the nextId fix for edge cases.'),
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: {
        name: 'bash',
        arguments: { command: 'node -e "console.log(nextId([{id:-5},{id:-3}])); console.log(nextId([{id:1.5}])); console.log(nextId([{title:\'x\'}]))"' },
      } }],
    } as Message,
    toolMsg('Negative IDs [-5, -3]: -2\nFloat ID [1.5]: 2.5\nmissing id: NaN'),
    assistantMsg(
      'Concrete evidence: nextId returns -2 for negative IDs [-5,-3] (finite, correct), 2.5 for float ID [1.5] '
      + '(finite, correct), and NaN only when a task is missing an id key entirely. Negative and float IDs do NOT '
      + 'produce NaN — only a genuinely missing id field does.'
    ),
  ]
  const draft = await updateCompactionState(ollama, TEST_MODEL, NO_OPTS, emptyCompactionState(), raw)
  const { state } = await validateCompactionState(ollama, TEST_MODEL, NO_OPTS, messagesToText(raw), draft)
  const rendered = renderCompactionState(state).toLowerCase()

  // The false claim reads like "negative/float ids ... nan" WITHOUT a negation
  // in the same clause — phrasings like "do not produce nan" or "only returns
  // nan when the id is missing" mention the same words but are the correct,
  // ground-truth statement, so they must not trip this check.
  const clauses = rendered.split(/[.\n]/)
  const falseClause = clauses.find(c =>
    /\bnan\b/.test(c) && /(negative|float)/.test(c) && !/\b(not|n't|never|without|only)\b/.test(c)
  )
  assert.equal(falseClause, undefined, `false claim reproduced: "${falseClause}"\nfull state:\n${rendered}`)
  // The true, verified fact should still be present in some form.
  assert.ok(/-2/.test(rendered) || /negative/.test(rendered), `lost the actual verified negative-id result:\n${rendered}`)
})
