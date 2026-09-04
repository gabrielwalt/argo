// MUTATION-AWARE loop detection + escalating recovery ladder (L0 -> L1 -> L2). A
// small local model tends to repeat the exact same tool call forever when it is
// stuck; the naive fix (count identical calls) also blocks a LEGITIMATE re-check —
// e.g. re-running a test after an edit to confirm it now passes. The fix here is to
// key "no progress" not on repetition count alone but on whether a project mutation
// (edit_file/write_file success) has happened SINCE the call last ran: if nothing
// changed, repeating is a loop; if something changed, the repeat is a fresh check
// and is always allowed. This module only DECIDES what to do about an about-to-run
// call — the agent (elsewhere) performs the corresponding side effects (skip the
// call, serve a cached result, compact context, force a re-plan). Pure: no fs, no
// LLM, no Date, no randomness, and no mutation of anything outside the passed-in
// `state`.
//
// 2026-09 redesign (H19/H20, MECHANISM-VERIFICATION.md §4.1, HYPOTHESIS-LEDGER.md):
// two changes from the original version of this module.
//   1. The near-duplicate "same tool, any args" guard (formerly checkSameToolStreak)
//      is DELETED outright. It fired 180 times across the full log corpus and
//      changed the model's next action in exactly 0 of them (every sampled firing
//      was immediately followed by another call to the same tool regardless) — a
//      mechanism that fires but never helps, not a mechanism that needs tuning.
//   2. The L0 exact-repeat guard now runs on a NORMALISED key (normalizeCallKey,
//      below), not the raw JSON.stringify(args) key, and its first hit on a given
//      key SERVES the cached prior result instead of a bare block. Measured: of 143
//      exact-repeat blocks with an observable next call, only 6 produced the
//      intended behaviour change; 46 were evaded by a cosmetically different
//      re-issue that the raw key cannot see — the two most common forms being
//      "append `2>&1`" (normalizeCallKey now closes this for the BLOCK decision —
//      see its rule list below) and "switch `read_file` for `bash cat`". The
//      latter is deliberately NOT closed and remains a known, still-open gap after
//      this redesign — see "What this explicitly does NOT collapse" below for why,
//      and /shared/argo-review/REPORT.md defect 2 for the adversarial review that
//      flagged it as open rather than implicitly closed by the 46/143 figure above.
//      Either way, a bare block gives the model nothing to act on besides "try
//      something else" with no information about WHAT changed (an empty answer,
//      since the plain answer is "nothing") — which is the other half of this
//      redesign.
//
// 2026-09 FIX ROUND (post-review, /shared/argo-review/REPORT.md +
// /shared/argo-loopfix/REPORT.md): two more changes, both narrowing when a CACHED
// RESULT may be replayed — never touching the allow-vs-block decision itself
// (mutationCount's role there is unchanged by either fix).
//   3. (FIX 1 / review defect 1) A cached result may only be replayed if no `bash`
//      call has executed since it was recorded. `isProjectMutation` (agent.ts)
//      only recognises edit_file/write_file, so a real filesystem change made via
//      `bash` (sed -i, `>`, `git checkout`, ...) is invisible to mutationCount —
//      and before this fix, replaying a cached read across that gap told the model
//      "nothing has changed" about a file that could have just changed underneath
//      it. See noteBashExecution below.
//   4. (FIX 2 / review defect 3, cone's call) A cached result may only be replayed
//      if the CURRENT call's args are the exact ones (up to object key order) that
//      produced it — normalizeCallKey's bash/path rules are safe for deciding
//      "this is the same call, blocked" but not for deciding "here is the same
//      BYTES" (a trailing `2>&1` can change real stdout/stderr interleaving order —
//      see StoredResult's doc comment below). See canonicalArgsKey below.

// 2026-09-04 (H21, this batch) — GATE REJECTIONS, and the unbounded L2, both
// captured live in the SAME frame. `commander/2026-09-04T01-48-24_fix-
// checkforrequiredlocaloptions-at.jsonl` ran 45 iterations / 12 minutes without
// spawning a new frame: 37 `bash` calls, 40 rejections total, one exact command
// (`grep -n 'conflicts' /workspace/lib/help.js`) reissued dozens of times. Two
// DISTINCT, evidenced problems were found reading that log directly (jq over the
// raw JSONL, not just the summary that flagged it):
//
//   (a) The role gate and the plan/act gate in agent.ts's tool-call loop
//       `continue` past evaluateCall entirely on a rejection — the loop's own
//       comments say so ("Not counted as a repeat, the call simply never runs" /
//       "it isn't counted as a repeat"), correctly, so a legitimate retry-after-
//       plan is never penalised. But it also means EITHER gate can refuse the
//       identical call forever with nothing watching. This is NOT what produced
//       the 32/40-repeat frame above (its every `rejected: true` event traces to
//       the pre-existing exact-repeat ladder below, not to either gate — see (b)),
//       but it is real and separately evidenced: two Planner frames on the
//       commander-option-requires hard task issued 9 and 7 rejected `bash` calls,
//       respectively, ALL refused on role (DRIVER-LOG.md, 2026-09-04 ~01:00) —
//       genuinely invisible to evaluateCall, since the role gate's `continue`
//       never reaches it. Fixed by noteGateRejection/clearPlanGateRejections/
//       GateReason below (agent.ts calls these at the role gate and the plan/act
//       gate specifically — see agent.ts's tool-call loop for exactly where).
//   (b) The cited 32/40-repeat frame's actual cause: its exact-repeat ladder DID
//       fire and escalate correctly, L0 -> L1 -> L2, exactly as designed — jq over
//       the log's `warning` events shows L2 ("You have repeatedly looped on
//       `bash` without any progress. ABANDON this approach... call update_plan")
//       firing roughly 30 times IN A ROW, ignored every time. `evaluateCall`'s L2
//       branch below had no ceiling: once `state.blocks >= l2BlocksBeforeAbort`,
//       every FURTHER no-progress repeat gets another identical 'replan', forever
//       — the ladder can escalate but never stop. Fixed by the LoopAction 'halt'
//       kind and haltBlocksAfterAbort below (agent.ts ends the frame on 'halt'
//       rather than continuing).
//
// Both fixes bound the SAME failure shape (a small model ignoring an escalating
// steer indefinitely) from the two different places it can originate — before the
// ladder ever sees the call (a), or after it has already escalated as far as it
// goes (b) — and both stop the FRAME rather than adding a further, softer rung: a
// harness that has refused the same thing 6+ times in a row has detected a real
// failure, and reporting that plainly is better than burning the remaining
// iteration budget to reach the same conclusion less legibly (see /shared/argo-
// gateloop/REPORT.md for the full design rationale and the "never fail open"
// constraint this observes).

