import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Message } from 'ollama'
import { estimateTokens, estimateTokensForText, sumContentChars, CHARS_PER_TOKEN } from './eviction.js'

function toolMsg(content: string): Message { return { role: 'tool', content } }
function userMsg(content: string): Message { return { role: 'user', content } }

test('estimateTokens sums content length across messages divided by CHARS_PER_TOKEN', () => {
  const messages: Message[] = [userMsg('x'.repeat(350)), toolMsg('y'.repeat(350))]
  const tokens = estimateTokens(messages)
  assert.ok(Math.abs(tokens - 700 / CHARS_PER_TOKEN) < 1e-9)
})

test('estimateTokens ignores non-string content rather than throwing', () => {
  const messages: Message[] = [{ role: 'assistant', content: '' }, userMsg('short')]
  assert.equal(estimateTokens(messages), 5 / CHARS_PER_TOKEN)
})

test('estimateTokens of an empty message list is 0', () => {
  assert.equal(estimateTokens([]), 0)
})

test('estimateTokensForText mirrors estimateTokens for a single string', () => {
  const content = 'z'.repeat(700)
  assert.equal(estimateTokensForText(content), 700 / CHARS_PER_TOKEN)
})

test('CHARS_PER_TOKEN is 3.5 — the default/fallback used only until agent.ts has a real measurement to calibrate against', () => {
  assert.equal(CHARS_PER_TOKEN, 3.5)
})

test('sumContentChars sums raw content length with no division — the basis estimateTokens/estimateTokensForText build on', () => {
  const messages: Message[] = [userMsg('x'.repeat(350)), toolMsg('y'.repeat(150)), { role: 'assistant', content: '' }]
  assert.equal(sumContentChars(messages), 500)
  assert.equal(sumContentChars([]), 0)
})

test('estimateTokens/estimateTokensForText accept an explicit charsPerToken, overriding the default', () => {
  const messages: Message[] = [userMsg('x'.repeat(100))]
  assert.equal(estimateTokens(messages, 1), 100)
  assert.equal(estimateTokens(messages, 2), 50)
  assert.equal(estimateTokensForText('y'.repeat(100), 1), 100)
  // Omitting it still falls back to the module default, unchanged.
  assert.equal(estimateTokens(messages), 100 / CHARS_PER_TOKEN)
})
