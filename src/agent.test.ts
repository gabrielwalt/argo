import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from './config.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import type { Ollama } from 'ollama'
import { Agent, parseChangedFiles, buildFallbackCommitMessage, isCleanStatus } from './agent.js'
import { NO_OUTPUT } from './tools/bash.js'
import { ROLE_TOOLS } from './frames.js'

// Every real Agent instance (dispatch.ts's spawnFrame) always calls
// setAllowedTools()/setRole() before chat() runs — there is no unrestricted mode
// any more (an un-configured Agent offers NO tools, not every tool; see
// dispatch.test.ts's own coverage of that default). The generic loop-mechanics
// tests below are about the tool-dispatch LOOP itself (repetition/loop-recovery/
// retry/eviction), not about any one role's specific tool set, so they use the
// Implementer's tool superset (read_file/write_file/edit_file/bash/conclude/etc)
// as a stand-in "give it everything it needs" role — this mirrors agent.ts's own
// default roleTag ('implementer') exactly, so a bare `new Agent(...)` used this
// way needs only this one extra call to behave like a real frame.
function grantFullTools(agent: Agent): void {
  agent.setAllowedTools(ROLE_TOOLS.implementer)
}

test('setMaxIterations clamps out-of-range values into [10, 1000]', () => {
  const agent = new Agent(() => {})
  agent.setMaxIterations(0)
  assert.equal(agent.getMaxIterations(), 10)
  agent.setMaxIterations(5000)
  assert.equal(agent.getMaxIterations(), 1000)
  agent.setMaxIterations(500)
  assert.equal(agent.getMaxIterations(), 500)
})

test('parseChangedFiles extracts paths from git status --porcelain output', () => {
  const status = ' M src/agent.ts\n?? src/new-file.ts\nR  old-name.ts -> new-name.ts\n'
  assert.deepEqual(parseChangedFiles(status), ['src/agent.ts', 'src/new-file.ts', 'new-name.ts'])
})

test('parseChangedFiles returns an empty list for clean/blank status', () => {
  assert.deepEqual(parseChangedFiles(''), [])
  assert.deepEqual(parseChangedFiles('\n  \n'), [])
})

test('buildFallbackCommitMessage names files directly when there are few', () => {
  const msg = buildFallbackCommitMessage(['a.ts', 'b.ts'])
  assert.equal(msg, 'Agent: update a.ts, b.ts')
})

test('buildFallbackCommitMessage falls back to a count when there are many files', () => {
  const msg = buildFallbackCommitMessage(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
  assert.equal(msg, 'Agent: update 5 files')
})

test('buildFallbackCommitMessage handles no changed files', () => {
  assert.equal(buildFallbackCommitMessage([]), 'Agent: update workspace')
})

test('isCleanStatus treats bash\'s NO_OUTPUT sentinel the same as a genuinely blank status', () => {
  assert.equal(isCleanStatus(''), true)
  assert.equal(isCleanStatus('\n  \n'), true)
  assert.equal(isCleanStatus(NO_OUTPUT), true)
  assert.equal(isCleanStatus(' M src/agent.ts\n'), false)
})

// ── compactNow() — the manual trigger must reuse the same underlying eviction
// mechanism as the automatic threshold path, just marked `manual: true` and
// without waiting for the near-full trigger. Deterministic — no LLM call, since
// eviction is a pure, no-model context-management pass.

test('compactNow evicts old tool-result messages and marks the emitted event manual', async () => {
  const events: AgentEvent[] = []
  const agent = new Agent(e => events.push(e), 'test-model')
  const sessionId = `test-compact-now-${Date.now()}`
  agent.setSessionId(sessionId)
  agent.setOptions({ num_ctx: 1024 }) // small budget so a modest history is already "over"

  const lastMessage = 'EXACT CURRENT PROMPT — must survive the manual eviction verbatim'
  agent.loadHistory([
    { role: 'user', content: 'Start working on the task.' },
    // Long assistant messages, not tool results: history loaded this way
    // (loadHistory is a raw transcript load, not a live run) carries no tool-role
    // messages at all, so evict()'s primary "strip oldest tool messages" pass finds
    // nothing to evict and falls through to its second-pass fallback — truncating
    // long assistant messages, oldest first — which is what this test actually
    // exercises.
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'assistant', content: `Iteration ${i} reasoning: `.padEnd(600, 'x') })),
    { role: 'user', content: lastMessage },
  ])

  try {
    const result = await agent.compactNow()
    assert.equal(result.compacted, true)

    const compact = events.find(e => e.type === 'compact')
    assert.ok(compact && 'manual' in compact && compact.manual === true)

    const history = agent.getChatHistory()
    assert.equal(history[history.length - 1].content, lastMessage)
  } finally {
    await fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {})
    await fs.readdir(LOGS_DIR).then(files =>
      Promise.all(files.filter(f => f.includes('manual-context-compaction')).map(f => fs.unlink(`${LOGS_DIR}/${f}`).catch(() => {})))
    ).catch(() => {})
  }
})

