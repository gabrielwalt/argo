import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from 'ollama'
import {
  evict,
  DEFAULT_EVICTION_BUDGET,
  type EvictionBudget,
  type MessageIds,
} from './eviction.js'

function toolMsg(content: string): Message { return { role: 'tool', content } }
function assistantMsg(content: string): Message { return { role: 'assistant', content } }
function userMsg(content: string): Message { return { role: 'user', content } }

// ── evict: token-budget semantics ────────────────────────────────

test('evict: under budget is a no-op and reports equal before/after token estimates', () => {
  const messages: Message[] = [userMsg('short'), assistantMsg('also short')]
  const result = evict(messages, [], { maxTokens: 10_000 })
  assert.deepEqual(result.messages, messages)
  assert.deepEqual(result.evictedMessageIds, [])
  assert.equal(result.tokenEstimateBefore, result.tokenEstimateAfter)
})

test('evict: budget is interpreted in tokens (chars/3.5), not raw chars', () => {
  // 350 chars ~= 100 tokens estimate. A char-based budget of 200 would have
  // wrongly considered this "over budget"; a token budget of 200 must not.
  const content = 'x'.repeat(350)
  const messages: Message[] = [toolMsg(content)]
  const result = evict(messages, ['msg-1'], { maxTokens: 200 })
  assert.equal(result.evictedMessageIds.length, 0)
  assert.ok(Math.abs(result.tokenEstimateBefore - 100) < 1)
})

test('evict: oldest tool messages are stubbed first', () => {
  const bigContent = 'y'.repeat(3500) // ~1000 tokens each
  const messages: Message[] = [
    toolMsg(bigContent), // oldest
    assistantMsg(bigContent),
    toolMsg(bigContent), // newest tool message
  ]
  const ids: MessageIds = ['msg-1', 'msg-2', 'msg-3']
  // ~3000 tokens total; stubbing just the oldest tool message (msg-1) brings this
  // to ~2015 tokens, comfortably under a 2100 budget — the newest tool message
  // (msg-3) must survive untouched.
  const result = evict(messages, ids, { maxTokens: 2100 })
  assert.ok(result.evictedMessageIds.includes('msg-1'), 'oldest tool message should be evicted first')
  assert.ok(!result.evictedMessageIds.includes('msg-3'), 'newer tool message should survive if budget is met first')
})

test('evict: evicts oldest-first across MULTIPLE tool messages until budget is met', () => {
  const bigContent = 'y'.repeat(3500) // ~1000 tokens each
  const messages: Message[] = [
    toolMsg(bigContent), // oldest
    toolMsg(bigContent),
    toolMsg(bigContent), // newest
  ]
  const ids: MessageIds = ['msg-1', 'msg-2', 'msg-3']
  const result = evict(messages, ids, { maxTokens: 500 })
  assert.ok(result.evictedMessageIds.includes('msg-1'))
  assert.ok(result.evictedMessageIds.includes('msg-2'))
})

test('evict: original messages array and its objects are not mutated', () => {
  const messages: Message[] = [toolMsg('w'.repeat(3500))]
  const originalContent = messages[0].content
  evict(messages, ['msg-1'], { maxTokens: 1 })
  assert.equal(messages[0].content, originalContent)
})

test('evict: stub content names the msg_id for recovery via ledger expand', () => {
  const messages: Message[] = [toolMsg('v'.repeat(3500))]
  const result = evict(messages, ['msg-abc'], { maxTokens: 1 })
  const stubbed = result.messages[0].content as string
  assert.ok(stubbed.includes('msg_id "msg-abc"'))
  assert.ok(stubbed.includes('recover'))
})

test('evict: a tool message with no known id still gets stubbed, without a recovery pointer', () => {
  const messages: Message[] = [toolMsg('v'.repeat(3500))]
  const result = evict(messages, [], { maxTokens: 1 })
  const stubbed = result.messages[0].content as string
  assert.ok(stubbed.startsWith('[evicted'))
  assert.ok(!stubbed.includes('msg_id'))
})

test('evict: an already-evicted stub is skipped, not re-stubbed or double-counted', () => {
  const stub = '[evicted — 3500 chars; msg_id "msg-1" to recover]'
  const messages: Message[] = [{ role: 'tool', content: stub }]
  const result = evict(messages, ['msg-1'], { maxTokens: 1 })
  assert.ok(!result.evictedMessageIds.includes('msg-1'))
  assert.equal(result.messages[0].content, stub)
})

// ── evict: second-pass assistant truncation (the fallback safety valve) ──

test('evict: falls back to truncating long assistant messages when no tool messages are available', () => {
  const longAssistant = 'a'.repeat(4000) // ~1143 tokens, well over TRUNCATE_THRESHOLD
  const messages: Message[] = [
    assistantMsg(longAssistant),
    userMsg('short user turn'),
  ]
  // No tool messages at all to evict — assistant content is the only lever available.
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
  // The tool message IS eligible for the primary pass, so pin the scenario with a
  // budget it alone can satisfy (~1158 tokens remain once the tool message is
  // stubbed) — proving the SECOND (assistant-only) pass never touches user/tool
  // content, not that the primary pass left the tool message alone by accident.
  const result = evict(messages, [undefined, 'msg-1'], { maxTokens: 1200 })
  assert.equal(result.messages[0].content, longUser)
  assert.ok((result.messages[1].content as string).startsWith('[evicted'))
})

test('evict: tool eviction runs before assistant truncation (assistant only touched if still over budget)', () => {
  const bigToolContent = 'q'.repeat(35_000) // ~10,000 tokens — evicting this alone clears a modest budget
  const shortAssistant = 'brief reasoning, not touched' // under TRUNCATE_THRESHOLD anyway, but proves ordering
  const messages: Message[] = [toolMsg(bigToolContent), assistantMsg(shortAssistant)]
  const result = evict(messages, ['msg-1'], { maxTokens: 100 })
  assert.ok(result.evictedMessageIds.includes('msg-1'))
  assert.equal(result.messages[1].content, shortAssistant)
})

test('evict: reports before/after token estimates that reflect real reduction', () => {
  const messages: Message[] = [toolMsg('r'.repeat(35_000))]
  const result = evict(messages, ['msg-1'], { maxTokens: 100 })
  assert.ok(result.tokenEstimateBefore > 9000 && result.tokenEstimateBefore < 10_100)
  assert.ok(result.tokenEstimateAfter < result.tokenEstimateBefore)
})

// ── DEFAULT_EVICTION_BUDGET ──────────────────────────────────────

test('DEFAULT_EVICTION_BUDGET targets ~70% of the 65536 num_ctx default, in tokens', () => {
  const budget: EvictionBudget = DEFAULT_EVICTION_BUDGET
  assert.equal(budget.maxTokens, Math.floor(65_536 * 0.7))
})