export interface LoopConfig {
  // Consecutive no-progress blocks before an L1 compaction is triggered.
  l1BlocksBeforeCompact: number
  // Consecutive no-progress blocks before an L2 stop+reframe (forced re-plan).
  l2BlocksBeforeAbort: number
  // How many times the FIRST no-progress repeat of a given key gets served the
  // cached prior result (kind: 'replay') before falling back to the plain textual
  // L0 steer for further repeats of that same key. See evaluateCall's L0 branch.
  maxReplaysPerKey: number
  // H21(a). Consecutive identical GATE rejections (role gate / plan-act gate — see
  // noteGateRejection) of the SAME (call, reason) pair before the escalated
  // wording (gateEscalationMessage) replaces the gate's normal message. 3: "on
  // roughly the 3rd identical rejection" per this batch's design brief, and
  // matches l1BlocksBeforeCompact's cadence — this project's models are not
  // observed to self-correct from one or two identical refusals alone.
  gateEscalateAfter: number
  // H21(a). Consecutive identical GATE rejections of the SAME (call, reason) pair
  // after which agent.ts stops the FRAME rather than asking (and refusing) again.
  // 6, matching l2BlocksBeforeAbort's cadence: gateEscalateAfter (3) plus 3 further
  // escalated refusals — enough to show the escalated wording is being ignored
  // specifically, not just the plain one, before giving up on this frame.
  gateStopAfter: number
  // H21(b). Further consecutive no-progress ladder blocks AFTER L2 has already
  // fired once, before evaluateCall reports 'halt' instead of yet another
  // identical L2 'replan'. Captured live: the cited frame hit L2 ~30 times running
  // with zero effect. 4: L2 itself plus 4 further identical asks is enough to show
  // the model is not going to act on this specific reframe request (a model that
  // ignores "ABANDON this approach" 4 times running is not about to act on a 5th),
  // without cutting off a frame that might still self-correct on its first or
  // second look at the reframe demand.
  haltBlocksAfterAbort: number
}

export const DEFAULT_LOOP_CONFIG: LoopConfig = {
  l1BlocksBeforeCompact: 3,
  l2BlocksBeforeAbort: 6,
  maxReplaysPerKey: 1,
  gateEscalateAfter: 3,
  gateStopAfter: 6,
  haltBlocksAfterAbort: 4,
}

// A previously-executed tool's result, cached verbatim so a later exact/normalised
// repeat can be served it back instead of re-running (or just blocking) the call.
// Deliberately the minimal shape this module needs — not an import of agent.ts's
// richer ToolResult, to keep this module dependency-free. This is also the shape
// handed back on a LoopAction's `replay.cached` field — see StoredResult below for
// the internal-only extra field kept OUT of this public shape.
export interface LoopCachedResult {
  output: string
  error?: string
}

// What is actually stored per key: the cached result PLUS a canonical snapshot of
// the exact args that produced it (FIX 2 / review defect 3). `canonicalArgs` is
// JSON.stringify'd after ONLY object-key-order normalisation (canonicalize below) —
// never normalizeCallKey's path/bash rules, which change the actual string values
// (stripping a trailing `2>&1`, a leading `./`, ...) and are therefore safe for
// deciding "block this repeat" but not for deciding "these are the same bytes,
// safe to replay". Concretely: `cat -n X` and `cat -n X 2>&1` normalise to the
// SAME loopKey (correctly recognised as a repeat, still blocked either way), but
// they are NOT the same canonicalArgs, so the second is never served the first's
// cached output — see the file-level FIX 2 note above and the adversarial pair in
// /shared/argo-review/REPORT.md defect 3 (`2>&1` changes real stdout/stderr
// interleaving order via tools/bash.ts's stream concatenation, not just spelling).
interface StoredResult extends LoopCachedResult {
  canonicalArgs: string
}

