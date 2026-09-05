// CALL FRAMES (docs/subagents-plan.md, config.agents / ARGO_AGENTS). A call frame is one
// role invocation. Implemented as one scoped `Agent` instance (agent.ts) rather than a
// second execution engine: every role reuses the exact same battle-tested ReAct loop
// (compaction/eviction, loop-recovery, retries, tool execution) with a different system
// prompt and a restricted tool set — "mode as permission state," not "mode as a separate
// program." dispatch.ts constructs these; this module only holds the per-role
// configuration and the context-construction algorithm.
//
// v1 SIMPLIFICATION, noted explicitly: the pinned anchor (objective + plan) is folded
// into the frame's initial assignment message rather than threaded into the reused
// Agent's own per-turn recitation machinery (which is keyed to that Agent instance's OWN
// this.currentPlan/task ledger, set via its own update_plan calls) — so a long-running
// frame's recitation of the LEDGER-level plan may fade the same way any other context
// does without eviction re-surfacing it. Re-threading ledger state into per-turn
// recitation is a real refinement, not a correctness requirement for v1.

import type { Role, ToolName, FrameSpawnRequest, FramePolicy } from './types.js'

// `conclude` (2026-09-06) is in EVERY role's tool set below — it is not role-
// specific, it is how any frame ends its turn now (agent.ts's chat() loop: a turn
// with no tool calls is a thinking turn, only calling `conclude` finishes). The
// Planner's plan (both its initial overall plan and each per-task assignment,
// read straight through as free text — see dispatch.ts's isPlannerDone/
// isPlannerGiveUp; there is no TASK:/TEST:/DONE line convention any more), the
// Boss's checkpoint markers, and the Tester's SUCCESS/FAIL verdict (dispatch.ts's
// parseTesterResult — see below) are all delivered as `conclude`'s `answer`
// argument instead of a bare no-tool-call final message — dispatch.ts/frames.ts's
// parsing functions are unaffected: they only ever read the STRING chat() returns,
// and that string is still exactly the model's own text either way.
//
// TESTER IS BACK, HARNESS-DRIVEN (this task, superseding the "iterative planner"
// rewrite's removal of it below). The harness (dispatch.ts's runObjectiveViaPlanner/
// runTesterValidation) spawns a Tester automatically after every Implementer
// concludes SUCCESS — the Planner never decides this and never sees a Tester frame
// directly, only the eventual validated (or still-failing) result folded back into
// its next detail call. The Tester's OWN conclude convention is now SUCCESS/FAIL:
// (dispatch.ts's buildTesterAssignment/parseTesterResult), NOT the RELEASE/REDO
// convention parseTesterVerdict below still implements — that function is now
// doubly superseded (previously dead because nothing spawned a Tester at all; now
// dead because the live Tester uses a different convention) and kept ONLY because
// batch2.test.ts (off this task's write list) still exercises it directly. See
// dispatch.ts's own module-level comments for the live design.
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  // Deliberately NO update_plan (removed 2026-09-04). The Planner's deliverable is
  // its own FRAME'S FINAL ANSWER on each call (delivered via `conclude`'s `answer`
  // — see dispatch.ts's buildInitialPlannerPrompt/buildNextTaskPrompt/
  // isPlannerDone), not a harness plan ledger: nothing ever read a Planner's own
  // this.currentPlan. Holding the tool was actively harmful, not merely redundant —
  // combined with harness task sequencing (which spawnFrame never disabled, see
  // types.ts FramePolicy) an update_plan call built a task ledger whose per-task
  // verify gate then refused to let the frame conclude, so its plan text was never
  // delivered. The 6 Planner frames that never called it concluded in two messages.
  planner: ['read_file', 'web_search', 'fetch_url', 'ledger', 'conclude'],
  // Deliberately NO update_plan (removed 2026-09-05, alongside the Planner's own
  // removal above). dispatch.ts's spawnFrame now calls Agent.seedPlan with this
  // frame's own assignment (the SIMPLE objective, or a Planner step's own
  // sub-objective) before chat() ever runs, so the plan/act gate is already
  // satisfied on the Implementer's very first turn — a real session had it call
  // update_plan 8 times with byte-identical content, 7 no-op revisions that read as
  // pure log noise. The harness owns the plan; the Implementer's job is to execute
  // it, not define or refine it (see agent.ts's canUpdatePlan/buildSystemPrompt).
  implementer: ['read_file', 'write_file', 'edit_file', 'bash', 'fetch_url', 'web_search', 'browser_fetch', 'ledger', 'conclude'],
  // Deliberately no write_file/edit_file — Tester directs fixes (its FAIL: text
  // becomes a NEW Implementer's assignment, dispatch.ts's parseTesterResult/
  // runTesterValidation), never makes them itself. `bash` is kept for running the
  // project's own tests/checks (see the Boss's own read-only bash rationale above —
  // same reasoning: no bash would leave the Tester unable to actually verify
  // anything beyond reading code).
  tester: ['read_file', 'bash', 'view_image', 'ledger', 'conclude'],
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
// param plus offset/limit line paging — 8656de9, fa5b497 — specifically so a role
// without bash can still find a symbol); `web_search`/`fetch_url` cover the
// checkpoint's own "ground it" instruction. `conclude` (2026-09-06) is how this
// checkpoint now delivers its ANSWER/SIMPLE/OBJECTIVE status — a turn
// with no tool calls no longer ends anything (agent.ts's chat() loop), so without
// it this checkpoint could investigate forever but never actually classify.
// The Boss classification checkpoint is READ-ONLY but needs bash for investigation
// (grep, cat, ls, running tests to understand behaviour). bash CAN write, but the
// prompt's read-only framing + the classification-only scope make that acceptable —
// the alternative (no bash) left the Boss unable to check real files, which is worse.
export const TASK_START_TOOLS: ToolName[] = ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger', 'conclude']