// ── Loop-recovery ladder (chat() loop). These drive the loop with a scripted
// Ollama client (the injectable constructor seam), so they need no live model.
// read_file on a nonexistent path returns a graceful error result without a
// container/network, so each "executed" call is deterministic and side-effect-free.
// The ladder is now the ONLY repeat-detection mechanism — there is no separate
// count-based baseline to toggle off.

type ScriptedResponse = {
  message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
}

// Returns each response in turn, then repeats the last one indefinitely — so a
// test can either end the run (final answer as the last element) or exercise a
// model that never stops repeating (tool call as the last element).
function scriptedOllama(responses: ScriptedResponse[]): Ollama {
  let i = 0
  return {
    chat: async () => responses[Math.min(i++, responses.length - 1)],
  } as unknown as Ollama
}

const REPEAT_ARGS = { path: '/nonexistent-argo-repetition-guard-test' }
const readCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: REPEAT_ARGS } }] },
}
// conclude tool call: the ONLY way to end a session. A bare no-tool-call turn is a
// thinking turn and does NOT terminate — only calling conclude does.
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'SUCCESS', message: 'Final answer.' } } }] } }

// Excludes rejected (harness-blocked) calls — Agent.rejectToolCall deliberately
// emits a tool_result shaped just like a real one (so the MODEL can't tell the
// difference), marked `rejected: true` for exactly this purpose: telling "the tool
// actually ran" apart from "the harness declined to run it" in code like this.
function readResults(events: AgentEvent[]): AgentEvent[] {
  return events.filter(e => e.type === 'tool_result' && e.tool === 'read_file' && !e.rejected)
}
function warningsMatching(events: AgentEvent[], re: RegExp): Array<Extract<AgentEvent, { type: 'warning' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning' && re.test(e.message))
}
async function cleanupSession(sessionId: string, slug: string): Promise<void> {
  await Promise.all([
    fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {}),
    fs.readdir(LOGS_DIR).then(files =>
      Promise.all(files.filter(f => f.includes(slug)).map(f => fs.unlink(`${LOGS_DIR}/${f}`).catch(() => {})))
    ).catch(() => {}),
  ])
}

// ── Single automatic retry of a failed per-iteration Ollama call. The stub's
// chat() throws on scripted attempts and resolves on others, and reports how
// many times it was invoked so tests can assert exactly one retry (two calls).

function flakyOllama(behaviors: Array<ScriptedResponse | Error>): { ollama: Ollama; getCalls: () => number } {
  let i = 0
  let calls = 0
  const ollama = {
    // Repeats the last behavior if invoked beyond the script.
    chat: async () => {
      calls++
      const b = behaviors[Math.min(i++, behaviors.length - 1)]
      if (b instanceof Error) throw b
      return b
    },
  } as unknown as Ollama
  return { ollama, getCalls: () => calls }
}

