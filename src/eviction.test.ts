import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from 'ollama'
import {
  classifyTool,
  inferDependencies,
  renderPinnedAnchor,
  evict,
  DEFAULT_EVICTION_BUDGET,
  type EpisodeMeta,
  type EvictionBudget,
} from './eviction.js'

// ── classifyTool ─────────────────────────────────────────────────

test('classifyTool: known exploratory tools', () => {
  assert.equal(classifyTool('read_file'), 'exploratory')
  assert.equal(classifyTool('web_search'), 'exploratory')
  assert.equal(classifyTool('fetch_url'), 'exploratory')
  assert.equal(classifyTool('view_image'), 'exploratory')
})

test('classifyTool: known action tools', () => {
  assert.equal(classifyTool('write_file'), 'action')
  assert.equal(classifyTool('edit_file'), 'action')
  assert.equal(classifyTool('bash'), 'action')
})

test('classifyTool: unknown tools default to action (never evicted early)', () => {
  assert.equal(classifyTool('some_future_tool'), 'action')
})

// ── inferDependencies ────────────────────────────────────────────

test('inferDependencies: an action depends on exploratory episodes since the last action', () => {
  const prior: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'exploratory', tool: 'read_file', messageIndex: 0, dependsOn: [] },
    { episodeId: 'e2', kind: 'action', tool: 'bash', messageIndex: 1, dependsOn: [] },
    { episodeId: 'e3', kind: 'exploratory', tool: 'read_file', messageIndex: 2, dependsOn: [] },
    { episodeId: 'e4', kind: 'exploratory', tool: 'web_search', messageIndex: 3, dependsOn: [] },
  ]
  assert.deepEqual(inferDependencies(prior, 'action'), ['e3', 'e4'])
})

test('inferDependencies: exploratory episodes never declare dependencies', () => {
  const prior: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
  ]
  assert.deepEqual(inferDependencies(prior, 'exploratory'), [])
})

test('inferDependencies: empty prior history yields no dependencies', () => {
  assert.deepEqual(inferDependencies([], 'action'), [])
})

// ── renderPinnedAnchor ───────────────────────────────────────────

test('renderPinnedAnchor: empty when neither objective nor plan present', () => {
  assert.equal(renderPinnedAnchor(null, null), '')
})

test('renderPinnedAnchor: includes the objective verbatim', () => {
  const rendered = renderPinnedAnchor('ship the feature exactly as specified', null)
  assert.ok(rendered.includes('ship the feature exactly as specified'))
  assert.ok(rendered.includes('OBJECTIVE'))
})

// ── evict: token-budget semantics ────────────────────────────────

function toolMsg(content: string): Message { return { role: 'tool', content } }
function assistantMsg(content: string): Message { return { role: 'assistant', content } }
function userMsg(content: string): Message { return { role: 'user', content } }

test('evict: under budget is a no-op and reports equal before/after token estimates', () => {
  const messages: Message[] = [userMsg('short'), assistantMsg('also short')]
  const episodes: EpisodeMeta[] = []
  const result = evict(messages, episodes, { maxTokens: 10_000 })
  assert.deepEqual(result.messages, messages)
  assert.deepEqual(result.evictedEpisodeIds, [])
  assert.equal(result.tokenEstimateBefore, result.tokenEstimateAfter)
})

test('evict: budget is interpreted in tokens (chars/3.5), not raw chars', () => {
  // 350 chars ~= 100 tokens estimate. A char-based budget of 200 would have
  // wrongly considered this "over budget"; a token budget of 200 must not.
  const content = 'x'.repeat(350)
  const messages: Message[] = [toolMsg(content)]
  const result = evict(messages, [], { maxTokens: 200 })
  assert.equal(result.evictedEpisodeIds.length, 0)
  assert.ok(Math.abs(result.tokenEstimateBefore - 100) < 1)
})

test('evict: oldest action episodes are stubbed first, then exploratory episodes with no live dependents', () => {
  const bigContent = 'y'.repeat(3500) // ~1000 tokens each
  const messages: Message[] = [
    toolMsg(bigContent), // action episode e1 (oldest)
    toolMsg(bigContent), // exploratory episode e2, nothing depends on it
    toolMsg(bigContent), // action episode e3 (newest)
  ]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
    { episodeId: 'e2', kind: 'exploratory', tool: 'read_file', messageIndex: 1, dependsOn: [] },
    { episodeId: 'e3', kind: 'action', tool: 'bash', messageIndex: 2, dependsOn: [] },
  ]
  // ~3000 tokens total; budget forces exactly one eviction to get under ~2000.
  const result = evict(messages, episodes, { maxTokens: 2000 })
  assert.ok(result.evictedEpisodeIds.includes('e1'), 'oldest action episode should be evicted first')
  assert.equal(messages, messages) // original array untouched (evict copies)
})

