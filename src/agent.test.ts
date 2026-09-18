import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from './config.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent } from './types.js'
import type { Ollama } from 'ollama'
import { Agent, parseChangedFiles, buildFallbackCommitMessage, isCleanStatus, looksLikeNarratedConclusion } from './agent.js'
import { NO_OUTPUT } from './tools/bash.js'
import { ROLE_TOOLS, ROLE_INSTRUCTIONS } from './frames.js'

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
  message: { role: string; content: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
  prompt_eval_count?: number
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

// ── pruneHarnessMessages must only ever remove HARNESS-INJECTED ephemeral system
// messages (nudges/stalls/reground steers/timeout errors — pushCtx's `ephemeral:
// true` call sites), never the frame's own permanent ROLE_INSTRUCTIONS. This used
// to be inferred from position (a system message counted as removable once any
// assistant message preceded it in history) — which broke specifically for the
// Dispatcher/Planner roles: their opening sequence pushes injected AGENTS.md/
// MEMORY.md read_file assistant/tool pairs BEFORE ROLE_INSTRUCTIONS (see chat()'s
// opening messages), so by that old heuristic ROLE_INSTRUCTIONS already had
// assistant messages ahead of it and looked exactly like a stale nudge.
// HARNESS_MESSAGE_MAX_ITERATION_AGE is 1, and pruneHarnessMessages runs on every
// manageContext call (the top of every chatCall) regardless of context budget —
// so under the old bug, ROLE_INSTRUCTIONS was already gone by the SECOND
// iteration's request, not just on a long run.
test('pruneHarnessMessages never removes the Dispatcher\'s ROLE_INSTRUCTIONS, even after other assistant turns have run', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-role-instructions-survive-${Date.now()}`
  // Iteration 1: a real tool call (produces an assistant message AFTER
  // ROLE_INSTRUCTIONS's position in history — exactly the shape that tripped the
  // old position-based heuristic). Iteration 2: manageContext runs BEFORE this
  // second request and is where the old bug already spliced ROLE_INSTRUCTIONS out.
  // Uses the Dispatcher's own valid conclude status (ANSWER) — not the shared
  // `finalAnswer` fixture's SUCCESS, which only the Implementer's conclude accepts.
  const dispatcherFinalAnswer: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'conclude', arguments: { status: 'ANSWER', message: 'Final answer.' } } }] },
  }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCall, dispatcherFinalAnswer]))
  agent.setSessionId(sessionId)
  agent.setRole('dispatcher')
  agent.setAllowedTools(ROLE_TOOLS.dispatcher)
  try {
    const answer = await agent.chat('does ROLE_INSTRUCTIONS survive?')
    assert.equal(answer, 'Final answer.')

    const { messages } = agent.getContext()
    const instructions = messages.find(m => m.role === 'system' && m.content === ROLE_INSTRUCTIONS.dispatcher)
    assert.ok(instructions, 'ROLE_INSTRUCTIONS.dispatcher must still be present in context after other turns have run')
  } finally {
    await cleanupSession(sessionId, 'role-instructions-survive')
  }
})

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
  // call 1 is new -> allowed + executed; call 2 -> the ONE cached L0 replay
  // (maxReplaysPerKey=1, not executed); calls 3, 5, 6 -> plain L0 steer; call 4 -> L1
  // compaction + steer (blocks==3); call 7 -> L2 forced re-plan reframe (blocks==6).
  // Since (H-duplicate-notice) steer/compact/replan no longer skip execution — only
  // the cached replay does — calls 1, 3, 4, 5, 6, 7 all genuinely re-run the tool;
  // only call 2 is served back without running. Never a mutation, so the streak
  // never resets.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    readCall, readCall, readCall, readCall, readCall, readCall, readCall, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop ladder case')

    // Six of the seven identical calls actually ran (real re-executions are now
    // allowed for steer/compact/replan — nothing failed, so there is no reason to
    // block execution) — only the single cached L0 replay (call 2) did not.
    assert.equal(readResults(events).length, 6)
    // Every attempt — real, replayed, or gate-rejected — still gets a tool_call event.
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

test('loop ladder: a cosmetically-varied repeat (leading "./") is recognised as the SAME call and re-run for real, but never served from cache (H20 + FIX 2)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-loop-normalize-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([readCallNormA, readCallNormB, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo loop normalization case')

    // The normalised key recognised the second as a no-progress repeat of the
    // first — but since nothing about that repeat actually FAILED, it is still
    // genuinely re-run (not skipped) rather than answered from a cache it isn't
    // eligible for (see the next assertion) or blocked outright.
    assert.equal(readResults(events).length, 2)

    // ...and it was NOT replayed, because the raw args differ. This is the FIX 2
    // boundary: recognised for the ladder's block/escalate decision, ineligible
    // for a cached answer.
    const replay = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file' && e.replayed === true)
    assert.equal(replay, undefined, 'a normalised-equal but raw-different repeat must not be answered from cache')

    // It still surfaced the plain L0 steer wording as a warning, and as an
    // ephemeral system-message duplicate-notice appended after the real result —
    // never as a fabricated tool-result error (nothing failed).
    assert.ok(warningsMatching(events, /STOP repeating it/).length > 0, 'expected the plain L0 steer to fire')
    const rejected = events.find((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file' && e.rejected === true)
    assert.equal(rejected, undefined, 'a duplicate call that is re-run for real must not be reported as a rejected tool_result')

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
    // 3rd: still a no-progress repeat by mutationCount (a real, separate,
    // documented gap this fix does NOT close — see loop.ts's noteBashExecution
    // doc comment) — but the invalidated cache means it falls to the plain L0
    // steer, which (like every non-replay rung) re-runs the call for real
    // rather than fabricating a rejection — so it is NOT reported as rejected,
    // and crucially NOT a replay either (never claims "nothing has changed"
    // about a file bash may have just touched):
    assert.equal(reads[2].rejected, undefined)
    assert.equal(reads[2].replayed ?? false, false)
    assert.ok(warningsMatching(events, /STOP repeating it/).length > 0)       // the plain L0 steer fired instead of a replay
    assert.doesNotMatch(reads[2].error ?? '', /reproduced verbatim/) // never claims "nothing has changed"

    // The bash call itself was never blocked by the ladder (a brand-new key) — it
    // actually ran, which is the precondition for noteBashExecution firing at all.
    assert.ok(events.some(e => e.type === 'tool_result' && e.tool === 'bash'), 'expected the bash call to actually execute')

    assert.equal(answer, 'Final answer.')
  } finally {
    await cleanupSession(sessionId, 'argo-loop-bash-invalidate-case')
  }
})

// ── DUPLICATE-CALL WARNING (steer/compact/replan rungs). A no-progress repeat
// that reaches one of these rungs is no longer skipped — the call actually
// re-runs (see the ladder tests above) — but the model still needs to know it
// was a flagged repeat. That notice is a SEPARATE, ephemeral system message
// appended to context right after the real tool result (never merged into the
// tool result itself, and never framed as an "Error:" — nothing failed).
test('a duplicate call re-run for real gets an ephemeral warning appended after its result, gone by the following iteration', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-duplicate-warning-${Date.now()}`
  const distinguishCall: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'echo distinguish-me' } } }] },
  }
  // call 1: allow (real). call 2: the one cached L0 replay. call 3: replay budget
  // exhausted -> plain L0 steer -> re-run for real, with the duplicate warning
  // pushed right after. call 4 (a DIFFERENT call, so the streak doesn't just
  // repeat the ladder again): the immediate next iteration — the warning must
  // still be visible here. call 5: one iteration later — the warning must be
  // gone by now.
  const sequence: ScriptedResponse[] = [readCall, readCall, readCall, distinguishCall, finalAnswer]
  let i = 0
  let sawWarningAtIter4 = false
  let sawWarningAtIter5 = false
  const agent: Agent = new Agent(e => events.push(e), 'test-model', {
    chat: async () => {
      const idx = i++
      const hasWarning = () => agent.getContext().messages.some(m => m.role === 'system' && /STOP repeating it/.test(m.content))
      if (idx === 3) sawWarningAtIter4 = hasWarning()
      if (idx === 4) sawWarningAtIter5 = hasWarning()
      return sequence[Math.min(idx, sequence.length - 1)]
    },
  } as unknown as Ollama)
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo duplicate warning case')

    // The 3rd (duplicate, steer-rung) call actually re-ran — a real tool_result,
    // not a rejected/fabricated one.
    const reads = events.filter((e): e is Extract<AgentEvent, { type: 'tool_result' }> => e.type === 'tool_result' && e.tool === 'read_file')
    assert.equal(reads.length, 3)
    assert.equal(reads[2].rejected, undefined)

    assert.equal(sawWarningAtIter4, true, 'the duplicate-call warning must still be visible the immediate next iteration')
    assert.equal(sawWarningAtIter5, false, 'the duplicate-call warning must be gone one further iteration later')
  } finally {
    await cleanupSession(sessionId, 'argo-duplicate-warning-case')
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

    // Every attempt except the one cached L0 replay (maxReplaysPerKey=1) actually
    // re-runs the call for real — nothing about a duplicate repeat has failed, so
    // steer/compact/replan/halt all execute rather than skip — right up through
    // the call that finally triggers 'halt' and ends the frame; never a 12th
    // attempt.
    assert.equal(readResults(events).length, 10)
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

// ── looksLikeNarratedConclusion — pure heuristic, no model/harness needed.

test('looksLikeNarratedConclusion recognizes conclusion-shaped prose, not short/unrelated content', () => {
  assert.equal(looksLikeNarratedConclusion('The implementation is now complete and satisfies every requirement in the original task.'), true)
  assert.equal(looksLikeNarratedConclusion('I successfully implemented the hex grid renderer with draggable vector endpoints as requested.'), true)
  assert.equal(looksLikeNarratedConclusion('Here\'s a summary of what changed in this pass, covering every file touched during the session.'), true)
  assert.equal(looksLikeNarratedConclusion('## What was created\nA single HTML file with inline CSS and JavaScript for the grid.'), true)
  assert.equal(looksLikeNarratedConclusion('Done.'), false) // too short
  assert.equal(looksLikeNarratedConclusion('Let me check the file contents before deciding on the next step here.'), false)
})

// ── Reasoning artifact — at most one "[Reasoning]" message ever lives in
// history; a new one fully replaces the old one, no stub.

test('pushReasoningArtifact keeps only the latest reasoning message, replacing the old one entirely', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reasoning-artifact-${Date.now()}`
  const firstThinking = 'FIRST REASONING PASS — should be fully gone once the second one lands.'
  const secondThinking = 'SECOND REASONING PASS — should be the only one left.'
  const turn1: ScriptedResponse = { message: { role: 'assistant', content: '', thinking: firstThinking } }
  const turn2: ScriptedResponse = { message: { role: 'assistant', content: '', thinking: secondThinking } }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([turn1, turn2, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo reasoning artifact case')
    assert.equal(answer, 'Final answer.')

    const messages = agent.getContext().messages
    const reasoningMsgs = messages.filter(m => m.content.startsWith('[Reasoning]'))
    assert.equal(reasoningMsgs.length, 1, 'exactly one [Reasoning] artifact should survive')
    assert.match(reasoningMsgs[0].content, /SECOND REASONING PASS/)
    assert.equal(messages.some(m => m.content.includes('FIRST REASONING PASS')), false, 'the first reasoning pass must leave no trace at all, not even a stub')
  } finally {
    await cleanupSession(sessionId, 'argo-reasoning-artifact-case')
  }
})

// ── Auto-conclude — the model narrating a finished-looking summary as plain
// content (never calling `conclude`) gets auto-completed on the 2nd occurrence.

test('a 2nd narrated-conclusion turn auto-concludes with the model\'s own text instead of nudging a 3rd time', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-auto-conclude-${Date.now()}`
  const firstSummary = 'The implementation is now complete and satisfies every requirement in the original task description.'
  const secondSummary = 'The implementation has been now complete: a single HTML file with inline CSS and JavaScript, fully self-contained.'
  const turn1: ScriptedResponse = { message: { role: 'assistant', content: firstSummary } }
  const turn2: ScriptedResponse = { message: { role: 'assistant', content: secondSummary } }
  // A 3rd scripted response the test would fail against if the loop somehow
  // kept going instead of auto-concluding on turn 2 — proves early termination,
  // not just a lucky matching answer.
  const shouldNeverBeReached: ScriptedResponse = { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'echo should-not-run' } } }] } }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([turn1, turn2, shouldNeverBeReached]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo auto-conclude case')

    assert.equal(answer, secondSummary)
    assert.equal(agent.getConcludeStatus(), 'SUCCESS')
    assert.equal(agent.getIterationCount(), 2, 'must stop at the 2nd narrated turn, never reaching the 3rd scripted response')
    assert.ok(warningsMatching(events, /auto-concluding/).length >= 1)
    assert.equal(events.some(e => e.type === 'tool_call' && e.tool === 'bash'), false)
    assert.equal(events.some(e => e.type === 'done'), true)
  } finally {
    await cleanupSession(sessionId, 'argo-auto-conclude-case')
  }
})

