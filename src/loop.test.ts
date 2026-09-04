import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createLoopState,
  noteMutation,
  noteBashExecution,
  recordResult,
  evaluateCall,
  normalizeCallKey,
  l0ReplayMessage,
  l0SteerMessage,
  l1SteerMessage,
  l2ReframeMessage,
  lHaltMessage,
  noteGateRejection,
  clearPlanGateRejections,
  gateEscalationMessage,
  gateStopMessage,
  type LoopContext,
} from './loop.js'

const ctx: LoopContext = {
  toolName: 'run_tests',
  recite: 'Objective: ship feature X. Current task: fix failing test.',
  hasTasks: true,
}

const ctxNoTasks: LoopContext = { ...ctx, hasTasks: false }

// A generic args object for tests that only care about the KEY-level ladder
// mechanics (allow/block/escalate), not about FIX 2's raw-args replay check —
// every call in a test that uses this constant is "the same call" by construction.
const ARGS = { path: '/workspace/x.ts' }

// ── createLoopState ───────────────────────────────────────────────

test('createLoopState: empty defaults', () => {
  const state = createLoopState()
  assert.equal(state.lastMutationByKey.size, 0)
  assert.equal(state.mutationCount, 0)
  assert.equal(state.blocks, 0)
  assert.equal(state.compactedForStreak, false)
  assert.equal(state.lastResultByKey.size, 0)
  assert.equal(state.replaysByKey.size, 0)
})

// ── evaluateCall: first call always allowed ─────────────────────

test('evaluateCall: first-ever call is allowed and recorded at current mutationCount', () => {
  const state = createLoopState()
  const action = evaluateCall(state, 'X', ARGS, ctx)
  assert.deepEqual(action, { kind: 'allow' })
  assert.equal(state.lastMutationByKey.get('X'), 0)
})

// ── evaluateCall: repeat with no mutation, no cached result ──────

test('evaluateCall: identical call with no mutation and no cached result falls back to the plain L0 steer', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  const second = evaluateCall(state, 'X', ARGS, ctx)
  assert.equal(second.kind, 'steer')
  if (second.kind === 'steer') assert.equal(second.level, 'L0')
})

// ── mutation-aware re-test ────────────────────────────────────────

test('evaluateCall: a repeat after a mutation is allowed again (progress resets)', () => {
  const state = createLoopState()
  assert.deepEqual(evaluateCall(state, 'X', ARGS, ctx), { kind: 'allow' })
  noteMutation(state)
  assert.deepEqual(evaluateCall(state, 'X', ARGS, ctx), { kind: 'allow' })
})

// ── escalation ladder (no cached result recorded — exercises the fallback path) ──

test('evaluateCall: escalation ladder hits L0 steer, L1 once, L0 steer, then L2', () => {
  const state = createLoopState()
  // Prime the key so subsequent calls are all "no progress" repeats. No
  // recordResult call anywhere in this test, so the L0 rung always falls back to
  // the plain steer (no cached result to serve) — see the dedicated replay tests
  // below for the case where a result WAS recorded.
  evaluateCall(state, 'X', ARGS, ctx)

  const results: Array<{ blocks: number; kind: string; level?: string }> = []
  for (let i = 0; i < 6; i++) {
    const action = evaluateCall(state, 'X', ARGS, ctx)
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
  evaluateCall(state, 'X', ARGS, ctx)
  for (let i = 0; i < 3; i++) evaluateCall(state, 'X', ARGS, ctx) // blocks 1,2,3 -> compact at 3
  assert.equal(state.compactedForStreak, true)
  const fourth = evaluateCall(state, 'X', ARGS, ctx) // blocks 4
  assert.equal(fourth.kind, 'steer')
})

// ── noteMutation resets the streak ────────────────────────────────

test('noteMutation: resets blocks and compactedForStreak, unblocking a subsequent identical call', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  for (let i = 0; i < 3; i++) evaluateCall(state, 'X', ARGS, ctx) // drives to L1 compact, blocks=3
  assert.equal(state.blocks, 3)
  assert.equal(state.compactedForStreak, true)

  noteMutation(state)
  assert.equal(state.blocks, 0)
  assert.equal(state.compactedForStreak, false)

  const action = evaluateCall(state, 'X', ARGS, ctx)
  assert.deepEqual(action, { kind: 'allow' })
})