// Per-role iteration budgets. Implementer keeps the most headroom (real work happens
// there); Planner/Tester/Boss are short bounded loops, not open-ended. Planner raised
// 15->20 (2026-09-03, overnight large-task eval): on a genuinely large objective
// against a real 11-file codebase (bigproj's tasklab, `docs/overnight-log.md` Finding
// 4), 15 wasn't enough room to read the codebase AND produce a task graph — it hit
// its cap with NO plan at all, falling open to a single-step graph that (correctly,
// but by accident) routed the whole objective to one large Implementer frame instead
// of real decomposition. This is exactly the scenario the Planner exists for; 20
// gives it a real chance to converge instead of reliably timing out on it.
//
// Planner raised 20->40 (2026-09-04, unattended driver session, harness c16df84). MEASURED,
// not guessed: on `commander-count-option` at k=3 with the schema-constrained control plane
// ON, 2 of the 3 runs ended with the Planner frame logging "Reached maximum iterations (20)
// without a final answer" — it never concluded, so there was no decision for schema
// extraction to restate and `graphFromPlanner` threw PlanningFailed with the run dead in
// about two minutes. The third run concluded and scored 60/60. So on this substrate the
// dominant Planner failure is NOT unreadable output (the mode schema.ts fixes, which fired
// and worked once) but simply never finishing: `commander` is 4180 lines with
// lib/command.js alone at 2790, and reading enough of it to decompose the objective does not
// fit in 20 turns when each read costs a turn.
//
// Two caveats recorded deliberately. (1) This project has already DISMISSED "more iterations
// help" once — 60->90 made a single-loop Implementer worse, by thrashing. That result does
// not obviously transfer: a frame killed mid-read while making steady progress is a
// different failure from a frame drifting with budget to spare, and the evidence here is a
// cap-hit with no plan rather than a plan that got worse. If 40 merely moves the cap-hit
// later, the budget is not the constraint and the real lever is how the Planner READS a
// large repository (docs/research/10-hermes-differential.md: Hermes needs 4-21 calls where
// Argo needs 69-83) — raise it once, measure, and do not keep raising it.
// (2) Per Gabriel's design directive, ~20 iterations is meant to be an IDEAL CHUNK SIZE and
// a stand-up cadence, NOT a hard kill; every entry in this table is currently a hard kill
// (agent.ts makes the cap-hit string the frame's final answer). The correct fix is a soft
// cap with a stand-up, and this raise is an interim measurement, not that fix.
// Implementer raised 60->80 (this task, "iteration limits and progress nudges"). The
// escalating PROGRESS_CHECK_ITERATIONS/PROGRESS_CHECK_MESSAGES table below now gives the
// Implementer THREE nudges before its hard cap (50/60/70), so 80 keeps a real 10-iteration
// margin after the strongest ("Finish immediately") nudge instead of the cap landing right
// on top of it — a model that genuinely needs a couple more turns to call `conclude` after
// being told to wrap up should get them, same spirit as the Planner's own "not a hard kill,
// an ideal chunk size" note below.
//
// Tester raised 20->40 (owner directive, superseding the flow audit's "Tester has no
// soft/hard split" finding). buildTesterAssignment (dispatch.ts) already states a
// 20-iteration SOFT budget in the prompt itself ("You have a hard budget of 20
// iterations to call `conclude`" — that wording predates this change and is the
// Tester's own stated target, not the actual enforced cap); 40 here is the real HARD
// cap, mirroring the Planner's own soft-20/hard-40 split exactly. The
// PROGRESS_CHECK_ITERATIONS/PROGRESS_CHECK_MESSAGES entry added below at [20, 30] is
// what makes the soft budget an actual mid-run nudge instead of a number the model
// only reads once at the top of its assignment.
export const ROLE_MAX_ITERATIONS: Record<Role, number> = {
  planner: 40,
  implementer: 80,
  tester: 40,
  boss: 15,
}