// ── Self-calibrating token estimate (manageContext's trigger) — a real
// prompt_eval_count far denser than the flat CHARS_PER_TOKEN constant would
// ever predict for such tiny message content must still drive manageContext
// to actually compact, proving the calibrated anchor (not raw accumulated
// char growth, which stays negligible throughout this test) is what triggers
// it. See eviction.ts's CHARS_PER_TOKEN comment / agent.ts's
// recalibrateCharsPerToken for the real incident this fixes.

test('manageContext compacts from a calibrated real-token anchor even when content stays tiny in char terms', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-calibration-${Date.now()}`
  const NUM_CTX = 3000 // trigger=1800, verbatim budget=1200 (CONTEXT_TRIGGER_PCT=0.6, CONTEXT_VERBATIM_PCT=0.4)
  // 15 short read_file calls to distinct nonexistent paths (distinct args so
  // the loop-recovery ladder never blocks/replays one as a repeat, which
  // would change what gets pushed). Each reports a real prompt_eval_count far
  // above what such tiny message content could ever justify under the flat
  // 3.5 chars/token constant — simulating dense content/tool-schema overhead
  // the char estimate structurally can't see — growing only slightly turn to
  // turn (real content stays small; it's the DENSITY that's simulated as high).
  const denseCalls: ScriptedResponse[] = Array.from({ length: 15 }, (_, i) => ({
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: `/nonexistent-${i}` } } }] },
    prompt_eval_count: 2600 + i * 20,
  }))
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([...denseCalls, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setOptions({ num_ctx: NUM_CTX })
  try {
    await agent.chat('argo calibration case')

    const compactEvents = events.filter(e => e.type === 'compact')
    assert.ok(compactEvents.length > 0, 'a real, dense-content-simulating measurement must eventually force an ACTUAL compaction (something shortened), not just a trigger check')

    // The flat 3.5-chars/token constant would need this many real chars to
    // reach the trigger on its own — this run's actual pushed content (15
    // tiny read_file calls/error results, plus the real system+user prompt)
    // must stay comfortably under it, so compaction firing here can only be
    // explained by the calibrated anchor, not accumulated char growth.
    const FLAT_CHARS_PER_TOKEN = 3.5
    const charsNeededForFlatTrigger = NUM_CTX * 0.6 * FLAT_CHARS_PER_TOKEN
    const ctx = agent.getContext()
    assert.ok(
      ctx.totalChars < charsNeededForFlatTrigger,
      `test content grew to ${ctx.totalChars} chars, at or past what the flat estimate alone would need (${charsNeededForFlatTrigger}) — no longer isolates the calibration effect`,
    )
  } finally {
    await cleanupSession(sessionId, 'argo-calibration-case')
  }
})

// ── manageContext must never "shorten" a message into something LONGER than
// the original — observed live (2026-09-18): a 17-char tool result
// ("(empty workspace)") and a 110-char bash tool-call description both got
// "collapsed" into themselves plus a marker, ending up bigger than before.

test('manageContext never turns a message into a stub longer than the original', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-no-pointless-collapse-${Date.now()}`
  const NUM_CTX = 3000
  // 15 short read_file calls to distinct nonexistent paths — each produces a
  // genuinely tiny error result, far shorter than any collapsed/evicted
  // marker's own text could ever be. Reuses the calibration test's own
  // technique (a real prompt_eval_count far denser than the flat estimate)
  // purely to force manageContext to actually walk back into this old, tiny
  // content — the point here is what it does once it gets there, not why.
  const denseCalls: ScriptedResponse[] = Array.from({ length: 15 }, (_, i) => ({
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: `/nonexistent-shrink-${i}` } } }] },
    prompt_eval_count: 2600 + i * 20,
  }))
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([...denseCalls, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setOptions({ num_ctx: NUM_CTX })
  try {
    await agent.chat('argo no-pointless-collapse case')
    assert.ok(events.some(e => e.type === 'compact'), 'compaction must actually have run for this test to mean anything')
    const messages = agent.getContext().messages
    for (const m of messages) {
      assert.equal(
        m.content.startsWith('[collapsed') || m.content.startsWith('[evicted'),
        false,
        `a tiny original message was turned into a stub that cannot possibly be shorter: ${JSON.stringify(m.content)}`,
      )
    }
  } finally {
    await cleanupSession(sessionId, 'argo-no-pointless-collapse-case')
  }
})