test('chat retry: a failed per-iteration call is retried once and the run continues', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-chat-retry-a-${Date.now()}`
  // First chat() call throws (e.g. a timeout / backend parse error); the retry succeeds.
  const { ollama, getCalls } = flakyOllama([new Error('Ollama did not respond within 180s'), finalAnswer])
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setChatRetryDelayMs(0)  // don't actually wait before retrying, in the test
  try {
    const answer = await agent.chat('argo chat retry case a')

    assert.equal(answer, 'Final answer.')            // returns the eventual success, not an error
    assert.equal(getCalls(), 2)                      // original + exactly one retry
    assert.equal(warningsMatching(events, /Ollama request failed .* retrying once/).length, 1)
    assert.equal(events.some(e => e.type === 'error'), false)  // no run-ending error
  } finally {
    await cleanupSession(sessionId, 'argo-chat-retry-case-a')
  }
})

test('chat retry: if both the call and its retry fail, the error is injected as context and the run continues', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-chat-retry-b-${Date.now()}`
  // Both the original and the retry throw — the error is injected into context
  // rather than killing the run, so the iteration loop continues.
  const { ollama, getCalls } = flakyOllama([new Error('boom-1'), new Error('boom-2')])
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setChatRetryDelayMs(0)
  agent.setMaxIterations(10)
  try {
    await agent.chat('argo chat retry case b')
    assert.ok(getCalls() >= 2, 'at least the original + one retry')
    assert.equal(warningsMatching(events, /Ollama request failed .* retrying once/).length >= 1, true)
    assert.equal(warningsMatching(events, /Ollama retry also failed/).length >= 1, true)
  } finally {
    await cleanupSession(sessionId, 'argo-chat-retry-case-b')
  }
})

test('chat retry: a stop issued during the retry wait is honored and no retry is attempted', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-chat-retry-c-${Date.now()}`
  // The first chat() call aborts the run mid-flight, then throws. The retry must
  // NOT be issued; if it were, chat() would (wrongly) return 'Final answer.'.
  let agent: Agent
  let calls = 0
  const ollama = {
    chat: async () => {
      calls++
      if (calls === 1) { agent.abort(); throw new Error('boom-during-first') }
      return finalAnswer
    },
  } as unknown as Ollama
  agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setChatRetryDelayMs(0)
  try {
    const answer = await agent.chat('argo chat retry case c')

    assert.equal(answer, 'Stopped.')                  // honored the abort, did not retry
    assert.equal(calls, 1)                            // the retry attempt was skipped
    const done = events.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
    assert.equal(done?.content, 'Stopped.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-chat-retry-case-c')
  }
})

test('a read-only run finishes directly with no mutation gate to satisfy', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-readonly-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo read-only case')
    assert.equal(readResults(events).length, 1)                         // the read ran
    assert.equal(answer, 'Final answer.')                               // finished directly
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-read-only-case')
  }
})

// ── LOOP-RECOVERY LADDER. Same scripted-Ollama harness as above — read_file on a
// nonexistent path is a non-mutating call (no edit_file/write_file, so noteMutation
// never fires). Deliberately deterministic: no live model, and the L1 "compact"
// action's underlying compactHistory call is a no-op here (this run's history
// never grows past the eviction budget) — but evaluateCall still returns the
// level-specific message text regardless, so escalation is asserted via that
// message text rather than via eviction events (see loop.ts's l0/l1/l2 message
// builders).

test('loop ladder: repeated identical non-mutating call is blocked and escalates L0 -> L1 -> L2', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-on-${Date.now()}`
  // 7 identical read_file calls, then a final answer. Per DEFAULT_LOOP_CONFIG (loop.ts):
  // call 1 is new -> allowed + executed; calls 2-3 -> L0 steer (blocks 1-2); call 4 -> L1
  // compaction + steer (blocks==3); calls 5-6 -> L0 steer (blocks 4-5); call 7 -> L2
  // forced re-plan reframe (blocks==6). Never a mutation, so the streak never resets.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, readCall, readCall, readCall, readCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop ladder case')

    // The identical call actually ran exactly once — every later repeat (no mutation
    // since it last ran) was blocked before reaching the tool, not executed.
    assert.equal(readResults(events).length, 1)
    // Every attempt — real or rejected — still gets a tool_call event: a block looks
    // exactly like a real attempt up to the tool_result, which is where `rejected`
    // distinguishes them.
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, 7)

    // One warning steer per blocked repeat (6 of the 7 identical calls) — scoped to
    // the loop LADDER's own three message shapes specifically (not `/./`, which
    // would also catch the separate, unrelated stall/progress-check mechanism).
    const warnings = warningsMatching(events, /EXACT same|context was just compacted|repeatedly looped/)
    assert.equal(warnings.length, 6)
    // Escalation genuinely reached all three levels (message text is level-specific —
    // see l0SteerMessage/l1SteerMessage/l2ReframeMessage in loop.ts).
    assert.ok(warnings.some(w => 'message' in w && /STOP repeating it/.test(w.message)), 'expected an L0 steer')
    assert.ok(warnings.some(w => 'message' in w && /context was just compacted/.test(w.message)), 'expected the L1 steer')
    assert.ok(warnings.some(w => 'message' in w && /ABANDON this approach/.test(w.message)), 'expected the L2 reframe')

    // The ladder never hard-terminates the run — it still finishes with the model's own
    // final answer once it stops repeating.
    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-on-case')
  }
})