export interface LoopState {
  // mutationCount recorded the last time each repetitionKey executed (or was
  // last evaluated) — lets evaluateCall tell "same call, nothing changed" apart
  // from "same call, but progress happened since".
  lastMutationByKey: Map<string, number>
  // Monotonic count of project mutations (edit/write successes) so far this run.
  // FIX 1 leaves this untouched: it keeps its exact pre-fix meaning and role in
  // the allow-vs-block decision (evaluateCall's `seen !== state.mutationCount`
  // check) — a `bash` call never advances it, same as before this fix round.
  mutationCount: number
  // Consecutive no-progress blocks since the last real progress (noteMutation).
  blocks: number
  // Whether an L1 compaction has already fired for the CURRENT stuck streak —
  // compaction is a one-shot intervention per streak, not repeated every block.
  compactedForStreak: boolean
  // The real result of the most recent EXECUTION of each key (populated by the
  // caller via recordResult right after a real tool call — this module never runs
  // a tool itself). Read by evaluateCall to serve a cached replay on the first
  // no-progress repeat of that key, but ONLY when canonicalArgs still matches
  // (FIX 2) and no `bash` call has run since (FIX 1 — see noteBashExecution,
  // which clears this map wholesale). Naturally stays correct across a mutation:
  // the entry is only ever replaced by a fresh recordResult call, which only
  // happens when the key was just actually re-executed.
  lastResultByKey: Map<string, StoredResult>
  // How many times each key has already been served as a cached replay since it
  // last actually executed. Cleared for a key the moment it next actually runs
  // (see evaluateCall's 'allow' branch) so a legitimately repeated action later in
  // the run gets a fresh replay budget, not the leftover count from earlier. Also
  // cleared wholesale by noteBashExecution, alongside lastResultByKey — see its
  // doc comment for why that pairing is kept even though it has no separately
  // observable effect through evaluateCall today.
  replaysByKey: Map<string, number>
  // H21(a). Counts of identical GATE rejections — calls refused by the role gate
  // or the plan/act gate in agent.ts's tool-call loop, BEFORE they ever reach
  // evaluateCall (both gates `continue` past it on a rejection; see this file's
  // H21 header note for the evidence). Keyed `${reason}:${normalizeCallKey(...)}`
  // (see noteGateRejection/GateReason) — never read or written by evaluateCall
  // itself, a strictly parallel counter for a strictly separate class of
  // rejection that the rest of this module cannot see.
  gateRejectCounts: Map<string, number>
}

// Fresh, empty state for the start of a run.
export function createLoopState(): LoopState {
  return {
    lastMutationByKey: new Map(),
    mutationCount: 0,
    blocks: 0,
    compactedForStreak: false,
    lastResultByKey: new Map(),
    replaysByKey: new Map(),
    gateRejectCounts: new Map(),
  }
}

// Call when a project mutation happened (edit_file/write_file succeeded).
// Progress always breaks the current stuck streak.
export function noteMutation(state: LoopState): void {
  state.mutationCount++
  state.blocks = 0
  state.compactedForStreak = false
}

// FIX 1 (/shared/argo-loopfix/REPORT.md, /shared/argo-review/REPORT.md defect 1).
// Call right after a `bash` call actually executed — success OR error, since a
// command can mutate the filesystem before later failing (`sed -i ...; false`) and
// its effect either way is unknowable without a shell parser. `isProjectMutation`
// (agent.ts) only ever recognises edit_file/write_file, so a real change made via
// `sed -i`, `>`, `mv`, `git apply`, `git checkout`, etc. never advances
// mutationCount — before this fix, that gap let a later cached-replay confidently
// tell the model "nothing has changed" about a file that just changed underneath
// it via bash, which is strictly worse than the pre-redesign bare block (it
// fabricates specific stale content instead of fabricating nothing).
//
// The fix is deliberately NOT "try to recognise a mutation-looking bash command" —
// that is exactly the "clever fuzzy matcher" this module elsewhere declines to
// build (see normalizeCallKey's rejections below), and a false negative there
// (missing a real mutation) would recreate the exact bug this is fixing. Instead,
// every cached result is invalidated wholesale on ANY bash call, not just one
// attributed to the same file: a bash call's blast radius is unknowable, so the
// conservative, provably-safe choice is to distrust every cache rather than guess
// which one (if any) bash might have touched.
//
// This does NOT touch mutationCount, lastMutationByKey, blocks, or
// compactedForStreak — invalidating a CACHE is not progress, and the allow-vs-
// block decision (evaluateCall's `seen !== state.mutationCount` check) is exactly
// as blind to bash mutations after this fix as it was before it (a real, separate,
// documented gap — see /shared/argo-loopguard/REPORT.md's own Q2 — left for a
// follow-up that can see inside `bash`, not patched over here by proxy). The one
// visible cost is an occasional missed replay for a key that bash never actually
// touched, which falls back to the plain L0 steer instead — the safe direction per
// this module's own principle that a false collapse is worse than a missed one.
export function noteBashExecution(state: LoopState): void {
  state.lastResultByKey.clear()
  // replaysByKey clears too. This has no OBSERVABLE effect through evaluateCall on
  // its own today — the L0 replay branch already requires `cached` to be truthy,
  // so a stale positive count against a now-absent cache entry could never be read
  // — but keeping the invariant "a key's replay budget never outlives the cached
  // result it was consuming budget against" true unconditionally (not just true by
  // the accident of one guard clause) means this function's contract stays legible
  // without also reading evaluateCall's internals, and stays correct if that guard
  // ever changes shape.
  state.replaysByKey.clear()
}

// Call right after a tool call actually executed (whether it errored or not) with
// the key evaluateCall was given for that call and the exact args it ran with, so
// a later no-progress repeat of the SAME key with the SAME args (FIX 2 — see
// StoredResult's doc comment) can be served this exact result back (see
// evaluateCall's L0 'replay' branch). Never called for a call the ladder itself
// blocked — those never reach the tool.
export function recordResult(
  state: LoopState,
  key: string,
  args: Record<string, unknown>,
  result: LoopCachedResult,
): void {
  state.lastResultByKey.set(key, { ...result, canonicalArgs: canonicalArgsKey(args) })
}

