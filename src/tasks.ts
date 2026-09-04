// SEQUENTIAL TASK LEDGER (docs/harness-planning-memory.md, "Resolved decision
// 2026-07-30"). The LLM decomposes a multi-task prompt into an ORDERED plan during
// its planning phase; this module is the DETERMINISTIC core of Stage 3 that turns
// that plan into a ledger the harness drives ONE task at a time — reciting the
// current task, verifying it, then advancing — while letting the LLM RE-PLAN mid-run
// without losing completed-work state. Division of labour: LLM decomposes + refines;
// harness (this) sequences + tracks progress. Pure: NO LLM, NO fs, NO Date, NO
// randomness — every function returns fresh objects and never mutates its inputs, so
// it is side-effect-free at import and trivially unit-testable. The LLM-driven parts
// (deciding WHEN to re-plan, WHAT the steps are) live in agent.ts.

import type { Role } from './types.js'

export type TaskStatus = 'pending' | 'active' | 'done'

export interface Task {
  id: number
  title: string
  status: TaskStatus
  // Optional shell command (run from the workspace root) that exits 0 EXACTLY when
  // this task is genuinely complete — e.g. a test command, a build, or a grep. When
  // present, the harness's per-task gate (agent.ts) RUNS it instead of taking the
  // model's self-report at face value; only a clean exit advances the ledger, and a
  // non-zero exit blocks with the failure fed back. Absent (undefined) → the existing
  // self-check nudge path is used unchanged. This module never executes it (pure, no
  // shell) — it only carries the string through create/reconcile.
  verify?: string
  // Per-task SUMMARY (harness Change: SUMMARIES + FINAL RECONCILIATION), captured
  // by agent.ts once the active task is genuinely complete (after its verify, if
  // any, passes): a brief model-authored account of WHAT was done and HOW. Set via
  // recordActiveTaskSummary just before the task is marked 'done'. Undefined until
  // then. Carried FORWARD across reconcile for tasks preserved as 'done', same as
  // verify — it is the record the final reconciliation pass reviews, so losing it
  // on an incidental re-plan would make that pass blind to already-finished work.
  summary?: string
}

// A plan step as the LLM's update_plan tool call supplies it: either bare title text
// (the original shape — still fully supported, unverified) or an object naming the
// task plus an optional programmatic verify command. createTaskList/reconcile accept
// either, freely mixed within one steps array.
export type StepInput = string | { task: string; verify?: string }

export interface TaskList {
  objective: string
  // Ordered; ids are 1-based by position. Invariant: at most one 'active'.
  tasks: Task[]
  // Bumps ONLY when the plan changes (reconcile), not on progress — so telemetry
  // can distinguish "the model re-planned" from "the model finished a task".
  revision: number
}

// Normalises one raw step (string or {task, verify}) to a plain {title, verify}
// shape, trimming both. A bare string step carries no verify (undefined) — the
// exact pre-existing behavior. Defensive against malformed input (this ultimately
// comes from model-authored tool-call JSON): anything that isn't a string or an
// object with a string `task` normalises to a blank title, which the blank-step
// filter in createTaskList/reconcile then drops.
function normalizeStep(step: StepInput): { title: string; verify?: string } {
  if (typeof step === 'string') return { title: step.trim() }
  const title = typeof step.task === 'string' ? step.task.trim() : ''
  const verify = typeof step.verify === 'string' ? step.verify.trim() : undefined
  return { title, verify: verify || undefined }
}

// ── Title normalisation ───────────────────────────────────────────

