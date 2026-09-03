// VERBATIM REQUEST THREADING (config.verbatimRequest) — pipeline wiring tests.
// docs/research/10-hermes-differential.md, finding 1: Argo's Boss task-start checkpoint
// paraphrases the user's raw message into one OBJECTIVE line, and until this change that
// paraphrase was the ONLY thing any downstream frame (Planner/Implementer/Tester) ever
// saw. Traced twice: `bigproj-observability`'s paraphrase dropped the seeded-test-file
// pointer and "read them first", so the Planner told the Implementer to add tests to the
// wrong file and tripped the eval's integrity gate (score zeroed regardless of code
// correctness); `commander-count-option`'s paraphrase dropped the seeded-spec pointer
// entirely, so the Implementer never read the seeded spec and shipped against its own
// invented verification (4/10 targeted assertions passed).
//
// No Ollama, no ledger, no git, no filesystem: this exercises frames.ts's pure functions
// directly — capVerbatimRequest, renderVerbatimRequestBlock, and buildAssignment called
// with dependsOn omitted/empty (the only path through buildAssignment that touches the
// ledger is the dependsOn branch — see ledger.getConclusion — so every test below avoids
// it, the same way ctrlplane.test.ts avoids agent.chat by only exercising the flag-ON
// branch that never resumes a frame).
//
// dispatch.ts's OWN gating (currentVerbatimRequest captured once per run, and
// runBossTaskStart's flag-gated note) is NOT exercised here: doing so would require
// running runDispatchLoop, which needs a real ledger (filesystem), a real Agent (Ollama),
// and git — all out of reach for a pure unit test. What IS unit-tested is the exact
// mechanism dispatch.ts's spawnFrame relies on: buildAssignment attaches the block to
// EVERY role's assignment, unconditionally, with no per-role branch that could skip one.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildAssignment,
  capVerbatimRequest,
  renderVerbatimRequestBlock,
  VERBATIM_REQUEST_CHAR_CAP,
  VERBATIM_REQUEST_HEAD_CHARS,
  VERBATIM_REQUEST_TAIL_CHARS,
} from './frames.js'
import type { FrameSpawnRequest, Role } from './types.js'

// ── capVerbatimRequest ──────────────────────────────────────────────────────────────

test('capVerbatimRequest leaves a short request untouched', () => {
  const short = 'Add Option.count() in lib/option.js.'
  assert.equal(capVerbatimRequest(short), short)
})

test('capVerbatimRequest leaves a request exactly at the cap untouched (boundary, not off-by-one)', () => {
  const atCap = 'x'.repeat(VERBATIM_REQUEST_CHAR_CAP)
  assert.equal(capVerbatimRequest(atCap), atCap)
})