// ── GATE-REJECTION counter (H21) ─────────────────────────────────────────────
//
// See this file's header note for the evidence and the shape of the gap this
// closes. Everything above this section governs calls that REACH evaluateCall —
// i.e. calls the harness actually executes, replays, or blocks as a no-progress
// repeat. `noteGateRejection` below is for the two OTHER call sites in agent.ts's
// tool-call loop that never reach evaluateCall at all: the role gate (a tool
// outside the current frame's allowedTools) and the plan/act gate (a project
// mutation attempted before any plan exists). Both `continue` past evaluateCall on
// a rejection, by design — see agent.ts's own comments at those two sites for why
// that is correct in isolation (a plan/act rejection must stop counting once a
// plan exists, or a legitimate retry-after-plan would read as a stuck loop).
//
// A third gate this batch's design brief asked to instrument — a "task-sequencing
// gate" in tasks.ts said to reject a call for belonging to a not-yet-current task
// — was searched for directly (grep across agent.ts/tasks.ts/tools/*.ts, and by
// reading the cited log's raw JSONL event-by-event) and not found as a hard-reject
// code path: `tasks.ts`'s `renderTaskLedger` only ever produces RECITED text
// (`ctx.recite`, appended to whatever DOES reject a call — including, confusingly,
// the exact-repeat ladder's own steer/reframe messages below, which is why its
// "[PLAN — work ONLY the current task; do not jump ahead...]" wording shows up
// inside every warning in the cited frame). There is no separate mechanism in this
// codebase that blocks a read of a file belonging to a later task; see /shared/
// argo-gateloop/REPORT.md for the full trace of the cited log that led to this
// finding. Only 'role' and 'plan' are instrumented below as a result.
export type GateReason = 'role' | 'plan'

function gateRejectMapKey(reason: GateReason, key: string): string {
  return `${reason}:${key}`
}

export interface GateRejectionOutcome {
  // Total identical rejections of this (call, reason) pair so far, this frame.
  count: number
  // True from cfg.gateEscalateAfter onward — agent.ts should use
  // gateEscalationMessage instead of the gate's normal rejection text.
  escalate: boolean
  // True from cfg.gateStopAfter onward — agent.ts must end the frame (see
  // gateStopMessage) rather than continue the run.
  stop: boolean
}

// Call from agent.ts's role gate / plan-act gate at the moment either one refuses
// a call, with `key` = normalizeCallKey(name, args) — the SAME key evaluateCall
// would use if the call ever reached it — and `reason` naming WHICH gate refused
// it. Keying on the reason too (not just the call) is what keeps the plan/act
// gate's legitimate retry-after-plan safe: once a plan is recorded, the plan/act
// gate stops firing for good (see clearPlanGateRejections below), so its counter
// for that key simply stops being reached — a role-gate rejection of the exact
// same call is a DIFFERENT situation (the tool remains unavailable for the rest of
// the frame) and gets its own independent count, never contaminated by, or
// contaminating, the plan/act one.
//
// RESET SEMANTICS (deliberately NOT handled inside this function — each trigger
// belongs to agent.ts state this pure module cannot see):
//   - 'role': NEVER reset within a frame. `allowedTools` is fixed for the life of
//     one role-scoped Agent instance (agent.ts: one frame = one scoped Agent), so
//     a role-gate rejection of a given call can never later succeed in this same
//     frame — there is no legitimate-retry case to protect here, unlike 'plan', so
//     there is nothing to reset it FOR. It only ever grows until the frame ends.
//   - 'plan': cleared GLOBALLY (clearPlanGateRejections, below), the instant a
//     plan is first recorded this run — not per-key. The plan/act gate's own
//     condition (`!this.currentPlan`) stops applying to EVERY call project-wide at
//     that instant, not just to whichever key happened to trigger the update_plan
//     call, so its rejection counts must clear the same way.
//   - Deliberately NOT reset on a mutation, and NOT reset on a new task becoming
//     current: neither changes the plan/act gate's or the role gate's own
//     triggering condition, so resetting on either would be a reset with no
//     corresponding change in what is actually being counted — exactly the
//     over-eager reset this batch's design brief warns re-opens the hole (a model
//     could rack up mutation- or task-advance-separated rejections of the SAME
//     still-gated call indefinitely, each reset just before the threshold, and
//     never reach escalation or the stop bound).
export function noteGateRejection(
  state: LoopState,
  key: string,
  reason: GateReason,
  cfgIn: Partial<LoopConfig> = DEFAULT_LOOP_CONFIG,
): GateRejectionOutcome {
  // Callers may pass a partial override (existing tests supply only the three
  // pre-2026-09-04 fields); merge over the defaults so a new tier never turns an
  // omitted field into NaN and silently disables itself.
  const cfg = { ...DEFAULT_LOOP_CONFIG, ...cfgIn }
  const gk = gateRejectMapKey(reason, key)
  const count = (state.gateRejectCounts.get(gk) ?? 0) + 1
  state.gateRejectCounts.set(gk, count)
  return { count, escalate: count >= cfg.gateEscalateAfter, stop: count >= cfg.gateStopAfter }
}

// Clears every 'plan'-reason gate-rejection count, for every key — call exactly
// once, the moment a plan is first recorded this run (agent.ts's handleUpdatePlan,
// right after it sets this.currentPlan). See noteGateRejection's reset-semantics
// note above for why this must be a GLOBAL clear (every key, not just the one that
// triggered this update_plan call) rather than a per-key one: the plan/act gate
// itself stops firing for every call the instant a plan exists, so its counters
// must stop existing the same way, not merely stop incrementing and linger as dead
// entries that a later, unrelated 'role' rejection of the same key must never read.
export function clearPlanGateRejections(state: LoopState): void {
  for (const k of [...state.gateRejectCounts.keys()]) {
    if (k.startsWith('plan:')) state.gateRejectCounts.delete(k)
  }
}

