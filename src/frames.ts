// CALL FRAMES. A call frame is one role invocation. Implemented as one scoped `Agent`
// instance (agent.ts) rather than a second execution engine: every role reuses the exact
// same battle-tested ReAct loop (eviction-based context management, loop-recovery,
// retries, tool execution) with a different system prompt and a restricted tool set —
// "mode as permission state," not "mode as a separate program." dispatch.ts constructs
// these; this module only holds the per-role configuration and the context-construction
// algorithm.

import type { Role, ToolName, FrameSpawnRequest } from './types.js'

// `conclude` is in EVERY role's tool set below — it is how any frame ends its turn
// (agent.ts's chat() loop: a turn with no tool calls is a thinking turn, only calling
// `conclude` finishes). The Planner's plan (both its initial overall plan and each
// per-task assignment, read straight through as free text — see dispatch.ts's
// isPlannerDone/isPlannerGiveUp; there is no TASK:/TEST:/DONE line convention) and the
// Boss's checkpoint markers are all delivered as `conclude`'s `answer` argument instead
// of a bare no-tool-call final message.
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  // Deliberately NO update_plan. The Planner's deliverable is its own FRAME'S FINAL
  // ANSWER on each call (delivered via `conclude`'s `answer` — see dispatch.ts's
  // buildInitialPlannerPrompt/buildNextTaskPrompt/isPlannerDone), not a harness plan
  // ledger.
  planner: ['read_file', 'web_search', 'fetch_url', 'ledger', 'conclude'],
  // Deliberately NO update_plan. The harness owns the plan; the Implementer's job is
  // to execute it, not define or refine it.
  implementer: ['read_file', 'write_file', 'edit_file', 'bash', 'fetch_url', 'web_search', 'browser_fetch', 'ledger', 'conclude'],
  // Deliberately no write_file/edit_file — the Boss verifies, it never fixes.
  boss: ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger', 'conclude'],
}

// The task-start checkpoint's tool set (dispatch.ts's runBossTaskStart) — deliberately
// NOT ROLE_TOOLS.boss. The owner asked classification to be STRICTLY read-only
// (2026-09-05): ROLE_TOOLS.boss's only real editing path was `bash` (no write_file/
// edit_file there either) — its one way to "fix" something was a full heredoc file
// rewrite, an inherently blunt, all-or-nothing instrument. Measured damage from
// exactly that: in eval, a Boss judged a 6-method feature TRIVIAL, rewrote the whole
// target file via `cat > file << EOF`, hallucinated surrounding code, and broke an
// unrelated constructor signature other files depended on; the same failure recurred
// in a real session (frame boss-mtmm1gcc-1: refused write_file, then ran the same
// heredoc trick via bash on its very next turn and committed). Removing `bash` here
// removes the capability at its root, so the git-diff-sizing guard rails that used to
// contain it (TRIVIAL_DIFF_LINE_LIMIT, the before/after dirty check in
// runBossTaskStart) are removed alongside it, not left behind as dead code for a
// capability that no longer exists.
// `ledger` stays: the TOOL only exposes read actions (get_goal/get_plan/get_recent/
// get_conclusion/get_frame_trail/expand — see tools/index.ts's ledger case); the
// harness's OWN ledger.setObjective/recordDelegation calls are direct module calls
// from dispatch.ts, never reachable through this tool, so including it does not
// reopen a write path. `read_file` covers investigation (it gained a `pattern` search
// param plus offset/limit line paging specifically so a role without bash can still
// find a symbol); `web_search`/`fetch_url` cover the checkpoint's own "ground it"
// instruction. `conclude` is how this checkpoint now delivers its ANSWER/SIMPLE/
// OBJECTIVE status — a turn with no tool calls no longer ends anything (agent.ts's
// chat() loop), so without it this checkpoint could investigate forever but never
// actually classify.
// The Boss classification checkpoint is READ-ONLY but needs bash for investigation
// (grep, cat, ls, running tests to understand behaviour). bash CAN write, but the
// prompt's read-only framing + the classification-only scope make that acceptable —
// the alternative (no bash) left the Boss unable to check real files, which is worse.
export const TASK_START_TOOLS: ToolName[] = ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger', 'conclude']