// ── Generalized single-slot reasoning artifact — covers content-channel
// output from a no-tool-call turn, not just thinking-channel output.

test('pushReasoningArtifact single-slot replacement also covers content-channel output from a no-tool-call turn', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reasoning-content-${Date.now()}`
  const firstPassContent = 'FIRST CONTENT PASS — rambling exploration with no tool call, should be fully gone once the second one lands.'
  const secondPassThinking = 'SECOND PASS VIA THINKING — should be the only one left.'
  const turn1: ScriptedResponse = { message: { role: 'assistant', content: firstPassContent } }
  const turn2: ScriptedResponse = { message: { role: 'assistant', content: '', thinking: secondPassThinking } }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([turn1, turn2, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    const answer = await agent.chat('argo reasoning content case')
    assert.equal(answer, 'Final answer.')
    const messages = agent.getContext().messages
    const reasoningMsgs = messages.filter(m => m.content.startsWith('[Reasoning]'))
    assert.equal(reasoningMsgs.length, 1, 'exactly one [Reasoning] artifact should survive, regardless of which channel each turn used')
    assert.match(reasoningMsgs[0].content, /SECOND PASS VIA THINKING/)
    assert.equal(messages.some(m => m.content.includes('FIRST CONTENT PASS')), false, 'the first (content-channel) pass must leave no trace at all, not even a stub')
  } finally {
    await cleanupSession(sessionId, 'argo-reasoning-content-case')
  }
})

// ── Real thinking alongside a REAL tool call must reach the next turn's own
// context as an explicit [Reasoning] artifact, ordered before the tool call's
// own accompanying content — not merely attached as the Message.thinking
// field, which does not reliably survive into the next request.

test('a tool-calling turn with both thinking and content pushes reasoning first (single-slot), content second (permanent)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reasoning-hascalls-order-${Date.now()}`
  const planText = "PLAN TEXT — the model's own commentary alongside its tool call."
  const turn1: ScriptedResponse = {
    message: {
      role: 'assistant',
      content: planText,
      thinking: 'THINK ONE — should be replaced, not merged into the content message.',
      tool_calls: [{ function: { name: 'read_file', arguments: { path: '/nonexistent-hascalls-reasoning-order' } } }],
    },
  }
  const turn2: ScriptedResponse = { message: { role: 'assistant', content: '', thinking: 'THINK TWO — the only reasoning artifact that should remain.' } }
  const sequence: ScriptedResponse[] = [turn1, turn2, finalAnswer]
  let i = 0
  let orderSnapshot: string[] = []
  const agent: Agent = new Agent(e => events.push(e), 'test-model', {
    chat: async () => {
      const idx = i++
      // Right before turn2 runs: turn1's own pushes are done and nothing has
      // superseded them yet.
      if (idx === 1) orderSnapshot = agent.getContext().messages.map(m => m.content)
      return sequence[Math.min(idx, sequence.length - 1)]
    },
  } as unknown as Ollama)
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo hasCalls reasoning order case')

    const reasoningIdx = orderSnapshot.findIndex(c => c.startsWith('[Reasoning]') && c.includes('THINK ONE'))
    const contentIdx = orderSnapshot.findIndex(c => c === planText)
    assert.notEqual(reasoningIdx, -1, 'expected the real reasoning to appear as its own [Reasoning] message')
    assert.notEqual(contentIdx, -1, 'expected the accompanying content to appear as its own permanent message')
    assert.ok(reasoningIdx < contentIdx, 'reasoning must come before the regular content, so content sits at the tail')

    const messages = agent.getContext().messages
    assert.equal(messages.some(m => m.content.includes('THINK ONE')), false, 'the superseded reasoning must leave no trace')
    assert.ok(messages.some(m => m.content.startsWith('[Reasoning]') && m.content.includes('THINK TWO')))
    assert.ok(
      messages.some(m => m.content === planText),
      'content accompanying a real tool call must survive as permanent, kept content — never superseded by a later reasoning push',
    )
  } finally {
    await cleanupSession(sessionId, 'argo-hascalls-reasoning-order-case')
  }
})

