// THE ORCHESTRATOR (docs/subagents-plan.md, config.agents / ARGO_AGENTS). Harness code,
// not an LLM — a strictly sequential dispatch loop over the ledger. Every role (Planner,
// Implementer, Tester, Boss) is one scoped `Agent` instance (agent.ts) reused as the
// call-frame execution primitive; this module owns spawning them, translating the
// Planner's task graph into frame dependencies, and applying the Boss's verdicts.
//
// HARD RULE: no two LLM calls ever run concurrently, for any reason — every `await`
// below fully resolves before the next one starts. One GPU, one resident model.
//
// v1 SIMPLIFICATIONS, noted explicitly (see docs/subagents-plan.md for the full design
// this is a first pass at):
//  - A frame's FrameResult is derived from its natural final answer + diffed files,
//    not a dedicated `conclude` tool call.
//  - Tester/Boss verdicts are parsed from a text convention at the end of their final
//    answer (RELEASE/REDO, NONE/INJECT/RESTART/ESCALATE) — see frames.ts.
//  - The pinned anchor (objective+plan) is folded into each frame's initial assignment
//    rather than threaded into per-turn recitation.
//  - Replanning starts a fresh step-id space for the new graph (the Planner ITSELF
//    stays a persistent, resumed Agent instance and is told what already succeeded, so
//    completed real-world work is never blindly redone — but step-tracking bookkeeping
//    resets on a replan rather than being merged positionally).

import { Agent } from './agent.js'
import { config } from './config.js'
import { SessionLogger } from './logger.js'
import type { AgentEvent, FrameSpawnRequest, FrameResult, FrameStatus, ModelOptions, Role, ToolName } from './types.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS, systemPromptFor, buildAssignment, capSummary, parseTesterVerdict, parseBossVerdict, parseTaskStartVerdict, policyFor, TESTER_VERDICT_NUDGE, TASK_START_TOOLS, type TaskStartVerdict } from './frames.js'
import * as ledger from './ledger.js'
import { createTaskGraph, readyGroups, allStepsDone, type TaskGraph, type TaskStep } from './tasks.js'
// SCHEMA-CONSTRAINED CONTROL PLANE (config.schemaControlPlane, docs/research/
// 09-small-model-scaffolding.md §1/§7; see src/schema.ts for the full design rationale).
// A single restatement call, tried after the cheap regex parse fails, in place of (or —
// for the Boss stand-up, which has no existing retry — ahead of) the old free-text
// format-retry resume. NEVER used to invent a decision: every extractX function here
// returns null on any doubt, and every call site below falls through to the SAME
// hard-stop / conservative default the flag-off path already uses on that null.
import { extractTaskGraph, extractTaskStart, extractTesterVerdict, extractBossVerdict } from './schema.js'

// The workspace root — config.workspacePath (NOT a literal '/workspace') because
// standalone dev mode runs this Node process directly on the HOST while `bash`
// reaches the project through a separate docker-exec'd container; only in-container
// worker mode has a real '/workspace' directory on ITS OWN filesystem. Read fresh
// each call, never cached, since standalone mode's runtime "mount a folder" flow
// mutates config.workspacePath directly (see server.ts's POST /api/workspace).
function root(): string {
  return config.workspacePath || '/workspace'
}

// git-diff sizing helpers (gitStatusShort/gitDiffLineCount/TRIVIAL_DIFF_LINE_LIMIT)
// used to live here, sizing a TRIVIAL self-attempt's blast radius because the task-
// start Boss could edit the workspace itself via bash. Removed (2026-09-05) along
// with that capability — see frames.ts's TASK_START_TOOLS for why and the incident
// that forced the issue. Guard code for a capability that no longer exists is worse
// than no guard at all.
const ACTION_EPISODES_PER_STANDUP = 10
// A frame that alone burns more iterations than this earns an immediate post-hoc
// standup regardless of the aggregate action-episode pacing (docs/subagents-plan.md,
// "large-frame standup trigger") — roughly the same order of magnitude as the
// baseline loop's own stall/progress-check thresholds (agent.ts, iterNum 20/35/45),
// since that's the point past which a SINGLE frame's own run starts to risk the same
// drift a standup exists to catch.
const LARGE_FRAME_ITERATIONS = 25
const MAX_TESTER_ROUNDS = 3
const MAX_REPLAN_ROUNDS = 5
const MAX_FINAL_VERIFY_ROUNDS = 3

// Model/options for the CURRENT dispatch run, set once at the top of runDispatchLoop
// and read by every spawnFrame call below. Module-level state is safe here only
// because server.ts's `isBusy` guard already prevents a second /chat request from
// starting a new runDispatchLoop while one is in flight — the same invariant that
// makes "no two LLM calls ever run concurrently" hold in the first place.
let currentModel: string | undefined
let currentOptions: ModelOptions | undefined
// VERBATIM REQUEST THREADING (config.verbatimRequest; docs/research/
// 10-hermes-differential.md, finding 1 — full rationale in frames.ts, above
// renderVerbatimRequestBlock). The CURRENT dispatch run's raw user message, captured
// once at the top of runDispatchLoop from the exact same `userMessage` runBossTaskStart
// paraphrases into an OBJECTIVE line — never recomputed per frame, so every frame of one
// run quotes byte-identical text (load-bearing for the prefix-cache argument: see
// buildAssignment's placement comment). undefined whenever config.verbatimRequest is
// off, which is what makes spawnFrame's buildAssignment call a no-op and the pipeline
// byte-identical to pre-existing behavior in that state.
let currentVerbatimRequest: string | undefined

// The model schema.ts's extraction calls should use — the SAME model the run's frames are
// already using (config.model as the fallback, exactly like runDispatchLoop's own `model`
// local), never a second model: this is a restatement of a decision the run's own model
// just made, not a job for a different model, and the whole point of reusing qwen3.6 for
// side calls elsewhere (critic.ts) is zero extra resident memory.
function effectiveModel(): string {
  return currentModel ?? config.model
}

// Matches Agent's own constructor param exactly (agent.ts), so a tagged emit can be
// handed straight to `new Agent(...)` — the optional `seq` is what the SSE/JSONL replay
// dedup logic (server.ts, app.js) keys on.
type Emit = (e: AgentEvent, seq?: number) => void

// STOP BUTTON (server.ts's POST /stop). The baseline Agent's own .abort() only affects
// the ONE shared instance server.ts constructs at module scope — every frame here is a
// SEPARATE Agent instance, so that call alone does nothing for a dispatch run. Track
// whichever frame is currently mid-chat() and abort THAT one too; the dispatch loop
// itself also checks stopRequested between frames (a frame stopping mid-chat only ends
// that one frame's turn, not the whole run) and unwinds via DispatchAborted, mirroring
// the baseline loop's own "Stopped." return convention exactly.
let stopRequested = false
let activeFrameAgent: Agent | null = null

export function abortDispatch(): void {
  stopRequested = true
  activeFrameAgent?.abort()
}

class DispatchAborted extends Error {}

function checkAborted(): void {
  if (stopRequested) throw new DispatchAborted()
}

// LIVE FRAME REGISTRY (context viewer backend, see /shared/argo-ui/CONTEXT-VIEWER-
// CONTRACT.md). GET /context always read the baseline single-loop Agent, which /chat
// bypasses entirely whenever config.agents is on — so the real per-frame contexts
// this Map records were never reachable from the API. A module-level Map, same
// pattern as stopRequested/activeFrameAgent above — deliberately not a class, this
// module already holds its run state as plain module-level bindings.
//
// Retention: cleared at the START of runDispatchLoop, not the end, so the LAST run's
// frames stay fully inspectable (server.ts's GET /frames, GET /context?frame=) right
// up until the next run begins — post-run inspection is the primary use of this
// feature, a user reading trace output while nothing is executing. Bound: every
// Agent instance this run has spawned stays resident (its full this.history +
// compaction state) until the next run's clear() — for a long multi-frame task this
// is real but small: the largest single frame history observed in this project's own
// logs is ~278KB, and a big multi-step task graph (2-5 steps is typical per
// docs/subagents-plan.md) spawning a few dozen frames this way tops out on the order
// of a few MB resident — negligible next to the Ollama client/model process itself,
// and fully released the moment the next run clears the Map. Worst case: an unusually
// long-running single task with many large Implementer frames holds all of them
// simultaneously until it (or the next run) starts; there is no cross-run cap because
// the whole point is "the last run", not "the last N runs".
export interface LiveFrame {
  frameId: string
  role: Role
  parentFrameId: string | null
  agent: Agent
  startedAt: number
  // Last `token_usage` event this frame emitted, cached here because Agent.getContext()
  // does not carry it (see agent.ts) — this is what lets GET /frames' promptTokens/
  // numCtx follow a running frame for the context donut. null until the frame's first
  // completed Ollama call.
  lastTokenUsage: { promptTokens: number; numCtx: number } | null
}