// PER-ROLE PROGRESS-CHECK ESCALATION (this task; Tester entry added later, owner
// directive superseding the flow audit's "Tester has no soft/hard split" finding).
// Distinct from the generic fraction-of-maxIterations stall/progress mechanism already
// in agent.ts (the `stallCheckpoints` local in chat(), scaled 0.4/0.65/0.85 of a run's
// own budget) — that mechanism stays exactly as it is for every role NOT listed here
// (Boss, the unrestricted baseline). Planner/Implementer/Tester instead get FIXED,
// ABSOLUTE per-call iteration thresholds with role-specific wording, because the
// numbers involved (Planner: two escalating nudges at 20/30 of a 40 cap; Implementer:
// three escalating nudges at 50/60/70 of an 80 cap; Tester: the same two-rung 20/30
// pattern as the Planner, matching its own soft-20/hard-40 split) don't fall out of the
// generic fractions — 20/40 = 0.5 and 30/40 = 0.75 (not 0.4/0.65/0.85), and none of the
// three roles is well served by the generic table's coarser rungs. agent.ts reads these
// keyed by the frame's role (Agent.setRole, called by dispatch.ts's spawnFrame alongside
// setAllowedTools/setMaxIterations/etc.) and, when a role has an entry here, replaces
// the generic mechanism for that one frame's checkpoints with these exact iteration
// numbers and exact message text — unconditionally (no "skip if the model already
// edited something since the last check" allowance the generic mechanism applies for
// Boss): these are fixed checkpoints on a countdown to a hard cap, not a stall
// detector, so they fire every time regardless of how much real progress is happening.
// Iteration numbers here are per-CALL (i.e. per resumeFrame/chat() turn on the frame's
// Agent instance) — this falls out for free from how agent.ts's iteration loop already
// works: the `for (let i = 0; i < this.maxIterations; i++)` loop always starts i at 0 on
// every chat() call regardless of a resumed frame's cumulative `iterationBase` (that
// offset only shifts REPORTED iteration numbers and this table's own thresholds
// together, so the comparison still lands on the same LOCAL iteration count every call —
// see agent.ts's stallCheckpoints computation).
export const PROGRESS_CHECK_ITERATIONS: Partial<Record<Role, number[]>> = {
  planner: [20, 30],
  implementer: [50, 60, 70],
  tester: [20, 30],
}

// Message text is VERBATIM per this task's brief — index-aligned with
// PROGRESS_CHECK_ITERATIONS[role] (message[i] fires at iteration[i]). Planner's own
// two rungs mirror the Implementer's escalating tone (gentle reminder, then firmer)
// at half the iteration count, since its hard cap (40) is half the Implementer's (80).
// Tester mirrors the Planner's exact two rungs and cap (20/30 of a 40 cap), with
// "validation" swapped in for "analysis" since the Tester's job is to validate the
// Implementer's work, not analyze a plan.
export const PROGRESS_CHECK_MESSAGES: Partial<Record<Role, string[]>> = {
  planner: [
    'PROGRESS CHECK: 20 iterations in. Wrap up your analysis and call conclude with your result.',
    'PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.',
  ],
  implementer: [
    'PROGRESS CHECK: 50 iterations in and not finished. Start wrapping up your work. Call conclude with a ' +
      'summary of what you accomplished, what didn\'t work, and what\'s left to do.',
    'PROGRESS CHECK: 60 iterations in. You must wrap up now. Call conclude with what you accomplished and ' +
      'what remains.',
    'PROGRESS CHECK: 70 iterations. Finish immediately. Call conclude with your final status — what was ' +
      'done, what failed, and what\'s left.',
  ],
  tester: [
    'PROGRESS CHECK: 20 iterations in. Wrap up your validation and call conclude with your result.',
    'PROGRESS CHECK: 30 iterations. You must finish now. Call conclude with your best result.',
  ],
}