// ── A no-tool-call turn's own content is not a real reply either (nothing was
// concluded, no tool ran) — when it comes alongside real thinking, both are
// pushed together as a PAIRED reasoning artifact (real reasoning first, its
// own content second, at the tail), and pushing the second half must not
// supersede the first: they are the same slot-generation and must survive
// together until the NEXT reasoning artifact replaces both at once.

test('a no-tool-call turn with both thinking and content pushes both as a paired reasoning artifact, neither removing the other', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reasoning-pair-${Date.now()}`
  const turn1: ScriptedResponse = {
    message: {
      role: 'assistant',
      content: 'REGULAR TEXT — no tool call, so this counts as reasoning too.',
      thinking: 'REAL THINKING — the actual reasoning half of the pair.',
    },
  }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([turn1, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo reasoning pair case')
    const messages = agent.getContext().messages
    const reasoningMsgs = messages.filter(m => m.content.startsWith('[Reasoning]'))
    assert.equal(reasoningMsgs.length, 2, 'both halves of the pair must survive together')
    assert.match(reasoningMsgs[0].content, /REAL THINKING/)
    assert.match(reasoningMsgs[1].content, /REGULAR TEXT/)
  } finally {
    await cleanupSession(sessionId, 'argo-reasoning-pair-case')
  }
})

test('a later reasoning artifact removes BOTH messages of an earlier paired artifact', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-reasoning-pair-replaced-${Date.now()}`
  const turn1: ScriptedResponse = { message: { role: 'assistant', content: 'OLD REGULAR TEXT', thinking: 'OLD REAL THINKING' } }
  const turn2: ScriptedResponse = { message: { role: 'assistant', content: '', thinking: 'NEW REASONING — should replace both halves of the old pair.' } }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([turn1, turn2, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo reasoning pair replaced case')
    const messages = agent.getContext().messages
    assert.equal(messages.some(m => m.content.includes('OLD REGULAR TEXT')), false, "the old pair's regular half must be gone once a new reasoning artifact lands")
    assert.equal(messages.some(m => m.content.includes('OLD REAL THINKING')), false, "the old pair's real-reasoning half must be gone once a new reasoning artifact lands")
    const reasoningMsgs = messages.filter(m => m.content.startsWith('[Reasoning]'))
    assert.equal(reasoningMsgs.length, 1)
    assert.match(reasoningMsgs[0].content, /NEW REASONING/)
  } finally {
    await cleanupSession(sessionId, 'argo-reasoning-pair-replaced-case')
  }
})