const liveFrames = new Map<string, LiveFrame>()

// The frame currently executing (mid agent.chat()), mirroring activeFrameAgent above
// one level up (by frameId instead of Agent instance) — see GET /frames' `active`
// field. Sequential by construction (this module's own "no two LLM calls ever run
// concurrently" hard rule, stated at the top of this file), so exactly one frame is
// ever active at a time; there is no queue or stack to maintain.
let activeFrameId: string | null = null

// Read accessors for server.ts — the registry itself stays a private module-level
// Map, matching how stopRequested/activeFrameAgent are exposed only through
// abortDispatch() rather than as raw bindings.
export function listLiveFrames(): LiveFrame[] {
  return Array.from(liveFrames.values())
}

export function getLiveFrame(frameId: string): LiveFrame | undefined {
  return liveFrames.get(frameId)
}

export function getActiveFrameId(): string | null {
  return activeFrameId
}

// Exported so ctrlplane.test.ts can build a fixture (a fake Agent + a FrameResult) without
// re-declaring the shape.
export interface SpawnedFrame {
  agent: Agent
  result: FrameResult
}

// Tags EVERY event this frame's Agent instance ever emits (thought/tool_call/
// tool_result/plan/done/...) with which role produced it and where it sits in the
// delegation tree — see types.ts's FrameTag. Bound once at construction, so a later
// resumeFrame() call on the same Agent instance automatically stays tagged too; no
// re-wrapping needed. An UNTAGGED event (the objective/task_graph/boss_verdict/replan
// narrative events below, emitted via the raw `emit` param) is the harness's own
// top-level narrative, not any one frame's turn.
//
// Also the one hook point for the live registry's lastTokenUsage cache (read-only
// observability only — this does not change what's emitted or sent to Ollama, it
// just also stashes a copy of `token_usage` events already flowing through here).
function tagEmit(emit: Emit, frameId: string, role: Role, parentFrameId: string | null) {
  return (event: AgentEvent, seq?: number) => {
    if (event.type === 'token_usage') {
      const entry = liveFrames.get(frameId)
      if (entry) entry.lastTokenUsage = { promptTokens: event.prompt_tokens, numCtx: event.num_ctx }
    }
    emit({ ...event, __frameId: frameId, __role: role, __parentFrameId: parentFrameId } as unknown as AgentEvent, seq)
  }
}

// PER-FRAME MECHANISM POLICY (H17, 2026-09-04). The one place a frame's mechanism set is
// decided, from the one place it is declared (frames.ts's ROLE_POLICY). Exported so it is
// unit-testable without an Ollama: spawnFrame itself cannot be tested (it writes a ledger
// entry and runs a real model turn), but "the Planner's frame has task sequencing off and
// the Implementer's has it on" is exactly this function's contract.
//
// Before this existed, spawnFrame configured tools, role prompt, frame id, max iterations
// and session id, and said NOTHING about tasks/memory/loop/grounding/layout — so every
// frame silently inherited config.* (tasks ON by default), which is what trapped the
// Planner. setTasks/setMemory/setLoop had zero production call sites; server.ts:108 set
// grounding alone.
export function applyFramePolicy(agent: Agent, role: Role): void {
  agent.setPolicy(policyFor(role))
}

// toolOverride lets ONE call site (runBossTaskStart's classification frame) restrict
// tools below ROLE_TOOLS[role] without a parallel spawning mechanism — every other
// caller omits it and gets the per-role default exactly as before. Deliberately not a
// FrameSpawnRequest field: that type is shared with the schema-extraction/planner-
// graph JSON shape (dispatch.ts's parseTaskGraph), and a tool override is a harness
// decision about ONE hardcoded checkpoint, never something a model-produced task
// graph should be able to request for itself.
//
// seedObjective (2026-09-05): pre-satisfies agent.ts's plan/act gate for an
// Implementer that already has a concrete objective before its first turn — see
// Agent.seedPlan's own comment for the full reasoning. Every Implementer spawn site
// in the step-execution loop below passes its own step's prompt here; every other
// role omits it (Tester/Boss never hold write_file/edit_file, so the gate can never
// trip for them; the Planner never writes either).
async function spawnFrame(req: FrameSpawnRequest, emit: Emit, toolOverride?: ToolName[], seedObjective?: string): Promise<SpawnedFrame> {
  checkAborted()
  const frameId = ledger.newId(req.role)
  await ledger.recordDelegation(root(), {
    frameId,
    parentFrameId: req.parentFrameId,
    from: 'harness',
    to: req.role,
    prompt: req.assignment,
    contextGiven: req.dependsOn,
  })

  const agent = new Agent(tagEmit(emit, frameId, req.role, req.parentFrameId), currentModel)
  if (currentOptions) agent.setOptions(currentOptions)
  agent.setAllowedTools(toolOverride ?? ROLE_TOOLS[req.role])
  agent.setRoleInstructions(systemPromptFor(req.role))
  agent.setFrameId(frameId)
  agent.setMaxIterations(req.maxIterations ?? ROLE_MAX_ITERATIONS[req.role])
  agent.setSessionId(frameId) // isolates history/compaction-state files per frame
  applyFramePolicy(agent, req.role) // H17 — never inherit the single-loop baseline's mechanisms
  if (seedObjective) agent.seedPlan(seedObjective) // BEFORE chat() — see the param comment above

  const assignment = await buildAssignment(root(), req, currentVerbatimRequest)
  const startedAt = Date.now()
  // Registered BEFORE chat() runs (not after) — GET /frames/GET /context?frame= must
  // be able to see a frame while it is still executing, not just once it concludes.
  liveFrames.set(frameId, { frameId, role: req.role, parentFrameId: req.parentFrameId, agent, startedAt, lastTokenUsage: null })
  activeFrameAgent = agent
  activeFrameId = frameId
  const finalAnswer = await agent.chat(assignment)
  activeFrameAgent = null
  activeFrameId = null
  checkAborted()
  const result = deriveFrameResult(frameId, finalAnswer, agent)
  await ledger.recordConclusion(root(), result)
  return { agent, result }
}

// Resumes an EXISTING frame (same Agent instance, same history) with a follow-up
// message — used for the Planner's replanning rounds and the Tester's "redo" verdict.
// Writes a NEW conclusion entry for the same frameId (the ledger is append-only; the
// latest conclusion for a frameId is authoritative — same convention as episode
// eviction records).
// H14 (2026-09-04): the { resume: true } flag is load-bearing. Without it chat() cleared
// the frame's currentPlan, taskList, loopState, editedPaths, episodes, reconciliation
// state and iteration counter (agent.ts's per-run reset), so "same Agent instance, same
// history" was true of the transcript and false of every piece of run state derived from
// it — a resumed frame restarted at ITER 1 with no plan and no memory of what it had
// edited. Latent while REDO/replan never fired; live the moment H13 makes REDO reachable.
// LIVE REGISTRY + resumeFrame: no registry update needed here beyond activeFrameId.
// The frameId's entry already exists (spawnFrame put it there, and it is never
// deleted until the NEXT run's clear()), and it holds this exact same Agent
// instance by construction ("Resumes an EXISTING frame (same Agent instance...)"
// above) — so `live` (computed from map membership) and the entry's role/
// parentFrameId/startedAt all stay correct with no changes on this path. What DOES
// need updating is which frame counts as "currently executing" for GET /frames'
// `active` field, exactly like activeFrameAgent just below.
//
// The H14 bug noted above (chat() wipes currentPlan/taskList/loopState/
// editedPaths/episodes/reconciliation-state/iteration-counter on resume) does NOT
// affect what GET /context or GET /frames report: both read only
// agent.getContext(), which reads this.history and this.compactionState — neither
// is in that list, so message counts/content stay accurate across a resume
// regardless of that separate, not-fixed-here bug.
async function resumeFrame(frameId: string, agent: Agent, followUp: string): Promise<FrameResult> {
  checkAborted()
  activeFrameAgent = agent
  activeFrameId = frameId
  const finalAnswer = await agent.chat(followUp, { resume: true })
  activeFrameAgent = null
  activeFrameId = null
  checkAborted()
  const result = deriveFrameResult(frameId, finalAnswer, agent)
  await ledger.recordConclusion(root(), result)
  return result
}