// Normalises a step title for dedup (createTaskList) + progress matching
// (reconcile): lowercase, trim, strip a leading list marker/number ("1.", "2)",
// "- ", "* "), and collapse internal whitespace. So "1. Add auth", "add   auth", and
// "- Add Auth" all key to the same task — this is what lets a refined plan recognise
// a step it has ALREADY completed and keep it 'done'. Matching on the normalised
// TITLE (not id) is deliberate: ids are re-issued on every re-plan, so a stable,
// content-based key is the only thing that survives a re-decomposition.
export function normalizeTitle(s: string): string {
  return s
    .trim()
    .replace(/^\s*(?:[-*+]\s+|\d+\s*[.)]\s*)/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

// ── Construction ──────────────────────────────────────────────────

// Builds a fresh ledger from the LLM's plan (revision 1). Blank steps are dropped and
// exact-duplicate titles (by normalizeTitle) collapse to their FIRST occurrence — a
// small model sometimes emits the same step twice, and a doubled task would make the
// ledger never reach allDone. The displayed title keeps the author's ORIGINAL wording
// (only the dedup KEY is normalised). ids are 1-based by order; the first task is
// 'active', the rest 'pending'. Empty/all-blank steps → empty tasks (revision 1).
export function createTaskList(objective: string, steps: StepInput[]): TaskList {
  const seen = new Set<string>()
  const kept: { title: string; verify?: string }[] = []
  for (const step of steps) {
    const { title, verify } = normalizeStep(step)
    if (!title) continue
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    kept.push({ title, verify })
  }
  const tasks: Task[] = kept.map((k, i) => ({
    id: i + 1,
    title: k.title,
    status: i === 0 ? 'active' : 'pending',
    ...(k.verify ? { verify: k.verify } : {}),
  }))
  return { objective: objective.trim(), tasks, revision: 1 }
}

// ── Queries ───────────────────────────────────────────────────────

// The task the harness should be working RIGHT NOW: the explicit 'active' one, else
// (defensively, if an invariant slipped) the first 'pending'. null when the list is
// empty or everything is done — the caller's signal that the ledger is exhausted.
export function activeTask(list: TaskList): Task | null {
  const active = list.tasks.find(t => t.status === 'active')
  if (active) return active
  return list.tasks.find(t => t.status === 'pending') ?? null
}

// True when every task is 'done' — INCLUDING the empty list (→ true): "nothing left to
// do" is the correct terminal answer for a driver loop asking "am I finished?", and it
// composes cleanly (an empty/absent plan must never hang the harness). every() on [] is
// already true, so no length guard is needed (a guard here was a bug: it made an empty
// ledger report "not done" and could stall the done-gate).
export function allDone(list: TaskList): boolean {
  return list.tasks.every(t => t.status === 'done')
}

// Counts for status/telemetry. total counts ALL tasks; done counts completed ones.
export function progress(list: TaskList): { done: number; total: number } {
  return {
    done: list.tasks.filter(t => t.status === 'done').length,
    total: list.tasks.length,
  }
}

// ── Transitions (pure) ────────────────────────────────────────────

// Marks the current task 'done' and promotes the next 'pending' to 'active' — the one
// step the driver loop takes after verifying a task. Returns a NEW list (never mutates
// input); revision is UNCHANGED because completing a task is progress, not a plan
// change. If nothing is active (empty or all-done) it is a no-op returning an
// equivalent fresh list, so the caller can advance unconditionally.
export function completeActiveTask(list: TaskList): TaskList {
  const active = list.tasks.find(t => t.status === 'active')
  if (!active) {
    return { ...list, tasks: list.tasks.map(t => ({ ...t })) }
  }
  let promoted = false
  const tasks: Task[] = list.tasks.map(t => {
    if (t.id === active.id) return { ...t, status: 'done' }
    if (!promoted && t.status === 'pending') {
      promoted = true
      return { ...t, status: 'active' }
    }
    return { ...t }
  })
  return { ...list, tasks }
}

// RE-PLAN without losing completed work (the core operation). The LLM has refined its
// plan; build a NEW list from newSteps that PRESERVES progress: a new step whose
// normalized title matches a step that was 'done' stays 'done'; every other step comes
// in 'pending'. Removed steps simply drop out (their done-state is discarded — the
// model no longer considers that work part of the plan). Then the FIRST non-done task
// becomes 'active'. ids are fresh 1-based by the NEW order; revision increments (a
// plan change); objective updates. Input is never mutated. newSteps is deduped/blank-
// stripped exactly like createTaskList so the two constructors agree.
export function reconcile(list: TaskList, newObjective: string, newSteps: StepInput[]): TaskList {
  // Titles that were completed in the prior plan, keyed by normalized title — plus
  // every prior task's verify command and summary, keyed the same way, so a re-plan
  // that repeats a step without repeating its verify (or without the model restating
  // its summary) still keeps the check/record it had.
  const doneKeys = new Set<string>()
  const priorVerifyByKey = new Map<string, string | undefined>()
  const priorSummaryByKey = new Map<string, string | undefined>()
  for (const t of list.tasks) {
    const key = normalizeTitle(t.title)
    if (t.status === 'done') doneKeys.add(key)
    priorVerifyByKey.set(key, t.verify)
    priorSummaryByKey.set(key, t.summary)
  }

  const seen = new Set<string>()
  const kept: { title: string; done: boolean; verify?: string; summary?: string }[] = []
  for (const step of newSteps) {
    const { title, verify } = normalizeStep(step)
    if (!title) continue
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    // Prefer the freshly-supplied verify; fall back to the one this step already
    // carried in the prior plan (a re-plan that just reorders/rewords steps
    // shouldn't silently lose an existing programmatic check).
    const carriedVerify = verify ?? priorVerifyByKey.get(key)
    const done = doneKeys.has(key)
    // A summary only ever makes sense for a step PRESERVED as done — a step that is
    // (re)starting as pending/active has no completed work to summarise yet.
    const carriedSummary = done ? priorSummaryByKey.get(key) : undefined
    kept.push({ title, done, verify: carriedVerify, summary: carriedSummary })
  }

  const tasks: Task[] = kept.map((k, i) => ({
    id: i + 1,
    title: k.title,
    status: k.done ? 'done' : 'pending',
    ...(k.verify ? { verify: k.verify } : {}),
    ...(k.summary ? { summary: k.summary } : {}),
  }))
  // Promote the first non-done task to 'active' (if any remain).
  const next = tasks.find(t => t.status === 'pending')
  if (next) next.status = 'active'

  return { objective: newObjective.trim(), tasks, revision: list.revision + 1 }
}

// Sets the SUMMARY on the currently-active task ONLY — a pure sibling of
// completeActiveTask, called just before it so the harness can capture "what/how"
// on the same turn it advances the ledger. Does NOT change status (that is
// completeActiveTask's job — callers compose the two). A no-op (fresh copy, no
// active task) when nothing is active, mirroring completeActiveTask's shape so
// callers can use it unconditionally.
export function recordActiveTaskSummary(list: TaskList, summary: string): TaskList {
  const trimmed = summary.trim()
  const active = list.tasks.find(t => t.status === 'active')
  if (!active) {
    return { ...list, tasks: list.tasks.map(t => ({ ...t })) }
  }
  const tasks: Task[] = list.tasks.map(t => (t.id === active.id ? { ...t, summary: trimmed } : { ...t }))
  return { ...list, tasks }
}

// ── Rendering ─────────────────────────────────────────────────────

const STATUS_BOX: Record<TaskStatus, string> = {
  done: '[x]',
  active: '[\u2192]',
  pending: '[ ]',
}

// Renders the ledger as a compact recited checkbox todo for the TAIL of context
// (mirrors agent.ts renderPlanReminder tone). Small models drift off a multi-step
// goal, so the harness recites the FULL ledger every turn with the current task
// clearly marked (`[\u2192] ... CURRENT:`), reinforcing "work only this one; do not
// jump ahead" plus an explicit invitation to re-plan via update_plan only on genuine
// contradiction. Empty list → '' (nothing to recite).
export function renderTaskLedger(list: TaskList): string {
  if (list.tasks.length === 0) return ''
  const current = activeTask(list)
  const header =
    '[PLAN — work ONLY the current task; do not jump ahead. Refine with update_plan only if the work contradicts the plan.]'
  const lines = list.tasks.map(t => {
    const box = STATUS_BOX[t.status]
    const label = current && t.id === current.id ? `CURRENT: ${t.title}` : t.title
    // Hint that this step is machine-checked, not just self-reported — helps the
    // model understand why it might get blocked with a command failure instead of
    // a plain "are you sure?" nudge.
    return `${box} ${t.id}. ${label}${t.verify ? ' (auto-verified)' : ''}`
  })
  const footer = 'Finish the current task and verify it before moving on.'
  return `${header}\nObjective: ${list.objective}\n${lines.join('\n')}\n${footer}`
}

// Renders the ledger's per-task SUMMARIES as a compact numbered list — the record
// the FINAL RECONCILIATION pass (agent.ts) feeds back to the model alongside the
// objective, so it can double-check nothing was missed across the whole run. One
// entry per task, in ledger order; a task with no recorded summary (never reached,
// or reached without capturing one) renders an explicit placeholder rather than a
// blank line, so its absence is legible to the model reviewing it.
export function renderTaskSummaries(list: TaskList): string {
  return list.tasks
    .map(t => `${t.id}. ${t.title} [${t.status}]\n    ${t.summary || '(no summary recorded)'}`)
    .join('\n')
}

// ── TASK GRAPH (docs/subagents-plan.md, config.agents / ARGO_AGENTS) ──────────────
// The Planner's output in the multi-agent architecture: a DAG of steps, each naming
// which role executes it, its own prompt, and dependencies on other steps in this
// same graph. Deliberately a SEPARATE type from TaskList/StepInput above (the
// single-loop baseline's plan shape) rather than an extension of it — the two plans
// serve different loops and mixing their fields would make the baseline's
// createTaskList/reconcile ambiguous about which fields apply. Pure: no LLM, no fs,
// no Date — same discipline as the rest of this module.

export interface TaskStep {
  id: string // stable within the graph, e.g. "s1" — dependsOn references these, not frameIds
  role: Role
  prompt: string
  dependsOn: string[]
  // Steps sharing a frameGroup run in ONE frame, fed as sequential assignments,
  // instead of each getting its own frame + Tester pass — the unified mechanism for
  // both "too cheap to warrant its own frame" and "touches the same files/logic as
  // another step, must not be isolated" (see docs/subagents-plan.md).
  frameGroup?: string
  // the Planner marks a step trivial when it's small/unambiguous enough
  // that the Tester's separate verification pass wouldn't earn its
  // extra iterations — the Boss's own periodic/final checks remain the safety net
  // either way. Default false (unchanged behavior) when omitted.
  skipTest?: boolean
}

export interface TaskGraph {
  objective: string
  steps: TaskStep[]
  revision: number
}

// Builds a fresh graph (revision 1), assigning stable ids by position.
export function createTaskGraph(objective: string, steps: Array<Omit<TaskStep, 'id'>>): TaskGraph {
  return {
    objective: objective.trim(),
    steps: steps.map((s, i) => ({ id: `s${i + 1}`, ...s })),
    revision: 1,
  }
}

// Steps whose dependsOn are ALL satisfied and that aren't already done or in flight,
// grouped by frameGroup (a step with no frameGroup is its own singleton group, keyed
// by its own id) — what the dispatch loop dequeues next.
export function readyGroups(
  graph: TaskGraph,
  doneStepIds: ReadonlySet<string>,
  inFlightStepIds: ReadonlySet<string>,
): Map<string, TaskStep[]> {
  const groups = new Map<string, TaskStep[]>()
  for (const step of graph.steps) {
    if (doneStepIds.has(step.id) || inFlightStepIds.has(step.id)) continue
    if (!step.dependsOn.every(d => doneStepIds.has(d))) continue
    const key = step.frameGroup ?? step.id
    const arr = groups.get(key) ?? []
    arr.push(step)
    groups.set(key, arr)
  }
  return groups
}

export function allStepsDone(graph: TaskGraph, doneStepIds: ReadonlySet<string>): boolean {
  return graph.steps.every(s => doneStepIds.has(s.id))
}

// Renders the task graph as a compact recited block — the TaskGraph analogue of
// renderTaskLedger above, used by eviction.ts's pinned-anchor renderer.
export function renderTaskGraph(graph: TaskGraph): string {
  if (graph.steps.length === 0) return ''
  const lines = graph.steps.map(s => {
    const deps = s.dependsOn.length ? ` (after ${s.dependsOn.join(', ')})` : ''
    const group = s.frameGroup ? ` [group: ${s.frameGroup}]` : ''
    return `${s.id}. [${s.role}] ${s.prompt}${deps}${group}`
  })
  return `[PLAN — task graph, revision ${graph.revision}]\n${lines.join('\n')}`
}