// Per-role iteration budgets. Implementer keeps the most headroom (real work happens
// there); Planner/Boss are short bounded loops, not open-ended. Planner raised
// 15->20->40 (2026-09-03/04, overnight large-task eval + unattended driver session):
// on a genuinely large objective against a real 11-file codebase, 15-20 wasn't enough
// room to read the codebase AND produce a task graph — it hit its cap with NO plan at
// all. MEASURED on `commander-count-option` at k=3: 2 of 3 runs hit a 20-iteration cap
// with no conclusion at all; `commander` is 4180 lines with lib/command.js alone at
// 2790, and reading enough of it to decompose the objective does not fit in 20 turns
// when each read costs a turn.
//
// Two caveats recorded deliberately. (1) This project has already DISMISSED "more
// iterations help" once — 60->90 made a single-loop Implementer worse, by thrashing.
// That result does not obviously transfer: a frame killed mid-read while making steady
// progress is a different failure from a frame drifting with budget to spare. If 40
// merely moves the cap-hit later, the budget is not the constraint — raise it once,
// measure, and do not keep raising it.
// (2) ~20 iterations is meant to be an IDEAL CHUNK SIZE and a stand-up cadence, NOT a
// hard kill; every entry in this table is currently a hard kill (agent.ts makes the
// cap-hit string the frame's final answer). The correct fix is a soft cap with a
// stand-up, and this raise is an interim measurement, not that fix.
// Implementer raised 60->80->160 across this project's history. The escalating
// PROGRESS_CHECK_ITERATIONS/PROGRESS_CHECK_MESSAGES table below gives the Implementer
// escalating nudges before its hard cap, keeping a real margin after the strongest
// ("Finish immediately") nudge instead of the cap landing right on top of it.
export const ROLE_MAX_ITERATIONS: Record<Role, number> = {
  planner: 40,
  implementer: 160,
  boss: 15,
}

// PER-ROLE PROGRESS-CHECK ESCALATION. Distinct from the generic fraction-of-
// maxIterations stall/progress mechanism already in agent.ts (the `stallCheckpoints`
// local in chat(), scaled 0.4/0.65/0.85 of a run's own budget) — that mechanism stays
// exactly as it is for every role NOT listed here (Boss, the unrestricted baseline).
// Planner/Implementer instead get FIXED, ABSOLUTE per-call iteration thresholds with
// role-specific wording, because the numbers involved don't fall out of the generic
// fractions and neither role is well served by the generic table's coarser rungs.
// agent.ts reads these keyed by the frame's role (Agent.setRole, called by
// dispatch.ts's spawnFrame alongside setAllowedTools/setMaxIterations/etc.) and, when a
// role has an entry here, replaces the generic mechanism for that one frame's
// checkpoints with these exact iteration numbers and exact message text —
// unconditionally: these are fixed checkpoints on a countdown to a hard cap, not a
// stall detector, so they fire every time regardless of how much real progress is
// happening. Iteration numbers here are per-CALL (i.e. per resumeFrame/chat() turn on
// the frame's Agent instance) — this falls out for free from how agent.ts's iteration
// loop already works: the `for (let i = 0; i < this.maxIterations; i++)` loop always
// starts i at 0 on every chat() call regardless of a resumed frame's cumulative
// `iterationBase` (that offset only shifts REPORTED iteration numbers and this table's
// own thresholds together, so the comparison still lands on the same LOCAL iteration
// count every call — see agent.ts's stallCheckpoints computation).
export const PROGRESS_CHECK_ITERATIONS: Partial<Record<Role, number[]>> = {
  planner: [20, 30],
  implementer: [100, 120, 140],
}

// Message text is VERBATIM per this task's brief — index-aligned with
// PROGRESS_CHECK_ITERATIONS[role] (message[i] fires at iteration[i]). Planner's own
// two rungs mirror the Implementer's escalating tone (gentle reminder, then firmer)
// at half the iteration count, since its hard cap (40) is half the Implementer's.
export const PROGRESS_CHECK_MESSAGES: Partial<Record<Role, string[]>> = {
  planner: [
    'IMPORTANT — 20 iterations used. Wrap up your analysis and call conclude with your result.',
    'IMPORTANT — 30 iterations used, approaching the hard limit. You MUST call conclude NOW with your best result.',
  ],
  implementer: [
    'IMPORTANT — 100 iterations used. Start wrapping up your work. Call conclude with a ' +
      'summary of what you accomplished, what didn\'t work, and what\'s left to do.',
    'IMPORTANT — 120 iterations used. You MUST wrap up now. Call conclude with what you accomplished and ' +
      'what remains.',
    'IMPORTANT — 140 iterations used, approaching the hard limit. Finish IMMEDIATELY. Call conclude with your ' +
      'final status — what was done, what failed, and what\'s left.',
  ],
}