// H13 (2026-09-04) — THE FRAME BOUNDARY IS WHERE FAILURE WAS BEING DISCARDED.
// agent.ts turns a cap-hit into the string "Reached maximum iterations (N) without a
// final answer.", emits a terminal `error` event, and returns that string; this function
// used to see only "a string came back" and record status:'success'. Measured over the
// September corpus: 43 frames ended blank at their cap and were recorded success —
// Planner 9/23 (39%), Boss 26/204, Implementer 6/61, Tester 2/85, single-loop baseline
// 7/194. Nearly a tenth of all frames reported success having produced nothing, and the
// same run's ledger conclusion contradicted its own event stream ("10/10 + error" vs
// "success").
//
// The fix is to consult the frame's TERMINAL STATE (Agent.getLastRunOutcome(), set at each
// of chat()'s exit paths) rather than to pattern-match the returned text or compare
// iteration counts — the latter is also now wrong by construction, since a resumed frame's
// counter is cumulative (H14).
//
//   'cap'     → 'partial'. Not 'failed': the frame may well have done real work (files
//               touched are still reported below) — what it did NOT do is conclude, so it
//               must never read as success. 'partial' is an existing FrameStatus member.
//   'error'   → 'failed'. The returned string is an error message, not an answer.
//   'aborted' → 'killed'. Reachable only in narrow races: a stop normally unwinds through
//               checkAborted()/DispatchAborted before this runs.
//   'ok'      → the pre-existing text heuristic (gave_up vs success), unchanged.
//
// NOTE, deliberately not changed here: the dispatch loop replans on 'failed'/'gave_up'/
// 'killed' but NOT on 'partial'. So this makes cap-hits visible and stops them being
// credited; it does not add a new replan trigger. Whether a partial Implementer step
// should trigger a replan is a separate decision with its own cost (see BATCH2 report).
// Exported for unit tests: spawnFrame itself needs a ledger and a live model, but the
// cap-hit → 'partial' mapping is the whole of H13 and must be provable without either.
export function deriveFrameResult(frameId: string, finalAnswer: string, agent: Agent): FrameResult {
  const editedPaths = agent.getEditedPaths()
  const outcome = agent.getLastRunOutcome()
  const lower = finalAnswer.toLowerCase()
  const gaveUp = /\b(giving up|give up|cannot complete|unable to complete)\b/.test(lower)
  const status: FrameStatus = outcome === 'cap'
    ? 'partial'
    : outcome === 'error'
      ? 'failed'
      : outcome === 'aborted'
        ? 'killed'
        : gaveUp
          ? 'gave_up'
          : 'success'
  const issues = outcome === 'ok'
    ? undefined
    : [outcome === 'cap'
        ? `frame hit its iteration cap (${agent.getMaxIterations()}) without producing a final answer`
        : outcome === 'error'
          ? 'frame ended with an unexpected error'
          : 'frame was stopped before it concluded']
  return {
    frameId,
    status,
    summary: capSummary(finalAnswer),
    filesTouched: editedPaths,
    filesWritten: editedPaths,
    ...(issues ? { issues } : {}),
  }
}

// Task-start's routed decision. Used to carry two harness-level override modes,
// 'preempted'/'preempted-incomplete', for a workspace change the Boss made ITSELF
// during classification (detected via a before/after git diff) — removed (2026-09-05)
// along with the Boss's ability to touch the workspace at all during this checkpoint
// (see frames.ts's TASK_START_TOOLS), so `mode` is now exactly the four values the
// model itself can express. `frameId`/`agent` are also gone: both existed only for the
// deleted 'preempted' branch below to hand the classification frame straight to a
// Tester — every remaining caller only ever reads `.mode`/`.text`.
interface RoutedTaskStart {
  mode: TaskStartVerdict['mode']
  text: string
}

// Deliberately tiny — this is the STRUCTURAL enforcement of "the Boss shouldn't do
// actual work unless it's really 1-2 iterations, else it should delegate" (2026-09-03
// redesign, Magentic-One-grounded: an orchestrator that can act itself needs a real
// bound on how much, not just an instruction not to). Enough room to read a couple of
// files and classify; nowhere near enough to run a real implement-then-reverify cycle
// (observed at 8-15+ iterations in eval failures) to completion. Set to 10, not lower —
// Agent.setMaxIterations clamps any smaller request UP to 10 regardless (its own
// documented floor), so anything below 10 here would silently lie about the real
// budget and make the `hitCap` comparison below fire too early, misreading a clean
// finish with room to spare as an exhausted, incomplete attempt.
const TASK_START_MAX_ITERATIONS = 10

// One-shot corrective retry (docs/roadmap.md, 2026-09-03): observed repeatedly in eval
// (3+/11 eval-suite2 tasks) — on a genuinely trivial question the Boss answers directly
// ("408") and skips the required marker line entirely, even though the checkpoint prompt
// explicitly demands one. A targeted recovery, not a blind retry (Self-Healing Agentic
// Orchestrators for Tool-Augmented LLM Systems, arXiv:2606.01416): the diagnosis is
// exact (marker missing, answer otherwise already given), so the nudge asks for
// precisely that — reformat, don't re-derive.
const TASK_START_MARKER_RETRY_NUDGE =
  'Your last answer didn\'t end with one of the four required lines. Reply again, and end ' +
  'your answer with exactly one of: ANSWER: <...>, TRIVIAL: <...>, SIMPLE: <...>, or ' +
  'OBJECTIVE: <...> — nothing else after it.'

// The one-step graph task-start's TRIVIAL/SIMPLE modes build (runDispatchLoopBody).
// Pure — no ledger, no model — so it's exported and directly testable: TRIVIAL sets
// skipTest, SIMPLE does not.
//
// TRIVIAL skipping the Tester is a deliberate 2026-09-05 change from the previous
// rule here, "at least two independent frames, always" — that floor was justified by
// the Boss's own ability to self-edit during task-start: if the Boss could already have
// written a file himself with nothing else checking it, a single Implementer's own
// verification wasn't enough to trust either. That justification is gone now that
// task-start is read-only (TASK_START_TOOLS, frames.ts) — the Boss cannot touch the
// workspace at all during classification, so a genuinely TRIVIAL classification is
// purely the Implementer's own work, and its own verification is a reasonable
// stopping point. This is also what makes TRIVIAL worth distinguishing from SIMPLE at
// all: without it, the two modes built the identical graph and differed in name only.
export function buildTaskStartGraph(objective: string, mode: 'trivial' | 'simple'): TaskGraph {
  return createTaskGraph(objective, [{
    role: 'implementer',
    prompt: objective,
    dependsOn: [],
    ...(mode === 'trivial' ? { skipTest: true } : {}),
  }])
}

// Boss, checkpoint task-start: a FOUR-way router (docs/subagents-plan.md, "skippable
// phases" + the 2026-09-03 redesign). Never re-fires within one dispatch — the
// objective is set exactly once per task by construction (setObjective's own
// immutability guard is the backstop if this were ever called twice).
// The task-start checkpoint's own assignment text (distinct from frames.ts's
// buildAssignment, which wraps EVERY frame's assignment with dependency summaries —
// this IS the assignment passed to that wrapper for the task-start Boss specifically).
// Pure and exported so the exact prompt — the <argo-user-prompt> tagging, the
// READ-ONLY statement, the four mode markers — is directly testable without spawning
// a real frame; the cone reviewing this change can also just call it to see exactly
// what reaches the model.
//
// 2026-09-05: rewritten to make classification's read-only-ness explicit in the
// prompt itself (matching the tool-set change, TASK_START_TOOLS in frames.ts) and
// roughly halved in length — every mode now states its own iteration-budget as a
// uniform field (0 / 1-3 / 3-20 / 20+) instead of burying it in prose, and the "you
// MAY fix it yourself" / "verify it once" guidance is gone: there is no longer a
// fix-it-yourself path to guide. The <argo-user-prompt> tagging and per-mode budgets
// are deliberate and must survive any future edit of this prompt.
export function buildTaskStartAssignment(userMessage: string, verbatimRequestOn: boolean): string {
  return (
    'CHECKPOINT: task-start\n' +
    'Your task is to classify the following user request into exactly one of the four modes below:\n' +
    `<argo-user-prompt>\n${userMessage}\n</argo-user-prompt>\n\n` +
    // VERBATIM REQUEST THREADING (config.verbatimRequest): when on, the raw user
    // message is also attached to every downstream frame's assignment (see
    // buildAssignment / renderVerbatimRequestBlock in frames.ts), so this checkpoint
    // is no longer the request's only surviving record and the mode line can be a
    // concise digest rather than a defensive transcription. Flag-gated so the OFF
    // path's prompt text is byte-identical to before this existed.
    (verbatimRequestOn
      ? 'Note: the user\'s request above is ALSO threaded verbatim to every downstream frame (Planner, ' +
        'Implementer, Tester) alongside whatever you write below — this checkpoint is no longer the only place ' +
        'it survives, so your mode line can be a concise digest rather than an exhaustive transcription; the ' +
        'original is preserved separately for anyone who needs the exact wording.\n\n'
      : '') +
    'Return exactly one of these formats:\n' +
    '- `ANSWER: {complete final answer}` — Use only if you already know the answer with certainty and no ' +
    'project changes are required.\n' +
    '- `TRIVIAL: {concrete, verifiable objective}` — Use only for the most trivial changes when you are ' +
    'certain no testing is needed, such as a one-character typo or a single obvious constant change. Do not ' +
    'implement it yourself; instead, formulate a clear objective for the Implementer agent, which has write ' +
    'access. Such tasks typically take 1\u20133 iterations.\n' +
    '- `SIMPLE: {concrete, verifiable objective}` — Use for a well-scoped change that will typically take ' +
    '3\u201320 iterations to diagnose and implement, such as a bug confined to one file or a single function ' +
    'to fix. The objective will be handled by an Implementer and a Tester agent.\n' +
    '- `OBJECTIVE: {concrete, verifiable objective}` — Use if you expect the task to take more than 20 ' +
    'iterations, require deeper upfront analysis, involve several distinct pieces of work, or contain genuine ' +
    'ambiguity about the approach. The objective will be given to a Planner agent to break down into an ' +
    'actionable plan.\n\n' +
    'Do not implement anything. The project is READ-ONLY; your only task is to classify the request, and ' +
    'nothing may be modified.\n' +
    'Ground your answer or objective whenever it depends on project-specific details, current facts, or ' +
    'anything you cannot know with certainty. Inspect the relevant files or use the web when necessary rather ' +
    'than relying on assumptions.\n' +
    `You have a hard budget of ${TASK_START_MAX_ITERATIONS} iterations to classify the task and return ` +
    'exactly the required format.'
  )
}

