// MUTATION-AWARE loop detection + escalating recovery ladder (L0 -> L1 -> L2). A
// small local model tends to repeat the exact same tool call forever when it is
// stuck; the naive fix (count identical calls) also blocks a LEGITIMATE re-check —
// e.g. re-running a test after an edit to confirm it now passes. The fix here is to
// key "no progress" not on repetition count alone but on whether a project mutation
// (edit_file/write_file success) has happened SINCE the call last ran: if nothing
// changed, repeating is a loop; if something changed, the repeat is a fresh check
// and is always allowed. This module only DECIDES what to do about an about-to-run
// call — the agent (elsewhere) performs the corresponding side effects (skip the
// call, compact context, force a re-plan). Pure: no fs, no LLM, no Date, no
// randomness, and no mutation of anything outside the passed-in `state`.

export interface LoopConfig {
  // Consecutive no-progress blocks before an L1 compaction is triggered.
  l1BlocksBeforeCompact: number
  // Consecutive no-progress blocks before an L2 stop+reframe (forced re-plan).
  l2BlocksBeforeAbort: number
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  l1BlocksBeforeCompact: 3,
  l2BlocksBeforeAbort: 6,
}

export interface LoopState {
  // mutationCount recorded the last time each repetitionKey executed (or was
  // last evaluated) — lets evaluateCall tell "same call, nothing changed" apart
  // from "same call, but progress happened since".
  lastMutationByKey: Map<string, number>
  // Monotonic count of project mutations (edit/write successes) so far this run.
  mutationCount: number
  // Consecutive no-progress blocks since the last real progress (noteMutation).
  blocks: number
  // Whether an L1 compaction has already fired for the CURRENT stuck streak —
  // compaction is a one-shot intervention per streak, not repeated every block.
  compactedForStreak: boolean
  // Coarse near-duplicate guard (2026-09-03, checkSameToolStreak below): the SAME
  // tool NAME called repeatedly, regardless of args, with no mutation in between —
  // catches "many different bash commands all re-verifying the same already-true
  // fact" (observed in eval: self-reverification loops that never repeat an EXACT
  // call, so evade lastMutationByKey/blocks above entirely, which key on exact args).
  lastToolName: string | null
  sameToolStreak: number
  sameToolWarnedForStreak: boolean
}

// Fresh, empty state for the start of a run.
export function createLoopState(): LoopState {
  return {
    lastMutationByKey: new Map(),
    mutationCount: 0,
    blocks: 0,
    compactedForStreak: false,
    lastToolName: null,
    sameToolStreak: 0,
    sameToolWarnedForStreak: false,
  }
}

// Call when a project mutation happened (edit_file/write_file succeeded).
// Progress always breaks the current stuck streak.
export function noteMutation(state: LoopState): void {
  state.mutationCount++
  state.blocks = 0
  state.compactedForStreak = false
  state.sameToolStreak = 0
  state.sameToolWarnedForStreak = false
}

// Coarse near-duplicate guard, deliberately SEPARATE from evaluateCall above: that
// ladder only ever fires on an EXACT repeat (same tool + same args) and BLOCKS the
// call once it does. This one is looser (same tool, ANY args) and never blocks —
// near-duplicate calls, unlike exact ones, sometimes genuinely differ (gemini-cli's
// own loop-detection design treats these as a distinct case for exactly this
// reason: fuzzy matching, not a hard skip). Call this AFTER evaluateCall allows the
// call through; it only ever adds a nudge, never prevents execution. Fires once per
// streak (mirrors compactedForStreak) so it doesn't renag on every single call past
// the threshold. A call to a DIFFERENT tool resets the streak.
export const SAME_TOOL_WARN_THRESHOLD = 3