// ── independent keys ───────────────────────────────────────────────

test('evaluateCall: different keys do not cross-trigger', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  evaluateCall(state, 'X', ARGS, ctx) // X blocked once, blocks=1
  evaluateCall(state, 'X', ARGS, ctx) // blocks=2

  const y = evaluateCall(state, 'Y', ARGS, ctx) // brand-new key
  assert.deepEqual(y, { kind: 'allow' })
  assert.equal(state.blocks, 2) // unaffected by Y
})

// ── cached replay (H20 §3: serve the previous result instead of a bare block) ────

test('evaluateCall: first no-progress repeat of a key with a recorded result is served as a replay', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx) // allow
  recordResult(state, 'X', ARGS, { output: 'file contents here' })

  const action = evaluateCall(state, 'X', ARGS, ctx)
  assert.equal(action.kind, 'replay')
  if (action.kind === 'replay') {
    assert.equal(action.level, 'L0')
    assert.deepEqual(action.cached, { output: 'file contents here' })
    assert.match(action.message, /EXACT same/)
    assert.match(action.message, /reproduced verbatim/)
  }
})

test('evaluateCall: replay carries an error result too, not just a successful one', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  recordResult(state, 'X', ARGS, { output: '', error: 'ENOENT: no such file' })

  const action = evaluateCall(state, 'X', ARGS, ctx)
  assert.equal(action.kind, 'replay')
  if (action.kind === 'replay') assert.deepEqual(action.cached, { output: '', error: 'ENOENT: no such file' })
})

test('evaluateCall: replay budget is capped at cfg.maxReplaysPerKey, then falls back to the plain steer', () => {
  const state = createLoopState()
  const cfg = { l1BlocksBeforeCompact: 100, l2BlocksBeforeAbort: 200, maxReplaysPerKey: 2 }
  evaluateCall(state, 'X', ARGS, ctx, cfg)
  recordResult(state, 'X', ARGS, { output: 'same every time' })

  const first = evaluateCall(state, 'X', ARGS, ctx, cfg)
  const second = evaluateCall(state, 'X', ARGS, ctx, cfg)
  const third = evaluateCall(state, 'X', ARGS, ctx, cfg)
  assert.equal(first.kind, 'replay')
  assert.equal(second.kind, 'replay') // budget = 2, so a second replay is still allowed
  assert.equal(third.kind, 'steer')   // budget exhausted — plain textual steer now
})

test('evaluateCall: a mutation resets a key\'s replay budget, not just its block count', () => {
  const state = createLoopState()
  const cfg = { l1BlocksBeforeCompact: 100, l2BlocksBeforeAbort: 200, maxReplaysPerKey: 1 }
  evaluateCall(state, 'X', ARGS, ctx, cfg)
  recordResult(state, 'X', ARGS, { output: 'v1' })
  assert.equal(evaluateCall(state, 'X', ARGS, ctx, cfg).kind, 'replay')  // uses the 1 replay
  assert.equal(evaluateCall(state, 'X', ARGS, ctx, cfg).kind, 'steer')   // budget exhausted

  noteMutation(state)                              // a real edit/write happened
  assert.equal(evaluateCall(state, 'X', ARGS, ctx, cfg).kind, 'allow')   // fresh execution
  recordResult(state, 'X', ARGS, { output: 'v2' })
  const replay = evaluateCall(state, 'X', ARGS, ctx, cfg) // budget is fresh again
  assert.equal(replay.kind, 'replay')
  if (replay.kind === 'replay') assert.deepEqual(replay.cached, { output: 'v2' }) // latest result, not v1
})