async function runBossTaskStart(userMessage: string, emit: Emit): Promise<RoutedTaskStart> {
  const req: FrameSpawnRequest = {
    role: 'boss',
    parentFrameId: null,
    maxIterations: TASK_START_MAX_ITERATIONS,
    assignment: buildTaskStartAssignment(userMessage, config.verbatimRequest),
  }
  // TASK_START_TOOLS (frames.ts), not ROLE_TOOLS.boss — this checkpoint is read-only
  // classification, see that constant's comment for why and the incident that forced it.
  const { agent, result } = await spawnFrame(req, emit, TASK_START_TOOLS)
  let verdict = parseTaskStartVerdict(result.summary)

  // Retry once, only when the frame actually concluded on its own (a frame that stalled
  // at its cap has no budget to spend re-asking) and the model didn't already commit to a
  // mode — verdict.parsed says the marker WAS found, nothing to fix. hitIterationCap()
  // replaces the old `getIterationCount() < TASK_START_MAX_ITERATIONS` comparison, which
  // H14 breaks: the counter is now cumulative across a frame's turns, so a count at or
  // above the cap no longer implies a stall.
  if (!verdict.parsed && !agent.hitIterationCap()) {
    if (config.schemaControlPlane) {
      // Replaces the resumeFrame retry entirely (see the module-header comment on the
      // import above): a single bounded, schema-constrained restatement of the SAME
      // final answer, no extra frame turn, no tools, think:false. The ledger conclusion
      // is deliberately left untouched — nothing about the frame's own run changes,
      // only how the harness reads what it already said.
      const extracted = await extractTaskStart(effectiveModel(), result.summary)
      if (extracted) {
        verdict = { mode: extracted.mode, text: extracted.text, parsed: true }
        emit({
          type: 'warning',
          message: `schema-extraction recovered a task-start classification for frame ${result.frameId} `
            + `(mode: ${extracted.mode}) after the marker line was missing.`,
        })
      }
    } else {
      const retry = await resumeFrame(result.frameId, agent, TASK_START_MARKER_RETRY_NUDGE)
      const retryVerdict = parseTaskStartVerdict(retry.summary)
      if (retryVerdict.parsed) verdict = retryVerdict
    }
  }

  // The harness-level 'preempted'/'preempted-incomplete' override that used to live
  // here (a before/after git-status diff, routing around a workspace change the Boss
  // made itself) is gone along with the Boss's ability to make one during this
  // checkpoint — see frames.ts's TASK_START_TOOLS. Fails open to 'objective' (the
  // safest, most-capable path) exactly as TaskStartVerdict's own parse does when
  // nothing was parseable.
  const base = verdict.parsed ? verdict : { mode: 'objective' as const, text: userMessage }
  return { mode: base.mode, text: base.text }
}

interface BossOutcome {
  action: 'none' | 'inject' | 'restart' | 'escalate'
  message: string
}

// Finding 8 (docs/overnight-log.md, 2026-09-03): parseBossVerdict's fail-open default
// (action:'none') is correct for "the Boss reviewed and found nothing wrong," but a
// Boss checkpoint that hits its OWN iteration cap without producing a parseable verdict
// at all collapses to that exact same 'none' — the harness then proceeds as if nothing
// were wrong, even when the Tester handed the Boss a clear, itemized FAIL right before
// it stalled. A real overnight run reached the user as "done" with 3/6 new tests still
// failing because both the standup AND final Boss checkpoints stalled blank and 'none'
// was silently read as "all clear." Fixed the same way task-start's own hitCap check
// works (dispatch.ts, runBossTaskStart): a harness-level iteration-count comparison,
// not a text convention the model has to remember to use. A stalled checkpoint is
// escalated (forces a replan/re-verify) rather than treated as a clean verdict — the
// SAME conservative direction this project always resolves an ambiguous outcome in
// (Finding 4/5/6/7's "fail-open must not mean invisible"), just applied one checkpoint
// later in the pipeline than any prior finding caught it.
async function runBoss(
  checkpoint: 'standup' | 'final',
  contextText: string,
  emit: Emit,
): Promise<BossOutcome> {
  const req: FrameSpawnRequest = {
    role: 'boss',
    parentFrameId: null,
    assignment: `CHECKPOINT: ${checkpoint}\n${contextText}`,
  }
  const { agent, result } = await spawnFrame(req, emit)
  let verdict = parseBossVerdict(result.summary)
  // H13: the same "did this checkpoint actually finish?" question, now answered from the
  // frame's terminal state instead of an iteration-count comparison (which H14's
  // cumulative counter invalidates), and extended from 'cap' to any non-clean ending.
  // The trigger is `!verdict.parsed`, not `action === 'none'`: 'none' is now returned both
  // for an explicit NONE (a real all-clear, which must be honoured even if the frame then
  // stalled) and for an unparseable reply.
  const outcome = agent.getLastRunOutcome()
  // SCHEMA-CONSTRAINED CONTROL PLANE: this site has no existing retry to replace — the
  // Boss stand-up/final checkpoint's fail-open default (action:'none' below) is a
  // DELIBERATE, benign default for genuinely markerless-but-clean prose (Finding 8's "the
  // SAME conservative direction"), not a defect to remove. So the extraction call here
  // PRECEDES that default rather than replacing it: only attempted when the frame
  // concluded cleanly with no marker (outcome === 'ok' && !verdict.parsed), and a failed
  // or unavailable extraction falls straight through to the EXISTING 'none' default below
  // — never to an invented action. This recovers real verdicts the model reached but
  // failed to mark (the same 3-of-22 no-keyword stand-ups the research doc measured)
  // without weakening the benign default for the cases where it is genuinely correct.
  if (!verdict.parsed && outcome === 'ok' && config.schemaControlPlane) {
    const extracted = await extractBossVerdict(effectiveModel(), result.summary)
    if (extracted) {
      verdict = { action: extracted.verdict, message: extracted.reason ?? '', parsed: true }
      emit({
        type: 'warning',
        message: `schema-extraction recovered a Boss ${checkpoint} verdict for frame ${result.frameId} `
          + `(action: ${extracted.verdict}) after no NONE/INJECT/RESTART/ESCALATE line was found.`,
      })
    }
  }
  if (!verdict.parsed && outcome !== 'ok') {
    const why = outcome === 'cap'
      ? `hit its iteration cap (${ROLE_MAX_ITERATIONS.boss})`
      : outcome === 'error'
        ? 'ended with an unexpected error'
        : 'was stopped'
    return {
      action: 'escalate',
      message: `Boss ${checkpoint} checkpoint ${why} without ` +
        'producing a parseable verdict — treating as unresolved rather than "nothing wrong," since a stalled ' +
        'checkpoint never actually reviewed anything. Last raw output: ' + capSummary(result.summary),
    }
  }
  return { action: verdict.action, message: verdict.message }
}