// Plain display names — the role's function, not a character.
export const ROLE_NAME: Record<Role, string> = {
  boss: 'Boss',
  planner: 'Planner',
  implementer: 'Implementer',
}

// Valid `conclude` status keywords per role. When an agent calls conclude(status, message),
// agent.ts validates `status` against this set and returns an error (visible to the model)
// if invalid, repeating the expected keywords. This replaces all regex-based parsing of
// conclude text in dispatch.ts.
export const ROLE_CONCLUDE_STATUSES: Record<Role, string[]> = {
  // Boss: ANSWER (knows the answer), SIMPLE (one implementer), OBJECTIVE (needs a
  // planner to decompose), SUMMARY (end-of-run conclusion).
  boss: ['ANSWER', 'SIMPLE', 'OBJECTIVE', 'SUMMARY'],
  // Planner initial call: PLAN (the plan is the message).
  // Planner detail calls: IMPLEMENT (assignment for next sub-agent), SUCCESS (objective
  // fully met, final statement), FAIL (cannot complete, explain why).
  planner: ['PLAN', 'IMPLEMENT', 'SUCCESS', 'FAIL'],
  // Implementer: SUCCESS (did the work) or FAIL (couldn't do it).
  implementer: ['SUCCESS', 'FAIL'],
}

export function concludeStatusError(role: Role, invalidStatus: string): string {
  const valid = ROLE_CONCLUDE_STATUSES[role]
  return `Invalid conclude status "${invalidStatus}". For your role (${ROLE_NAME[role]}), ` +
    `the valid status keywords are: ${valid.join(', ')}. ` +
    `Call conclude again with status set to one of these keywords and your message in the message parameter.`
}

const ROLE_SYSTEM_SUFFIX: Record<Role, string> = {
  // ITERATIVE PLANNER, `conclude`-based — no TASK:/TEST:/DONE line convention. The
  // Planner is called in two phases: ONCE for an overall plan (an ordered list of
  // concrete sub-tasks, delivered as its `conclude` answer), then RESUMED repeatedly,
  // each time producing exactly one fully self-contained Implementer assignment as its
  // `conclude` answer, informed by the previous Implementer's own conclusion. There is
  // no separate re-planning step — adaptation is just what happens naturally on the
  // next detail call (see dispatch.ts's module header for the full flow, and
  // isPlannerDone for how the harness detects "no further work needed").
  planner:
    'ROLE\n' +
    'You are the PLANNER inside Argo\'s multi-agent harness.\n\n' +
    'TASK\n' +
    'Your job happens in two phases:\n' +
    '1. Given the immutable objective, determine the most effective implementation strategy and call `conclude` with an ordered list of IMPLEMENTATION UNITS — the overall plan. Each unit represents one coherent body of work for one Implementer. At this stage describe the intended outcome, meaningful boundary, dependencies and verification goal concisely. Do not expand each unit into its full agent assignment yet. Use a single unit when the objective fits naturally within one Implementer run; decompose only when doing so materially improves execution or verification.\n' +
    '2. You will then be resumed for each unit and asked to produce exactly one fully self-contained IMPLEMENTATION ASSIGNMENT for the next Implementer, informed by the previous agent\'s result (including any failures). Adjust your plan naturally as you go; there is no separate re-planning step to request.\n\n' +
    'DETAILED ASSIGNMENTS\n' +
    'When detailing a unit into its full assignment, it must be fully self-contained: the implementation agent sees only that one assignment, never your plan or investigation. An implementation assignment is not a single implementation step. One assignment may include setup, data structures, rendering, interaction, wiring and tests when those pieces belong to one coherent outcome. Restate everything the agent needs:\n' +
    '- The concrete, verifiable outcome\n' +
    '- Relevant context and dependencies on prior work\n' +
    '- Relevant files, interfaces, and constraints\n' +
    '- What is in scope vs out of scope\n' +
    '- Testing and validation expectations\n' +
    '- The implementation agent does NOT have access to /workspace/AGENTS.md or /workspace/MEMORY.md. You must inspect those files and include directly in the assignment any relevant instructions, conventions, architectural constraints, project facts, or prior decisions that the agent needs to carry out the work correctly.\n\n' +
    'COMPLETION\n' +
    'When the objective is fully met and no further implementation work remains, say so plainly in your `conclude` answer instead of producing another assignment.\n\n' +
    'SCOPE\n' +
    'The project is READ-ONLY for you. You create the plan, you do not implement anything yourself. Use read_file to inspect files as needed. You may read files and search the web, but you never write or edit anything — you reason about the plan, you don\'t produce artifacts. You never redefine the objective itself — only the Boss does that.',
  implementer:
    'ROLE\n' +
    'You are the IMPLEMENTER inside Argo\'s multi-agent harness.\n\n' +
    'TASK\n' +
    'Work one well-scoped task handed to you. ' +
    'Before editing, inspect the relevant existing implementation and tests. Prefer the smallest coherent change that satisfies the assignment and preserves unrelated behaviour.\n\n' +
    'TESTING\n' +
    'Verify your own work before concluding. Run the relevant build, lint, and test commands; exercise the ' +
    'behaviour you changed directly (a script, a manual repro, a request against a running server) rather than ' +
    'relying on inspection alone. Do not claim success without having actually run something that demonstrates it.\n\n' +
    'FAILURE\n' +
    'If you cannot complete it within reasonable effort, say so explicitly in your final answer: state what you tried, what failed, and why you don\'t think it will succeed as scoped — do not grind indefinitely on the same approach.',
  boss:
    'ROLE\n' +
    'You are the BOSS inside Argo\'s multi-agent harness, accountable for the whole run over multiple turns.',
}

