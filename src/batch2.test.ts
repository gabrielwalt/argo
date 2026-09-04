// BATCH 2 (H13-H17, 2026-09-04) — deterministic unit tests for the five changes.
//
// No Ollama, no network, no container, no git: every model turn comes from a scripted
// Ollama double (the same technique agent.test.ts uses), every filesystem touch is either
// an injected in-memory io object or a path outside the workspace (so the file-ops
// boundary check makes it a no-op either way). These are the verdicts for H13/H14/H15/H16
// — they are meant to stand in for an eval run on those four. H17's real verdict needs one
// live run (a `task_graph` event with >=2 steps and >=2 Implementer delegations); what is
// proved here is only that the policy exists and is applied.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Ollama } from 'ollama'
import { config } from './config.js'
import { LOGS_DIR } from './logger.js'
import type { AgentEvent, Role } from './types.js'
import { Agent } from './agent.js'
import {
  ROLE_TOOLS,
  ROLE_MAX_ITERATIONS,
  ROLE_POLICY,
  policyFor,
  parseTesterVerdict,
  parseTaskStartVerdict,
  parseBossVerdict,
} from './frames.js'
import { applyFramePolicy, deriveFrameResult } from './dispatch.js'
import { classifyMemoryItem, filterDurableItems, persistToMemory } from './memory.js'

// ── shared scaffolding (mirrors agent.test.ts's helpers, kept local so that file stays
// untouched by this batch) ─────────────────────────────────────────────────────────
type ScriptedResponse = {
  message: { role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }
}

// Returns each response in turn, then repeats the last one indefinitely.
function scriptedOllama(responses: ScriptedResponse[]): Ollama {
  let i = 0
  return {
    chat: async () => responses[Math.min(i++, responses.length - 1)],
  } as unknown as Ollama
}

// Same, but re-scriptable between turns — needed for H14, where the SECOND turn of the
// same Agent instance must issue a specific call.
function programmableOllama(): { ollama: Ollama; script: (responses: ScriptedResponse[]) => void } {
  let responses: ScriptedResponse[] = []
  let i = 0
  const ollama = {
    chat: async () => responses[Math.min(i++, responses.length - 1)],
  } as unknown as Ollama
  return { ollama, script: (r: ScriptedResponse[]) => { responses = r; i = 0 } }
}

function readCallTo(p: string): ScriptedResponse {
  return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: { path: p } } }] } }
}
const finalAnswer: ScriptedResponse = { message: { role: 'assistant', content: 'Final answer.' } }

async function cleanupSession(sessionId: string, slug: string): Promise<void> {
  await Promise.all([
    fs.unlink(`${LOGS_DIR}/history-${sessionId}.json`).catch(() => {}),
    fs.unlink(`${LOGS_DIR}/compaction-${sessionId}.json`).catch(() => {}),
    fs.readdir(LOGS_DIR).then(files =>
      Promise.all(files.filter(f => f.includes(slug)).map(f => fs.unlink(`${LOGS_DIR}/${f}`).catch(() => {}))),
    ).catch(() => {}),
  ])
}

function iterationEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'iteration' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'iteration' }> => e.type === 'iteration')
}
function warningEvents(events: AgentEvent[]): Array<Extract<AgentEvent, { type: 'warning' }>> {
  return events.filter((e): e is Extract<AgentEvent, { type: 'warning' }> => e.type === 'warning')
}

// ── H13 — a cap-hit must report `partial`, never `success` ────────────────────────

// A frame that never stops calling tools: `budget + 2` DISTINCT read_file calls, so the
// loop-recovery ladder (on in every role policy) never blocks anything and the run's only
// possible ending is the iteration cap.
function neverConcludes(budget: number): Ollama {
  const responses: ScriptedResponse[] = []
  for (let i = 0; i < budget + 2; i++) responses.push(readCallTo(`/nonexistent-argo-h13-${i}`))
  return scriptedOllama(responses)
}