test('evaluateCall: the global blocks counter (and therefore L1/L2 timing) is unaffected by whether L0 replays or steers', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  recordResult(state, 'X', ARGS, { output: 'same' })
  const kinds: string[] = []
  for (let i = 0; i < 6; i++) kinds.push(evaluateCall(state, 'X', ARGS, ctx).kind)
  // maxReplaysPerKey defaults to 1: block1 -> replay, block2 -> steer, block3 -> compact,
  // block4,5 -> steer, block6 -> replan. Same escalation schedule as the no-cache case.
  assert.deepEqual(kinds, ['replay', 'steer', 'compact', 'steer', 'steer', 'replan'])
})

// ── FIX 1 (/shared/argo-loopfix/REPORT.md, review defect 1): noteBashExecution
// invalidates every cached result, so a later no-progress repeat of a key whose
// cache predates a `bash` call falls back to the plain steer instead of serving
// stale content while claiming "nothing has changed" — the bash call itself might
// have changed exactly that. This is the module-level pin for the defect; the
// agent-level pin (proving the wiring actually calls noteBashExecution after a real
// `bash` tool call) lives in agent.test.ts.

test('noteBashExecution: invalidates a cached result — the next no-progress repeat gets the plain steer, not a replay', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx) // allow
  recordResult(state, 'X', ARGS, { output: 'pre-bash contents' })

  noteBashExecution(state) // a bash call ran in between (its own key, not asserted here)

  const action = evaluateCall(state, 'X', ARGS, ctx)
  assert.equal(action.kind, 'steer') // NOT replay — the cache is gone
  // The block/escalation decision itself is untouched by the invalidation:
  // mutationCount and blocks behave exactly as the no-cache case above.
  assert.equal(state.blocks, 1)
})

test('noteBashExecution: does NOT reset mutationCount, blocks, or compactedForStreak — invalidating a cache is not progress', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  for (let i = 0; i < 3; i++) evaluateCall(state, 'X', ARGS, ctx) // blocks=3, L1 compact fired
  assert.equal(state.blocks, 3)
  assert.equal(state.compactedForStreak, true)
  const mutationCountBefore = state.mutationCount

  noteBashExecution(state)

  assert.equal(state.blocks, 3)                              // unchanged
  assert.equal(state.compactedForStreak, true)                // unchanged
  assert.equal(state.mutationCount, mutationCountBefore)       // unchanged
})

test('noteBashExecution: clears every key\'s cache, not just one — a bash call\'s blast radius is unknowable without a parser', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  recordResult(state, 'X', ARGS, { output: 'x contents' })
  evaluateCall(state, 'Y', ARGS, ctx)
  recordResult(state, 'Y', ARGS, { output: 'y contents' })

  noteBashExecution(state)

  assert.equal(evaluateCall(state, 'X', ARGS, ctx).kind, 'steer')
  assert.equal(evaluateCall(state, 'Y', ARGS, ctx).kind, 'steer')
})

// ── FIX 2 (cone's call, subsuming review defect 3): a cached result may only be
// replayed when the CURRENT call's args are exactly what produced it — a
// normalised-equal-but-raw-different repeat (e.g. adding a trailing `2>&1`) still
// counts as a no-progress block (the escalation ladder must not be evadable this
// way — that is the H20 fix this preserves) but must NOT be served the other
// command's cached output, since they can produce genuinely different real bytes
// (/shared/argo-review/REPORT.md defect 3: stdout/stderr interleaving order).

test('FIX 2: a normalised-equal but raw-different repeat (trailing 2>&1) is blocked but not replayed', () => {
  const state = createLoopState()
  const cmdA = { command: "printf 'first\\n'; printf 'ERR\\n' >&2; printf 'last\\n'" }
  const cmdB = { command: "printf 'first\\n'; printf 'ERR\\n' >&2; printf 'last\\n' 2>&1" }
  const key = normalizeCallKey('bash', cmdA)
  assert.equal(key, normalizeCallKey('bash', cmdB)) // same normalised key — recognised as a repeat

  evaluateCall(state, key, cmdA, ctx) // allow, executes as cmdA
  recordResult(state, key, cmdA, { output: 'first\nlast\nERR\n' }) // real bytes WITHOUT 2>&1

  // The repeat arrives with cmdB's raw args (2>&1 appended) — same key, so still a
  // no-progress block for escalation purposes, but the cached result was produced
  // by DIFFERENT raw args, so it must not be served back.
  const action = evaluateCall(state, key, cmdB, ctx)
  assert.equal(action.kind, 'steer') // blocked, NOT replayed
  assert.equal(state.blocks, 1)      // still counted as a repeat for the ladder
})