// ── Injected-listing cleanup — the harness's own auto-injected `fd`-style
// project listing (pushed by chat()'s own setup code, before the model ever
// runs) is removed entirely once real work starts (a successful write, or
// any bash call — including the model's own first one).

test('the harness\'s injected project listing is removed entirely once a write_file succeeds', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-injected-listing-write-${Date.now()}`
  const tmpPath = '/tmp/argo-test-injected-listing-write.txt'
  const doWrite: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: tmpPath, content: 'hello' } } }] },
  }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([doWrite, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo injected-listing write case')
    const messages = agent.getContext().messages
    assert.equal(messages.some(m => m.content.includes('fd . -t f -d 2')), false, 'the harness\'s injected listing must be fully gone once real work (the write) has started')
    assert.ok(messages.some(m => m.content.includes('write_file')), 'the triggering write_file call itself must still be present')
  } finally {
    await cleanupSession(sessionId, 'argo-injected-listing-write-case')
    await fs.unlink(tmpPath).catch(() => {})
  }
})

test('the harness\'s injected project listing is also removed once the model\'s own first bash call runs', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-injected-listing-bash-${Date.now()}`
  const modelBash: ScriptedResponse = {
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: { command: 'echo model-own-bash-call' } } }] },
  }
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([modelBash, finalAnswer]))
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  try {
    await agent.chat('argo injected-listing bash case')
    const messages = agent.getContext().messages
    assert.equal(messages.some(m => m.content.includes('fd . -t f -d 2')), false, 'the harness\'s injected listing must be gone once the model runs any bash call of its own')
    assert.ok(messages.some(m => m.content.includes('model-own-bash-call')), 'the triggering bash call itself must still be present')
  } finally {
    await cleanupSession(sessionId, 'argo-injected-listing-bash-case')
  }
})