for (const role of ['planner', 'implementer', 'tester', 'boss'] as Role[]) {
  test(`H13: a ${role} frame that hits its iteration cap derives status 'partial', not 'success'`, async () => {
    const budget = ROLE_MAX_ITERATIONS[role]
    const events: AgentEvent[] = []
    const sessionId = `test-h13-cap-${role}-${Date.now()}`
    const agent = new Agent(e => events.push(e), 'test-model', neverConcludes(budget))
    agent.setSessionId(sessionId)
    agent.setMaxIterations(budget)
    agent.setPolicy(policyFor(role))
    try {
      const answer = await agent.chat(`argo h13 cap case ${role}`)

      // The pre-existing symptom: chat() returns a NOTICE that reads like an answer, and
      // emits a terminal error event with no `done`.
      assert.match(answer, /^Reached maximum iterations \(\d+\) without a final answer\.$/)
      assert.equal(events.some(e => e.type === 'error'), true)
      assert.equal(events.some(e => e.type === 'done'), false)

      // The fact that used to be discarded at the frame boundary.
      assert.equal(agent.getLastRunOutcome(), 'cap')
      assert.equal(agent.hitIterationCap(), true)
      assert.equal(agent.getIterationCount(), budget)

      // The fix.
      const result = deriveFrameResult(`fr-${role}`, answer, agent)
      assert.equal(result.status, 'partial')
      assert.notEqual(result.status, 'success')
      const issues = result.issues ?? []
      assert.equal(issues.length, 1, 'a cap-hit records exactly one issue')
      assert.match(issues[0], /iteration cap/)
    } finally {
      await cleanupSession(sessionId, `argo-h13-cap-case-${role}`)
    }
  })
}

test('H13: a frame that concludes normally still derives success (no over-correction)', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-h13-ok-${Date.now()}`
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([finalAnswer]))
  agent.setSessionId(sessionId)
  agent.setPolicy(policyFor('tester'))
  try {
    const answer = await agent.chat('argo h13 ok case')
    assert.equal(answer, 'Final answer.')
    assert.equal(agent.getLastRunOutcome(), 'ok')
    assert.equal(agent.hitIterationCap(), false)
    const result = deriveFrameResult('fr-ok', answer, agent)
    assert.equal(result.status, 'success')
    assert.equal(result.issues, undefined)
  } finally {
    await cleanupSession(sessionId, 'argo-h13-ok-case')
  }
})

test('H13: a frame whose turn ended in an error derives failed, not success', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-h13-err-${Date.now()}`
  // Every chat attempt throws — chatWithRetry retries once, then chat()'s outer catch runs.
  const ollama = { chat: async () => { throw new Error('backend exploded') } } as unknown as Ollama
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setChatRetryDelayMs(0)
  try {
    const answer = await agent.chat('argo h13 error case')
    assert.match(answer, /^Unexpected error:/)
    assert.equal(agent.getLastRunOutcome(), 'error')
    const result = deriveFrameResult('fr-err', answer, agent)
    assert.equal(result.status, 'failed')
  } finally {
    await cleanupSession(sessionId, 'argo-h13-error-case')
  }
})

// ── H13 — the parse sites must not fail open ──────────────────────────────────────

test('H13: a stalled Tester never reads as approval — parseTesterVerdict escalates', () => {
  // The exact string a cap-hit frame returns (agent.ts) — the summary the 2 measured
  // stalled-Tester frames actually had, and which used to parse as RELEASE.
  const capHit = parseTesterVerdict('Reached maximum iterations (20) without a final answer.')
  assert.equal(capHit.action, 'escalate')
  assert.equal(capHit.parsed, false)

  // Prose with no verdict line: also not approval.
  const prose = parseTesterVerdict('I looked at the files and the change seems reasonable to me.')
  assert.equal(prose.action, 'escalate')
  assert.equal(prose.parsed, false)

  // Both real verdicts still parse, including RELEASE stated bare on its own line.
  const release = parseTesterVerdict('Checked all three claims against the test output.\nRELEASE')
  assert.equal(release.action, 'release')
  assert.equal(release.parsed, true)
  const redo = parseTesterVerdict('The second claim is false.\nREDO: re-run test/query.test.js and fix filterTasks')
  assert.equal(redo.action, 'redo')
  assert.equal(redo.parsed, true)
  assert.match(redo.followUp, /^re-run test\/query\.test\.js/)
})