// PER-ROLE MECHANISM POLICY (2026-09-04). See types.ts's FramePolicy for why this is a
// declared object rather than a few setter calls at the spawn site. Justification per
// cell, since "why is this false" is the whole point:
//
//   tasks (harness task sequencing) — ON only for the Implementer. It is the one role
//     that does multi-step work, holds update_plan, and produces the file mutations the
//     per-task verify gate exists to check. For every other role the mechanism cannot
//     help and can only trap: the deliverable of a Planner/Tester/Boss frame IS its
//     `conclude` answer (an overall plan or a self-contained task assignment, a
//     RELEASE/REDO verdict, a NONE/INJECT/RESTART/ESCALATE verdict), and task
//     sequencing reinterprets that exact signal as "current task might be done — run
//     its verify, then ask for a summary", which costs iterations at best and blocks
//     the verdict at worst.
//   memory — ON only for the Implementer: MEMORY.md persistence at compaction (memory.ts
//     persistToMemory) is a WRITE to the workspace, and the read-only roles must not
//     write. Turning it off does not blind them: agent.ts falls back to the baseline
//     whole-file AGENTS.md + MEMORY.md injection, which for a short-budget role is
//     strictly more context than task-scoped retrieval.
//   loop — ON for every role. The failure it prevents (a small local model repeating an
//     identical call forever with nothing changed since) is role-independent, and its
//     escalation flag is what dispatch.ts's `hadTrouble()` standup trigger reads.
//   grounding / layout — ON only for the Implementer: both are PRE-DONE gates on an
//     ARTIFACT the frame produced (a document, an HTML page). A role that never writes
//     files can only ever be delayed by them, and a gate on a verdict-shaped final
//     answer is the same trap shape as `tasks` above. (layout is off in config by
//     default anyway; stated explicitly so a future default flip cannot re-open this.)
export const ROLE_POLICY: Record<Role, FramePolicy> = {
  planner:     { tasks: false, memory: false, loop: true, grounding: false, layout: false },
  implementer: { tasks: true,  memory: true,  loop: true, grounding: true,  layout: true  },
  tester:      { tasks: false, memory: false, loop: true, grounding: false, layout: false },
  boss:        { tasks: false, memory: false, loop: true, grounding: false, layout: false },
}

// Returned as a fresh object so a caller can never mutate the table above.
export function policyFor(role: Role): FramePolicy {
  return { ...ROLE_POLICY[role] }
}

// Plain display names — the role's function, not a character.
export const ROLE_NAME: Record<Role, string> = {
  boss: 'Boss',
  planner: 'Planner',
  implementer: 'Implementer',
  tester: 'Tester',
}

// Valid `conclude` status keywords per role. When an agent calls conclude(status, message),
// agent.ts validates `status` against this set and returns an error (visible to the model)
// if invalid, repeating the expected keywords. This replaces all regex-based parsing of
// conclude text in dispatch.ts.
export const ROLE_CONCLUDE_STATUSES: Record<Role, string[]> = {
  // Boss: ANSWER (knows the answer), SIMPLE (one implementer + tester),
  // OBJECTIVE (needs a planner to decompose), SUMMARY (end-of-run conclusion).
  boss: ['ANSWER', 'SIMPLE', 'OBJECTIVE', 'SUMMARY'],
  // Planner initial call: PLAN (the plan is the message).
  // Planner detail calls: IMPLEMENT (assignment for next sub-agent), SUCCESS (objective
  // fully met, final statement), FAIL (cannot complete, explain why).
  planner: ['PLAN', 'IMPLEMENT', 'SUCCESS', 'FAIL'],
  // Implementer: SUCCESS (did the work) or FAIL (couldn't do it).
  implementer: ['SUCCESS', 'FAIL'],
  // Tester: ASSESSMENT (blind-turn independent assessment, not a final verdict),
  // SUCCESS (implementation is correct) or FAIL (found problems, fix assignment in message).
  tester: ['ASSESSMENT', 'SUCCESS', 'FAIL'],
}

export function concludeStatusError(role: Role, invalidStatus: string): string {
  const valid = ROLE_CONCLUDE_STATUSES[role]
  return `Invalid conclude status "${invalidStatus}". For your role (${ROLE_NAME[role]}), ` +
    `the valid status keywords are: ${valid.join(', ')}. ` +
    `Call conclude again with status set to one of these keywords and your message in the message parameter.`
}