// ── Ledger recovery retires the old stub — once the model recovers a
// collapsed/evicted message's full content via `ledger`'s get_msg_id, the OLD
// stub (now duplicated by the freshly-recovered copy) is removed entirely.

test('recovering a collapsed/evicted message via the ledger tool removes the old stub entirely', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-ledger-recover-${Date.now()}`
  const NUM_CTX = 3000
  // Deltas here are deliberately much larger per-turn than the other
  // calibration test above (+200, not +20): recalibrateCharsPerToken is
  // delta-based (measuredRatio = deltaChars/deltaTokens), and a SMALL token
  // delta relative to the char growth these tiny messages produce blends
  // effectiveCharsPerToken UP toward its clamp ceiling — loosening the
  // verbatim budget every turn and never actually collapsing/evicting
  // anything (confirmed by hand: with +20 deltas this test never produces a
  // stub at all). A token delta comfortably bigger than the char delta keeps
  // the ratio pinned near its floor instead, so the (still tiny, still
  // "dense-content-simulating") messages actually get shortened once enough
  // of them accumulate — which this test needs, unlike the anchor test above
  // which only needs a compact EVENT to fire, not real shortening.
  const denseCalls: ScriptedResponse[] = Array.from({ length: 15 }, (_, i) => ({
    message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: `/nonexistent-recover-${i}` } } }] },
    prompt_eval_count: 2600 + i * 200,
  }))
  let i = 0
  let recovered = false
  let recoveredMsgId = ''
  // A dynamic mock, not a plain scriptedOllama array: the msg_id to recover
  // isn't known until manageContext has actually produced a stub mid-run, so
  // this inspects the agent's own live context on each call and switches to
  // recovering the first stub it finds instead of continuing the script.
  const agent: Agent = new Agent(e => events.push(e), 'test-model', {
    chat: async () => {
      if (!recovered) {
        // Collapse stubs embed the `[collapsed ...]` marker mid-string (head +
        // marker + tail), not at the start — only evict stubs are marker-only.
        const stubbed = agent.getContext().messages.find(m => /\[(?:evicted|collapsed) — \d+ chars; msg_id "/.test(m.content))
        if (stubbed) {
          const match = /msg_id "([^"]+)"/.exec(stubbed.content)
          if (match) {
            recovered = true
            recoveredMsgId = match[1]
            return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'ledger', arguments: { action: 'get_msg_id', msg_id: match[1] } } }] } }
          }
        }
        return denseCalls[Math.min(i++, denseCalls.length - 1)]
      }
      return finalAnswer
    },
  } as unknown as Ollama)
  agent.setSessionId(sessionId)
  grantFullTools(agent)
  agent.setOptions({ num_ctx: NUM_CTX })
  try {
    await agent.chat('argo ledger recover case')
    assert.ok(recovered, 'the test must actually have found a stub to recover, or it proves nothing')
    const messages = agent.getContext().messages
    const staleStub = messages.find(m => /\[(?:evicted|collapsed) — \d+ chars;/.test(m.content) && m.content.includes(`msg_id "${recoveredMsgId}"`))
    assert.equal(staleStub, undefined, 'the old stub referencing the now-recovered msg_id must be gone entirely, not left duplicating the fresh copy')
  } finally {
    await cleanupSession(sessionId, 'argo-ledger-recover-case')
  }
})