test('H13: parseTaskStartVerdict and parseBossVerdict report unparseable explicitly', () => {
  const noMarker = parseTaskStartVerdict('All 7 tests pass. The three functions are now implemented.')
  assert.equal(noMarker.parsed, false)
  assert.equal(noMarker.text, '') // the caller falls back to the user's own message
  const objective = parseTaskStartVerdict('OBJECTIVE: make the due-date sort stable')
  assert.equal(objective.parsed, true)
  assert.equal(objective.mode, 'objective')

  const bossStalled = parseBossVerdict('Reached maximum iterations (15) without a final answer.')
  assert.equal(bossStalled.parsed, false)
  // Benign default kept; runBoss escalates on !parsed AND a non-clean frame ending.
  assert.equal(bossStalled.action, 'none')
  const bossNone = parseBossVerdict('Everything checks out.\nNONE')
  assert.equal(bossNone.parsed, true)
  assert.equal(bossNone.action, 'none')
  const bossEscalate = parseBossVerdict('ESCALATE: three of six new tests still fail')
  assert.equal(bossEscalate.parsed, true)
  assert.equal(bossEscalate.action, 'escalate')
})

// ── H14 — resumeFrame must not wipe run state ─────────────────────────────────────

const planCall: ScriptedResponse = {
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'update_plan', arguments: { objective: 'Ship the widget', steps: ['Build it', 'Wire it in'] } } }],
  },
}
// Deliberately outside any configured workspace: file-ops' boundary check turns it into a
// no-op, which keeps the test environment-independent. editedPaths records the ATTEMPT
// either way (agent.ts records the path before looking at the result), and the loop
// ladder's mutation counter therefore cannot advance in this test regardless of whether a
// WORKSPACE_PATH is configured — which is what makes the "repeat is blocked" assertion
// below deterministic.
const REPEATED_READ = '/nonexistent-argo-h14-repeat'
const writeCall: ScriptedResponse = {
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ function: { name: 'write_file', arguments: { path: path.join(os.tmpdir(), 'argo-h14-should-not-exist.txt'), content: 'widget\n' } } }],
  },
}

// Drives one Agent through a first turn that establishes real state (a plan, optionally a
// task ledger, an edited path, episodes, and one recorded loop-ladder key), then a second
// turn that either RESUMES or starts fresh, and reports both snapshots plus the second
// turn's own events.
async function runThenResume(opts: { tasks: boolean; resume: boolean }) {
  const events: AgentEvent[] = []
  const sessionId = `test-h14-${opts.tasks ? 'tasks' : 'plain'}-${opts.resume ? 'resume' : 'fresh'}-${Date.now()}`
  const { ollama, script } = programmableOllama()
  const agent = new Agent(e => events.push(e), 'test-model', ollama)
  agent.setSessionId(sessionId)
  agent.setTasks(opts.tasks)
  agent.setLoop(true)
  agent.setMemory(false)
  agent.setGrounding(false)
  // Episode recording (the CWL episode graph) is gated on config.agents, which is what a
  // real multi-agent frame runs under. Flipped for the duration of this test only.
  const agentsBefore = config.agents
  config.agents = true
  try {
    // write BEFORE the read, so the read's ladder key is recorded at the final mutation
    // count and a later repeat of it is a no-progress repeat by construction.
    script([planCall, writeCall, readCallTo(REPEATED_READ), finalAnswer])
    await agent.chat('argo h14 first turn')
    const before = agent.getRunState()
    const mark = events.length
    // The SAME read again: blocked by the ladder only if loopState survived.
    script([readCallTo(REPEATED_READ), finalAnswer])
    await agent.chat('argo h14 follow-up', opts.resume ? { resume: true } : undefined)
    const after = agent.getRunState()
    const secondTurn = events.slice(mark)
    return { before, after, secondTurn, maxIterations: agent.getMaxIterations() }
  } finally {
    config.agents = agentsBefore
    await cleanupSession(sessionId, 'argo-h14')
  }
}

