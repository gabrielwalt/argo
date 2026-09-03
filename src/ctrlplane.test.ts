// SCHEMA-CONSTRAINED CONTROL PLANE — pipeline wiring tests (config.schemaControlPlane).
// No Ollama, no ledger, no git, no filesystem: exercises dispatch.ts's `graphFromPlanner`
// directly, the single site this idea was ranked top priority for
// (docs/research/09-small-model-scaffolding.md §1 — the `commander-option-requires`
// failure: the Planner failed to emit a readable graph even after its one format retry,
// ending the run in 87 seconds with zero progress). global.fetch is stubbed (the ONLY
// network surface schema.ts uses); `agent.chat`/resumeFrame is never reached in these
// tests because every one of them takes the flag-ON branch, which — by design — never
// resumes the frame (see dispatch.ts's comment at that call site).
//
// The three failure/recovery paths that matter most, mirrored from the task brief:
//   1. a genuinely unreadable Planner answer IS recovered via extraction.
//   2. extraction itself failing (HTTP failure, non-conformant reply) still hard-stops
//      (PlanningFailed) — NEVER an invented one-step plan.
//   3. a capped frame's cap-hit notice is never even sent for extraction — there is
//      nothing in it to restate — confirmed by asserting fetch was never called.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from './config.js'
import { graphFromPlanner, PlanningFailed } from './dispatch.js'
import type { Agent } from './agent.js'
import type { AgentEvent, FrameResult } from './types.js'

function fakeAgent(outcome: 'ok' | 'cap' | 'error' | 'aborted'): Agent {
  return { getLastRunOutcome: () => outcome } as unknown as Agent
}

function frameResult(summary: string): FrameResult {
  return { frameId: 'fr-planner-test', status: 'success', summary, filesTouched: [], filesWritten: [] }
}

async function withSchemaControlPlane<T>(enabled: boolean, fn: () => Promise<T>): Promise<T> {
  const original = config.schemaControlPlane
  config.schemaControlPlane = enabled
  try {
    return await fn()
  } finally {
    config.schemaControlPlane = original
  }
}

async function withStubbedFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = global.fetch
  global.fetch = impl
  try {
    return await fn()
  } finally {
    global.fetch = original
  }
}

// Prose deliberately WITHOUT a ```json fence — parseTaskGraph (the cheap first attempt)
// must fail to parse this, which is the precondition for graphFromPlanner to even reach
// the schema-extraction branch.
const UNFENCED_PLAN_PROSE =
  'Here is my plan: first implement the --count option parser in lib/option.js, then add ' +
  'tests verifying it rejects a non-numeric value.'

test('graphFromPlanner recovers a graph via schema extraction when the fenced JSON block is unreadable', async () => {
  await withSchemaControlPlane(true, async () => {
    const events: AgentEvent[] = []
    const frame = { agent: fakeAgent('ok'), result: frameResult(UNFENCED_PLAN_PROSE) }
    const { graph, result } = await withStubbedFetch(
      (async () => ({
        ok: true,
        json: async () => ({
          message: {
            content: JSON.stringify({
              steps: [
                { role: 'implementer', prompt: 'implement the --count option parser in lib/option.js' },
                { role: 'tester', prompt: 'verify it rejects a non-numeric value', dependsOn: ['s1'] },
              ],
            }),
          },
        }),
      })) as unknown as typeof fetch,
      () => graphFromPlanner('objective text', frame, e => events.push(e), 'initial plan'),
    )
    assert.equal(graph.steps.length, 2)
    assert.equal(graph.steps[0].role, 'implementer')
    assert.equal(graph.steps[1].role, 'tester')
    assert.deepEqual(graph.steps[1].dependsOn, ['s1'])
    // The frame's own result/conclusion is untouched — no resumeFrame call happened.
    assert.equal(result, frame.result)
    assert.ok(events.some(e => e.type === 'warning' && /recovered a 2-step task graph/.test(e.message)))
  })
})

test('graphFromPlanner hard-stops (PlanningFailed) rather than inventing a plan when extraction gets a non-OK HTTP response', async () => {
  await withSchemaControlPlane(true, async () => {
    const frame = { agent: fakeAgent('ok'), result: frameResult(UNFENCED_PLAN_PROSE) }
    await withStubbedFetch(
      (async () => ({ ok: false, status: 500, statusText: 'Internal Server Error' })) as unknown as typeof fetch,
      async () => {
        await assert.rejects(
          () => graphFromPlanner('objective text', frame, () => {}, 'initial plan'),
          PlanningFailed,
        )
      },
    )
  })
})

test('graphFromPlanner hard-stops rather than inventing a plan when extraction returns a non-conformant/empty reply', async () => {
  await withSchemaControlPlane(true, async () => {
    const frame = { agent: fakeAgent('ok'), result: frameResult(UNFENCED_PLAN_PROSE) }
    await withStubbedFetch(
      (async () => ({ ok: true, json: async () => ({ message: { content: '{"steps":[]}' } }) })) as unknown as typeof fetch,
      async () => {
        await assert.rejects(
          () => graphFromPlanner('objective text', frame, () => {}, 'initial plan'),
          PlanningFailed,
        )
      },
    )
  })
})

test('graphFromPlanner never attempts extraction on a capped frame — nothing to restate, no network call', async () => {
  await withSchemaControlPlane(true, async () => {
    let called = false
    // A capped Planner's "final answer" is agent.ts's own cap-hit notice, not a decision.
    const frame = { agent: fakeAgent('cap'), result: frameResult('Reached maximum iterations (20) without a final answer.') }
    await withStubbedFetch(
      (async () => { called = true; return { ok: true, json: async () => ({ message: { content: '{"steps":[{"role":"implementer","prompt":"x"}]}' } } ) } }) as unknown as typeof fetch,
      async () => {
        await assert.rejects(
          () => graphFromPlanner('objective text', frame, () => {}, 'initial plan'),
          PlanningFailed,
        )
      },
    )
    assert.equal(called, false, 'a capped frame has nothing to restate — must not spend a network round-trip on it')
  })
})

test('graphFromPlanner PlanningFailed message names the objective and the frame outcome, with no invented plan inside it', async () => {
  await withSchemaControlPlane(true, async () => {
    const frame = { agent: fakeAgent('ok'), result: frameResult(UNFENCED_PLAN_PROSE) }
    await withStubbedFetch(
      (() => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
      async () => {
        try {
          await graphFromPlanner('ship the widget', frame, () => {}, 'initial plan')
          assert.fail('expected PlanningFailed to throw')
        } catch (err) {
          assert.ok(err instanceof PlanningFailed)
          assert.match((err as Error).message, /ship the widget/)
          assert.match((err as Error).message, /No plan was invented in its place/)
        }
      },
    )
  })
})