const ROLE_SYSTEM_SUFFIX: Record<Role, string> = {
  // ITERATIVE PLANNER, `conclude`-based (this rewrite — no TASK:/TEST:/DONE line
  // convention). The Planner is called in two phases: ONCE for an overall plan (an
  // ordered list of concrete sub-tasks, delivered as its `conclude` answer), then
  // RESUMED repeatedly, each time producing exactly one fully self-contained
  // Implementer assignment as its `conclude` answer, informed by the previous
  // Implementer's own conclusion. There is no separate re-planning step any more —
  // adaptation is just what happens naturally on the next detail call. The harness
  // (not the Planner) spawns a real Tester after every successful Implementer to
  // validate its work (see dispatch.ts's module header for the full flow, and
  // isPlannerDone for how the harness detects "no further work needed") — the
  // Planner does not manage or need to know the details of that validation step.
  planner:
    'ROLE\n' +
    'You are the PLANNER inside Argo\'s multi-agent harness.\n\n' +
    'TASK\n' +
    'Your job happens in two phases:\n' +
    '1. Given the immutable objective, determine the most effective implementation strategy and call `conclude` with an ordered list of IMPLEMENTATION UNITS — the overall plan. Each unit represents one coherent body of work for one Implementer. At this stage describe the intended outcome, meaningful boundary, dependencies and verification goal concisely. Do not expand each unit into its full agent assignment yet. Use a single unit when the objective fits naturally within one Implementer run; decompose only when doing so materially improves execution or verification.\n' +
    '2. You will then be resumed for each unit and asked to produce exactly one fully self-contained IMPLEMENTATION ASSIGNMENT for the next Implementer, informed by the previous agent\'s verified result (including any failures). Adjust your plan naturally as you go; there is no separate re-planning step to request.\n\n' +
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
    'Focus on a clean, correct implementation. Do not spend iterations on extensive testing or verification — a dedicated adversarial Tester agent will independently verify your work and iterate with you on any issues found. A quick sanity check (e.g. one build or one obvious test run) is fine; methodical edge-case testing is the Tester\'s job.\n\n' +
    'FAILURE\n' +
    'If you cannot complete it within reasonable effort, say so explicitly in your final answer: state what you tried, what failed, and why you don\'t think it will succeed as scoped — do not grind indefinitely on the same approach.',
  tester:
    'ROLE\n' +
    'You are the TESTER inside Argo\'s multi-agent harness — an adversarial verifier.\n\n' +
    'APPROACH\n' +
    'Assume a subtle defect exists and try to falsify the implementation. ' +
    'Derive the intended behaviour independently from the assignment; do not trust the implementer\'s claims ' +
    'or let its approach constrain where you look. Inspect the actual project and use focused tests and ' +
    'counterexamples to attack failure modes relevant to this change, including non-obvious boundaries, state ' +
    'transitions, failure paths, and interactions with surrounding code. Consider concurrency, compatibility, ' +
    'security, or performance when the change makes them relevant.\n\n' +
    'MUTANT ANALYSIS\n' +
    'Ask especially: what realistic wrong implementation would still pass the existing tests? Invent such ' +
    'mutant failures and try to distinguish them from the current implementation.\n\n' +
    'Whenever practical, exercise at least one meaningful behaviour or failure mode that is not already covered ' +
    'by the tests cited or apparent from the implementation.\n\n' +
    'VISUAL VERIFICATION\n' +
    'When the assignment affects a webpage, layout, styling, canvas, chart, animation, responsive behaviour, or ' +
    'other user-visible UI: launch the application when practical and verify the rendered result. Use Playwright ' +
    'or bash to exercise the relevant interaction flow. Use view_image on screenshots of meaningful states to ' +
    'check for visual defects — clipping, overlap, incorrect geometry, doubled borders, bad spacing, invisible ' +
    'states, broken drag, overflow, or responsive regressions. For canvas, WebGL, or custom visual controls, ' +
    'prefer screenshot inspection over DOM assertions alone (DOM cannot establish visual correctness for drawn ' +
    'content). Re-inspect state after interaction. Check representative viewport sizes when responsiveness ' +
    'matters. Do not declare SUCCESS on a visual feature merely because tests pass if the rendered result has ' +
    'not been meaningfully checked.\n' +
    'Skip browser verification for non-visual tasks — code logic, API behaviour, data processing, and similar ' +
    'do not need it.\n' +
    'If a browser-verification attempt fails or times out, do not keep retrying with variations (different ' +
    'selectors, debug scripts, longer waits) — one or two attempts is enough to know whether the harness is ' +
    'cooperating. Confirmed live: a Tester burned 20 of its 40 iterations on repeated Playwright attempts (a ' +
    'timeout, a wrong element ID, a missing function) and reached the hard cap without ever calling `conclude`. ' +
    'Fall back to a source-code-only assessment and conclude with the evidence you have, noting the visual claim ' +
    'as unverified — do not exhaust your iteration budget debugging the test infrastructure itself.\n\n' +
    'DISCIPLINE\n' +
    'Report only concrete, evidence-backed failures — not speculative nitpicks. Do not stop at the first issue. ' +
    'Do not modify the project yourself; your role is to inspect, test, challenge, and report.\n\n' +
    'VERDICT\n' +
    'Call `conclude` with status SUCCESS only if no evidence-backed defect remains after your verification. ' +
    'The message must concisely state what was actually inspected or exercised, including the important tests or ' +
    'counterexamples used and any relevant verification limitations. ' +
    'Otherwise call `conclude` with status FAIL. Include the evidence: observed behaviour, expected behaviour, ' +
    'reproduction steps or test, and the smallest known scope of the defect. Then describe what must be fixed ' +
    'and how to verify the fix.',
  // 2026-09 ("iterative planner"): the standup/final checkpoints this suffix used to
  // also describe an ending convention for (NONE/INJECT/RESTART/ESCALATE) were
  // removed along with the task-graph execution loop they reviewed — see
  // dispatch.ts's module header. task-start is now the ONLY Boss checkpoint that
  // ever spawns (runBossTaskStart), and its own ANSWER/SIMPLE/OBJECTIVE
  // convention is stated entirely in its own assignment text
  // (dispatch.ts's buildTaskStartAssignment), not here. The generic
  // "follow the assignment below" framing is kept deliberately future-proof: it
  // remains true regardless of how many checkpoint types exist.
  boss:
    'ROLE\n' +
    'You are the BOSS inside Argo\'s multi-agent harness, accountable for the whole run over multiple turns.',
}