// ── LOOP-RECOVERY LADDER — cached replay + normalised key. The pure mechanics of
// both (evaluateCall's 'replay' branch, normalizeCallKey's collapse/refuse rules)
// are unit-tested exhaustively in loop.test.ts; this is the AGENT-level integration
// proof that the wiring actually reaches them: the tool_result event served for a
// blocked repeat really does carry the EARLIER call's real output (not just a
// message).

test('loop ladder: a blocked repeat is served the EARLIER call\'s actual result, not just a message', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-replay-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo loop replay case')

    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 2)                 // one tool_result per attempt, real or replayed
    const [first, second] = reads
    assert.equal(first.rejected, undefined)       // the 1st call actually ran
    assert.equal(second.rejected, true)           // the 2nd was blocked...
    assert.equal(second.replayed, true)           // ...specifically as a cached REPLAY, not a plain steer
    // The replay carries the SAME error text the real call produced — reproduced,
    // not regenerated or replaced with a generic "blocked" message.
    assert.equal(second.error, first.error)
    assert.equal(second.output, first.output)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-replay-case')
  }
})

// Leading './' is still a collapsed spelling after FIX 3 (only the TRAILING-slash rule
// was removed — see the dedicated FIX 3 test below). A cosmetically-varied repeat is
// still RECOGNISED (so it is blocked and never executes a second time — the H20
// evasion fix), but it is NOT answered from the cache: two calls can normalise to one
// key and still produce different real bytes (a trailing `2>&1` makes the shell
// interleave one fd, where bash.ts otherwise concatenates two separated buffers), so
// replaying the first call's output under the second call's spelling would answer a
// question that was not asked. Replay therefore requires byte-identical raw
// arguments; normalisation governs blocking only.
const NORMALIZE_PATH_A = 'nonexistent-argo-normalize-test'
const NORMALIZE_PATH_B = './nonexistent-argo-normalize-test'  // leading './' — a cosmetically different spelling of the SAME relative path
const readCallNormA: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: NORMALIZE_PATH_A } } }] },
}
const readCallNormB: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: NORMALIZE_PATH_B } } }] },
}