// the Tester verifies a claim (an Implementer step's, or — 2026-09-03 — the Boss's own
// task-start attempt) and can send it back for a targeted redo. Factored out so the
// SAME independent-verification path applies uniformly regardless of who did the
// work: "always at least two distinct frames involved" (docs/subagents-plan.md)
// means even the Boss's own TRIVIAL self-fix gets a real Tester pass, never just a
// self-report accepted as-is.
// H13: a Tester that produced no readable verdict must NOT read as approval. Measured:
// 85 Tester frames, zero REDOs ever issued, and parseTesterVerdict defaulted every
// unreadable reply — including the 2 that stalled blank at their cap — to RELEASE, i.e.
// work accepted with no review at all. The escalation ladder here, in order:
//   1. round(s) remaining → re-run the verification with a targeted reformat nudge
//      (TESTER_VERDICT_NUDGE), the same shape as the task-start marker retry: the review
//      may well have happened and only the verdict line is missing.
//   2. rounds exhausted → the verified frame's conclusion is REWRITTEN to 'partial' with
//      an explicit UNVERIFIED note and a fresh ledger conclusion (the ledger is
//      append-only; the latest conclusion for a frameId wins), plus a harness-level
//      `warning` event. The Boss's final checkpoint reads that same recent-ledger window,
//      so an unverified step is visible to it rather than silently released.
// It deliberately does NOT replan: a Tester failing to format a verdict is not evidence
// the implementation is wrong, and 'partial' is not in the dispatch loop's replan trigger.
async function runTesterRounds(frame: SpawnedFrame, combinedPrompt: string, emit: Emit): Promise<SpawnedFrame> {
  let verdictNudge = ''
  // At most ONE extra Tester frame is spent on a missing verdict line, deliberately: the
  // Boss's own measured record is 16/22 markers present, 6/22 unusable, and if the Tester's
  // rate is similar then retrying every remaining round would triple the verification cost
  // of ~a quarter of all steps to recover a formatting slip. One targeted retry, then say
  // "unverified" and move on — leaving the remaining round available for a real REDO cycle.
  let verdictRetries = 0
  for (let round = 0; round < MAX_TESTER_ROUNDS; round++) {
    const testerReq: FrameSpawnRequest = {
      role: 'tester',
      parentFrameId: frame.result.frameId,
      assignment:
        buildTesterAssignment(
          `Original assignment: ${combinedPrompt}\n` +
          `Conclusion (${frame.result.status}): ${frame.result.summary}\n` +
          `Files touched: ${frame.result.filesTouched.join(', ') || 'none (or made via bash, not tracked)'}`,
        ) + verdictNudge,
    }
    const { agent: testerAgent, result: testerResult } = await spawnFrame(testerReq, emit)
    const verdict = parseTesterVerdict(testerResult.summary)
    if (verdict.action === 'release') break
    if (verdict.action === 'escalate') {
      const how = testerAgent.hitIterationCap()
        ? `stalled at its iteration cap (${ROLE_MAX_ITERATIONS.tester})`
        : `ended (${testerAgent.getLastRunOutcome()}) with no RELEASE/REDO line`
      emit({
        type: 'warning',
        message: `Tester frame ${testerResult.frameId} ${how} — no verdict to act on. A missing verdict is NOT `
          + 'a release; the reviewed work is not being accepted on the strength of it.',
      })
      // Builds the SAME "unverified" terminal FrameResult either path below falls to —
      // factored out only to avoid writing it twice, not a behavior change.
      const buildUnverified = (): FrameResult => ({
        ...frame.result,
        status: frame.result.status === 'success' ? 'partial' : frame.result.status,
        summary: capSummary(
          `${frame.result.summary}\n\nUNVERIFIED: the Tester produced no parseable RELEASE/REDO verdict `
          + '(including after an explicit request for the verdict line), so this work has NOT been '
          + 'independently verified.',
        ),
        issues: [...(frame.result.issues ?? []), 'tester-verdict-unparseable'],
      })
      if (config.schemaControlPlane) {
        // Replaces the TESTER_VERDICT_NUDGE resume entirely (see the import comment at the
        // top of this file): one bounded, schema-constrained restatement of the SAME final
        // answer, attempted only when the frame actually concluded (a capped Tester's
        // final answer is agent.ts's own cap-hit notice, nothing to restate — resuming it
        // would just re-hit the same cap, H14). On failure, go straight to the SAME
        // "unverified" terminal state the flag-off path reaches once ITS OWN retry budget
        // is spent (never straight to release) — a further free-text nudge is not expected
        // to succeed where a schema-constrained one already failed.
        const extracted = testerAgent.getLastRunOutcome() === 'ok'
          ? await extractTesterVerdict(effectiveModel(), testerResult.summary)
          : null
        if (extracted) {
          emit({
            type: 'warning',
            message: `schema-extraction recovered a Tester verdict for frame ${testerResult.frameId} `
              + `(verdict: ${extracted.verdict}) after the RELEASE/REDO line was missing.`,
          })
          if (extracted.verdict === 'release') break
          const resumed = await resumeFrame(frame.result.frameId, frame.agent, extracted.reason ?? TESTER_VERDICT_NUDGE)
          frame = { agent: frame.agent, result: resumed }
          continue
        }
        const unverified = buildUnverified()
        await ledger.recordConclusion(root(), unverified)
        frame = { agent: frame.agent, result: unverified }
        break
      }
      if (verdictRetries === 0 && round < MAX_TESTER_ROUNDS - 1) {
        verdictRetries++
        verdictNudge = `\n\n${TESTER_VERDICT_NUDGE}`
        continue
      }
      const unverified = buildUnverified()
      await ledger.recordConclusion(root(), unverified)
      frame = { agent: frame.agent, result: unverified }
      break
    }
    const resumed = await resumeFrame(frame.result.frameId, frame.agent, verdict.followUp)
    frame = { agent: frame.agent, result: resumed }
    verdictNudge = ''
  }
  return frame
}

// H13: returns null — NOT a one-step graph — when no task graph could be read. The old
// fail-open default is the single most consequential silent failure measured in this
// harness: all 8 large-task Planner frames produced valid 2-to-5-step graphs, 84 of 85
// executed graphs had exactly one step, so the graphs were being parsed away, and "the
// whole objective goes to one Implementer" looked like a working system. A fallback that
// is indistinguishable from success is worse than no fallback.
// Exported for unit tests (ctrlplane.test.ts): the cheap regex parse is the pure logic the
// schema-extraction wiring sits on top of, and it needs no Ollama/ledger/git to exercise.
export function parseTaskGraph(objective: string, plannerAnswer: string): TaskGraph | null {
  const m = /```json\s*([\s\S]*?)```/i.exec(plannerAnswer)
  if (m) {
    try {
      const parsed = JSON.parse(m[1]) as {
        steps?: Array<{ role?: string; prompt?: string; dependsOn?: string[]; frameGroup?: string; skipTest?: boolean }>
      }
      const steps = (parsed.steps ?? [])
        .filter((s): s is { role: string; prompt: string; dependsOn?: string[]; frameGroup?: string; skipTest?: boolean } =>
          typeof s.prompt === 'string' && (s.role === 'implementer' || s.role === 'tester'))
        .map(s => ({
          role: s.role as Role,
          prompt: s.prompt,
          dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d): d is string => typeof d === 'string') : [],
          ...(s.frameGroup ? { frameGroup: s.frameGroup } : {}),
          ...(s.skipTest === true ? { skipTest: true } : {}),
        }))
      if (steps.length > 0) return createTaskGraph(objective, steps)
    } catch {
      // Fall through to null below. NOT to a synthesised graph: a JSON block that failed
      // to parse (or parsed to zero usable steps) tells us the Planner's output was not
      // understood, and pretending it said "one step: the whole objective" destroys the
      // only signal that anything went wrong.
    }
  }
  return null
}

// Raised when planning cannot produce a graph even after a targeted retry. Unwound by
// runDispatchLoop, which reports it to the user as a planning failure instead of running
// an invented single-step plan. The Planner is the one checkpoint whose OUTPUT IS THE PLAN
// — there is no conservative default available to it, so this is the one place in the
// pipeline that stops rather than degrades.
export class PlanningFailed extends Error {}

// The Planner's format-retry nudge — the same targeted-recovery shape as task-start's
// marker retry (the plan may be fine and only the fenced block missing/mangled), not a
// blind "try again".
const PLANNER_FORMAT_RETRY_NUDGE =
  'Your last answer did not contain a readable task graph, so nothing could be dispatched from it. Reply again '
  + 'with the graph ONLY, as a single fenced ```json block: {"steps": [{"role": "implementer"|"tester", '
  + '"prompt": "...", "dependsOn": ["s1", ...]}]} — at least one step, no other JSON blocks, nothing after it.'