test('evict: never evicts an exploratory episode a still-live action depends on', () => {
  const bigContent = 'z'.repeat(3500)
  const messages: Message[] = [
    toolMsg(bigContent), // e1 exploratory, depended on by e2
    toolMsg(bigContent), // e2 action, depends on e1
  ]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'exploratory', tool: 'read_file', messageIndex: 0, dependsOn: [] },
    { episodeId: 'e2', kind: 'action', tool: 'bash', messageIndex: 1, dependsOn: ['e1'] },
  ]
  // e2 (action) is evicted first per policy; e1 (exploratory, depended-on) must
  // never be evicted even though eviction can't reach budget without it.
  const result = evict(messages, episodes, { maxTokens: 1 })
  assert.ok(result.evictedEpisodeIds.includes('e2'))
  assert.ok(!result.evictedEpisodeIds.includes('e1'), 'depended-on exploratory episode must survive')
})

test('evict: original messages array and its objects are not mutated', () => {
  const messages: Message[] = [toolMsg('w'.repeat(3500))]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
  ]
  const originalContent = messages[0].content
  evict(messages, episodes, { maxTokens: 1 })
  assert.equal(messages[0].content, originalContent)
})

test('evict: stub content names the episodeId and tool for recovery via ledger expand', () => {
  const messages: Message[] = [toolMsg('v'.repeat(3500))]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'ep-abc', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
  ]
  const result = evict(messages, episodes, { maxTokens: 1 })
  const stubbed = result.messages[0].content as string
  assert.ok(stubbed.includes('ep-abc'))
  assert.ok(stubbed.includes('bash'))
  assert.ok(stubbed.includes('expand'))
})

test('evict: an already-evicted stub is skipped, not re-stubbed or double-counted', () => {
  const stub = '[evicted — episode e1, 3500 chars, tool bash; call ledger with action "expand" and this episodeId to recover it]'
  const messages: Message[] = [{ role: 'tool', content: stub }]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
  ]
  const result = evict(messages, episodes, { maxTokens: 1 })
  assert.ok(!result.evictedEpisodeIds.includes('e1'))
  assert.equal(result.messages[0].content, stub)
})

// ── evict: second-pass assistant truncation (the fallback safety valve) ──

test('evict: falls back to truncating long assistant messages when episodes alone are insufficient', () => {
  const longAssistant = 'a'.repeat(4000) // ~1143 tokens, well over TRUNCATE_THRESHOLD
  const messages: Message[] = [
    assistantMsg(longAssistant),
    userMsg('short user turn'),
  ]
  // No episodes at all to evict — assistant content is the only lever available.
  const result = evict(messages, [], { maxTokens: 100 })
  const truncated = result.messages[0].content as string
  assert.ok(truncated.length < longAssistant.length, 'assistant message should have been truncated')
  assert.ok(truncated.includes('truncated from 4000 chars'))
  assert.ok(result.tokenEstimateAfter < result.tokenEstimateBefore)
})

test('evict: assistant truncation leaves short messages alone', () => {
  const shortAssistant = 'brief thought'
  const messages: Message[] = [assistantMsg(shortAssistant)]
  const result = evict(messages, [], { maxTokens: 1 })
  assert.equal(result.messages[0].content, shortAssistant)
})

test('evict: assistant truncation never touches user or tool messages', () => {
  const longUser = 'u'.repeat(4000)
  const longTool = 't'.repeat(4000)
  const messages: Message[] = [userMsg(longUser), toolMsg(longTool)]
  const result = evict(messages, [], { maxTokens: 1 })
  assert.equal(result.messages[0].content, longUser)
  assert.equal(result.messages[1].content, longTool)
})

test('evict: episode eviction runs before assistant truncation (assistant only touched if still over budget)', () => {
  const bigToolContent = 'q'.repeat(35_000) // ~10,000 tokens — evicting this alone clears a modest budget
  const shortAssistant = 'brief reasoning, not touched' // under TRUNCATE_THRESHOLD anyway, but proves ordering
  const messages: Message[] = [toolMsg(bigToolContent), assistantMsg(shortAssistant)]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
  ]
  const result = evict(messages, episodes, { maxTokens: 100 })
  assert.ok(result.evictedEpisodeIds.includes('e1'))
  assert.equal(result.messages[1].content, shortAssistant)
})

test('evict: reports before/after token estimates that reflect real reduction', () => {
  const messages: Message[] = [toolMsg('r'.repeat(35_000))]
  const episodes: EpisodeMeta[] = [
    { episodeId: 'e1', kind: 'action', tool: 'bash', messageIndex: 0, dependsOn: [] },
  ]
  const result = evict(messages, episodes, { maxTokens: 100 })
  assert.ok(result.tokenEstimateBefore > 9000 && result.tokenEstimateBefore < 10_100)
  assert.ok(result.tokenEstimateAfter < result.tokenEstimateBefore)
})

// ── DEFAULT_EVICTION_BUDGET ──────────────────────────────────────

test('DEFAULT_EVICTION_BUDGET targets ~70% of the 65536 num_ctx default, in tokens', () => {
  const budget: EvictionBudget = DEFAULT_EVICTION_BUDGET
  assert.equal(budget.maxTokens, Math.floor(65_536 * 0.7))
})
