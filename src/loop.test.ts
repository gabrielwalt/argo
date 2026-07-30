import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLoopState,
  noteMutation,
  evaluateCall,
  l0SteerMessage,
  l1SteerMessage,
  l2ReframeMessage,
  type LoopContext,
} from './loop.js'

const ctx: LoopContext = {
  toolName: 'run_tests',
  recite: 'Objective: ship feature X. Current task: fix failing test.',
  hasTasks: true,
}

const ctxNoTasks: LoopContext = { ...ctx, hasTasks: false }

// ── createLoopState ───────────────────────────────────────────────

test('createLoopState: empty defaults', () => {
  const state = createLoopState()
  assert.equal(state.lastMutationByKey.size, 0)
  assert.equal(state.mutationCount, 0)
  assert.equal(state.blocks, 0)
  assert.equal(state.compactedForStreak, false)
})

// ── evaluateCall: first call always allowed ─────────────────────

test('evaluateCall: first-ever call is allowed and recorded at current mutationCount', () => {
  const state = createLoopState()
  const action = evaluateCall(state, 'X', ctx)
  assert.deepEqual(action, { kind: 'allow' })
  assert.equal(state.lastMutationByKey.get('X'), 0)
})

// ── evaluateCall: repeat with no mutation is blocked ─────────────

test('evaluateCall: identical call with no mutation between is blocked at L0', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ctx)
  const second = evaluateCall(state, 'X', ctx)
  assert.equal(second.kind, 'steer')
  if (second.kind === 'steer') {
    assert.equal(second.level, 'L0')
  }
})

// ── mutation-aware re-test ────────────────────────────────────────

test('evaluateCall: a repeat after a mutation is allowed again (progress resets)', () => {
  const state = createLoopState()
  assert.deepEqual(evaluateCall(state, 'X', ctx), { kind: 'allow' })
  noteMutation(state)
  assert.deepEqual(evaluateCall(state, 'X', ctx), { kind: 'allow' })
})

// ── escalation ladder ─────────────────────────────────────────────

test('evaluateCall: escalation ladder hits L0, L1 once, L0, then L2', () => {
  const state = createLoopState()
  // Prime the key so subsequent calls are all "no progress" repeats.
  evaluateCall(state, 'X', ctx)

  const results: Array<{ blocks: number; kind: string; level?: string }> = []
  for (let i = 0; i < 6; i++) {
    const action = evaluateCall(state, 'X', ctx)
    results.push({ blocks: state.blocks, kind: action.kind, level: 'level' in action ? action.level : undefined })
  }

  assert.deepEqual(
    results.map(r => [r.blocks, r.kind, r.level]),
    [
      [1, 'steer', 'L0'],
      [2, 'steer', 'L0'],
      [3, 'compact', 'L1'],
      [4, 'steer', 'L0'],
      [5, 'steer', 'L0'],
      [6, 'replan', 'L2'],
    ],
  )
})

test('evaluateCall: L1 compaction fires only once per streak', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ctx)
  for (let i = 0; i < 3; i++) evaluateCall(state, 'X', ctx) // blocks 1,2,3 -> compact at 3
  assert.equal(state.compactedForStreak, true)
  const fourth = evaluateCall(state, 'X', ctx) // blocks 4
  assert.equal(fourth.kind, 'steer')
})

// ── noteMutation resets the streak ────────────────────────────────

test('noteMutation: resets blocks and compactedForStreak, unblocking a subsequent identical call', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ctx)
  for (let i = 0; i < 3; i++) evaluateCall(state, 'X', ctx) // drives to L1 compact, blocks=3
  assert.equal(state.blocks, 3)
  assert.equal(state.compactedForStreak, true)

  noteMutation(state)
  assert.equal(state.blocks, 0)
  assert.equal(state.compactedForStreak, false)

  const action = evaluateCall(state, 'X', ctx)
  assert.deepEqual(action, { kind: 'allow' })
})

// ── independent keys ───────────────────────────────────────────────

test('evaluateCall: different keys do not cross-trigger', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ctx)
  evaluateCall(state, 'X', ctx) // X blocked once, blocks=1
  evaluateCall(state, 'X', ctx) // blocks=2

  const y = evaluateCall(state, 'Y', ctx) // brand-new key
  assert.deepEqual(y, { kind: 'allow' })
  assert.equal(state.blocks, 2) // unaffected by Y
})

// ── message builders ──────────────────────────────────────────────

test('l0SteerMessage: mentions toolName and includes recite', () => {
  const msg = l0SteerMessage(ctx)
  assert.match(msg, /run_tests/)
  assert.ok(msg.includes(ctx.recite))
})

test('l1SteerMessage: mentions toolName and includes recite', () => {
  const msg = l1SteerMessage(ctx)
  assert.match(msg, /run_tests/)
  assert.ok(msg.includes(ctx.recite))
})

test('l2ReframeMessage: mentions update_plan when hasTasks is true', () => {
  const msg = l2ReframeMessage(ctx)
  assert.match(msg, /update_plan/)
  assert.ok(msg.includes(ctx.recite))
})

test('l2ReframeMessage: does not mention update_plan when hasTasks is false', () => {
  const msg = l2ReframeMessage(ctxNoTasks)
  assert.doesNotMatch(msg, /update_plan/)
  assert.ok(msg.includes(ctxNoTasks.recite))
})