// H21(a) escalated wording — fires once a (call, reason) pair has been refused
// cfg.gateEscalateAfter times. Shaped for a small local model with the same
// discipline as l0SteerMessage/l2ReframeMessage below: short, literal, imperative,
// and naming the ONE concrete alternative action. Deliberately NOT "stop
// repeating" alone — this project has measured that shape achieving its purpose
// in only 6 of 143 firings (this file's H19/H20 note above,
// /shared/argo-loopguard/REPORT.md) precisely because it names the problem
// without saying what to do instead. Includes the live `count` so consecutive
// escalated messages for a slow-to-stop model are never byte-identical either —
// the same defect (identical text, repeated) this whole mechanism responds to.
export function gateEscalationMessage(reason: GateReason, toolName: string, count: number, recite: string): string {
  const alternative = reason === 'role'
    ? `\`${toolName}\` does not exist for you in this role, and asking again will not change that. Do NOT call \`${toolName}\` again. Achieve the goal using only the tools you actually have, or give your best answer now with what you already know.`
    : `\`${toolName}\` cannot run until a plan exists. Do NOT retry \`${toolName}\` yet. Call \`update_plan\` now with a concrete objective and steps — THEN retry \`${toolName}\`.`
  return `You have now asked for \`${toolName}\` ${count} times and been refused every time for the SAME reason. It will keep being refused. ${alternative}\n\n${recite}`
}

// H21(a) stop wording — fires once a (call, reason) pair reaches cfg.gateStopAfter.
// Paired with agent.ts ending the frame right after this (see /shared/argo-
// gateloop/REPORT.md for the exact frame-stop contract and why it reuses the
// existing 'cap' RunOutcome rather than adding a new one). Told to the model
// mainly for the transcript's sake — the frame ends immediately after, so there is
// no next turn for it to act on.
export function gateStopMessage(reason: GateReason, toolName: string, count: number): string {
  const gateName = reason === 'role' ? 'the role tool restriction' : 'the plan-before-mutation gate'
  return `STOPPING this frame: \`${toolName}\` has been refused ${count} times in a row by ${gateName}, with no progress. Continuing would only repeat the same refusal.`
}

// ── L0 key normalisation (H20) ──────────────────────────────────────────────
//
// evaluateCall's `key` is normally repetitionKey(name, args) from agent.ts — the
// literal JSON.stringify of the arguments. normalizeCallKey below computes a
// SEPARATE, coarser key that the ARGO_LOOP ladder uses instead (the baseline
// REPEAT_THRESHOLD path in agent.ts keeps using the raw key unchanged, so
// behaviour with the ladder OFF is untouched by any of this).
//
// Every rule here is chosen because it can be shown NOT to change what the call
// actually does — never because it merely looks similar. The governing principle:
// a MISSED evasion just costs another iteration (the existing failure mode,
// unchanged); a FALSE collapse tells the model a materially different call is
// "the same one you already ran", which can hide real information from it. When a
// candidate rule cannot be shown safe, it is left out — see the explicit
// rejections below the code (`| head`, cross-tool equivalence, interior path
// spellings, generic whitespace collapse, and — post-review — a trailing slash)
// for cases considered and declined.
//
// IMPORTANT: this key normalisation governs the BLOCK/no-progress decision only.
// It does NOT govern whether a cached result may be REPLAYED — that additionally
// requires canonicalArgs to match exactly (FIX 2, see StoredResult above) and no
// intervening `bash` call (FIX 1, see noteBashExecution above). A rule can be
// perfectly safe for "these two calls are the same ask" while still being unsafe
// for "these two calls would return the same bytes" — the `2>&1` rule below is
// exactly that case, which is why it stays here (blocking is still correct) but is
// NOT trusted for replay.
//
// What this DOES collapse:
//   - Object key order in the args object (`{a,b}` vs `{b,a}` serialize the same).
//   - A leading `./` or a doubled internal `/` in a `path` argument
//     (read_file/write_file/edit_file/view_image) — unambiguous POSIX-equivalent
//     spellings of the same path with no symlink/`..` resolution attempted.
//   - For `bash`'s `command` string only, and only at the very END of the string
//     (see the "why only the end" note on normalizeBashCommand): leading/trailing
//     whitespace; a trailing chain of `2>&1` / `1>&2` / `>/dev/null` / `1>/dev/null`
//     / `2>/dev/null` / `&>/dev/null` (streams that are merged or discarded, never
//     written to a real file); quotes around a trailing plain path/word token with
//     no whitespace or shell metacharacters in it; a leading `./` on that same
//     trailing token.
//
// What this explicitly does NOT collapse (by design, not oversight):
//   - A trailing `/` on a `path` argument (`x/` vs `x`). Considered safe in the
//     original version of this rule and REMOVED after adversarial review
//     (/shared/argo-review/REPORT.md's normalisation table): if `x` is a plain
//     file, `read_file('x/')` can fail with an ENOTDIR-class error where
//     `read_file('x')` succeeds — collapsing the two hides a real success/failure
//     boundary, not a spelling difference, which is exactly the false-collapse
//     this module's own principle says is worse than a miss. `./x` and doubled
//     internal `/` stay collapsed; only the trailing case was unsafe.
//   - `bash cat X` vs `read_file X` — literally the model's own most common evasion
//     (MECHANISM-VERIFICATION.md §4.1) but collapsing across TOOLS asserts the two
//     tools are equivalent for every purpose (error text, size limits, permissions
//     differ), which is not a "small, well-argued rule" — it is exactly the
//     "clever fuzzy matcher" the mandate says to avoid. Left as a KNOWN, STILL-OPEN
//     GAP (not implicitly closed by this redesign's other numbers — see
//     /shared/argo-review/REPORT.md defect 2) — the cached-replay mechanism
//     (below) helps here too, once, if the model happens to re-hit the SAME tool a
//     second time, but not on the cross-tool switch itself.
//   - `> real/path`, `>> real/path`, `| tee real/path` — anything that can write a
//     real file is never touched, even though a model switching TO one of these as
//     its evasion is common (an observed real example switched `| head -80` to
//     `| tee /tmp/…`) — that is a genuine behaviour change, not a cosmetic one.
//   - A trailing `| head` (with or without a count) added or removed. Considered
//     and rejected: unlike a redirection, `head` changes how much of the SAME
//     output the model can see, and whether adding/removing it is "cosmetic"
//     depends on the direction — a model that saw truncated output and now wants
//     the rest is asking a genuinely different question, and collapsing that would
//     be exactly the false-collapse the mandate warns is worse than a miss.
//   - Any whitespace or quoting INSIDE the middle of a bash command (only the
//     trailing token and the string's own ends are touched — see
//     normalizeBashCommand's header comment for why the middle is left alone).
//   - Any argument other than `command` (bash) and `path` (file tools) — e.g.
//     `edit_file`'s `old_string`/`new_string`, or a materially different
//     `timeout_ms`/`cwd` on a repeated bash call, are compared verbatim.
//   - `..` path segments, resolving symlinks, or case-folding — none of that can be
//     done correctly without touching the filesystem, which this pure module must
//     not do.