test('FIX 2: the SAME raw args (byte for byte) after a first no-progress repeat still replays normally', () => {
  const state = createLoopState()
  const cmd = { command: 'cat -n /workspace/src/validation.js' }
  const key = normalizeCallKey('bash', cmd)
  evaluateCall(state, key, cmd, ctx)
  recordResult(state, key, cmd, { output: 'file contents' })

  const action = evaluateCall(state, key, cmd, ctx)
  assert.equal(action.kind, 'replay') // identical raw args — safe to replay
})

test('FIX 2: object key order alone does not defeat a replay (still the same canonical args)', () => {
  const state = createLoopState()
  const key = normalizeCallKey('write_file', { path: '/workspace/x.txt', content: 'hi' })
  evaluateCall(state, key, { path: '/workspace/x.txt', content: 'hi' }, ctx)
  recordResult(state, key, { path: '/workspace/x.txt', content: 'hi' }, { output: 'wrote it' })

  // Reordered keys — canonicalArgsKey treats this as identical (key order carries
  // no meaning and changes no argument value), unlike normalizeCallKey's path/bash
  // rules, which DO change values and are therefore excluded from the replay check.
  const action = evaluateCall(state, key, { content: 'hi', path: '/workspace/x.txt' }, ctx)
  assert.equal(action.kind, 'replay')
})

// ── normalizeCallKey (H20): what it collapses ─────────────────────

test('normalizeCallKey: reordered JSON keys in the args object collapse', () => {
  const a = normalizeCallKey('write_file', { path: '/workspace/x.txt', content: 'hi' })
  const b = normalizeCallKey('write_file', { content: 'hi', path: '/workspace/x.txt' })
  assert.equal(a, b)
})

test('normalizeCallKey: a leading "./" in a path argument collapses', () => {
  const a = normalizeCallKey('read_file', { path: './src/loop.ts' })
  const b = normalizeCallKey('read_file', { path: 'src/loop.ts' })
  assert.equal(a, b)
})

test('normalizeCallKey: doubled internal slashes in a path argument collapse', () => {
  const a = normalizeCallKey('read_file', { path: '/workspace//src/loop.ts' })
  const b = normalizeCallKey('read_file', { path: '/workspace/src/loop.ts' })
  assert.equal(a, b)
})

// FIX 3 (/shared/argo-review/REPORT.md's normalisation table): the trailing-slash
// rule was REMOVED because read_file('x/') can fail with an ENOTDIR-class error
// where read_file('x') succeeds — collapsing them would hide a real success/
// failure boundary, not just a spelling difference.
test('normalizeCallKey: a trailing slash on a path argument no longer collapses (FIX 3 — can hide an ENOTDIR-class failure boundary)', () => {
  const a = normalizeCallKey('read_file', { path: '/workspace/x' })
  const b = normalizeCallKey('read_file', { path: '/workspace/x/' })
  assert.notEqual(a, b)
})

test('normalizeCallKey: a trailing 2>&1 on a bash command collapses (the measured evasion)', () => {
  const a = normalizeCallKey('bash', { command: 'cat -n /workspace/src/validation.js' })
  const b = normalizeCallKey('bash', { command: 'cat -n /workspace/src/validation.js 2>&1' })
  assert.equal(a, b)
})

test('normalizeCallKey: stacked trailing redirections (>/dev/null 2>&1) collapse', () => {
  const a = normalizeCallKey('bash', { command: './run.sh' })
  const b = normalizeCallKey('bash', { command: './run.sh >/dev/null 2>&1' })
  assert.equal(a, b)
})