export function systemPromptFor(role: Role): string {
  return ROLE_SYSTEM_SUFFIX[role]
}

const SUMMARY_CHAR_CAP = 2000

// VERBATIM REQUEST THREADING. Argo's Boss task-start checkpoint paraphrases the user's
// raw message into one `OBJECTIVE:` line, and the paraphrase used to be the ONLY thing
// any downstream frame (Planner/Implementer) ever saw. Traced twice in eval: a
// paraphrase dropped a pointer to seeded test files, causing the Planner to invent a
// target file; a paraphrase dropped a "do NOT modify existing tests" constraint that
// sat at the end of the message, causing the Implementer to ship against its own
// invented verification.
//
// The fix: dispatch.ts's spawnFrame attaches the run's raw user message to EVERY
// frame's assignment via buildAssignment below, unconditionally and by construction —
// never replacing the objective (setObjective's immutability guard is untouched; the
// objective still exists and still matters as the harness's stable restatement of the
// work), only sitting alongside it as a second, unparaphrased source of truth.
//
// Cap rationale: PROJECT_CONTEXT_CHAR_CAP (agent.ts) is 8000 chars for a whole file read
// ONCE per frame. This block is different: it repeats in EVERY frame's assignment for
// the whole run, and a per-frame cost multiplies by frame count in a way
// loadProjectContext's doesn't. Set to half that (4000). Truncation is head-and-tail,
// not a plain head cut: both traced failures had their load-bearing detail (a seed-file
// pointer, a "do NOT modify tests" clause) at DIFFERENT positions in the raw message —
// one mid-message, one at the very end — so a head-only cut would have preserved one
// failure mode's fix and reproduced the other. An explicit marker names exactly how
// much was dropped, rather than silently splicing two halves together.
export const VERBATIM_REQUEST_CHAR_CAP = 4000
// Exported alongside the cap (rather than kept private) so verbatim.test.ts can assert
// the truncation arithmetic exactly, not just "it got shorter" — a silently wrong
// dropped-chars count in the marker would be worse than no count at all.
export const VERBATIM_REQUEST_HEAD_CHARS = 2800
export const VERBATIM_REQUEST_TAIL_CHARS = 1000

// Pure and exported so the truncation behavior is directly testable (verbatim.test.ts)
// without needing a pathological live request.
export function capVerbatimRequest(text: string): string {
  if (text.length <= VERBATIM_REQUEST_CHAR_CAP) return text
  const dropped = text.length - VERBATIM_REQUEST_HEAD_CHARS - VERBATIM_REQUEST_TAIL_CHARS
  const head = text.slice(0, VERBATIM_REQUEST_HEAD_CHARS)
  const tail = text.slice(text.length - VERBATIM_REQUEST_TAIL_CHARS)
  return `${head}\n\n...[${dropped} chars truncated — original request exceeded the ${VERBATIM_REQUEST_CHAR_CAP}-char cap]...\n\n${tail}`
}

// Bracketed-label convention, matching the existing `[CURRENT PLAN — ...]` (agent.ts)
// and `[OBJECTIVE — immutable, set once by the Boss; never redefine it]` (eviction.ts)
// blocks, not a novel format — the same recitation shape a frame already sees elsewhere
// in this codebase, so it reads as one more instance of a known convention rather than a
// new kind of thing to parse. "Authoritative" and "governs" are the operative words: this
// is not one more piece of context to weigh against the others, it is the tie-breaker
// when the objective/plan/step prompt below it turns out to have paraphrased something
// away.
export function renderVerbatimRequestBlock(userMessage: string): string {
  const text = capVerbatimRequest(userMessage)
  return '[ORIGINAL USER REQUEST — global intent and constraints. The current assignment defines this agent\'s '
    + `scope. Use the original request to resolve intent, not to expand the assigned scope.]\n${text}`
}