test('H14: resuming a frame preserves plan, task list, edited paths, episodes, loop state and reconciliation state', async () => {
  const { before, after, secondTurn } = await runThenResume({ tasks: true, resume: true })

  // The first turn really did establish state — otherwise the equalities below are vacuous.
  assert.equal(before.hasPlan, true, 'first turn recorded a plan')
  assert.equal(before.hasTaskList, true, 'first turn built a task ledger')
  assert.ok(before.taskListRevision >= 1)
  assert.ok(before.editedPaths.length >= 1, 'first turn recorded an edited path')
  assert.ok(before.episodes >= 1, 'first turn recorded episodes')

  // …and the resumed turn kept every piece of it.
  assert.equal(after.hasPlan, true)
  assert.equal(after.hasTaskList, true)
  assert.equal(after.taskListRevision, before.taskListRevision)
  assert.deepEqual(after.editedPaths, before.editedPaths)
  assert.ok(after.episodes >= before.episodes)
  assert.equal(after.loopMutationCount, before.loopMutationCount)
  assert.equal(after.finalReconciled, before.finalReconciled)

  // Loop state specifically: the repeated read_file was BLOCKED (rejected, never executed)
  // because lastMutationByKey still remembered it from the previous turn.
  const rejected = secondTurn.filter(e => e.type === 'tool_result' && e.tool === 'read_file' && e.rejected === true)
  assert.equal(rejected.length, 1, 'the ladder recognised the repeat across the resume')
})

test('H14: a resumed frame continues the iteration counter instead of restarting at 1', async () => {
  const { before, after, secondTurn, maxIterations } = await runThenResume({ tasks: false, resume: true })
  const iters = iterationEvents(secondTurn)

  assert.ok(before.iterationCount >= 2, 'first turn spent real iterations')
  assert.ok(iters.length >= 1, 'the resumed turn ran at least one iteration')
  // The observed bug was a resume reporting "ITER 1/10". It must now pick up at N+1…
  assert.equal(iters[0].current, before.iterationCount + 1)
  // …and never report a current above its own max.
  assert.equal(iters[0].max, before.iterationCount + maxIterations)
  for (const e of iters) assert.ok(e.current <= e.max)
  assert.ok(after.iterationCount > before.iterationCount, 'the counter is cumulative for the frame')
})

test('H14: a NON-resumed chat() still resets run state (the flag is what preserves it)', async () => {
  const { before, after, secondTurn } = await runThenResume({ tasks: true, resume: false })
  const iters = iterationEvents(secondTurn)

  assert.equal(before.hasPlan, true)
  assert.ok(before.editedPaths.length >= 1)
  // Baseline behavior for a genuinely new run is deliberately unchanged.
  assert.equal(after.hasPlan, false)
  assert.equal(after.hasTaskList, false)
  assert.deepEqual(after.editedPaths, [])
  assert.equal(after.loopMutationCount, 0)
  assert.equal(iters[0].current, 1)
  // With loopState reset, the repeated read is allowed to execute again.
  const rejected = secondTurn.filter(e => e.type === 'tool_result' && e.tool === 'read_file' && e.rejected === true)
  assert.equal(rejected.length, 0)
})

// ── H15 — no tool-call transcript can reach MEMORY.md ─────────────────────────────

// The shape actually found (twice, near-duplicated) in test-two/MEMORY.md, produced by
// compaction.ts's messagesToText rendering (`Called <tool>(<json>)` / `Result: …`).
const POISON = '- Called bash({"command":"ls /workspace/tests/"}) Result: total 4 drwxr-xr-x 2 root root 4096'
const POISON_NEAR_DUP = '- Called bash({"command":"ls /workspace/tests"}) Result: total 4 drwxr-xr-x 2 root'

test('H15: rendered tool-call/result text is rejected at the write boundary', () => {
  assert.equal(classifyMemoryItem(POISON), 'tool-call-transcript')
  assert.equal(classifyMemoryItem(POISON_NEAR_DUP), 'tool-call-transcript')
  assert.equal(classifyMemoryItem('Called read_file({"path":"/workspace/src/agent.ts"})'), 'tool-call-transcript')
  assert.equal(classifyMemoryItem('Result: 36 passing, 0 failing'), 'tool-result-transcript')
  assert.equal(classifyMemoryItem('{"command":"npm test"}'), 'json-blob')
  assert.equal(classifyMemoryItem('ls /workspace/tests/'), 'shell-command')
  assert.equal(classifyMemoryItem('The workspace root contains src/, test/ and docs/, and the …'), 'truncated')
  assert.equal(classifyMemoryItem('Iteration 4 confirmed the parser change'), 'transient')
  assert.equal(classifyMemoryItem('ok'), 'no-durable-value')
  assert.equal(classifyMemoryItem('src/query.js'), 'no-durable-value')
})