test('normalizeCallKey: quotes around a plain trailing path token collapse', () => {
  const a = normalizeCallKey('bash', { command: 'cat -n file.txt' })
  const b = normalizeCallKey('bash', { command: 'cat -n "file.txt"' })
  const c = normalizeCallKey('bash', { command: "cat -n 'file.txt'" })
  assert.equal(a, b)
  assert.equal(a, c)
})

test('normalizeCallKey: a leading "./" on the trailing bash token collapses', () => {
  const a = normalizeCallKey('bash', { command: 'cat file.txt' })
  const b = normalizeCallKey('bash', { command: 'cat ./file.txt' })
  assert.equal(a, b)
})

test('normalizeCallKey: leading/trailing whitespace around a bash command collapses', () => {
  const a = normalizeCallKey('bash', { command: 'ls -la' })
  const b = normalizeCallKey('bash', { command: '  ls -la  ' })
  assert.equal(a, b)
})

// ── normalizeCallKey: what it refuses to collapse ─────────────────

test('normalizeCallKey: does not collapse across tools (read_file vs bash cat of the same path)', () => {
  const a = normalizeCallKey('read_file', { path: '/workspace/x.txt' })
  const b = normalizeCallKey('bash', { command: 'cat /workspace/x.txt' })
  assert.notEqual(a, b)
})

test('normalizeCallKey: does not collapse a trailing "| head" being added or removed', () => {
  const a = normalizeCallKey('bash', { command: 'node --test /workspace/test/effort.test.js' })
  const b = normalizeCallKey('bash', { command: 'node --test /workspace/test/effort.test.js | head -80' })
  assert.notEqual(a, b)
})

test('normalizeCallKey: does not collapse a redirection into a real file', () => {
  const a = normalizeCallKey('bash', { command: 'node --test /workspace/test/effort.test.js' })
  const b = normalizeCallKey('bash', { command: 'node --test /workspace/test/effort.test.js > /tmp/out.txt' })
  const c = normalizeCallKey('bash', { command: 'node --test /workspace/test/effort.test.js | tee /tmp/out.txt' })
  assert.notEqual(a, b)
  assert.notEqual(a, c)
})

test('normalizeCallKey: does not collapse quotes that guard a glob or whitespace (not purely cosmetic)', () => {
  const a = normalizeCallKey('bash', { command: 'ls *.txt' })
  const b = normalizeCallKey('bash', { command: 'ls "*.txt"' })
  assert.notEqual(a, b) // glob expansion differs — quoting here is NOT cosmetic

  const c = normalizeCallKey('bash', { command: 'echo hello world' })
  const d = normalizeCallKey('bash', { command: 'echo "hello world"' })
  assert.notEqual(c, d) // word-splitting differs — two args vs one
})

test('normalizeCallKey: does not collapse "../x" into "x" (a genuinely different path)', () => {
  const a = normalizeCallKey('bash', { command: 'cat ../secrets.env' })
  const b = normalizeCallKey('bash', { command: 'cat secrets.env' })
  assert.notEqual(a, b)
})

test('normalizeCallKey: does not collapse a materially different argument alongside an identical command', () => {
  const a = normalizeCallKey('bash', { command: 'npm test', timeout_ms: 30000 })
  const b = normalizeCallKey('bash', { command: 'npm test', timeout_ms: 120000 })
  assert.notEqual(a, b)

  const c = normalizeCallKey('edit_file', { path: '/workspace/x.ts', old_string: 'a', new_string: 'b' })
  const d = normalizeCallKey('edit_file', { path: '/workspace/x.ts', old_string: 'a', new_string: 'c' })
  assert.notEqual(c, d)
})

test('normalizeCallKey: does not collapse interior whitespace differences in a bash command', () => {
  // Only the string's own leading/trailing whitespace is touched (see the "why
  // only the end" rationale in loop.ts) — a doubled space in the MIDDLE of a
  // command could be inside a quoted, whitespace-significant string, so it is
  // left alone rather than risk collapsing two commands whose quoted content
  // actually differs.
  const a = normalizeCallKey('bash', { command: 'echo "a  b"' })
  const b = normalizeCallKey('bash', { command: 'echo "a b"' })
  assert.notEqual(a, b)
})