// Caps a frame's own final-answer text before it's stored as a ledger conclusion's
// `summary` — keeps dependency hand-offs small by construction (buildAssignment below
// only ever forwards THIS capped text, never a dependency's raw episode graph).
export function capSummary(s: string): string {
  return s.length > SUMMARY_CHAR_CAP ? `${s.slice(0, SUMMARY_CHAR_CAP)}…` : s
}

// The concrete mechanism for "only relevant content is shared": a dependency
// contributes its capped conclusion summary + file pointers, NEVER its raw episode
// graph or transcript. If a frame needs more, it calls `ledger` with action
// "getFrameTrail" itself — explicit, on-demand, never automatic.
//
// `verbatimRequest` (see the block comment above renderVerbatimRequestBlock) is the
// run's raw user message, passed by dispatch.ts's spawnFrame — the ONE call site that
// builds every frame's assignment — so attaching it here makes it apply to every role
// by construction, not by each dispatch.ts call site remembering to add it.
// undefined/empty is a no-op (`filter(Boolean)` below drops it).
//
// Placement is deliberately FIRST in the array, ahead of dependency summaries and the
// step-specific assignment. Ollama's prefix cache on this machine is aggressive and
// cheap to lose: every turn re-sends the whole message array, so cache reuse is decided
// by whether the HEAD of that array is byte-stable; measured directly on this box for
// this change: 34ms warm vs 1445ms cold for an identical prefix, and 1416ms — i.e. no
// better than cold — for the SAME tokens with one mutated LEADING token. This block is
// the one piece of a frame's assignment that is identical across every frame of the
// SAME dispatch run — putting it at the head maximizes how much of the assignment
// message's own prefix is byte-identical across sibling frames of one run, rather than
// burying an immutable block after content that already varies frame to frame, where it
// could never anchor a cache hit at all.
export async function buildAssignment(root: string, req: FrameSpawnRequest, verbatimRequest?: string): Promise<string> {
  const verbatimBlock = verbatimRequest ? renderVerbatimRequestBlock(verbatimRequest) : ''
  return [verbatimBlock, req.assignment].filter(Boolean).join('\n\n')
}

// ── Boss task-start verdict parsing ────────────────────────────────────────────────
// The Boss is a real Agent-based frame (its own ReAct loop, real tools), not a
// single-shot JSON-mode critic call — so its verdict comes from a simple text
// convention at the end of its final answer (see ROLE_SYSTEM_SUFFIX above), used as a
// fallback when the frame's own `conclude` status wasn't set/valid.
//
// The convention: parseTaskStartVerdict returns an explicit `parsed` flag, so
// "unparseable" is a fact the caller can act on rather than something laundered into a
// positive verdict.
export interface TaskStartVerdict {
  mode: 'answer' | 'simple' | 'objective'
  text: string // the final answer (mode 'answer') or the objective statement (otherwise)
  parsed: boolean // false ⇔ no marker line was found (text is then '')
}

export function parseTaskStartVerdict(finalAnswer: string): TaskStartVerdict {
  const answer = /ANSWER\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (answer) return { mode: 'answer', text: answer[1].trim(), parsed: true }
  const simple = /SIMPLE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (simple) return { mode: 'simple', text: simple[1].trim(), parsed: true }
  const objective = /OBJECTIVE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (objective) return { mode: 'objective', text: objective[1].trim(), parsed: true }
  // No marker found at all — do NOT fall back to the raw final answer text. A real
  // failure observed in eval: the Boss did the fix itself via bash instead of just
  // classifying, then reported that as free-form prose with no ANSWER/SIMPLE/
  // OBJECTIVE line; the raw prose ("All 7 tests pass. The three functions are
  // now implemented: ...") became the "objective" fed to the Planner, which had no
  // idea what to plan for a COMPLETION REPORT and hallucinated an entire unrelated
  // project structure trying to find something to do. Returning empty text here
  // signals "unparseable" so the caller (dispatch.ts's runBossTaskStart) falls back
  // to the ORIGINAL user message instead — always a valid objective by construction,
  // unlike the Boss's free-form answer. `parsed: false` says the same thing explicitly.
  return { mode: 'objective', text: '', parsed: false }
}
