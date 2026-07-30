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

export type TaskStatus = 'pending' | 'active' | 'done'

export interface Task {
  id: number
  title: string
  status: TaskStatus
}

export interface TaskList {
  objective: string
  // Ordered; ids are 1-based by position. Invariant: at most one 'active'.
  tasks: Task[]
  // Bumps ONLY when the plan changes (reconcile), not on progress — so telemetry
  // can distinguish "the model re-planned" from "the model finished a task".
  revision: number
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
export function createTaskList(objective: string, steps: string[]): TaskList {
  const seen = new Set<string>()
  const titles: string[] = []
  for (const step of steps) {
    const title = step.trim()
    if (!title) continue
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    titles.push(title)
  }
  const tasks: Task[] = titles.map((title, i) => ({
    id: i + 1,
    title,
    status: i === 0 ? 'active' : 'pending',
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
export function reconcile(list: TaskList, newObjective: string, newSteps: string[]): TaskList {
  // Titles that were completed in the prior plan, keyed by normalized title.
  const doneKeys = new Set<string>()
  for (const t of list.tasks) {
    if (t.status === 'done') doneKeys.add(normalizeTitle(t.title))
  }

  const seen = new Set<string>()
  const kept: { title: string; done: boolean }[] = []
  for (const step of newSteps) {
    const title = step.trim()
    if (!title) continue
    const key = normalizeTitle(title)
    if (!key || seen.has(key)) continue
    seen.add(key)
    kept.push({ title, done: doneKeys.has(key) })
  }

  const tasks: Task[] = kept.map((k, i) => ({
    id: i + 1,
    title: k.title,
    status: k.done ? 'done' : 'pending',
  }))
  // Promote the first non-done task to 'active' (if any remain).
  const next = tasks.find(t => t.status === 'pending')
  if (next) next.status = 'active'

  return { objective: newObjective.trim(), tasks, revision: list.revision + 1 }
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
    return `${box} ${t.id}. ${label}`
  })
  const footer = 'Finish the current task and verify it before moving on.'
  return `${header}\nObjective: ${list.objective}\n${lines.join('\n')}\n${footer}`
}