// ── message builders ──────────────────────────────────────────────

test('l0ReplayMessage: mentions toolName, "reproduced", and includes recite', () => {
  const msg = l0ReplayMessage(ctx)
  assert.match(msg, /run_tests/)
  assert.match(msg, /reproduced/)
  assert.ok(msg.includes(ctx.recite))
})

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
  const msg = l2ReframeMessage(ctx, 6)
  assert.match(msg, /update_plan/)
  assert.ok(msg.includes(ctx.recite))
})

test('l2ReframeMessage: does not mention update_plan when hasTasks is false', () => {
  const msg = l2ReframeMessage(ctxNoTasks, 6)
  assert.doesNotMatch(msg, /update_plan/)
  assert.ok(msg.includes(ctxNoTasks.recite))
})

test('l2ReframeMessage: includes the block count, so two consecutive firings are not byte-identical (H21b)', () => {
  const first = l2ReframeMessage(ctx, 6)
  const second = l2ReframeMessage(ctx, 7)
  assert.match(first, /6 consecutive stalled calls/)
  assert.match(second, /7 consecutive stalled calls/)
  assert.notEqual(first, second)
})

// ── H21(b): the ladder's L2 rung is itself unbounded without the 'halt' tier —
// captured live (commander/2026-09-04T01-48-24_fix-checkforrequiredlocaloptions-
// at.jsonl): L2 fired ~30 times running, each ignored. This pins evaluateCall's
// own escalation path all the way through 'halt', extending the existing L0/L1/L2
// ladder test above (which stops at the first L2 firing).

test('evaluateCall: L2 keeps firing (unbounded) until haltBlocksAfterAbort further blocks, then reports halt', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx) // primes the key
  const kinds: string[] = []
  // DEFAULT_LOOP_CONFIG: l2BlocksBeforeAbort=6, haltBlocksAfterAbort=4 -> halt at blocks=10.
  for (let i = 0; i < 10; i++) kinds.push(evaluateCall(state, 'X', ARGS, ctx).kind)
  assert.deepEqual(kinds, ['steer', 'steer', 'compact', 'steer', 'steer', 'replan', 'replan', 'replan', 'replan', 'halt'])
  assert.equal(state.blocks, 10)
})

test('evaluateCall: halt fires exactly once per streak reaching the threshold, and its message names the count', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  for (let i = 0; i < 9; i++) evaluateCall(state, 'X', ARGS, ctx) // drive to blocks=9 (still L2)
  const nineth = evaluateCall(state, 'X', ARGS, ctx) // blocks=10 -> halt
  assert.equal(nineth.kind, 'halt')
  if (nineth.kind === 'halt') assert.match(nineth.message, /10 consecutive calls/)
})

test('evaluateCall: a mutation resets the streak even after halt would otherwise have fired', () => {
  const state = createLoopState()
  evaluateCall(state, 'X', ARGS, ctx)
  for (let i = 0; i < 9; i++) evaluateCall(state, 'X', ARGS, ctx) // blocks=9, one more away from halt
  noteMutation(state)
  assert.equal(state.blocks, 0)
  const action = evaluateCall(state, 'X', ARGS, ctx)
  assert.deepEqual(action, { kind: 'allow' })
})

// ── H21(a): the GATE-REJECTION counter — role gate / plan-act gate rejections
// that never reach evaluateCall at all (agent.ts's tool-call loop `continue`s
// past it on either gate). See loop.ts's H21 header note and noteGateRejection's
// doc comment for the evidence (two Planner frames issuing 9 and 7 rejected
// `bash` calls, all refused on role, DRIVER-LOG.md 2026-09-04 ~01:00) and for why
// keying on (call, reason) — not the call alone — is what keeps the plan/act
// gate's legitimate retry-after-plan safe.