export function systemPromptFor(role: Role): string {
  return ROLE_SYSTEM_SUFFIX[role]
}

const SUMMARY_CHAR_CAP = 2000

// VERBATIM REQUEST THREADING (config.verbatimRequest; docs/research/
// 10-hermes-differential.md, finding 1). Argo's Boss task-start checkpoint paraphrases
// the user's raw message into one `OBJECTIVE:` line, and until now that paraphrase was
// the ONLY thing any downstream frame (Planner/Implementer/Tester) ever saw —
// `userMessage` was referenced in dispatch.ts's task-start path and nowhere else. Traced
// twice: on `bigproj-observability` the paraphrase dropped the pointer to the seeded
// test files and "read them first", so the Planner invented `test/service.test.js` as a
// target and tripped the eval's integrity gate (score zeroed regardless of code
// correctness); on `commander-count-option` the paraphrase dropped the seeded-spec
// pointer entirely, so the Implementer never read `tests/eval-count-option.test.js` and
// shipped against its own invented verification (4/10 targeted assertions passed).
//
// The fix: dispatch.ts's spawnFrame attaches the run's raw user message to EVERY frame's
// assignment via buildAssignment below, unconditionally and by construction (no per-call-
// site opt-in to forget) — never replacing the objective (setObjective's immutability
// guard is untouched; the objective still exists and still matters as the harness's
// stable restatement of the work), only sitting alongside it as a second, unparaphrased
// source of truth.
//
// Cap rationale: PROJECT_CONTEXT_CHAR_CAP (agent.ts) is 8000 chars for a whole file read
// ONCE per frame. This block is different: it repeats in EVERY frame's assignment for the
// whole run, and the anchor pair that motivates this fix is exactly a run with 75 frames
// — so a per-frame cost multiplies by frame count in a way loadProjectContext's doesn't.
// Set to half that (4000) for the same reason a pathological essay-length user message
// must not blow up 75x. Truncation is head-and-tail, not a plain head cut: both traced
// failures had their load-bearing detail (a seed-file pointer, a "do NOT modify tests"
// clause) at DIFFERENT positions in the raw message — one mid-message, one at the very
// end — so a head-only cut would have preserved one failure mode's fix and reproduced the
// other. An explicit marker names exactly how much was dropped, rather than silently
// splicing two halves together.
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