test('H15: a legitimate durable fact is kept', () => {
  assert.equal(classifyMemoryItem('The task store persists to data/tasks.json and is loaded lazily on first read'), null)
  assert.equal(classifyMemoryItem('Tests are run with npm test, which shells out to node --test'), null)
  assert.equal(classifyMemoryItem('first fact'), null) // short but a statement — pre-existing behavior preserved
})

test('H15: persistToMemory writes the fact, rejects the transcript, and never re-appends a near-duplicate', async () => {
  const store: Record<string, string> = {
    '/w/MEMORY.md': '## Session memory (2026-01-01)\n- The project uses Postgres for durable storage and Redis for the queue\n',
  }
  const io = {
    readFile: async (p: string) => {
      if (!(p in store)) throw new Error('ENOENT')
      return store[p]
    },
    writeFile: async (p: string, c: string) => { store[p] = c },
  }
  const res = await persistToMemory(
    '/w/MEMORY.md',
    [
      POISON,
      POISON_NEAR_DUP,
      'The project uses Postgres for durable storage and Redis for the job queue', // near-dup of an existing line
      'Due dates are stored as ISO-8601 strings and compared lexicographically',    // the one real fact
    ],
    io,
    new Date('2026-09-04T00:00:00Z'),
  )

  assert.deepEqual(res.written, ['Due dates are stored as ISO-8601 strings and compared lexicographically'])
  assert.deepEqual(res.rejected.map(r => r.reason).sort(), ['near-duplicate', 'tool-call-transcript', 'tool-call-transcript'])

  const written = store['/w/MEMORY.md']
  assert.equal(written.includes('Called bash'), false, 'no tool-call transcript reached the file')
  assert.equal(written.includes('Result:'), false)
  assert.ok(written.includes('- The project uses Postgres for durable storage and Redis for the queue'), 'existing content preserved')
  assert.ok(written.includes('- Due dates are stored as ISO-8601 strings'))
  // Exactly one Postgres line — the near-duplicate did not land.
  assert.equal(written.split('Postgres').length - 1, 1)
})

test('H15: an all-transcript batch writes nothing at all', async () => {
  const store: Record<string, string> = {}
  let wrote = false
  const io = {
    readFile: async (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p] },
    writeFile: async (p: string, c: string) => { wrote = true; store[p] = c },
  }
  const res = await persistToMemory('/w/MEMORY.md', [POISON, 'Result: total 4', 'cat /workspace/AGENTS.md'], io)
  assert.deepEqual(res.written, [])
  assert.equal(res.rejected.length, 3)
  assert.equal(wrote, false, 'MEMORY.md is not created just to hold rejected items')
})

test('H15: filterDurableItems rejects a near-duplicate of an item earlier in the SAME batch', () => {
  const { keep, rejected } = filterDurableItems(
    [
      'The scheduler retries a failed job three times with exponential backoff',
      'The scheduler retries a failed job three times using exponential backoff',
    ],
    '',
  )
  assert.equal(keep.length, 1)
  assert.deepEqual(rejected.map(r => r.reason), ['near-duplicate'])
})

// ── H16 — the loop-recovery ladder rung is emitted as a structured field ──────────

test('H16: loop-recovery warnings carry action.level (L0/L1/L2) instead of only prose', async () => {
  const events: AgentEvent[] = []
  const sessionId = `test-h16-${Date.now()}`
  const same = readCallTo('/nonexistent-argo-h16-level')
  // Per DEFAULT_LOOP_CONFIG: call 1 allowed; 2-3 L0; 4 L1; 5-6 L0; 7 L2.
  const agent = new Agent(e => events.push(e), 'test-model', scriptedOllama([
    same, same, same, same, same, same, same, finalAnswer,
  ]))
  agent.setSessionId(sessionId)
  agent.setLoop(true)
  try {
    await agent.chat('argo h16 level case')
    const levels = warningEvents(events)
      .map(e => e.level)
      .filter((l): l is 'L0' | 'L1' | 'L2' => l !== undefined)
    assert.deepEqual(levels, ['L0', 'L0', 'L1', 'L0', 'L0', 'L2'])
    // Every ladder message carries its rung — the point of H16 is that no consumer has to
    // recover the level from this prose again.
    const ladderWarnings = warningEvents(events).filter(e => /EXACT same|context was just compacted|repeatedly looped/.test(e.message))
    assert.equal(ladderWarnings.length, 6)
    for (const w of ladderWarnings) assert.ok(w.level !== undefined, `ladder warning without a level: ${w.message.slice(0, 60)}`)
  } finally {
    await cleanupSession(sessionId, 'argo-h16-level-case')
  }
})