test('noteGateRejection: counts up per (key, reason), independent of the call\'s own key', () => {
  const state = createLoopState()
  const a = noteGateRejection(state, 'bash:{"command":"x"}', 'role')
  const b = noteGateRejection(state, 'bash:{"command":"x"}', 'role')
  const c = noteGateRejection(state, 'bash:{"command":"x"}', 'role')
  assert.deepEqual([a.count, b.count, c.count], [1, 2, 3])
  assert.deepEqual([a.escalate, b.escalate, c.escalate], [false, false, true])  // gateEscalateAfter=3
  assert.deepEqual([a.stop, b.stop, c.stop], [false, false, false])              // gateStopAfter=6
})

test('noteGateRejection: a DIFFERENT reason for the SAME call key counts separately', () => {
  const state = createLoopState()
  noteGateRejection(state, 'edit_file:{"path":"/workspace/x"}', 'role')
  noteGateRejection(state, 'edit_file:{"path":"/workspace/x"}', 'role')
  // Same key, but refused by the OTHER gate — its own count starts at 1, not 3.
  const planOutcome = noteGateRejection(state, 'edit_file:{"path":"/workspace/x"}', 'plan')
  assert.equal(planOutcome.count, 1)
  assert.equal(planOutcome.escalate, false)
})

test('noteGateRejection: reaches stop at gateStopAfter (default 6), not sooner', () => {
  const state = createLoopState()
  const outcomes = []
  for (let i = 0; i < 6; i++) outcomes.push(noteGateRejection(state, 'K', 'role'))
  assert.deepEqual(outcomes.map(o => o.stop), [false, false, false, false, false, true])
})

test('clearPlanGateRejections: clears every "plan"-reason key, but leaves "role" counts untouched', () => {
  const state = createLoopState()
  noteGateRejection(state, 'A', 'plan')
  noteGateRejection(state, 'B', 'plan')
  noteGateRejection(state, 'A', 'role')
  clearPlanGateRejections(state)
  // Both plan-reason keys are gone (a fresh call re-hitting the plan gate — which
  // cannot happen once a plan exists, but the counter itself must not lie about
  // it — starts back at count 1).
  assert.equal(noteGateRejection(state, 'A', 'plan').count, 1)
  assert.equal(noteGateRejection(state, 'B', 'plan').count, 1)
  // The UNRELATED role-reason count for the same key A survived the clear —
  // clearing 'plan' must never contaminate a different gate's count for the same call.
  assert.equal(noteGateRejection(state, 'A', 'role').count, 2)
})

test('gateEscalationMessage: role reason names the tool as unavailable and forbids retrying it; plan reason names update_plan', () => {
  const roleMsg = gateEscalationMessage('role', 'bash', 4, 'RECITE')
  assert.match(roleMsg, /does not exist for you in this role/)
  assert.match(roleMsg, /Do NOT call `bash` again/)
  assert.match(roleMsg, /4 times/)
  assert.ok(roleMsg.includes('RECITE'))

  const planMsg = gateEscalationMessage('plan', 'edit_file', 5, 'RECITE')
  assert.match(planMsg, /update_plan/)
  assert.match(planMsg, /5 times/)
})

test('gateEscalationMessage: consecutive counts produce non-identical text (the defect this responds to)', () => {
  const third = gateEscalationMessage('role', 'bash', 3, 'R')
  const fourth = gateEscalationMessage('role', 'bash', 4, 'R')
  assert.notEqual(third, fourth)
})

test('gateStopMessage: names the tool, the count, and the specific gate', () => {
  const msg = gateStopMessage('role', 'bash', 6)
  assert.match(msg, /bash/)
  assert.match(msg, /6 times/)
  assert.match(msg, /role tool restriction/)

  const planMsg = gateStopMessage('plan', 'edit_file', 6)
  assert.match(planMsg, /plan-before-mutation gate/)
})

test('lHaltMessage: names the block count and references the ignored L2 request', () => {
  const msg = lHaltMessage(ctx, 10)
  assert.match(msg, /10 consecutive calls/)
  assert.match(msg, /update_plan/)
  assert.match(msg, /STOPPING this frame/)
})