// Reads a graph out of a Planner frame's final answer, retrying the frame ONCE with a
// format-only nudge before giving up. Returns the graph and the (possibly updated) frame
// result; throws PlanningFailed rather than inventing a plan. The retry is a resume of the
// SAME Planner frame, so it keeps the reasoning it already did (H14).
// Exported for unit tests (ctrlplane.test.ts) — this is the site the schema-constrained
// control plane idea was ranked top priority for (docs/research/09-small-model-
// scaffolding.md §1: the `commander-option-requires` failure, pfail=1, zero progress).
export async function graphFromPlanner(
  objective: string,
  frame: SpawnedFrame,
  emit: Emit,
  context: string,
): Promise<{ graph: TaskGraph; result: FrameResult }> {
  const first = parseTaskGraph(objective, frame.result.summary)
  if (first) return { graph: first, result: frame.result }
  emit({
    type: 'warning',
    message: `Planner frame ${frame.result.frameId} (${context}) produced no readable task graph `
      + `(frame ended: ${frame.agent.getLastRunOutcome()}) — asking once for the JSON block only. `
      + 'An unreadable plan is NOT a one-step plan.',
  })

  if (config.schemaControlPlane) {
    // Replaces the resumeFrame format retry entirely (see the import comment at the top
    // of this file). This is the site the schema-constrained control plane idea was
    // ranked top priority for (docs/research/09-small-model-scaffolding.md §1) — a real
    // measured failure, `commander-option-requires`, had the Planner fail to emit a
    // readable graph EVEN AFTER its one format retry (pfail=1) and the run ended in 87
    // seconds with zero progress. Only attempted when the frame actually concluded
    // (getLastRunOutcome() === 'ok'): a capped Planner's "final answer" is agent.ts's own
    // cap-hit notice, not a decision — there is nothing in it to restate, and resuming it
    // would just re-hit the same cap (H14).
    const extracted = frame.agent.getLastRunOutcome() === 'ok'
      ? await extractTaskGraph(effectiveModel(), frame.result.summary)
      : null
    if (extracted) {
      // TaskStep.dependsOn is a required string[] (see tasks.ts); ExtractedTaskStep's is
      // optional (schema.ts never fabricates an empty array just to satisfy this shape) —
      // default it here, the same mapping parseTaskGraph itself does for the regex path.
      const graph = createTaskGraph(objective, extracted.steps.map(s => ({
        role: s.role,
        prompt: s.prompt,
        dependsOn: s.dependsOn ?? [],
        ...(s.frameGroup ? { frameGroup: s.frameGroup } : {}),
        ...(s.skipTest ? { skipTest: true } : {}),
      })))
      if (graph.steps.length > 0) {
        emit({
          type: 'warning',
          message: `schema-extraction recovered a ${graph.steps.length}-step task graph for Planner frame `
            + `${frame.result.frameId} (${context}) after the fenced JSON block was missing or unreadable.`,
        })
        return { graph, result: frame.result }
      }
    }
    throw new PlanningFailed(
      `Planning failed: the Planner produced no readable task graph for this objective, and the `
      + `schema-constrained extraction pass could not recover one either (${context}; frame `
      + `${frame.result.frameId} ended: ${frame.agent.getLastRunOutcome()}). No plan was invented in its `
      + `place. Objective: ${objective}\nLast raw output:\n${frame.result.summary}`,
    )
  }

  const retry = await resumeFrame(frame.result.frameId, frame.agent, PLANNER_FORMAT_RETRY_NUDGE)
  const second = parseTaskGraph(objective, retry.summary)
  if (second) return { graph: second, result: retry }
  throw new PlanningFailed(
    `Planning failed: the Planner produced no readable task graph for this objective, even after an explicit `
    + `format retry (${context}; frame ${frame.result.frameId} ended: ${frame.agent.getLastRunOutcome()}). `
    + `No plan was invented in its place. Objective: ${objective}\nLast raw output:\n${retry.summary}`,
  )
}

function emitTaskGraph(emit: Emit, graph: TaskGraph): void {
  emit({ type: 'task_graph', objective: graph.objective, steps: graph.steps, revision: graph.revision })
}

const PLANNER_FORMAT_INSTRUCTION =
  'End your answer with a JSON code block fenced in ```json ... ``` shaped exactly as: ' +
  '{"steps": [{"role": "implementer"|"tester", "prompt": "...", "dependsOn": ["s1", ...], "frameGroup": "optional", ' +
  '"skipTest": false}]}. Reference earlier steps in dependsOn by their 1-based position (s1, s2, ...).'

// The Planner's initial-plan assignment. Owner-drafted structure (2026-09-05),
// replacing a single opaque line (`Objective: ${objective}\nProduce a task graph for
// this objective. ${PLANNER_FORMAT_INSTRUCTION}`) that said nothing about what the
// Planner is, what it can do, or what its output must look like. `<argo-objective>`
// tags mirror the same unmistakable-boundary convention as the task-start
// checkpoint's `<argo-user-prompt>` tags (buildTaskStartAssignment, above) — pure and
// exported so this exact text is directly testable without spawning a real frame.
export function buildPlannerAssignment(objective: string): string {
  return (
    `<argo-objective>\n${objective}\n</argo-objective>\n\n` +
    'The project is READ-ONLY: you are tasked with creating the plan to address the above objective, ' +
    'so nothing can be modified. Read files as needed to understand the codebase.\n\n' +
    'Produce a task graph: an ordered list of agents (implementer or tester), each with a focused ' +
    'sub-objective, and their dependency order. A step\'s sub-objective must be self-contained — the ' +
    'agent receiving it will not see the full plan, only its own assignment and the conclusions of ' +
    'its dependencies.\n\n' +
    'If the work is too large to fully predict, plan only the part you can and include a final ' +
    'step that requests a re-planning round. On a re-plan you will be resumed with what each ' +
    `agent produced.\n\n${PLANNER_FORMAT_INSTRUCTION}`
  )
}

// The Planner's replan assignment — same structure as buildPlannerAssignment (the
// objective tag, the READ-ONLY statement, the format instruction) plus what changed
// since the last plan (the reason replan() was called: a step's failure, a Boss
// escalation, an empty ready-set, ...) and the REMAINING-work-only framing, so a
// replan never re-litigates work that already succeeded. Used identically whether
// this resumes an EXISTING Planner frame or spawns a fresh one (a TRIVIAL/SIMPLE
// start that never spawned a Planner needing its first replan) — the objective tag
// means neither path needs a separate "restate the objective" prefix.
export function buildReplanAssignment(objective: string, reason: string): string {
  return (
    `<argo-objective>\n${objective}\n</argo-objective>\n\n` +
    'The project is READ-ONLY: you are tasked with revising the plan to address the above objective, ' +
    'so nothing can be modified. Read files as needed to understand the codebase.\n\n' +
    `REPLANNING ROUND. What happened since the last plan: ${reason}\n\n` +
    'Produce a revised task graph for the objective\'s REMAINING work only (do not redo what already ' +
    'succeeded): an ordered list of agents (implementer or tester), each with a focused sub-objective, ' +
    'and their dependency order. A step\'s sub-objective must be self-contained — the agent receiving ' +
    'it will not see the full plan, only its own assignment and the conclusions of its dependencies.\n\n' +
    'If the work is too large to fully predict, plan only the part you can and include a final step ' +
    'that requests a re-planning round. On a re-plan you will be resumed with what each agent ' +
    `produced.\n\n${PLANNER_FORMAT_INSTRUCTION}`
  )
}

// Implementer/Tester assignments, wrapped the same way as the Boss task-start
// checkpoint's `<argo-user-prompt>` tags and the Planner's `<argo-objective>` tags
// (buildTaskStartAssignment / buildPlannerAssignment above) — one prompt shape
// across every role instead of each spawn site below handing over a bare,
// untagged string. Pure and exported so the exact text is directly testable
// without spawning a real frame.
export function buildImplementerAssignment(objective: string): string {
  return (
    'Your task is to implement the following objective:\n' +
    `<argo-objective>\n${objective}\n</argo-objective>`
  )
}

// Same tag, opposite framing: the Tester is told what to VERIFY, never what to
// implement, matching ROLE_SYSTEM_SUFFIX.tester ("You verify another agent's
// claimed work — you never fix anything yourself").
export function buildTesterAssignment(claim: string): string {
  return (
    'Your task is to verify the following claimed work:\n' +
    `<argo-objective>\n${claim}\n</argo-objective>`
  )
}