test('loop ladder: a cosmetically-varied repeat (leading "./") is recognised as the SAME call and BLOCKED, but never served from cache (H20 + FIX 2)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-normalize-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCallNormA, readCallNormB, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop normalization case')

    // Only the FIRST spelling actually ran: the normalised key recognised the second as
    // a repeat and blocked it.
    assert.equal(readResults(events).length, 1)

    // ...and it was NOT replayed, because the raw args differ. This is the FIX 2
    // boundary: recognised for blocking, ineligible for a cached answer.
    const replay = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file' && e.replayed === true)
    assert.equal(replay, undefined, 'a normalised-equal but raw-different repeat must not be answered from cache')

    // It still produced a rejected tool_result — the plain L0 steer, not silence.
    const rejected = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file' && e.rejected === true)
    assert.ok(rejected, 'expected the blocked repeat to surface as a rejected tool_result carrying the L0 steer')

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-normalization-case')
  }
})

// FIX 3 (adversarial-review normalisation table): the trailing-slash rule was
// REMOVED from normalizeCallKey — read_file('x/') can fail with an ENOTDIR-class
// error where read_file('x') succeeds, so collapsing them would hide a real
// success/failure boundary rather than a spelling difference. This is the
// agent-level proof that a trailing-slash repeat now runs TWICE for real under the
// ladder — loop.test.ts pins the underlying normalizeCallKey behavior directly;
// this pins the wiring.
test('loop ladder: a trailing-slash repeat is NO LONGER collapsed (FIX 3) — both calls run for real, not replayed', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-trailing-slash-${Date.now()}`
  const trailingSlashPath = NORMALIZE_PATH_A + '/'
  const readCallTrailingSlash: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: trailingSlashPath } } }] },
  }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCallNormA, readCallTrailingSlash, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop trailing slash case')

    // Both calls actually ran — a trailing slash is a DIFFERENT normalizeCallKey
    // after FIX 3, so the 2nd is a brand-new key (not a no-progress repeat of the
    // 1st) and is allowed, not blocked/replayed.
    assert.equal(readResults(events).length, 2)
    assert.equal(events.some(e => e.type === 'tool_result' && e.tool === 'read_file' && e.replayed === true), false)

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-trailing-slash-case')
  }
})

test('loop ladder: a project mutation between two identical calls resets the ladder — the later call runs fresh, not replayed', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-mutation-${Date.now()}`
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-loop-mutation-'))
  const prevWorkspacePath = config.workspacePath
  config.workspacePath = dir
  const writeCall: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: '/workspace/loop-mutation-out.txt', content: 'hello' } } }] },
  }
  // read (runs), read (no mutation yet -> replayed), write (a REAL mutation), read
  // again (must run fresh).
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, writeCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop mutation case')

    // The 1st and 3rd (post-mutation) read_file calls both actually ran; only the
    // 2nd — issued before anything changed — was replayed.
    assert.equal(readResults(events).length, 2)
    const readToolResults = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(readToolResults.length, 3)
    assert.deepEqual(readToolResults.map(r => r.replayed ?? false), [false, true, false])

    // The write actually landed (config.workspacePath pointed at a real temp dir).
    const writeResult = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'write_file')
    assert.ok(writeResult && !writeResult.rejected && !writeResult.error)
    assert.equal(await fs.readFile(path.join(dir, 'loop-mutation-out.txt'), 'utf-8'), 'hello')

    assert.equal(answer, 'Final answer.')
    assert.equal(events.some(e => e.type === 'error'), false)
  } finally {
    config.workspacePath = prevWorkspacePath
    await fs.rm(dir, { recursive: true, force: true })
    await cleanupSession(sessionId, 'argo-loop-mutation-case')
  }
})

// ── FIX 1: a `bash` call is invisible to isProjectMutation (only ever recognises
// edit_file/write_file under /workspace), so before this fix a cached read served
// across an intervening bash call could confidently tell the model "nothing has
// changed" about a file bash may have just changed. The fix invalidates every
// cached result on any bash call (loop.ts's noteBashExecution) — this is the
// agent-level proof the wiring actually calls it after a REAL bash tool execution,
// not just the pure loop.test.ts unit test of noteBashExecution itself.

const bashCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'true' } } }] },
}