// The concrete mechanism for "only relevant content is shared" (docs/subagents-plan.md):
// a dependency contributes its capped conclusion summary + file pointers, NEVER its raw
// episode graph or transcript. If a frame needs more, it calls `ledger` with action
// "getFrameTrail" itself — explicit, on-demand, never automatic.
//
// `verbatimRequest` (config.verbatimRequest; see the block comment above
// renderVerbatimRequestBlock) is the run's raw user message, passed by dispatch.ts's
// spawnFrame — the ONE call site that builds every frame's assignment — so attaching it
// here makes it apply to every role by construction, not by each dispatch.ts call site
// remembering to add it. undefined/empty is a no-op (`filter(Boolean)` below drops it),
// which is what keeps config.verbatimRequest OFF byte-identical to the pre-existing
// behavior: dispatch.ts only ever passes a non-empty string here when the flag is on.
//
// Placement is deliberately FIRST in the array, ahead of dependency summaries and the
// step-specific assignment. Ollama's prefix cache on this machine is aggressive and
// cheap to lose (docs/research/09-small-model-scaffolding.md §6, "prefix-cache
// economics": every turn re-sends the whole message array, so cache reuse is decided by
// whether the HEAD of that array is byte-stable; measured directly on this box for this
// change: 34ms warm vs 1445ms cold for an identical prefix, and 1416ms — i.e. no better
// than cold — for the SAME tokens with one mutated LEADING token). This block is the one
// piece of a frame's assignment that is identical across every frame of the SAME dispatch
// run (unlike dependency summaries and the step prompt, which differ per frame by
// construction) — putting it at the head maximizes how much of the assignment message's
// own prefix is byte-identical across sibling frames of one run, rather than burying an
// immutable block after content that already varies frame to frame, where it could never
// anchor a cache hit at all.
// DEAD CODE REMOVED (this task): buildAssignment used to also render a "PRIOR WORK"
// block from req.dependsOn (a list of prior frameIds whose conclusions it fetched via
// ledger.getConclusion) — unreachable under the current iterative Planner design.
// Every dispatch.ts spawnFrame call site constructs its FrameSpawnRequest literal
// without a dependsOn field, so it was always undefined; the harness now threads prior
// work forward through the Planner's own follow-up prompt (buildNextTaskPrompt) and
// each frame's self-contained assignment text instead of a harness-rendered summary
// block. See DEAD-CODE.md for the corresponding type field dispatch.ts/types.ts still
// carry.
export async function buildAssignment(root: string, req: FrameSpawnRequest, verbatimRequest?: string): Promise<string> {
  const verbatimBlock = verbatimRequest ? renderVerbatimRequestBlock(verbatimRequest) : ''
  return [verbatimBlock, req.assignment].filter(Boolean).join('\n\n')
}

// ── Tester / Boss verdict parsing ──────────────────────────────────────────────────
// Tester and Boss are real Agent-based frames (their own ReAct loop, real tools),
// not single-shot JSON-mode critic calls — so their verdict comes from a simple text
// convention at the end of their final answer (see ROLE_SYSTEM_SUFFIX above).
//
// FOUR parse sites live in this pipeline — parseTesterVerdict, parseTaskStartVerdict,
// parseBossVerdict (here) and parseTaskGraph (dispatch.ts) — and until 2026-09-04 they
// each "failed open to a safe default" in their own way, with no way for a caller to
// tell "the model said this" from "nothing was parseable". Two of those defaults were
// not safe at all: an unparseable TESTER reply became RELEASE, i.e. work accepted with
// no review (measured: 85 Tester frames, ZERO REDOs ever issued, 2 of them stalled
// blank at their cap and still read as approval), and an unparseable PLANNER reply
// became a one-step graph, i.e. decomposition silently discarded.
//
// The convention now: every parse site returns an explicit `parsed` flag, so
// "unparseable" is a fact the caller can act on rather than something laundered into a
// positive verdict. Fail-open remains the default for a CLEAN, parseable-but-markerless
// reply where the benign reading is genuinely the likely one (Boss "nothing wrong");
// it is NOT the default where the pessimistic reading is (Tester approval, Planner
// decomposition), and it is never the default when the frame's own run ended in a cap
// hit or an error — dispatch.ts consults Agent.getLastRunOutcome() for that.
//
// SCHEMA-CONSTRAINED CONTROL PLANE (config.schemaControlPlane; src/schema.ts;
// docs/research/09-small-model-scaffolding.md §1/§7). These four parse functions stay
// EXACTLY as they are — pure regexes, tried first, at zero cost — even with the flag on.
// What changes is what dispatch.ts does with a `parsed: false` result: instead of (or
// before, for the Boss's benign default) burning a whole extra frame turn on a free-text
// reformat retry (TASK_START_MARKER_RETRY_NUDGE / TESTER_VERDICT_NUDGE / dispatch.ts's
// PLANNER_FORMAT_RETRY_NUDGE), dispatch.ts hands the frame's own final answer to
// schema.ts's extractX functions — one bounded, schema-constrained, tool-free,
// think:false call that restates the SAME decision as the required object, or returns
// null. A null there falls through to this module's existing conservative behaviour
// unchanged (the Tester/Planner hard stop, the Boss's benign 'none') — this module's own
// parsers and fail-open/fail-safe defaults are the backstop schema.ts relies on, not
// something it replaces.
export interface TesterVerdict {
  // 'escalate' = no verdict could be read at all. Deliberately NOT collapsed into
  // 'release': a Tester that never said RELEASE has not approved anything.
  action: 'release' | 'redo' | 'escalate'
  followUp: string // only meaningful when action === 'redo'
  parsed: boolean  // false ⇔ action === 'escalate'
}