// Recursively sorts object keys so `{a:1,b:2}` and `{b:2,a:1}` serialize
// identically. Array element ORDER is never touched — unlike object keys, position
// in an array can carry meaning, so only object key order (which by definition
// carries none in JSON) is normalised. Reused for BOTH normalizeCallKey (the block
// decision) and canonicalArgsKey (the replay-eligibility decision, FIX 2) because
// reordering an object's keys never changes any argument VALUE — unlike every
// other normalizeArgsForKey rule below, it is safe for both purposes at once.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = canonicalize(src[k])
    return out
  }
  return value
}

// FIX 2's replay-eligibility snapshot: canonicalize (key order only — see its doc
// comment) then stringify, WITHOUT any of normalizeArgsForKey's path/bash rules.
// Two calls whose normalizeCallKey matches can still have different
// canonicalArgsKey values (e.g. the `2>&1` pair) — that difference is exactly what
// FIX 2 uses to refuse a replay while still allowing the block/escalation decision
// to treat them as the same repeat.
function canonicalArgsKey(args: Record<string, unknown>): string {
  return JSON.stringify(canonicalize(args))
}

// './x' and 'x' name the same file; collapsing '..' or symlinks would require
// actually resolving the filesystem, which this rule deliberately does not attempt
// (a wrong resolution would itself be a false collapse). A trailing '/' is
// deliberately NOT collapsed here — see "What this explicitly does NOT collapse"
// above (FIX 3 / review's normalisation table: an ENOTDIR-class failure can turn
// on that exact spelling difference).
function normalizePathArg(p: string): string {
  return p.replace(/^\.\//, '').replace(/\/{2,}/g, '/')
}

const PATH_ARG_KEYS = new Set(['path'])

// Rules 2-4 below intentionally touch only the STRING'S OWN ENDS (leading/trailing
// whitespace, and suffix chains of specific tokens), never an interior substring.
// This module has no shell parser and never will, so it relies on a structural
// fact instead: in any syntactically valid shell command, quotes are balanced, so
// a quote that is still "open" at the very end of the string cannot exist (an
// actually-open quote would make the command incomplete, which is not something a
// model would knowingly submit as a finished call). That means anything matched by
// an END-anchored pattern, after removal of an already end-anchored match to its
// right, is provably outside any quoted region — "provably outside quotes by
// construction" is the bar for every rule here, not "probably fine in practice".
function normalizeBashCommand(cmd: string): string {
  let s = cmd.trim()

  // Rule 1 — a trailing chain of stream redirections that MERGE or DISCARD an
  // already-produced stream, never write a real file: 2>&1, 1>&2, >/dev/null,
  // 1>/dev/null, 2>/dev/null, &>/dev/null. This is the exact evasion measured in
  // MECHANISM-VERIFICATION.md §4.1: `cat -n X` -> `cat -n X 2>&1`. Looped because
  // more than one can stack (`>/dev/null 2>&1`); re-trimmed after each removal.
  // Safe for the BLOCK decision (two commands differing only by this chain really
  // are "no progress" either way); NOT trusted for REPLAY (FIX 2 — see the
  // `2>&1`-changes-interleaving-order case in canonicalArgsKey's doc comment and
  // /shared/argo-review/REPORT.md defect 3).
  const redir = /\s*(?:2>&1|1>&2|&>\s*\/dev\/null|[12]?>\s*\/dev\/null)\s*$/
  while (redir.test(s)) s = s.replace(redir, '').trimEnd()

  // Rule 2 — quotes around the trailing token, ONLY when the quoted content has no
  // whitespace and no shell metacharacter (so the quoting could not have been
  // doing any real work — no word-splitting or globbing to prevent). `cat file.txt`
  // and `cat "file.txt"` behave identically; `cat "*.txt"` and `cat *.txt` do NOT
  // (glob expansion differs), and '*' is excluded from the allowed charset so that
  // case is left untouched.
  s = s.replace(/(^|\s)(['"])([A-Za-z0-9_.\/=-]+)\2$/, '$1$3')

  // Rule 3 — a leading './' on the trailing token only, now that it is unquoted.
  // '../x' is a different, real path segment and is not touched: the regex
  // requires the token to start with exactly one '.' then '/', and `(^|\s)`
  // anchors that to the START of the token, so '..' cannot satisfy it (the
  // character immediately before the matched '.' would have to be whitespace or
  // start-of-string, but in '../x' it is another '.').
  s = s.replace(/(^|\s)\.\/([A-Za-z0-9_.\/-]+)$/, '$1$2')

  return s
}

function normalizeArgsForKey(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const canon = canonicalize(args) as Record<string, unknown>
  for (const k of Object.keys(canon)) {
    if (PATH_ARG_KEYS.has(k) && typeof canon[k] === 'string') canon[k] = normalizePathArg(canon[k] as string)
  }
  if (name === 'bash' && typeof canon.command === 'string') canon.command = normalizeBashCommand(canon.command)
  return canon
}

// The ARGO_LOOP ladder's own repeat key — NOT used by the baseline REPEAT_THRESHOLD
// path in agent.ts (which keeps repetitionKey's raw JSON.stringify unchanged), so
// this can only ever affect behaviour when the ladder is on.
export function normalizeCallKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(normalizeArgsForKey(name, args))}`
}

export type LoopAction =
  | { kind: 'allow' }
  // First no-progress repeat(s) of a key, up to cfg.maxReplaysPerKey: the cached
  // result of the call that already ran is served back, labeled as a repeat,
  // instead of a bare block. `cached` is exactly what recordResult last stored for
  // this key (output/error only — canonicalArgs is internal, see StoredResult).
  | { kind: 'replay'; level: 'L0'; message: string; cached: LoopCachedResult }
  | { kind: 'steer'; level: 'L0'; message: string }
  | { kind: 'compact'; level: 'L1'; message: string }
  | { kind: 'replan'; level: 'L2'; message: string }
  // H21(b). L2 itself has no ceiling below this addition — evaluateCall returns
  // 'replan' again on every FURTHER no-progress repeat once `blocks >=
  // l2BlocksBeforeAbort`, forever. The frame that motivated this batch shows why
  // that matters: L2 fired ~30 times in a row, each carrying "ABANDON this
  // approach... call update_plan," never acted on. 'halt' fires once, after
  // cfg.haltBlocksAfterAbort FURTHER blocks past the first L2 — agent.ts must END
  // THE FRAME on this (never just `continue`), reusing the existing 'cap'
  // RunOutcome so it reports as a stall, never success (see /shared/argo-gateloop/
  // REPORT.md for the exact contract).
  | { kind: 'halt'; message: string }

export interface LoopContext {
  // The tool being repeated (for the message).
  toolName: string
  // Objective + current-task recitation, to re-anchor the model.
  recite: string
  // Whether a task ledger is active — changes L2 wording (update_plan reconcile
  // vs a generic re-plan instruction).
  hasTasks: boolean
  // Short human-readable summary of the repeated call's key args (e.g. a URL, a
  // path, a truncated command) — lets the L0 messages show WHAT was repeated, not
  // just that something was. Optional: falls back to the plain wording when
  // absent (agent.ts is the only caller and may not always have a summariser).
  callSummary?: string
}

// Decide what to do about an about-to-run tool call identified by `key` (=
// normalizeCallKey(name, args) when the ladder is on — see agent.ts) with the
// exact `args` it is about to run with (needed only for FIX 2's replay-eligibility
// check below; the allow-vs-block decision itself is still keyed on `key` alone,
// exactly as before). Mutates `state`: records lastMutationByKey + clears any
// replay budget on allow, and advances/resets blocks + compactedForStreak on a
// no-progress repeat.
export function evaluateCall(
  state: LoopState,
  key: string,
  args: Record<string, unknown>,
  ctx: LoopContext,
  cfgIn: Partial<LoopConfig> = DEFAULT_LOOP_CONFIG,
): LoopAction {
  const cfg = { ...DEFAULT_LOOP_CONFIG, ...cfgIn }
  const seen = state.lastMutationByKey.get(key)
  if (seen === undefined || seen !== state.mutationCount) {
    // New key, or a mutation happened since this key last ran — not a stall. A
    // fresh execution is about to happen (the caller calls recordResult right
    // after it), so this key's replay budget resets too.
    state.lastMutationByKey.set(key, state.mutationCount)
    state.replaysByKey.delete(key)
    return { kind: 'allow' }
  }

  // Same call, nothing has changed since — a no-progress repeat. This decision is
  // driven by mutationCount alone, exactly as before FIX 1/2 — a `bash` call that
  // may have mutated the target file still does not make this an 'allow' (that gap
  // is real, documented, and deliberately not patched by proxy here — see
  // noteBashExecution's doc comment). What FIX 1/2 change is only what happens
  // BELOW, inside this same no-progress branch: whether the block is a REPLAY or
  // the plain steer.
  state.blocks++

  // H21(b) — checked BEFORE the plain L2 branch: once L2 has already fired once
  // for this streak and cfg.haltBlocksAfterAbort further no-progress repeats have
  // happened with no effect, stop escalating text and report a halt instead. See
  // the LoopAction 'halt' doc comment above for the evidence this responds to.
  if (state.blocks >= cfg.l2BlocksBeforeAbort + cfg.haltBlocksAfterAbort) {
    return { kind: 'halt', message: lHaltMessage(ctx, state.blocks) }
  }
  if (state.blocks >= cfg.l2BlocksBeforeAbort) {
    return { kind: 'replan', level: 'L2', message: l2ReframeMessage(ctx, state.blocks) }
  }
  if (state.blocks >= cfg.l1BlocksBeforeCompact && !state.compactedForStreak) {
    state.compactedForStreak = true
    return { kind: 'compact', level: 'L1', message: l1SteerMessage(ctx) }
  }

  // L0: serve the cached result, labeled as a repeat, while budget for this key
  // remains AND that cache is still trustworthy — cheaper AND more informative
  // than a bare block when it is (see the file header for why). A cache is
  // trustworthy only when BOTH hold: (FIX 2) the current call's args are exactly
  // what produced it (canonicalArgsKey match — a normalised-equal-but-raw-different
  // repeat, e.g. the `2>&1` pair, still counts as a block above but is not replayed
  // here); (FIX 1) no `bash` call ran since it was recorded (noteBashExecution
  // clears lastResultByKey wholesale on any bash execution, so `cached` is simply
  // absent here if one did). Once budget is exhausted, or a cache exists but fails
  // either check, further no-progress repeats of the SAME key fall back to the
  // plain textual steer; the global `blocks` counter above still drives the run to
  // L1/L2 on the same schedule regardless of which L0 form fired.
  const cached = state.lastResultByKey.get(key)
  const replays = state.replaysByKey.get(key) ?? 0
  const sameArgs = cached !== undefined && cached.canonicalArgs === canonicalArgsKey(args)
  if (cached && sameArgs && replays < cfg.maxReplaysPerKey) {
    state.replaysByKey.set(key, replays + 1)
    // `cached` mirrors exactly what recordResult stored — and NOTHING MORE. Building it
    // as `{ output, error: cached.error }` would materialise an explicit `error: undefined`
    // key on a result that never had one, which then rides out into the emitted
    // tool_result event and makes a successful replay structurally different from the
    // successful real call it reproduces. The replay's whole promise is that it is the
    // earlier result verbatim, so the payload has to be shaped like it too.
    const payload: LoopCachedResult = cached.error === undefined ? { output: cached.output } : { output: cached.output, error: cached.error }
    return { kind: 'replay', level: 'L0', message: l0ReplayMessage(ctx), cached: payload }
  }
  return { kind: 'steer', level: 'L0', message: l0SteerMessage(ctx) }
}

// L0, replay form — the FIRST no-progress repeat(s) of a key (see cfg.maxReplaysPerKey):
// tells the model plainly that the result it is about to see again is old, not new.
export function l0ReplayMessage(ctx: LoopContext): string {
  const call = ctx.callSummary ? `\`${ctx.toolName}\` call (\`${ctx.callSummary}\`)` : `\`${ctx.toolName}\` call`
  return (
    `You just issued the EXACT same ${call} that already ran, with nothing changed since — ` +
    'the result below is reproduced verbatim from that earlier run, not a fresh observation. Nothing has ' +
    `changed, so running it again will not tell you anything new: take a DIFFERENT concrete action, or give ` +
    `your final answer if the task is already done.\n\n${ctx.recite}`
  )
}

// L0, plain steer form — used once a key's replay budget (cfg.maxReplaysPerKey) is
// exhausted, or the cached result is no longer trustworthy enough to serve (FIX
// 1/FIX 2 above): names the exact repeat, demand a different concrete action or a
// final answer if the task is actually done.
export function l0SteerMessage(ctx: LoopContext): string {
  const call = ctx.callSummary ? `\`${ctx.toolName}\` call (\`${ctx.callSummary}\`)` : `\`${ctx.toolName}\` call`
  return (
    `You just issued the EXACT same ${call} that already ran, with nothing changed since. ` +
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
// plan rather than another steer nudge. `blocks` (the running no-progress count,
// H21(b)) is included so that consecutive L2 firings for the SAME stuck streak are
// never byte-identical text — the cited frame's ~30 back-to-back identical L2
// messages is exactly the "harness returns the same text N times" defect this
// batch responds to, and it applies to L2's own wording just as much as it does
// to the gate-rejection case above.
export function l2ReframeMessage(ctx: LoopContext, blocks: number): string {
  const plan = ctx.hasTasks
    ? `Call \`update_plan\` now with a REVISED plan that solves the current task a different way — the harness will reconcile it, keeping already-completed tasks.`
    : `Produce a revised plan now for solving the current task a different way.`
  return (
    `You have repeatedly looped on \`${ctx.toolName}\` without any progress (${blocks} consecutive stalled calls now). ABANDON this approach. ${plan}\n\n${ctx.recite}`
  )
}

// H21(b) — fires once, when evaluateCall reports 'halt' (see LoopAction). Told to
// the model mainly for the transcript's sake: agent.ts ends the frame right after
// this, so there is no next turn for it to act on. Names the concrete count and
// the concrete steer that was already tried and ignored, rather than repeating
// generic "you're stuck" wording a 4th distinct time.
export function lHaltMessage(ctx: LoopContext, blocks: number): string {
  return (
    `STOPPING this frame: \`${ctx.toolName}\` has looped without progress for ${blocks} consecutive calls. ` +
    `The request to abandon this approach and call update_plan was already given and ignored. Continuing would only repeat the same failed recovery.`
  )
}