// Wraps a step-execution spawn's assignment with the correct one of the two
// builders above, keyed on the role about to receive it — the ONE place this
// decision is made, so a spawn site never has to remember which wrapper matches
// which role. Tester steps reached via a Planner-authored task-graph step
// (as opposed to runTesterRounds' own explicit verification pass, which builds
// its own richer claim text) still just want "verify this objective."
function buildRoleAssignment(role: Role, content: string): string {
  return role === 'tester' ? buildTesterAssignment(content) : buildImplementerAssignment(content)
}

export async function runDispatchLoop(
  userMessage: string,
  rawEmit: Emit,
  overrides?: { model?: string; options?: ModelOptions; sessionId?: string },
): Promise<string> {
  currentModel = overrides?.model
  currentOptions = overrides?.options
  stopRequested = false
  activeFrameAgent = null
  // LIVE REGISTRY (server.ts's GET /frames, GET /context?frame=): cleared at the
  // START of a run, not the end — the whole retention policy is "one run's frames
  // replace the previous run's", so the run that just finished stays fully
  // inspectable right up until this line runs for the NEXT one. See the registry's
  // own declaration above for the memory bound this implies.
  liveFrames.clear()
  activeFrameId = null
  // See the module-level currentVerbatimRequest declaration above. Deliberately the
  // SAME raw userMessage runBossTaskStart is about to paraphrase, captured before that
  // paraphrase happens — there is no other candidate text this could be, and capturing
  // it here (once) rather than threading a parameter through every downstream function
  // is what makes it apply to every frame spawned below without any of them having to
  // ask for it.
  currentVerbatimRequest = config.verbatimRequest ? userMessage : undefined
  const model = currentModel ?? config.model

  // The dispatch run's own top-level narrative (start/objective/task_graph/
  // boss_verdict/replan/message/done) gets a REAL persisted log — a SessionLogger
  // exactly like agent.ts's baseline chat() creates, under the SAME sessionId
  // server.ts already tracks for the UI's session dropdown/history (passed in via
  // overrides.sessionId). Without this, the ONLY record of "what did the harness
  // decide" was the live SSE stream — gone the moment the run ended, and every
  // individual FRAME (each its own real Agent.chat() call) already gets its own
  // separate JSONL+MD, so "every session is logged" was silently false for the
  // one file that would show the overall shape of the run. Only UNTAGGED events
  // (no __frameId) are logged HERE — a tagged event already has its own home in
  // its frame's own log; logging it again here would just duplicate it.
  const logger = new SessionLogger(userMessage, model, currentOptions ?? {}, overrides?.sessionId)
  const emit: Emit = (event, seq) => {
    if ('__frameId' in event) { rawEmit(event, seq); return }
    logger.log(event)
    rawEmit(event, logger.getSeq())
  }

  // Top-level lifecycle events, UNTAGGED (no frame owns them) — mirrors agent.ts's own
  // chat() exactly (start ... message/done), so the existing status bar, trace block,
  // notifications, and git/file refresh in app.js work unmodified for the WHOLE
  // dispatch run; every tagged per-frame event nests inside this same trace block.
  emit({ type: 'start', model, query: userMessage, options: currentOptions ?? {} })
  try {
    const finalAnswer = await runDispatchLoopBody(userMessage, emit)
    emit({ type: 'message', role: 'assistant', content: finalAnswer })
    emit({ type: 'done', content: finalAnswer })
    await logger.flush()
    return finalAnswer
  } catch (err) {
    if (err instanceof DispatchAborted) {
      // No 'message' event on a user-requested stop — mirrors agent.ts's own
      // stop path exactly (done only, no assistant chat bubble for "Stopped.").
      const stopped = 'Stopped.'
      emit({ type: 'done', content: stopped })
      await logger.flush()
      return stopped
    }
    // H13: planning that could not produce a graph is a REPORTED failure, not an
    // "unexpected error" and emphatically not an invented one-step plan. Same event shape
    // as the generic branch below (error + no assistant bubble), with the diagnosis as the
    // returned text so the user/eval sees why nothing ran.
    if (err instanceof PlanningFailed) {
      emit({ type: 'error', message: err.message })
      await logger.flush()
      return err.message
    }
    const message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`
    emit({ type: 'error', message })
    await logger.flush()
    return message
  }
}

async function runDispatchLoopBody(userMessage: string, emit: Emit): Promise<string> {
  await ledger.ensureGitignored(root())

  const taskStart = await runBossTaskStart(userMessage, emit)

  // ANSWER: the Boss already knows, verified it himself — no Planner/Implementer/Tester
  // frame ever spawns. The whole point of this mode is zero further iteration.
  if (taskStart.mode === 'answer') {
    await ledger.setObjective(root(), taskStart.text)
    emit({ type: 'objective', text: taskStart.text })
    return taskStart.text
  }

  const objective = taskStart.text
  await ledger.setObjective(root(), objective)
  emit({ type: 'objective', text: objective })

  // plannerFrame stays null until/unless something actually goes wrong (replan()
  // below spawns one lazily at that point) for every mode except 'objective' — the
  // whole point of TRIVIAL/SIMPLE is skipping the Planner's ceremony for work that isn't
  // anticipated to need MULTIPLE distinct pieces.
  let plannerFrame: SpawnedFrame | null = null
  // Whichever frame's Agent instance most recently did real work — reused purely as
  // the vehicle for the end-of-run autoCommit (it only needs git + a model, not a
  // specific role), so a run that never spawns a Planner still has one.
  let commitAgent: Agent | null = null
  let graph: TaskGraph

  const doneStepIds = new Set<string>()
  const stepFrameId = new Map<string, string>()

  if (taskStart.mode === 'trivial' || taskStart.mode === 'simple') {
    graph = buildTaskStartGraph(objective, taskStart.mode)
  } else {
    // Held in a local const as well as in plannerFrame: graphFromPlanner may resume the
    // frame, and the local keeps the non-null Agent reference obvious without depending on
    // narrowing across the awaits.
    const planner = await spawnFrame(
      {
        role: 'planner',
        parentFrameId: null,
        assignment: buildPlannerAssignment(objective),
      },
      emit,
    )
    plannerFrame = planner
    commitAgent = planner.agent
    // H13: no fail-open one-step graph. graphFromPlanner retries the frame once for the
    // JSON block and otherwise throws PlanningFailed (caught in runDispatchLoop).
    const planned = await graphFromPlanner(objective, planner, emit, 'initial plan')
    plannerFrame = { agent: planner.agent, result: planned.result }
    graph = planned.graph
  }
  await ledger.setPlan(root(), graph)
  emitTaskGraph(emit, graph)

  let standupWatermark = Date.now()
  let replanRounds = 0

  async function replan(reason: string): Promise<void> {
    replanRounds++
    emit({ type: 'replan', reason })
    const followUp = buildReplanAssignment(objective, reason)
    let result: FrameResult
    if (plannerFrame) {
      result = await resumeFrame(plannerFrame.result.frameId, plannerFrame.agent, followUp)
      plannerFrame = { agent: plannerFrame.agent, result }
    } else {
      // A TRIVIAL start never spawned a Planner — this is the first time one is
      // actually needed, so spawn it fresh rather than resuming a frame that never
      // existed. buildReplanAssignment already carries the objective (its own
      // <argo-objective> tag), so unlike before, this needs no separate prefix —
      // the fresh-spawn and resume branches now send the IDENTICAL text.
      plannerFrame = await spawnFrame(
        { role: 'planner', parentFrameId: null, assignment: followUp },
        emit,
      )
      result = plannerFrame.result
    }
    // Captured before the await for the same reason as the initial-plan branch above.
    const plannerAgent = plannerFrame.agent
    commitAgent = plannerAgent
    // H13: same rule on a replan — one format retry, then PlanningFailed. A replan that
    // silently collapsed to "one Implementer, the whole objective" was the worst case of
    // the old fail-open: it discarded both the Boss's diagnosis and the remaining-work
    // scoping this round exists to produce.
    const replanned = await graphFromPlanner(
      objective,
      { agent: plannerAgent, result },
      emit,
      `replan round ${replanRounds}`,
    )
    plannerFrame = { agent: plannerAgent, result: replanned.result }
    graph = replanned.graph
    await ledger.setPlan(root(), graph)
    emitTaskGraph(emit, graph)
    doneStepIds.clear() // fresh step-id space for the new graph — see module doc
  }

  // Runs a Boss standup over the same recent-ledger window either trigger reads, and
  // applies whichever verdict comes back (docs/subagents-plan.md). Always resets
  // standupWatermark — a large-frame-triggered standup covers the same recent activity
  // an aggregate-triggered one would have, so the aggregate counter should not ALSO
  // fire again immediately after. Returns the frame to keep tracking (the original,
  // unless 'restart' replaced it with a fresh one).
  async function runStandup(
    trigger: 'large-frame' | 'trouble' | 'aggregate',
    frame: SpawnedFrame,
    role: Role,
    combinedPrompt: string,
    depFrameIds: string[],
    steps: TaskStep[],
  ): Promise<SpawnedFrame> {
    standupWatermark = Date.now()
    const recent = await ledger.getRecent(root(), 20)
    const triggerDetail = trigger === 'large-frame'
      ? ` (frame ran ${frame.agent.getIterationCount()} iterations)`
      : trigger === 'trouble'
        ? ' (frame hit loop-recovery escalation or needed an Ollama retry — converged, but with real friction)'
        : ''
    const outcome = await runBoss(
      'standup',
      `Objective: ${objective}\nTrigger: ${trigger}${triggerDetail}\n` +
        `Recent ledger activity (most recent last):\n${JSON.stringify(recent).slice(0, 4000)}`,
      emit,
    )
    if (outcome.action === 'inject') {
      emit({ type: 'boss_verdict', action: 'inject', message: outcome.message, targetFrameId: frame.result.frameId })
      await ledger.recordInjection(root(), { targetFrameId: frame.result.frameId, message: outcome.message, reason: 'boss-standup', injectedBy: 'boss' })
      return frame
    }
    if (outcome.action === 'restart') {
      emit({ type: 'boss_verdict', action: 'restart', message: outcome.message, targetFrameId: frame.result.frameId })
      await ledger.recordInjection(root(), { targetFrameId: frame.result.frameId, message: outcome.message, reason: 'boss-restart', injectedBy: 'boss' })
      const retryReq: FrameSpawnRequest = {
        role,
        parentFrameId: plannerFrame?.result.frameId ?? null,
        assignment: `${buildRoleAssignment(role, combinedPrompt)}\n\nA PREVIOUS ATTEMPT at this task got stuck. What it did and where: ${frame.result.summary}\nTry a different approach.`,
        dependsOn: depFrameIds,
      }
      const retry = await spawnFrame(retryReq, emit)
      commitAgent = retry.agent
      for (const s of steps) stepFrameId.set(s.id, retry.result.frameId)
      return retry
    }
    if (outcome.action === 'escalate') {
      emit({ type: 'boss_verdict', action: 'escalate', message: outcome.message, targetFrameId: null })
      await replan(`Boss escalation during standup: ${outcome.message}`)
    }
    return frame
  }

  while (!allStepsDone(graph, doneStepIds)) {
    if (replanRounds > MAX_REPLAN_ROUNDS) {
      return `Could not complete the objective after ${MAX_REPLAN_ROUNDS} replanning rounds. Objective: ${objective}. Last plan:\n${plannerFrame?.result.summary ?? '(none)'}`
    }

    const groups = readyGroups(graph, doneStepIds, new Set())
    if (groups.size === 0) {
      await replan('No steps are currently ready to run — the dependency graph may be malformed or contradictory.')
      continue
    }

    for (const steps of groups.values()) {
      const role = steps[0].role
      const depFrameIds = [...new Set(steps.flatMap(s => s.dependsOn))]
        .map(id => stepFrameId.get(id))
        .filter((x): x is string => !!x)
      const combinedPrompt = steps.map(s => s.prompt).join('\n\n---\n\n')

      // Seed the Implementer's plan with its own assignment (TRIVIAL/SIMPLE's top-
      // level objective, or a Planner step's sub-objective — combinedPrompt is
      // exactly that in every mode this loop handles) so it can write from its FIRST
      // iteration, never forced through update_plan just to restate what it was
      // already told. Tester never gets this — it holds no write_file/edit_file, so
      // the plan/act gate can never trip for it regardless.
      let frame = await spawnFrame(
        { role, parentFrameId: plannerFrame?.result.frameId ?? null, assignment: buildRoleAssignment(role, combinedPrompt), dependsOn: depFrameIds },
        emit,
        undefined,
        role === 'implementer' ? combinedPrompt : undefined,
      )
      commitAgent = frame.agent

      // skipTest is set by the Planner per-step for a Planner-produced OBJECTIVE graph
      // (tasks.ts), and by task-start's own TRIVIAL classification (runBossTaskStart,
      // above) for its one-step graph — SIMPLE and every Planner step default to
      // false (a real Tester pass) unless explicitly waived.
      if (role === 'implementer' && !steps[0].skipTest) {
        frame = await runTesterRounds(frame, combinedPrompt, emit)
      }

      for (const s of steps) {
        stepFrameId.set(s.id, frame.result.frameId)
        doneStepIds.add(s.id)
      }

      if (frame.result.status === 'failed' || frame.result.status === 'gave_up' || frame.result.status === 'killed') {
        await replan(`Step(s) [${steps.map(s => s.id).join(', ')}] ended with status "${frame.result.status}": ${frame.result.summary}`)
        break // the group's steps are re-planned from scratch; stop iterating this stale `groups` map
      }

      // Three independent standup triggers, any one fires a Boss review of the SAME
      // recent ledger window (docs/subagents-plan.md, 2026-09-03 redesign): a frame
      // that alone burned past LARGE_FRAME_ITERATIONS, or one that showed real
      // friction even though it converged (hit L1/L2 loop-recovery, or needed an
      // Ollama retry — hadTrouble()), is checked IMMEDIATELY (post-hoc — frames run
      // to completion under the no-concurrency rule, so "immediate" means "the
      // moment it concludes," not mid-frame) rather than waiting for the aggregate
      // counter — a raw action-episode count alone can't tell "healthy, paced work"
      // apart from "converged, but only after real thrashing." The aggregate
      // ACTION_EPISODES_PER_STANDUP counter remains the fallback for many small,
      // individually-unremarkable frames that never trip either signal.
      const justRanLong = frame.agent.getIterationCount() > LARGE_FRAME_ITERATIONS
      const hadTrouble = frame.agent.hadTrouble()
      const actionsSince = (justRanLong || hadTrouble) ? 0 : await ledger.countActionEpisodesSince(root(), standupWatermark)
      if (justRanLong || hadTrouble || actionsSince >= ACTION_EPISODES_PER_STANDUP) {
        const trigger = justRanLong ? 'large-frame' : hadTrouble ? 'trouble' : 'aggregate'
        frame = await runStandup(trigger, frame, role, combinedPrompt, depFrameIds, steps)
      }
    }
  }

  // Boss, checkpoint final: independently verify the objective was actually met before
  // returning to the user; on dissatisfaction, resume the Planner rather than failing.
  for (let round = 0; round < MAX_FINAL_VERIFY_ROUNDS; round++) {
    const recent = await ledger.getRecent(root(), 30)
    const outcome = await runBoss(
      'final',
      `Objective: ${objective}\nAll planned steps report done. Recent ledger:\n${JSON.stringify(recent).slice(0, 4000)}`,
      emit,
    )
    if (outcome.action !== 'escalate') break
    emit({ type: 'boss_verdict', action: 'escalate', message: outcome.message, targetFrameId: null })
    await replan(`Boss final verification found gaps: ${outcome.message}`)
    while (!allStepsDone(graph, doneStepIds)) {
      const groups = readyGroups(graph, doneStepIds, new Set())
      if (groups.size === 0) break
      for (const steps of groups.values()) {
        const role = steps[0].role
        const combinedPrompt = steps.map(s => s.prompt).join('\n\n---\n\n')
        // Same seed as the main step-execution loop above — this is the SAME kind of
        // step-execution spawn (post-replan remaining work after a Boss final-
        // verification escalation), so an Implementer here must not hit the plan/act
        // gate either.
        const frame = await spawnFrame(
          { role, parentFrameId: plannerFrame?.result.frameId ?? null, assignment: buildRoleAssignment(role, combinedPrompt) },
          emit,
          undefined,
          role === 'implementer' ? combinedPrompt : undefined,
        )
        commitAgent = frame.agent
        for (const s of steps) { stepFrameId.set(s.id, frame.result.frameId); doneStepIds.add(s.id) }
      }
    }
  }

  const lastConclusions = [...stepFrameId.values()]
  const summaries = await Promise.all(lastConclusions.map(id => ledger.getConclusion(root(), id)))
  const doneSummary = summaries.filter((c): c is NonNullable<typeof c> => !!c).map(c => `- ${c.summary}`).join('\n')

  // Mirrors the baseline loop's own end-of-run auto-commit (agent.ts), opt-in via the
  // same config.autoCommit flag. Reuses whichever frame's Agent instance most recently
  // did real work purely as a vehicle — autoCommit() only needs git + a model to write
  // the message, it doesn't care which role's instance runs it. commitAgent is only
  // null here if NO frame ever spawned, which can't happen once we're past the
  // 'answer' early-return above.
  if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)

  return `Objective: ${objective}\n\n${doneSummary || plannerFrame?.result.summary || 'Done.'}`
}