// ── H17 — the per-frame policy, and the Planner trap ─────────────────────────────

test('H17: a Planner frame runs with harness task sequencing OFF; an Implementer frame runs with it ON', () => {
  const planner = new Agent(() => {})
  applyFramePolicy(planner, 'planner')
  assert.equal(planner.getPolicy().tasks, false, 'the Planner trap: harness task sequencing must be off')
  assert.deepEqual(planner.getPolicy(), { tasks: false, memory: false, loop: true, grounding: false, layout: false })

  const implementer = new Agent(() => {})
  applyFramePolicy(implementer, 'implementer')
  assert.equal(implementer.getPolicy().tasks, true, 'the Implementer is the role task sequencing is for')
  assert.deepEqual(implementer.getPolicy(), { tasks: true, memory: true, loop: true, grounding: true, layout: true })
})

test('H17: every role has an explicit policy, and no read-only role runs task sequencing', () => {
  for (const role of ['planner', 'implementer', 'tester', 'boss'] as Role[]) {
    const p = policyFor(role)
    assert.equal(typeof p.tasks, 'boolean')
    assert.equal(typeof p.memory, 'boolean')
    assert.equal(typeof p.loop, 'boolean')
    assert.equal(typeof p.grounding, 'boolean')
    assert.equal(typeof p.layout, 'boolean')
    assert.equal(p.loop, true, 'loop recovery is role-independent')
    if (role !== 'implementer') {
      assert.equal(p.tasks, false)
      assert.equal(p.memory, false, 'read-only roles must not write MEMORY.md')
      assert.equal(p.grounding, false)
      assert.equal(p.layout, false)
    }
  }
  // policyFor hands out a copy — mutating it cannot corrupt the table.
  const copy = policyFor('planner')
  copy.tasks = true
  assert.equal(ROLE_POLICY.planner.tasks, false)
})

test('H17: applying a frame policy does not depend on config defaults', () => {
  const tasksBefore = config.tasks
  const memoryBefore = config.memory
  try {
    // Even with every harness default ON (the real production default for tasks/memory),
    // a Planner frame must come out with them off — the defect was inheritance.
    config.tasks = true
    config.memory = true
    const planner = new Agent(() => {})
    assert.equal(planner.getPolicy().tasks, true, 'a bare Agent still inherits config (baseline behavior)')
    applyFramePolicy(planner, 'planner')
    assert.equal(planner.getPolicy().tasks, false)
    assert.equal(planner.getPolicy().memory, false)
  } finally {
    config.tasks = tasksBefore
    config.memory = memoryBefore
  }
})

test('H17: no multi-agent role holds update_plan (harness-only via seedPlan)', () => {
  // update_plan was removed from every role (2026-09-05): the harness seeds the
  // plan via Agent.seedPlan before chat() for every Implementer frame, so no agent
  // ever needs to set or refine its own plan. The baseline single-loop agent
  // (allowedTools null, no per-role restriction) still has it as the only path to
  // satisfy the plan/act gate — but that is not a ROLE_TOOLS entry.
  assert.equal(ROLE_TOOLS.planner.includes('update_plan'), false)
  assert.equal(ROLE_TOOLS.implementer.includes('update_plan'), false)
  assert.equal(ROLE_TOOLS.tester.includes('update_plan'), false)
  assert.equal(ROLE_TOOLS.boss.includes('update_plan'), false)
  // Unchanged guarantees the rest of the harness relies on.
  assert.equal(ROLE_TOOLS.planner.includes('write_file'), false)
  assert.equal(ROLE_TOOLS.tester.includes('write_file'), false)
  assert.equal(ROLE_TOOLS.boss.includes('write_file'), false)
  assert.ok(ROLE_TOOLS.planner.includes('read_file'))
})