export function checkSameToolStreak(state: LoopState, toolName: string, threshold = SAME_TOOL_WARN_THRESHOLD): string | null {
  if (state.lastToolName === toolName) {
    state.sameToolStreak++
  } else {
    state.lastToolName = toolName
    state.sameToolStreak = 1
    state.sameToolWarnedForStreak = false
  }
  if (state.sameToolStreak >= threshold && !state.sameToolWarnedForStreak) {
    state.sameToolWarnedForStreak = true
    return (
      `You have now called \`${toolName}\` ${state.sameToolStreak} times in a row (different arguments each time, ` +
      'but the same kind of action, with nothing changed in between). If you already have what you need, commit ' +
      'to your verdict or answer now — otherwise take a genuinely different kind of action.'
    )
  }
  return null
}

export type LoopAction =
  | { kind: 'allow' }
  | { kind: 'steer'; level: 'L0'; message: string }
  | { kind: 'compact'; level: 'L1'; message: string }
  | { kind: 'replan'; level: 'L2'; message: string }

export interface LoopContext {
  // The tool being repeated (for the message).
  toolName: string
  // Objective + current-task recitation, to re-anchor the model.
  recite: string
  // Whether a task ledger is active — changes L2 wording (update_plan reconcile
  // vs a generic re-plan instruction).
  hasTasks: boolean
}

// Decide what to do about an about-to-run tool call identified by `key` (=
// repetitionKey(name, args) in agent.ts). Mutates `state`: records
// lastMutationByKey on allow, and advances/resets blocks + compactedForStreak
// on a no-progress repeat.
export function evaluateCall(
  state: LoopState,
  key: string,
  ctx: LoopContext,
  cfg: LoopConfig = DEFAULT_LOOP_CONFIG,
): LoopAction {
  const seen = state.lastMutationByKey.get(key)
  if (seen === undefined || seen !== state.mutationCount) {
    // New key, or a mutation happened since this key last ran — not a stall.
    state.lastMutationByKey.set(key, state.mutationCount)
    return { kind: 'allow' }
  }

  // Same call, nothing has changed since — a no-progress repeat.
  state.blocks++

  if (state.blocks >= cfg.l2BlocksBeforeAbort) {
    return { kind: 'replan', level: 'L2', message: l2ReframeMessage(ctx) }
  }
  if (state.blocks >= cfg.l1BlocksBeforeCompact && !state.compactedForStreak) {
    state.compactedForStreak = true
    return { kind: 'compact', level: 'L1', message: l1SteerMessage(ctx) }
  }
  return { kind: 'steer', level: 'L0', message: l0SteerMessage(ctx) }
}

// L0 — gentle first steer: name the exact repeat, demand a different concrete
// action or a final answer if the task is actually done.
export function l0SteerMessage(ctx: LoopContext): string {
  return (
    `You just issued the EXACT same \`${ctx.toolName}\` call that already ran, with nothing changed since. ` +
    `STOP repeating it — take a DIFFERENT concrete action toward the current task, or, if it is truly already done, say so.\n\n${ctx.recite}`
  )
}

// L1 — firmer: fires alongside a context compaction, so it explicitly notes
// that and demands a real change of approach.
export function l1SteerMessage(ctx: LoopContext): string {
  return (
    `Your context was just compacted to help you refocus. You have repeated the same \`${ctx.toolName}\` call several times with no progress. ` +
    `You must change your approach now — do not repeat this call again.\n\n${ctx.recite}`
  )
}

// L2 — strongest: abandon the current approach entirely and force a revised
// plan rather than another steer nudge.
export function l2ReframeMessage(ctx: LoopContext): string {
  const plan = ctx.hasTasks
    ? `Call \`update_plan\` now with a REVISED plan that solves the current task a different way — the harness will reconcile it, keeping already-completed tasks.`
    : `Produce a revised plan now for solving the current task a different way.`
  return (
    `You have repeatedly looped on \`${ctx.toolName}\` without any progress. ABANDON this approach. ${plan}\n\n${ctx.recite}`
  )
}