export function parseTesterVerdict(finalAnswer: string): TesterVerdict {
  const redo = /REDO\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (redo) return { action: 'redo', followUp: redo[1].trim(), parsed: true }
  // RELEASE must be stated, not assumed. Word-boundary matched (not a substring) so
  // "released"/"releasing" in prose cannot be mistaken for the verdict marker; the
  // colon is optional because the prompt asks the model to end with the bare word.
  if (/\bRELEASE\b/i.test(finalAnswer)) return { action: 'release', followUp: '', parsed: true }
  return { action: 'escalate', followUp: '', parsed: false }
}

// The nudge dispatch.ts sends when a Tester frame produced no readable verdict and
// there is still a round left — a targeted reformat request (the diagnosis is exact:
// the review may well have happened, the marker line is missing), mirroring
// TASK_START_MARKER_RETRY_NUDGE rather than a blind "try again".
export const TESTER_VERDICT_NUDGE =
  'Your last answer did not end with a verdict line, so it cannot be acted on. Reply again and end your ' +
  'answer with exactly one of: RELEASE (you accept the conclusion, success or failure) or ' +
  'REDO: <specific follow-up instruction> — nothing else after it.'

// Task-start checkpoint, a THREE-way fork rather than always producing an objective +
// full plan (docs/subagents-plan.md, "skippable phases" + the Magentic-One-grounded
// redesign of 2026-09-03; collapsed from four ways to three when TRIVIAL was merged
// into SIMPLE, see dispatch.ts's buildTaskStartAssignment): a pure Q&A needs no frame
// at all; anything from a trivial one-line fix up to a single-file/single-function
// change goes straight to one Implementer + Tester with no Planner ceremony; and only
// work anticipated to need MULTIPLE distinct pieces gets the full Planner pipeline.
// Fails open to 'objective' (the safest, most-capable path) on anything unparseable.
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
  // unlike the Boss's free-form answer. `parsed: false` says the same thing explicitly;
  // note this site was ALREADY not failing open (the fallback objective is the user's
  // own words, not the model's prose), so only the flag is new here.
  return { mode: 'objective', text: '', parsed: false }
}

export interface BossVerdict {
  action: 'none' | 'inject' | 'restart' | 'escalate'
  message: string
  // false ⇔ no NONE/INJECT/RESTART/ESCALATE marker was found. Unlike the Tester's,
  // this default STAYS benign ('none' = reviewed, nothing wrong) for a run that ended
  // cleanly: the Boss is a periodic health check whose overwhelmingly common outcome
  // is "carry on", and escalating every markerless-but-complete review would replan on
  // formatting. dispatch.ts's runBoss escalates when !parsed AND the frame's own run
  // did not end cleanly (cap hit / error) — the case where nothing was reviewed at all.
  parsed: boolean
}

export function parseBossVerdict(finalAnswer: string): BossVerdict {
  const inject = /INJECT\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (inject) return { action: 'inject', message: inject[1].trim(), parsed: true }
  const restart = /RESTART\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (restart) return { action: 'restart', message: restart[1].trim(), parsed: true }
  const escalate = /ESCALATE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (escalate) return { action: 'escalate', message: escalate[1].trim(), parsed: true }
  if (/\bNONE\b/.test(finalAnswer)) return { action: 'none', message: '', parsed: true }
  return { action: 'none', message: '', parsed: false }
}