test('loop ladder: an intervening bash call invalidates the cached replay (FIX 1) — the next repeat gets the plain steer, not stale content', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-bash-invalidate-${Date.now()}`
  // read (runs, cached), read (would normally be replayed), bash (not a tracked
  // mutation — mutationCount stays put — but the cached read result is
  // invalidated wholesale), read (must NOT be replayed).
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, bashCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop bash invalidate case')

    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 3)
    assert.equal(reads[0].rejected, undefined)          // 1st: ran for real
    assert.equal(reads[1].rejected, true)                // 2nd: blocked...
    assert.equal(reads[1].replayed, true)                // ...and specifically replayed (no bash yet)
    assert.equal(reads[2].rejected, true)                // 3rd: still a no-progress repeat by
    // mutationCount (a real, separate, documented gap this fix does NOT close —
    // see loop.ts's noteBashExecution doc comment) — but crucially NOT a replay:
    assert.equal(reads[2].replayed ?? false, false)
    assert.match(reads[2].error ?? '', /STOP repeating it/)       // the plain L0 steer fired instead
    assert.doesNotMatch(reads[2].error ?? '', /reproduced verbatim/) // never claims "nothing has changed"

    // The bash call itself was never blocked by the ladder (a brand-new key) — it
    // actually ran, which is the precondition for noteBashExecution firing at all.
    assert.ok(events.some(e => e.type === 'tool_result' && e.tool === 'bash'), 'expected the bash call to actually execute')

    assert.equal(answer, 'Final answer.')
  } finally {
    await cleanupSession(sessionId, 'argo-loop-bash-invalidate-case')
  }
})

// ── FIX 4: a replay (rejected: true, replayed: true, error: undefined) must stay
// distinguishable from a real fast execution — in the LIVE event stream. There is
// no separate run-level JSONL log any more (SessionLogger removed entirely; the
// ledger, per-frame under .argo/frames/, is the only durable record, and it has no
// rejected/replayed field either — pushCtx's rejectToolCall/replayToolCall call
// sites push a plain tool message with no uiMeta) — so this flag exists ONLY on
// the live event, nowhere at rest.
test('loop ladder: a replay is recorded as replayed:true (not error) on the live event stream (FIX 4)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-replay-logger-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo loop replay logger case')

    const replayed = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> =>
      e.type === 'tool_result' && e.replayed === true,
    )
    assert.ok(replayed, 'expected a replayed tool_result on the live event stream (same setup as the replay test above)')
    // A replay correctly carries the cached result — including any error from the
    // original execution. The replayed:true flag is what distinguishes it, not the
    // absence of an error field.
    assert.equal(replayed!.rejected, true, 'a replay is still marked rejected (the tool did not actually run a second time)')
  } finally {
    await cleanupSession(sessionId, 'argo-loop-replay-logger-case')
  }
})

// ── Pinning what previously went untested by inspection alone: a replayed tool
// call must not count as a second real tool result. The `continue` in the
// ladder's block/replay branch (agent.ts, right after replayToolCall/
// rejectToolCall) fires BEFORE the real-execution path (executeTool + the
// toolResultCount increment) — the count staying at 1 after 2 attempts (1 real + 1
// replayed) is the pin.

test('loop ladder: a replayed tool call does not count as a second real tool result', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-replay-episodes-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, readCall, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo loop replay episode case')

    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 2)
    assert.equal(reads[1].replayed, true)

    // Only the FIRST (real) read counts as a real tool result — the replayed 2nd
    // attempt never reaches the real-execution path.
    assert.equal(agent.getRunState().toolResults, 1)
  } finally {
    await cleanupSession(sessionId, 'argo-loop-replay-episode-case')
  }
})

// ── H21 — GATE-REJECTION counter + the ladder's own 'halt' tier. Closes the
// unbounded-retry hole where a call the role gate refuses `continue`s past the
// ladder entirely, and bounds the pre-existing L2 rung itself (evaluateCall's
// 'replan' had no ceiling before this — see loop.ts's LoopAction 'halt' doc
// comment). No live model: a role-restricted scripted model exercises the same
// deterministic, side-effect-free calls the rest of this file's ladder tests
// already rely on.

const roleRejectedBashCall: ScriptedResponse = {
  message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: "grep -n 'conflicts' /workspace/lib/help.js" } } }] },
}

test('role gate (H21): a role-restricted tool refused repeatedly escalates at the 3rd rejection, then STOPS the frame at the 6th', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-gate-h21-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([roleRejectedBashCall]))
  agent.setSessionId(sessionId)
  agent.setAllowedTools(['read_file']) // 'bash' is never available to this role
  agent.setMaxIterations(20) // plenty of room for the stop (fires at the 6th) to arrive well before any cap
  try {
    const answer = await agent.chat('argo role gate H21 case')

    const rejections = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'bash' && e.rejected === true)
    // Stops EXACTLY at the 6th identical rejection (cfg.gateStopAfter) — never a 7th.
    assert.equal(rejections.length, 6)

    // Rejections 1-2: the gate's plain, unescalated message (no count, no "role" wording).
    assert.doesNotMatch(rejections[0].error ?? '', /times/)
    assert.doesNotMatch(rejections[1].error ?? '', /times/)
    // Rejections 3-5: escalated wording — names the count and the concrete alternative.
    for (const r of [rejections[2], rejections[3], rejections[4]]) {
      assert.match(r.error ?? '', /does not exist for you in this role/)
      assert.match(r.error ?? '', /Do NOT call `bash` again/)
    }
    assert.match(rejections[2].error ?? '', /3 times/)
    assert.match(rejections[3].error ?? '', /4 times/)
    assert.match(rejections[4].error ?? '', /5 times/)
    // The 6th is the STOP message, not another escalation — and the frame ends.
    assert.match(rejections[5].error ?? '', /STOPPING this frame/)
    assert.match(rejections[5].error ?? '', /6 times/)

    // Never fails open: this reads as a stall (reused 'cap' RunOutcome), never as
    // a normal finish.
    assert.equal(agent.getLastRunOutcome(), 'cap')
    assert.equal(agent.hitIterationCap(), true)
    assert.equal(events.some(e => e.type === 'done'), false)
    assert.ok(events.some(e => e.type === 'error'))
    assert.match(answer, /STOPPING this frame/)
  } finally {
    await cleanupSession(sessionId, 'argo-role-gate-h21-case')
  }
})

// H21(b) — the pre-existing L2 rung had no ceiling of its own: this extends the
// "loop ladder: repeated identical non-mutating call is blocked and escalates L0
// -> L1 -> L2" test above past its first L2 firing, to the point a real incident
// actually reached (L2, ignored, over and over) and proves the harness now stops
// rather than repeating it indefinitely.
test('loop ladder (H21b): a model that never stops repeating past L2 is eventually HALTED — the frame ends, never as success', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-halt-${Date.now()}`
  // readCall is the only element, so it recurs every iteration — never stops on its own.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setMaxIterations(20) // DEFAULT_LOOP_CONFIG halts at blocks=10 (the 11th attempt) — well inside 20
  try {
    const answer = await agent.chat('argo loop halt case')

    // Exactly one real execution; every further repeat is blocked/escalated by the
    // ladder, until 'halt' fires and ends the frame — never a 12th attempt.
    assert.equal(readResults(events).length, 1)
    assert.equal(events.filter(e => e.type === 'tool_call' && e.tool === 'read_file').length, 11)

    assert.match(answer, /STOPPING this frame/)
    assert.match(answer, /10 consecutive calls/)
    assert.equal(agent.getLastRunOutcome(), 'cap') // never reads as success
    assert.equal(events.some(e => e.type === 'done'), false)
    assert.ok(events.some(e => e.type === 'error'))
  } finally {
    await cleanupSession(sessionId, 'argo-loop-halt-case')
  }
})