test('capVerbatimRequest truncates head-and-tail (not head-only) once over the cap, with an explicit marker', () => {
  // Two load-bearing clauses at OPPOSITE ends of a long message — mirrors the two traced
  // failures: bigproj-observability's seed-file pointer sat mid-message, and
  // commander-count-option's "do NOT modify any existing test file" sat at the very end.
  // A head-only truncation would keep the first and lose the second; both must survive.
  const head = 'READ test/export.test.js, test/audit-log.test.js, test/event-hook.test.js FIRST. '
  const filler = 'y'.repeat(VERBATIM_REQUEST_CHAR_CAP * 2)
  const tail = ' Do NOT modify any existing test file.'
  const long = head + filler + tail

  const capped = capVerbatimRequest(long)

  assert.ok(capped.length < long.length, 'must actually shrink the oversized request')
  assert.ok(capped.startsWith(head), 'the head clause must survive verbatim')
  assert.ok(capped.endsWith(tail), 'the tail clause must survive verbatim')
  assert.match(capped, /\[\d+ chars truncated — original request exceeded the \d+-char cap\]/)

  // Exact arithmetic, not just "some number appears": the marker must report the ACTUAL
  // count of dropped characters. A silently wrong count would be worse than no count at
  // all, since it would look precise while lying about how much context was discarded.
  const droppedMatch = /\[(\d+) chars truncated/.exec(capped)
  assert.ok(droppedMatch)
  const reportedDropped = Number(droppedMatch![1])
  assert.equal(reportedDropped, long.length - VERBATIM_REQUEST_HEAD_CHARS - VERBATIM_REQUEST_TAIL_CHARS)
  assert.equal(capped.startsWith(long.slice(0, VERBATIM_REQUEST_HEAD_CHARS)), true)
  assert.equal(capped.endsWith(long.slice(long.length - VERBATIM_REQUEST_TAIL_CHARS)), true)
})

// ── renderVerbatimRequestBlock ───────────────────────────────────────────────────────

test('renderVerbatimRequestBlock labels the block as authoritative and includes the (capped) text', () => {
  const msg = 'A failing spec is seeded at tests/eval-count-option.test.js. Read it first.'
  const block = renderVerbatimRequestBlock(msg)
  assert.match(block, /^\[ORIGINAL REQUEST — verbatim, authoritative;/)
  assert.match(block, /governs\]/)
  assert.ok(block.includes(msg), 'an under-cap message must appear whole, not re-truncated again')
})

test('renderVerbatimRequestBlock is deterministic — same input always produces the same block', () => {
  // Load-bearing for the cache argument (frames.ts's placement comment on buildAssignment):
  // if a Planner frame is re-spawned fresh during a replan (dispatch.ts's replan(), the
  // "no Planner ever existed yet" branch) rather than resumed, it must get a BYTE-
  // IDENTICAL block to what any sibling frame of the same run already has, or nothing
  // upstream of the divergence point can share a cached prefix.
  const msg = 'Implement exportTasksToCsv in src/export.js.'
  assert.equal(renderVerbatimRequestBlock(msg), renderVerbatimRequestBlock(msg))
})

// ── buildAssignment ──────────────────────────────────────────────────────────────────

const ROLES: Role[] = ['planner', 'implementer', 'tester', 'boss']

function req(assignment: string): FrameSpawnRequest {
  return { role: 'implementer', parentFrameId: null, assignment }
}

test('buildAssignment (flag ON): the verbatim block is present, at the HEAD, for every role that gets spawned', async () => {
  // dispatch.ts's spawnFrame calls buildAssignment with the SAME currentVerbatimRequest
  // regardless of req.role — this test proves that call has no role-based branch that
  // could silently exempt one role, by exercising all four directly.
  const verbatim = 'Three new failing tests are seeded at test/export.test.js — read them first.'
  for (const role of ROLES) {
    const assignment = await buildAssignment(
      '/workspace',
      { ...req('OBJECTIVE: build the CSV exporter.'), role },
      verbatim,
    )
    assert.ok(assignment.startsWith('[ORIGINAL REQUEST'), `role ${role} must see the block at the head`)
    assert.ok(assignment.includes(verbatim), `role ${role} must see the verbatim text itself`)
    assert.ok(
      assignment.indexOf('[ORIGINAL REQUEST') < assignment.indexOf('OBJECTIVE: build the CSV exporter.'),
      `role ${role}'s own assignment text must come AFTER the verbatim block, not before it`,
    )
  }
})

test('buildAssignment: the block is an exact prefix regardless of what dependsOn/assignment resolve to', async () => {
  // The property the prefix-cache argument actually depends on: everything BEFORE the
  // step-specific content is byte-identical across frames of one run, so appending
  // different downstream content (a different step prompt, a replan's revised prompt)
  // never touches — and so never invalidates — the shared head.
  const verbatim = 'Add Option.count() and do not touch any existing test file.'
  const block = renderVerbatimRequestBlock(verbatim)
  const a = await buildAssignment('/workspace', req('Step 1: implement the parser.'), verbatim)
  const b = await buildAssignment('/workspace', req('Step 2 (a REPLAN — different text entirely): revisit the parser.'), verbatim)
  assert.equal(a.slice(0, block.length), block)
  assert.equal(b.slice(0, block.length), block)
  assert.equal(a.slice(0, block.length), b.slice(0, block.length), 'identical heads across two differently-worded frames')
})

test('buildAssignment (flag OFF, verbatimRequest omitted): output is byte-identical to the pre-existing shape', async () => {
  const plain = req('OBJECTIVE: build the CSV exporter.')
  const withoutParam = await buildAssignment('/workspace', plain)
  const withUndefined = await buildAssignment('/workspace', plain, undefined)
  assert.equal(withoutParam, plain.assignment, 'no deps, no verbatim block: assignment passes through unchanged')
  assert.equal(withoutParam, withUndefined)
  assert.ok(!withoutParam.includes('ORIGINAL REQUEST'))
})

test('buildAssignment: an empty-string verbatimRequest behaves exactly like omitting it (falsy, not "empty block")', async () => {
  const plain = req('OBJECTIVE: build the CSV exporter.')
  const withEmpty = await buildAssignment('/workspace', plain, '')
  const withoutParam = await buildAssignment('/workspace', plain)
  assert.equal(withEmpty, withoutParam)
  assert.ok(!withEmpty.includes('ORIGINAL REQUEST'))
})

// ── Survives a replan ────────────────────────────────────────────────────────────────

test('the verbatim block survives a replan by construction: resumeFrame never rebuilds the assignment', async () => {
  // dispatch.ts's resumeFrame (verified by reading its body) does exactly one thing to
  // continue a frame: `agent.chat(followUp, { resume: true })` — it never calls
  // buildAssignment again. So whatever buildAssignment produced at the frame's ORIGINAL
  // spawnFrame call remains message #1 of that Agent instance's history for the rest of
  // its life, including every resume a replan performs on it. What is unit-testable
  // here, without executing that resume path (which needs a live Agent), is the
  // precondition that makes it safe: the initial spawn actually carried the block, and a
  // short REPLAN follow-up (the shape dispatch.ts's replan() sends — a few lines of
  // instruction, no re-statement of the original request) does not need to and does not
  // duplicate it — simulated here as a plain array append, since that is literally what
  // agent.ts's resumed chat() does to its own message history.
  const verbatim = 'Do NOT modify any existing test file.'
  const initialAssignment = await buildAssignment(
    '/workspace',
    { role: 'planner', parentFrameId: null, assignment: 'Objective: add Option.count(). Produce a task graph.' },
    verbatim,
  )
  assert.ok(initialAssignment.includes('ORIGINAL REQUEST'))

  const history = [initialAssignment]
  const replanFollowUp =
    'REPLANNING ROUND.\nStep s2 ended with status "failed".\nProduce a revised task graph for the remaining work only.'
  history.push(replanFollowUp)

  assert.ok(!replanFollowUp.includes('ORIGINAL REQUEST'), 'a replan follow-up is short and does not re-embed the block')
  assert.ok(history[0].includes(verbatim), 'the original spawn message — still message #1 — still carries it')
})
