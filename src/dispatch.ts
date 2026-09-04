// THE ORCHESTRATOR (docs/subagents-plan.md, config.agents / ARGO_AGENTS). Harness code,
// not an LLM — a strictly sequential dispatch loop over the ledger. Every role (Planner,
// Implementer, Boss) is one scoped `Agent` instance (agent.ts) reused as the call-frame
// execution primitive; this module owns spawning them and driving the ITERATIVE PLANNER
// flow.
//
// HARD RULE: no two LLM calls ever run concurrently, for any reason — every `await`
// below fully resolves before the next one starts. One GPU, one resident model.
//
// TESTER IS BACK — HARNESS-DRIVEN, NOT PLANNER-DRIVEN (2026-09, "Testers are back").
// A Tester briefly did not exist in an earlier rewrite of this module (the owner's own
// words at the time: "let's forget about the testing agent... assuming the implementing
// agent will test what it does if we instruct it to do so"), but that is no longer how
// this module works: the HARNESS itself (not the Planner, and not the Implementer's own
// say-so) spawns a real Tester frame (`runTesterValidation`, below) after every
// Implementer that reports SUCCESS, for both the OBJECTIVE/Planner path AND the SIMPLE
// fast path — up to MAX_TESTER_FIX_ATTEMPTS fix-and-retest rounds before the task is
// escalated back to the Planner (OBJECTIVE) or to the full Planner pipeline (SIMPLE).
// TRIVIAL is the one mode that still skips the Tester entirely (see its own comment
// below) — everything else gets one. frames.ts's `ROLE_TOOLS.tester`/
// `ROLE_MAX_ITERATIONS.tester`/`ROLE_POLICY.tester`/`ROLE_SYSTEM_SUFFIX.tester` and its
// `parseTesterVerdict`/`TESTER_VERDICT_NUDGE` stay defined there for the same reason as
// ever — Role (types.ts, off limits) enumerates `'tester'` so those Record<Role,...>
// tables need an entry regardless — but this module now spawns Testers directly via
// `buildTesterAssignment`/`parseTesterResult` (below), not through either of those.
//
// PLANNER DISPATCH, REWRITTEN (this task). The Planner is called ONCE for an overall
// plan (`buildInitialPlannerPrompt`, plain text, `conclude`d — no harness-owned plan
// object, no graph, no list, no step ids), then RESUMED repeatedly
// (`buildNextTaskPrompt`) to detail exactly one self-contained Implementer assignment
// at a time, each call informed by the previous Implementer's own conclusion. There is
// no `TASK:`/`TEST:` line convention any more: every frame (Planner included) now ends
// its turn by calling the `conclude` tool (frames.ts's ROLE_TOOLS, every role), and the
// Planner's `conclude` answer is used AS the next Implementer's assignment verbatim —
// unless it reads as "no further work needed", detected by `isPlannerDone` below (a
// natural-language heuristic, deliberately not a rigid marker — see that function's
// own comment for why and what was considered instead). `parseNextTask`,
// `NEXT_TASK_RETRY_NUDGE`, and `detailNextTask`'s format-retry machinery are gone
// along with the marker convention they existed to parse: a `conclude` answer is
// always usable text, there is nothing to reformat.
//
// v1 SIMPLIFICATIONS, still true and noted explicitly:
//  - A frame's FrameResult is derived from its `conclude` answer + diffed files.
//  - There is no separate "replan" step: adaptation is just what happens naturally on
//    the Planner's next detail call, which always sees the prior Implementer's own
//    conclusion (including any failure) and can act on it however it judges best.
//
// REMOVED PREVIOUSLY (2026-09, "iterative planner"): the Boss standup/final-
// verification checkpoints — periodic health checks over a task-graph execution loop
// that no longer exists. Still true; not revisited by this task.

import { Agent } from './agent.js'
import { config } from './config.js'
import { SessionLogger } from './logger.js'
import type { AgentEvent, FrameSpawnRequest, FrameResult, FrameStatus, ModelOptions, Role, ToolName } from './types.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS, systemPromptFor, buildAssignment, capSummary, parseTaskStartVerdict, policyFor, TASK_START_TOOLS, type TaskStartVerdict } from './frames.js'
import * as ledger from './ledger.js'
// SCHEMA-CONSTRAINED CONTROL PLANE (config.schemaControlPlane, docs/research/
// 09-small-model-scaffolding.md §1/§7; see src/schema.ts for the full design rationale).
// Still used for the task-start checkpoint's ANSWER/TRIVIAL/SIMPLE/OBJECTIVE marker
// recovery below. There is no schema-constrained recovery path for the Planner's
// `conclude` answers any more — that answer is always usable free text (there is no
// marker line to fail to produce), so nothing here calls extractTesterVerdict any more.
import { extractTaskStart } from './schema.js'

// The workspace root — config.workspacePath (NOT a literal '/workspace') because
// standalone dev mode runs this Node process directly on the HOST while `bash`
// reaches the project through a separate docker-exec'd container; only in-container
// worker mode has a real '/workspace' directory on ITS OWN filesystem. Read fresh
// each call, never cached, since standalone mode's runtime "mount a folder" flow
// mutates config.workspacePath directly (see server.ts's POST /api/workspace).
function root(): string {
  return config.workspacePath || '/workspace'
}

// Safety valve for the iterative Planner loop — bounds how many Implementer-then-
// resume-Planner rounds one dispatch run will make before giving up. Raised 30->50
// per this task's brief; this count bounds PLANNER rounds specifically, not the
// harness-spawned Tester validation cycle (runTesterValidation) that now runs inside
// each round after an Implementer SUCCESS — 50 is still comfortably above the 2-5
// steps a typical objective decomposes into (docs/subagents-plan.md) while bounding a
// Planner that never says it's done. If this is ever hit in practice, the real lever
// is almost certainly the Planner's own per-call iteration budget
// (ROLE_MAX_ITERATIONS.planner, frames.ts), not this count; raise that first before
// raising this.
const MAX_PLANNER_ROUNDS = 50

// Safety cap for repeated Implementer cap-hits on the SAME objective (this task,
// "iteration limits and progress nudges"): each cap-hit gets the Planner one chance to
// reframe the task narrower (buildImplementerCapFollowUp, below) rather than failing the
// run outright, but a Planner that keeps handing back tasks the Implementer can't finish
// even after reframing means the loop isn't converging — 2 lets it try twice more before
// the OBJECTIVE loop gives up and reports the failure to the user instead of burning the
// full MAX_PLANNER_ROUNDS budget on a task that is never going to land.
const MAX_IMPLEMENTER_CAP_RETRIES = 2

// Safety cap for Tester FAIL→fix-and-retest cycles on ONE task (this task, "Testers are
// back, harness-driven"). Per the brief: "Cap at 2 fix attempts per task before
// escalating to the Planner." Each attempt spawns a NEW Implementer with the Tester's
// own self-contained fix assignment, then re-runs the Tester — after this many attempts
// still fail validation, runTesterValidation gives up on the task and the caller
// (runObjectiveViaPlanner / the SIMPLE fast path) escalates instead of looping forever.
const MAX_TESTER_FIX_ATTEMPTS = 2

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
// logs is ~278KB, and a big multi-task objective (2-5 tasks is typical per
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

// BUG-1 FIX (control-flow strings truncated at 2000 chars before the harness parses
// them). FrameResult (types.ts) is off-limits to edit for this task, so the FULL,
// uncapped `finalAnswer` text is carried as a dispatch-local extension of it rather
// than a new field on that shared type. `summary` stays exactly what it always was —
// capSummary's 2000-char-capped text, kept for ledger storage/display where a cap is
// appropriate. `rawSummary` is the untruncated finalAnswer that every control-flow
// decision below (isPlannerDone/isPlannerGiveUp, the next Implementer assignment,
// parseImplementerResult/parseTesterResult, and every prompt built from any of their
// text) must read instead — a phrase a model puts at the END of a long message, or a
// fix assignment that runs past 2000 characters, must never be silently cut off
// before the harness gets to look at it. Still structurally a FrameResult (extends,
// doesn't replace), so it flows through every existing FrameResult-typed call
// unchanged; the ONE place that would leak the extra field somewhere it shouldn't
// (ledger.jsonl, which has no rawSummary column) strips it back out before writing —
// see toLedgerResult, used by both spawnFrame and resumeFrame below.
export interface FrameResultRaw extends FrameResult {
  rawSummary: string
}

function toLedgerResult(result: FrameResultRaw): FrameResult {
  return {
    frameId: result.frameId,
    status: result.status,
    summary: result.summary,
    filesTouched: result.filesTouched,
    filesWritten: result.filesWritten,
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(result.issues ? { issues: result.issues } : {}),
  }
}

// Exported so ctrlplane.test.ts can build a fixture (a fake Agent + a FrameResult) without
// re-declaring the shape.
export interface SpawnedFrame {
  agent: Agent
  result: FrameResultRaw
}

// Tags EVERY event this frame's Agent instance ever emits (thought/tool_call/
// tool_result/plan/done/...) with which role produced it and where it sits in the
// delegation tree — see types.ts's FrameTag. Bound once at construction, so a later
// resumeFrame() call on the same Agent instance automatically stays tagged too; no
// re-wrapping needed. An UNTAGGED event (the objective/done narrative events below,
// emitted via the raw `emit` param) is the harness's own top-level narrative, not any
// one frame's turn.
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
export function applyFramePolicy(agent: Agent, role: Role): void {
  agent.setPolicy(policyFor(role))
}

// toolOverride lets ONE call site (runBossTaskStart's classification frame) restrict
// tools below ROLE_TOOLS[role] without a parallel spawning mechanism — every other
// caller omits it and gets the per-role default exactly as before. Deliberately not a
// FrameSpawnRequest field: that type is shared with schema.ts's extraction request
// shapes, and a tool override is a harness decision about ONE hardcoded checkpoint,
// never something a model-produced reply should be able to request for itself.
//
// seedObjective (2026-09-05): pre-satisfies agent.ts's plan/act gate for an
// Implementer that already has a concrete objective before its first turn — see
// Agent.seedPlan's own comment for the full reasoning. Every Implementer spawn site
// below passes its own task prompt here (the TRIVIAL/SIMPLE objective, or the
// Planner's own per-task detail prompt); every other role omits it (the Planner
// never writes at all, so the gate can never trip for it).
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
  agent.setRole(req.role) // agent.ts's role-specific progress-check thresholds/messages
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
  await ledger.recordConclusion(root(), toLedgerResult(result)) // never persist the uncapped rawSummary
  return { agent, result }
}

// Resumes an EXISTING frame (same Agent instance, same history) with a follow-up
// message — used for the Planner's per-task detail calls. Writes a NEW conclusion
// entry for the same frameId (the ledger is append-only; the latest conclusion for a
// frameId is authoritative — same convention as episode eviction records).
// H14 (2026-09-04): the { resume: true } flag is load-bearing. Without it chat() cleared
// the frame's currentPlan, taskList, loopState, editedPaths, episodes, reconciliation
// state and iteration counter (agent.ts's per-run reset), so "same Agent instance, same
// history" was true of the transcript and false of every piece of run state derived from
// it — a resumed frame restarted at ITER 1 with no plan and no memory of what it had
// edited.
// LIVE REGISTRY + resumeFrame: no registry update needed here beyond activeFrameId.
// The frameId's entry already exists (spawnFrame put it there, and it is never
// deleted until the NEXT run's clear()), and it holds this exact same Agent
// instance by construction — so `live` (computed from map membership) and the
// entry's role/parentFrameId/startedAt all stay correct with no changes on this
// path.
async function resumeFrame(frameId: string, agent: Agent, followUp: string): Promise<FrameResultRaw> {
  checkAborted()
  activeFrameAgent = agent
  activeFrameId = frameId
  const finalAnswer = await agent.chat(followUp, { resume: true })
  activeFrameAgent = null
  activeFrameId = null
  checkAborted()
  const result = deriveFrameResult(frameId, finalAnswer, agent)
  await ledger.recordConclusion(root(), toLedgerResult(result)) // never persist the uncapped rawSummary
  return result
}

// H13 (2026-09-04) — THE FRAME BOUNDARY IS WHERE FAILURE WAS BEING DISCARDED.
// agent.ts turns a cap-hit into the string "Reached maximum iterations (N) without a
// final answer.", emits a terminal `error` event, and returns that string; this function
// used to see only "a string came back" and record status:'success'. Measured over the
// September corpus: 43 frames ended blank at their cap and were recorded success —
// nearly a tenth of all frames reported success having produced nothing, and the same
// run's ledger conclusion contradicted its own event stream ("10/10 + error" vs
// "success").
//
// The fix is to consult the frame's TERMINAL STATE (Agent.getLastRunOutcome(), set at each
// of chat()'s exit paths) rather than to pattern-match the returned text or compare
// iteration counts.
//
//   'cap'     → 'partial'. Not 'failed': the frame may well have done real work (files
//               touched are still reported below) — what it did NOT do is conclude, so it
//               must never read as success. 'partial' is an existing FrameStatus member.
//   'error'   → 'failed'. The returned string is an error message, not an answer.
//   'aborted' → 'killed'. Reachable only in narrow races: a stop normally unwinds through
//               checkAborted()/DispatchAborted before this runs.
//   'ok'      → the pre-existing text heuristic (gave_up vs success), unchanged.
//
// NOTE, deliberately not changed here: the dispatch loop does NOT replan/retry on
// 'failed'/'gave_up'/'killed' by itself any more — under the iterative Planner design
// the failing task's own conclusion simply becomes part of what the Planner sees on
// its NEXT detail call, and it decides what (if anything) to do about it. This makes
// cap-hits visible and stops them being credited; it is not a trigger for any
// harness-level retry mechanism.
// Exported for unit tests: spawnFrame itself needs a ledger and a live model, but the
// cap-hit → 'partial' mapping is the whole of H13 and must be provable without either.
export function deriveFrameResult(frameId: string, finalAnswer: string, agent: Agent): FrameResultRaw {
  const editedPaths = agent.getEditedPaths()
  const outcome = agent.getLastRunOutcome()
  const lower = finalAnswer.toLowerCase()
  const gaveUp = /\b(giv(?:e|es|en|ing) up|cannot complete|can['\u2019]t complete|unable to complete)\b/.test(lower)
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
    summary: capSummary(finalAnswer), // capped — ledger storage/display only, see FrameResultRaw
    rawSummary: finalAnswer, // uncapped — every control-flow consumer reads THIS, see FrameResultRaw
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
// documented floor).
//
// This is now the PROMPT's stated budget only (buildTaskStartAssignment below), not
// the actual enforced cap — see TASK_START_HARD_CAP just below for why the two were
// split (2026-09, "soft budget 10, hard cap 20"): telling the model "you have 10
// iterations" while the harness silently killed it at exactly 10 left no room for a
// classification that was genuinely one or two turns from landing to finish late
// instead of being cut off mid-thought.
export const TASK_START_MAX_ITERATIONS = 10

// The ACTUAL iteration cap passed to spawnFrame for the task-start checkpoint —
// deliberately larger than TASK_START_MAX_ITERATIONS (the number the PROMPT states).
// The prompt's stated budget is a target/pacing cue for the model, not a hard kill;
// giving the Boss real room to run past it (same spirit as ROLE_MAX_ITERATIONS'
// Planner comment on "ideal chunk size... NOT a hard kill", frames.ts) means a
// classification that overruns 10 by a few turns still gets to conclude normally
// instead of being force-ended exactly on the model's own stated deadline. If the
// Boss genuinely exhausts even THIS budget without classifying, runBossTaskStart
// below returns a plain failure message to the user rather than either the raw
// "Reached maximum iterations" cap-hit string or a silent fallback that treats the
// unclassified request as an OBJECTIVE anyway.
export const TASK_START_HARD_CAP = 20

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

// Returned to the USER (as the run's final answer, mode 'answer' — see
// runBossTaskStart below) when the Boss exhausts TASK_START_HARD_CAP without ever
// classifying the request. Deliberately not the raw agent.ts cap-hit string
// ("Reached maximum iterations (20) without a final answer.") and deliberately not
// a silent fall-through to mode 'objective' with the user's own message as the
// objective (the pre-existing fail-open default for an unparseable-but-NOT-capped
// reply, still used below for that separate case) — a stalled classification
// checkpoint has not decided anything, so treating it as either a raw internal
// string or a tacit "treat the whole message as an OBJECTIVE" is misleading in two
// different ways.
export const TASK_START_CAP_FAILURE_MESSAGE =
  'Could not classify the request within the iteration budget. Please try rephrasing or simplifying your request.'

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
// LOCKED — do not modify. This is the Boss prompt referenced by the task brief as
// off-limits; the SIMPLE mode's description below is unchanged text, even though
// SIMPLE no longer spawns a Tester (see this module's header) — "handled by an
// Implementer and a Tester agent" is now inaccurate to the actual pipeline, but this
// exact function body is explicitly out of scope for this rewrite.
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
    'Your task is done once you call `conclude` with exactly one of these formats:\n' +
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
    'Do not implement anything. The project is READ-ONLY: you may inspect files to understand the codebase, but you must not modify anything.\n' +
    'Ground your answer or objective whenever it depends on project-specific details, current facts, or anything you cannot know with certainty. Inspect the relevant files or use the web when necessary rather than relying on assumptions.\n' +
    `You have a hard budget of ${TASK_START_MAX_ITERATIONS} iterations to call \`conclude\` with the classified task, using exactly the required format.`
  )
}

async function runBossTaskStart(userMessage: string, emit: Emit): Promise<RoutedTaskStart> {
  const req: FrameSpawnRequest = {
    role: 'boss',
    parentFrameId: null,
    // The prompt still STATES TASK_START_MAX_ITERATIONS (10, buildTaskStartAssignment
    // below) as the Boss's target budget; the actual enforced cap is the larger
    // TASK_START_HARD_CAP (20) — see that constant's comment for why the two are
    // deliberately split.
    maxIterations: TASK_START_HARD_CAP,
    assignment: buildTaskStartAssignment(userMessage, config.verbatimRequest),
  }
  // TASK_START_TOOLS (frames.ts), not ROLE_TOOLS.boss — this checkpoint is read-only
  // classification, see that constant's comment for why and the incident that forced it.
  const { agent, result } = await spawnFrame(req, emit, TASK_START_TOOLS)
  let verdict = parseTaskStartVerdict(result.rawSummary) // BUG-1: read the uncapped text, not the ledger-capped summary

  // Retry once, only when the frame actually concluded on its own (a frame that stalled
  // at its cap has no budget to spend re-asking) and the model didn't already commit to a
  // mode — verdict.parsed says the marker WAS found, nothing to fix. hitIterationCap()
  // replaces the old `getIterationCount() < TASK_START_MAX_ITERATIONS` comparison, which
  // H14 breaks: the counter is now cumulative across a frame's turns, so a count at or
  // above the cap no longer implies a stall.
  if (!verdict.parsed && !agent.hitIterationCap()) {
    if (config.schemaControlPlane) {
      // Replaces the resumeFrame retry entirely (see the import comment at the
      // top of this file): a single bounded, schema-constrained restatement of the SAME
      // final answer, no extra frame turn, no tools, think:false. The ledger conclusion
      // is deliberately left untouched — nothing about the frame's own run changes,
      // only how the harness reads what it already said.
      const extracted = await extractTaskStart(effectiveModel(), result.rawSummary)
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
      const retryVerdict = parseTaskStartVerdict(retry.rawSummary)
      if (retryVerdict.parsed) verdict = retryVerdict
    }
  }

  // The Boss exhausted its (hard-capped) budget without ever classifying — distinct
  // from "concluded cleanly but the marker was missing/unrecoverable" just below.
  // Routed as mode 'answer' so runDispatchLoopBody returns this text directly as the
  // run's final answer, with no Planner/Implementer ever spawned on an unclassified
  // request (2026-09, "soft budget 10, hard cap 20" — see TASK_START_CAP_FAILURE_MESSAGE).
  if (!verdict.parsed && agent.hitIterationCap()) {
    return { mode: 'answer', text: TASK_START_CAP_FAILURE_MESSAGE }
  }

  // The harness-level 'preempted'/'preempted-incomplete' override that used to live
  // here (a before/after git-status diff, routing around a workspace change the Boss
  // made itself) is gone along with the Boss's ability to make one during this
  // checkpoint — see frames.ts's TASK_START_TOOLS. Fails open to 'objective' (the
  // safest, most-capable path) exactly as TaskStartVerdict's own parse does when
  // nothing was parseable (and the frame did NOT hit its cap — that case is handled
  // above).
  const base = verdict.parsed ? verdict : { mode: 'objective' as const, text: userMessage }
  return { mode: base.mode, text: base.text }
}

// Raised when the Planner cannot produce a usable answer even after a targeted retry
// of its INITIAL plan call, or when the Planner hits its own iteration cap on ANY
// call (initial plan or a per-task detail resume) without concluding at all. Unwound
// by runDispatchLoop, which reports it to the user as a planning failure instead of
// inventing a task. The Planner is the one checkpoint whose OUTPUT IS THE PLAN —
// there is no conservative default available to it, so this is the one place in the
// pipeline that stops rather than degrades.
//
// NOTE (this rewrite): under the `conclude`-based design there is no rigid TASK:/
// TEST:/DONE line to fail to produce — the Planner's `conclude` answer is always
// usable free text, read straight through isPlannerDone below. So the only way a
// detail call now reaches PlanningFailed is a genuine cap-hit (agent.hitIterationCap()),
// never an "unparseable reply" — the previous format-retry-then-fail path
// (detailNextTask/parseNextTask/NEXT_TASK_RETRY_NUDGE) is gone along with the
// convention it existed to parse.
export class PlanningFailed extends Error {}

// Implementer assignments, wrapped the same way as the Boss task-start checkpoint's
// `<argo-user-prompt>` tags (buildTaskStartAssignment, above) — one prompt shape
// across roles instead of each spawn site below handing over a bare, untagged
// string. Pure and exported so the exact text is directly testable without spawning
// a real frame.
//
// Used for the TRIVIAL/SIMPLE task-start fast paths below, which hand the Boss's own
// classified objective straight to one Implementer. The OBJECTIVE path's per-task
// Implementer assignment is the Planner's OWN `conclude` answer, unwrapped — see
// buildNextTaskPrompt and runDispatchLoopBody below.
export function buildImplementerAssignment(objective: string): string {
  return (
    'Your task is to implement the following objective:\n' +
    `<argo-objective>\n${objective}\n</argo-objective>`
  )
}

// The Planner's FIRST call — VERBATIM, per this task's brief; every word of this
// string reaches the model exactly as written here. No structural markup beyond the
// `<argo-objective>` tag (which mirrors the same unmistakable-boundary convention as
// the task-start checkpoint's `<argo-user-prompt>` tag, buildTaskStartAssignment
// above) — the Planner's deliverable is its own `conclude` answer (an ordered list
// of sub-tasks in plain text), not a harness-parsed structure. Pure and exported so
// this exact text is directly testable without spawning a real frame.
export function buildInitialPlannerPrompt(objective: string): string {
  return (
    'Your task is to create an implementation plan for the following user-requested objective:\n' +
    `<argo-objective>\n${objective}\n</argo-objective>\n\n` +
    'Your task is complete once you call `conclude` with an ordered list of concrete, actionable sub-tasks that can be assigned to implementation sub-agents. The plan should make dependencies and sequencing clear, and each sub-task should have a sufficiently specific and verifiable objective.\n\n' +
    'Do not implement anything. The project is READ-ONLY: your role is to plan and orchestrate the implementation, and nothing may be modified. Inspect the relevant project files as needed to understand the codebase and ground your plan. Use the web when necessary for current or external information rather than relying on assumptions.\n\n' +
    'You have a hard budget of 20 iterations to call `conclude` with the produced plan. If the full implementation cannot yet be predicted reliably, plan the portions that can be determined with confidence and explicitly account for a later re-planning step.'
  )
}

// Resumes the Planner frame to detail exactly ONE task. `completedMessage` is null
// for the very FIRST detail call (right after the initial plan, no Implementer has
// run yet) and the previous Implementer's own `conclude` answer for every call after
// that. Deliberately does NOT re-state the overall plan or any prior completed-task
// list in the prompt text itself — this is a RESUME of the same Planner frame/Agent
// instance (see resumeFrame above), so the plan and the full back-and-forth already
// live in its own conversation history; restating them here would just be redundant
// context competing with that history rather than a substitute for it. VERBATIM per
// this task's brief; pure and exported so this exact text is directly testable
// without spawning a real frame.
export function buildNextTaskPrompt(completedMessage: string | null): string {
  if (completedMessage === null) {
    return (
      'According to your plan, create the assignment for the next implementation sub-agent.\n\n' +
      'The implementation agent will NOT see the overall plan or any previous planner context. Its assignment must therefore be fully self-contained and include everything needed to understand and complete this specific sub-task.\n\n' +
      'Your task is complete once you call `conclude` with the complete sub-objective for that implementation agent.\n' +
      'It should:\n' +
      '- Clearly state what must be implemented and define the expected outcome in concrete, verifiable terms.\n' +
      '- Where relevant, include a brief description of the surrounding context and overall goal.\n' +
      '- Include all context from the overall objective and plan that is relevant to this sub-task.\n' +
      '- State any dependencies on previously completed work without assuming the agent has seen earlier assignments.\n' +
      '- Identify relevant files, components, interfaces, constraints, or existing behaviour when already known.\n' +
      '- Clearly distinguish what is in scope from what should remain unchanged or be deferred.\n' +
      '- Include appropriate testing or validation expectations.\n' +
      '- Exclude context that does not affect this implementation step.\n\n' +
      'Inspect relevant project files as needed to ground the assignment in the current codebase. Also inspect `AGENTS.md` and `MEMORY.md`, and include directly in the sub-objective any relevant instructions, conventions, architectural constraints, project facts, or prior decisions. But remember, the project remains READ-ONLY at this point: do not implement anything yourself.\n\n' +
      'You have a hard budget of 20 iterations to call `conclude` with the final self-contained sub-objective. If the next planned step is no longer appropriate given the current project state, adapt the sub-objective while preserving the intent and sequencing of the overall plan.'
    )
  }
  return (
    'The previous implementation sub-agent concluded with:\n' +
    `<argo-implemented>\n${completedMessage}\n</argo-implemented>\n\n` +
    'Review this result against your plan and the current project state, then create the self-contained assignment for the next implementation sub-agent.\n\n' +
    'As before, formulate it as a clear implementation task with a verifiable expected outcome. Include any relevant consequences of the completed work, dependencies, and instructions or context from `AGENTS.md` and `MEMORY.md` that the next agent will need. Explicitly scope what to change, preserve, or defer, including what to test.\n\n' +
    'If the result changes or invalidates your original plan, adapt the next step accordingly. If no further implementation work is required, conclude that the objective is complete.\n\n' +
    'The project remains READ-ONLY for you. You have a hard budget of 20 iterations to call `conclude`.'
  )
}

// IMPLEMENTER CAP-HIT FOLLOW-UP (this task, "iteration limits and progress nudges").
// Used INSTEAD OF buildNextTaskPrompt above for the one Planner resume immediately
// following an Implementer frame that hit its own hard iteration cap
// (agent.hitIterationCap(), see runDispatchLoopBody's OBJECTIVE loop) — the generic
// "previous sub-agent concluded with..." wording doesn't distinguish a real conclusion
// from a raw "Reached maximum iterations" cap-hit string, and feeding the Planner the
// SAME framing for both risks it reading a cap-hit as ordinary completed work. This is
// explicit instead: the assignment was too broad for one implementation pass, and the
// Planner is asked to reframe it narrower (or decide the objective is already met)
// rather than simply handed the same failed assignment again. Text is VERBATIM per
// this task's brief; pure and exported so it is directly testable without spawning a
// real frame.
export function buildImplementerCapFollowUp(assignment: string, lastStatus: string): string {
  return (
    'The previous implementation sub-agent was unable to complete its task within the iteration budget.\n' +
    `It was working on: ${assignment}\n` +
    `Its last status: ${lastStatus}\n\n` +
    'This task was too broad or complex for a single implementation pass. Please reframe it as a more ' +
    'specific, narrower task and provide a revised assignment, or determine that a different approach ' +
    'is needed. Call conclude with the revised assignment, or conclude that the objective is complete ' +
    'if the work done so far is sufficient.'
  )
}

// ── SUCCESS/FAIL — every Implementer's own verdict (this task, "Testers are back,
// harness-driven, not Planner-driven"). Appended to every Implementer's assignment
// (buildImplementerAssignment for TRIVIAL/SIMPLE; the Planner's own per-task text for
// OBJECTIVE) so the HARNESS — not the Planner — can decide whether to spawn a Tester
// (SUCCESS) or route the failure straight back to the Planner (FAIL) without needing
// the Planner to parse or restate that decision. Text is VERBATIM per this task's
// brief; kept separate from the "raw" assignment text (buildImplementerAssignment/
// the Planner's own text is never itself mutated) so callers still have the plain
// task description available for the Tester's "{implementer prompt}" field, which
// should describe the TASK, not this harness bookkeeping suffix.
export function appendImplementerResultFormat(assignment: string): string {
  return `${assignment}\n\nWhen you are done, call \`conclude\` with your result in one of these formats:\n`
    + '- `SUCCESS: {description of what you implemented and how you verified it}`\n'
    + '- `FAIL: {description of what you tried, what failed, and why}`'
}

export interface ImplementerResult {
  succeeded: boolean
  message: string
}

// Parses an Implementer's `conclude` text against the SUCCESS:/FAIL: convention
// appendImplementerResultFormat asks for. FAIL is checked first so a message that
// happens to mention "success" inside an otherwise-failing explanation is never
// misread. Per the brief: neither prefix present → treat as SUCCESS ("the model
// didn't follow the format but did conclude") — this is the one place in this
// pipeline that DELIBERATELY fails open, because the Tester exists precisely to
// catch a wrongly-claimed success; unlike the Tester's own parse below, there is a
// second real check downstream, so failing open here does not skip verification
// entirely the way it would for the Tester.
export function parseImplementerResult(text: string): ImplementerResult {
  const trimmed = text.trim()
  const fail = /^FAIL\s*:\s*([\s\S]+)/i.exec(trimmed)
  if (fail) return { succeeded: false, message: fail[1].trim() }
  const success = /^SUCCESS\s*:\s*([\s\S]+)/i.exec(trimmed)
  if (success) return { succeeded: true, message: success[1].trim() }
  return { succeeded: true, message: trimmed }
}

// ── THE TESTER — harness-spawned, not Planner-driven (this task). Prompt text is
// VERBATIM per this task's brief; `{implementer prompt}` is the TASK the Implementer
// was given (the raw assignment, WITHOUT appendImplementerResultFormat's bookkeeping
// suffix — the Tester needs to know what was asked for, not how the Implementer was
// told to format its own sign-off), and `{implementer's conclude message}` is exactly
// what the Implementer's own `conclude` call returned (its FULL text, including its
// own SUCCESS:/FAIL: prefix — the Tester should see precisely what was claimed).
export function buildTesterAssignment(implementerAssignment: string, implementerConclusion: string): string {
  return (
    'Your task is to critically validate the implementation of the following assignment:\n\n' +
    `<argo-implementation-assignment>\n${implementerAssignment}\n</argo-implementation-assignment>\n\n` +
    'The implementation sub-agent concluded with:\n\n' +
    `<argo-implemented>\n${implementerConclusion}\n</argo-implemented>\n\n` +
    'Do not assume the implementation is correct. Actively look for ways it may be incomplete, incorrect, ' +
    'fragile, inconsistent with the surrounding codebase, or technically compliant while still failing the ' +
    'underlying objective.\n\n' +
    'Inspect the implementation and relevant project files, and test or verify it as appropriate. Think beyond ' +
    'the obvious happy path: consider edge cases, regressions, integration points, hidden assumptions, ' +
    'unintended side effects, error handling, compatibility, and anything the implementer may have overlooked. ' +
    'Be deliberately critical and investigate suspicious details rather than accepting the implementer\'s ' +
    'conclusion at face value.\n\n' +
    'Also account for any relevant instructions, conventions, constraints, or prior decisions in `AGENTS.md` ' +
    'and `MEMORY.md`.\n\n' +
    'Your task is complete once you call `conclude` with exactly one of these outcomes:\n\n' +
    '- `SUCCESS` — if the implementation satisfies the assignment and you found no material issue that still ' +
    'needs fixing.\n' +
    '- `FAIL: {self-contained fix assignment}` — if anything material is wrong, incomplete, unverified, or ' +
    'requires further implementation. The text after `FAIL:` must be a clear, self-contained prompt for the ' +
    'implementation agent explaining what failed, what must be fixed, what should remain unchanged, and how ' +
    'the fix should be validated.\n\n' +
    'Do not modify the project yourself. Your role is to inspect, test, challenge, and report.\n\n' +
    'You have a hard budget of 20 iterations to call `conclude`.'
  )
}

export interface TesterResult {
  passed: boolean
  fixAssignment?: string // only meaningful when passed === false
}

// Parses a Tester's `conclude` text against the SUCCESS/FAIL: convention
// buildTesterAssignment asks for. Deliberately the OPPOSITE fail-open direction from
// parseImplementerResult above: an unparseable Tester reply (neither marker) is NOT
// treated as passed — this project's own history (frames.ts's parseTesterVerdict,
// the now-superseded RELEASE/REDO convention) already measured the real cost of that
// exact default once: "an unparseable TESTER reply became RELEASE, i.e. work accepted
// with no review." The Tester is the ONE check standing between a claimed SUCCESS and
// the Planner/user; a markerless or capped-out reply reads as "still failing" here,
// using whatever text the Tester DID produce as the best available fix assignment —
// worse than a real fix prompt, but never silently treated as approval.
export function parseTesterResult(text: string): TesterResult {
  const trimmed = text.trim()
  if (/^SUCCESS\b/i.test(trimmed)) return { passed: true }
  const fail = /^FAIL\s*:\s*([\s\S]+)/i.exec(trimmed)
  if (fail) return { passed: false, fixAssignment: fail[1].trim() }
  return { passed: false, fixAssignment: trimmed }
}

// Detects a Planner `conclude` answer that means "no further work needed" rather
// than a real Implementer assignment — the harness's only signal to stop the
// OBJECTIVE loop and treat the objective as complete.
//
// Why a heuristic over `conclude` text rather than a rigid marker (e.g. a required
// "DONE:"/"COMPLETE:" prefix): the brief's own instruction is to try natural
// language first, since a required prefix is one more formatting rule a small local
// model can drop under load — exactly the class of failure this project's H13/H14
// notes already catalogue for the OLDER TASK:/TEST:/DONE convention this replaces
// (a missing marker line silently read as either "approval" or "one more task",
// never as "unreadable"). A phrase-based heuristic degrades more gracefully here:
// worst case, a genuinely-finished Planner phrases its answer unusually and this
// misreads it as one more (harmless, if slightly redundant) assignment — never the
// other way around, an assignment misread as "done" and dropped, because the
// phrase list below only matches completion language, not the absence of a
// keyword. If real-world false negatives (a done-Planner not recognized) turn out
// to be common, the fix that best fits this codebase's own stated preference is a
// LOOSER phrase list here, not a required prefix — see this module's report to the
// cone (/shared/argo-ui/PLANNER-V2.md) for the concrete proposal to reconsider a
// "DONE:" prefix if this heuristic proves too narrow in practice.
//
// Two independent triggers, either is sufficient:
//   1. Completion phrasing — the answer explicitly says the objective is finished
//      or that no further implementation is needed, in any of several common
//      phrasings a model might use ("the objective is complete", "no further
//      implementation is needed", "all planned work is done", "fully addressed",
//      "nothing more to implement", ...).
//   2. Length + no imperative language — a real assignment is inherently a
//      multi-sentence, actionable brief (see buildNextTaskPrompt's own required
//      content list above: outcome, context, dependencies, files, scope, testing).
//      A SHORT reply that also contains none of the common implementation verbs
//      ("implement", "add", "fix", "create", ...) reads as a wrap-up note, not an
//      assignment — this is the "too short/doesn't look like a task" fallback the
//      brief calls for, checked ONLY when phrase (1) didn't already match.
const PLANNER_DONE_PHRASES: RegExp[] = [
  /\bobjective is (?:now |already )?(?:fully )?(?:complete|met|done|achieved|satisfied)\b/i,
  /\bno (?:further|more|additional) implementation(?: work)? (?:is )?(?:needed|required|remains)\b/i,
  /\bno (?:further|more|additional) (?:work|tasks?|steps?) (?:is |are )?(?:needed|required|remain(?:ing)?)\b/i,
  /\ball (?:planned )?(?:work|tasks?|sub-?tasks?) (?:is |are )?(?:complete|done|finished)\b/i,
  /\bnothing (?:more|further|else) (?:to|needs to|left to) (?:be )?(?:done|implement(?:ed)?)\b/i,
  /\bfully (?:implemented|addresses|addressed|completed)\b/i,
  /\bthe (?:objective|implementation) is (?:now )?complete\b/i,
]

// A reply shorter than this AND with no implementation verb reads as a wrap-up
// note rather than a real assignment — see the block comment above for why this is
// the second, weaker trigger rather than the primary signal. Chosen well below a
// realistic self-contained assignment: buildNextTaskPrompt's own required content
// (outcome, context, dependencies, files, scope, testing) makes a genuine sub-task
// prompt run to several sentences in practice; 160 chars is roughly one short
// sentence, comfortably below that.
const PLANNER_DONE_SHORT_CHARS = 160

const IMPLEMENTATION_VERB = /\b(implement|add|fix|create|write|update|change|modify|refactor|remove|delete|build|configure|wire|integrate|migrate|rename|extract|replace|test|verify)\w*\b/i

export function isPlannerDone(concludeText: string): boolean {
  const text = concludeText.trim()
  if (!text) return false // conclude itself rejects an empty answer — nothing to read as "done" here
  if (PLANNER_DONE_PHRASES.some(re => re.test(text))) return true
  if (text.length < PLANNER_DONE_SHORT_CHARS && !IMPLEMENTATION_VERB.test(text)) return true
  return false
}

// GIVE-UP (this task, "the Planner can give up"). A SEPARATE signal from isPlannerDone
// above — "the objective is met" and "I cannot complete this" are opposite outcomes and
// must never be conflated. Checked BEFORE isPlannerDone at every call site (the explicit
// failure signal takes priority — a give-up phrased ambiguously enough to also brush
// against a "done" phrase must still read as a failure, never quietly as success). Per
// the brief: `GIVE_UP:` as an explicit prefix, OR a reasonable natural-language
// heuristic ("give up" / "cannot complete") for a model that concludes without the
// prefix — same "try natural language first" reasoning as isPlannerDone's own phrase
// list above, and the same reason this is a heuristic rather than a rigid required
// marker.
const PLANNER_GIVE_UP_PHRASES: RegExp[] = [
  /^\s*GIVE_UP\s*:/i,
  /\bgiv(?:e|es|en|ing) up\b/i,
  /\bcannot complete\b/i,
  /\bcan['\u2019]t complete\b/i,
  /\bunable to complete (?:the|this) objective\b/i,
]

export function isPlannerGiveUp(concludeText: string): boolean {
  const text = concludeText.trim()
  if (!text) return false
  return PLANNER_GIVE_UP_PHRASES.some(re => re.test(text))
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

  // The dispatch run's own top-level narrative (start/objective/message/done) gets a
  // REAL persisted log — a SessionLogger exactly like agent.ts's baseline chat()
  // creates, under the SAME sessionId server.ts already tracks for the UI's session
  // dropdown/history (passed in via overrides.sessionId). Without this, the ONLY
  // record of "what did the harness decide" was the live SSE stream — gone the
  // moment the run ended, and every individual FRAME (each its own real
  // Agent.chat() call) already gets its own separate JSONL+MD, so "every session is
  // logged" was silently false for the one file that would show the overall shape
  // of the run. REVERSED (2026-09-04, see /shared/argo-ui/REPLAY-ARCHITECTURE.md):
  // the old comment above argued that a tagged event "already has its own home in
  // its frame's own log; logging it again here would just duplicate it" — true of
  // the bytes, false of the ORDER. Skipping tagged events here meant the run's log
  // stopped being a record of what the UI actually showed: every thought, tool call,
  // tool result and role card lived ONLY in the SSE stream and died with the page.
  // The UI is a pure function of one durable, ordered event stream per run — so
  // EVERY event, tagged or not, gets logged here, and every event's seq now comes
  // from this ONE top-level logger (the frame's own `seq` argument is ignored for
  // ordering purposes; the frame log keeps its own independent counter for its own
  // file). Per-frame JSONL logs stay — they remain the per-agent analytical copy
  // used by GET /context?frame=, and the run log now duplicating their contents is
  // an accepted, quantified cost, not an oversight.
  const logger = new SessionLogger(userMessage, model, currentOptions ?? {}, overrides?.sessionId)
  const emit: Emit = (event) => {
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
    // H13: planning that could not produce a usable decision is a REPORTED failure,
    // not an "unexpected error" and emphatically not an invented task. Same event
    // shape as the generic branch below (error + no assistant bubble), with the
    // diagnosis as the returned text so the user/eval sees why nothing ran.
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

// Builds the diagnostic PlanningFailed message for a Planner call (initial or a
// per-task resume) that hit its own iteration cap without ever calling `conclude`.
// Factored out because the OBJECTIVE loop below checks this after BOTH the initial
// plan call and every per-task resume — a capped frame's "final answer" is agent.ts's
// own cap-hit notice, not a decision, and there is nothing to salvage from it (H14's
// own reasoning: resuming a capped frame would just re-hit the same cap).
function plannerCapFailure(stage: string, frameId: string, rawOutput: string): PlanningFailed {
  return new PlanningFailed(
    `Planning failed: the Planner hit its iteration cap while ${stage} and never called \`conclude\` `
    + `(frame ${frameId}).\nLast raw output:\n${rawOutput}`,
  )
}

// THE FULL ITERATIVE PLANNER PIPELINE (this rewrite — see the module header for the
// overall design). Spawns a FRESH Planner frame with the INITIAL planning prompt
// (buildInitialPlannerPrompt — an ordered list of concrete sub-tasks, delivered as its
// `conclude` answer), then resumes that same Planner frame round by round to produce
// exactly one self-contained Implementer assignment at a time, informed by the previous
// Implementer's own conclusion, until the Planner reports the objective complete. There
// is no separate "replan" step: the Planner IS the loop. There IS a Tester round —
// the harness (not the Planner) spawns one after every Implementer SUCCESS
// (runTesterValidation, below) to validate the work before the Planner is resumed.
//
// TWO CALLERS (this task, "SIMPLE cap-hit escalation"): the OBJECTIVE task-start mode
// (its original, sole caller) and — new — the SIMPLE mode's ESCALATION path, when its
// one Implementer hits its own hard iteration cap. A SIMPLE task the Boss judged as
// "3-20 iterations" that instead ran the full 80 without concluding was measurably
// bigger than that judgment — rather than reporting a raw cap-hit string as failure,
// it gets the SAME decomposition machinery an OBJECTIVE task gets, starting completely
// fresh (a NEW Planner frame, the INITIAL prompt, not a resume of anything): the failed
// Implementer's own edits are still sitting in the workspace (git, not this function's
// business — whichever frame eventually calls autoCommit() below picks up ALL
// uncommitted changes, not just its own), and the Planner is expected to ground itself
// in that current project state (read_file/bash, same as any Planner) and plan forward
// from it rather than being told about the failure explicitly — the brief for this
// escalation calls for exactly the plain initial prompt, no special-cased wording.
// One EXTRA Implementer spawn made while validating a task (a Tester FAIL→fix
// round) — returned by runTesterValidation below so the CALLER (runObjectiveViaPlanner
// / the SIMPLE fast path) can fold it into its own completedTasks/cap-hit bookkeeping,
// which differs by caller (OBJECTIVE has a Planner to feed a cap-hit follow-up back
// to and a shared retry budget across the whole objective; SIMPLE has none of that and
// just escalates) — kept as data here rather than a decision made inside this helper.
interface TesterFixAttempt {
  assignment: string
  conclusion: string
  capped: boolean
}

interface TesterValidationResult {
  passed: boolean
  // The validated Implementer conclusion when passed; the Tester's own explanation
  // (or, if a fix-attempt Implementer capped, that Implementer's own cap-hit message)
  // when not passed.
  message: string
  lastAgent: Agent // for autoCommit — whichever frame most recently ran
  fixAttempts: TesterFixAttempt[]
}

// THE TESTER VALIDATION CYCLE (this task, "Testers are back, harness-driven, not
// Planner-driven"). Spawns a Tester to validate an Implementer's SUCCESS conclusion;
// if the Tester finds a problem, spawns a NEW Implementer with the Tester's own
// self-contained fix assignment and re-tests — up to MAX_TESTER_FIX_ATTEMPTS times —
// before giving up on this one task. Shared by BOTH the OBJECTIVE loop
// (parentFrameId = the Planner's frameId) and the SIMPLE fast path (parentFrameId =
// null) per the brief's "same SUCCESS/FAIL parsing" for both paths.
async function runTesterValidation(
  parentFrameId: string | null,
  assignment: string,
  conclusion: string,
  emit: Emit,
): Promise<TesterValidationResult> {
  let currentAssignment = assignment
  let currentConclusion = conclusion
  let lastAgent!: Agent
  const fixAttempts: TesterFixAttempt[] = []

  for (let attempt = 0; attempt <= MAX_TESTER_FIX_ATTEMPTS; attempt++) {
    const testerFrame = await spawnFrame(
      { role: 'tester', parentFrameId, assignment: buildTesterAssignment(currentAssignment, currentConclusion) },
      emit,
    )
    lastAgent = testerFrame.agent

    if (testerFrame.agent.hitIterationCap()) {
      // The Tester itself never concluded — its own cap-hit string is not a real
      // verdict to extract a fix assignment from. Read as "still failing" rather
      // than risk spawning a fix-Implementer with garbage as its assignment.
      return { passed: false, message: testerFrame.result.summary, lastAgent, fixAttempts }
    }

    const testerResult = parseTesterResult(testerFrame.result.summary)
    if (testerResult.passed) {
      return { passed: true, message: currentConclusion, lastAgent, fixAttempts }
    }
    if (attempt === MAX_TESTER_FIX_ATTEMPTS) {
      // Out of fix attempts — still failing, escalate.
      return { passed: false, message: testerFrame.result.summary, lastAgent, fixAttempts }
    }

    const fixAssignment = testerResult.fixAssignment ?? testerFrame.result.summary
    const fixFrame = await spawnFrame(
      { role: 'implementer', parentFrameId, assignment: appendImplementerResultFormat(fixAssignment) },
      emit,
      undefined,
      fixAssignment,
    )
    lastAgent = fixFrame.agent
    const capped = fixFrame.agent.hitIterationCap()
    fixAttempts.push({ assignment: fixAssignment, conclusion: fixFrame.result.summary, capped })
    if (capped) {
      return { passed: false, message: fixFrame.result.summary, lastAgent, fixAttempts }
    }

    currentAssignment = fixAssignment
    currentConclusion = fixFrame.result.summary
    // Loop again — re-test the fix. Deliberately NOT parsing the fix-Implementer's
    // own SUCCESS/FAIL here: the Tester is the one gate that decides whether a fix
    // actually landed, not the Implementer's own self-report (that's the entire
    // point of a Tester existing).
  }

  // Unreachable — the loop above always returns — but TypeScript needs a value here.
  return { passed: false, message: currentConclusion, lastAgent, fixAttempts }
}

async function runObjectiveViaPlanner(objective: string, emit: Emit): Promise<string> {
  // Whichever frame's Agent instance most recently did real work — reused purely as
  // the vehicle for the end-of-run autoCommit (it only needs git + a model, not a
  // specific role). Deliberately NOT seeded from a caller's own prior frame (e.g. a
  // SIMPLE mode's now-capped Implementer): autoCommit operates on the whole git
  // working tree (git status/add -A), not per-agent-instance state, so any earlier
  // uncommitted work is still picked up by whichever frame spawned by THIS function
  // ends up calling autoCommit — no need to thread the caller's agent through.
  let commitAgent: Agent | null = null

  const plannerFrame = await spawnFrame(
    { role: 'planner', parentFrameId: null, assignment: buildInitialPlannerPrompt(objective) },
    emit,
  )
  commitAgent = plannerFrame.agent
  if (plannerFrame.agent.hitIterationCap()) {
    throw plannerCapFailure('producing the overall plan', plannerFrame.result.frameId, plannerFrame.result.summary)
  }

  const plannerAgent = plannerFrame.agent
  const plannerFrameId = plannerFrame.result.frameId
  // What the Planner is resumed with on the NEXT round — normally buildNextTaskPrompt's
  // generic "previous sub-agent concluded with..." wording, but overridden to
  // buildImplementerCapFollowUp when the Implementer that just ran hit its own hard
  // iteration cap (see the branch below). Starts as the first detail call (no
  // Implementer has run yet).
  let plannerFollowUp: string = buildNextTaskPrompt(null)
  const completedTasks: Array<{ prompt: string; conclusion: string }> = []
  let done = false
  // Counts Implementer cap-hits across THIS objective's whole OBJECTIVE loop — see
  // MAX_IMPLEMENTER_CAP_RETRIES above. Shared across BOTH the initial per-task
  // Implementer and any Tester fix-attempt Implementers (runTesterValidation) — any
  // Implementer hitting its own hard cap is the same signal regardless of which
  // round of the task it happened on.
  let implementerCapHits = 0

  for (let round = 0; round < MAX_PLANNER_ROUNDS; round++) {
    // Each detail call gets its OWN fresh iteration budget (40, with progress checks
    // at 20/30) rather than the accumulating count resumeFrame's underlying
    // chat(..., { resume: true }) uses by default — the Planner's CONTEXT carries
    // over (same Agent instance, same history), but its iteration budget must not.
    // Scoped to just this one call site, not resumeFrame itself: the Boss task-start
    // marker-retry resume (this file, runBossTaskStart) and any future Tester REDO
    // resume still want the default accumulating behavior.
    plannerAgent.resetIterations()
    const detailResult = await resumeFrame(plannerFrameId, plannerAgent, plannerFollowUp)
    if (plannerAgent.hitIterationCap()) {
      throw plannerCapFailure('detailing the next task', plannerFrameId, detailResult.summary)
    }

    // GIVE-UP (this task) is checked BEFORE "done" — an explicit failure signal must
    // never be misread as quiet success. Ends the run immediately with a failure
    // message that includes the Planner's own explanation, per the brief.
    if (isPlannerGiveUp(detailResult.summary)) {
      if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
      return `Objective: ${objective}\n\nThe Planner gave up: ${detailResult.summary}\n\n`
        + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
    }

    if (isPlannerDone(detailResult.summary)) {
      done = true
      break
    }

    const nextAssignment = detailResult.summary
    // What's actually given to the Implementer — the Planner's task text PLUS the
    // SUCCESS:/FAIL: sign-off convention (this task, "Testers are back"). nextAssignment
    // itself stays the plain task text, used for completedTasks/buildImplementerCapFollowUp
    // and as the Tester's own "{implementer prompt}" field.
    const implementerAssignment = appendImplementerResultFormat(nextAssignment)

    // Implementer FAIL is NOT retried here — the failing task's own conclusion simply
    // becomes what the Planner sees on its next detail call (via plannerFollowUp
    // below), and the Planner decides what to do about it, exactly like the
    // pre-existing "no harness-level retry" discipline this module has followed since
    // H13. The ONE exception (iteration-cap): an Implementer that hits its own hard
    // iteration cap (agent.hitIterationCap()) gets resumed to the Planner with an
    // explicit "this task was too broad, reframe it narrower" message instead of the
    // generic wording, up to MAX_IMPLEMENTER_CAP_RETRIES times before this loop gives
    // up and reports the failure to the user rather than a raw cap-hit string or an
    // indefinite retry loop.
    const implFrame = await spawnFrame(
      { role: 'implementer', parentFrameId: plannerFrameId, assignment: implementerAssignment },
      emit,
      undefined,
      nextAssignment,
    )
    commitAgent = implFrame.agent
    completedTasks.push({ prompt: nextAssignment, conclusion: implFrame.result.summary })

    if (implFrame.agent.hitIterationCap()) {
      implementerCapHits++
      if (implementerCapHits > MAX_IMPLEMENTER_CAP_RETRIES) {
        if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
        return `Objective: ${objective}\n\nAn implementation sub-agent hit its iteration cap `
          + `${implementerCapHits} times on this objective, even after being asked to reframe the task `
          + 'narrower each time. Reporting this instead of continuing to loop.\n\n'
          + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
      }
      plannerFollowUp = buildImplementerCapFollowUp(nextAssignment, implFrame.result.summary)
      continue
    }

    // NEW (this task): the Implementer's own SUCCESS/FAIL verdict decides whether the
    // harness spawns a Tester at all — a FAIL skips the Tester entirely and goes
    // straight back to the Planner with the failure details, per the brief.
    const implResult = parseImplementerResult(implFrame.result.summary)
    if (!implResult.succeeded) {
      plannerFollowUp = buildNextTaskPrompt(implFrame.result.summary)
      continue
    }

    // SUCCESS → the harness spawns a Tester to validate, with up to
    // MAX_TESTER_FIX_ATTEMPTS fix-and-retest rounds if it finds a problem.
    const cycle = await runTesterValidation(plannerFrameId, nextAssignment, implFrame.result.summary, emit)
    commitAgent = cycle.lastAgent
    for (const fa of cycle.fixAttempts) completedTasks.push({ prompt: fa.assignment, conclusion: fa.conclusion })

    const cappedFix = cycle.fixAttempts.find(fa => fa.capped)
    if (cappedFix) {
      implementerCapHits++
      if (implementerCapHits > MAX_IMPLEMENTER_CAP_RETRIES) {
        if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
        return `Objective: ${objective}\n\nAn implementation sub-agent hit its iteration cap `
          + `${implementerCapHits} times on this objective, even after being asked to reframe the task `
          + 'narrower each time. Reporting this instead of continuing to loop.\n\n'
          + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
      }
      plannerFollowUp = buildImplementerCapFollowUp(cappedFix.assignment, cappedFix.conclusion)
      continue
    }

    plannerFollowUp = cycle.passed
      ? buildNextTaskPrompt(cycle.message)
      : buildNextTaskPrompt(
          `Tester could not validate this task after ${MAX_TESTER_FIX_ATTEMPTS} fix attempt(s). ${cycle.message}`,
        )
  }

  if (!done) {
    if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
    return `Could not complete the objective within ${MAX_PLANNER_ROUNDS} planner rounds. Objective: ${objective}\n\n`
      + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
  }

  const doneSummary = completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')

  // Mirrors the baseline loop's own end-of-run auto-commit (agent.ts), opt-in via the
  // same config.autoCommit flag. Reuses whichever frame's Agent instance most recently
  // did real work purely as a vehicle — autoCommit() only needs git + a model to write
  // the message, it doesn't care which role's instance runs it. commitAgent is only
  // null here if NO frame ever spawned, which can't happen once past the Planner spawn
  // above.
  if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)

  return `Objective: ${objective}\n\n${doneSummary || 'No implementation tasks were required.'}`
}

async function runDispatchLoopBody(userMessage: string, emit: Emit): Promise<string> {
  await ledger.ensureGitignored(root())

  const taskStart = await runBossTaskStart(userMessage, emit)

  // ANSWER: the Boss already knows, verified it himself — no Planner/Implementer
  // frame ever spawns. The whole point of this mode is zero further iteration.
  if (taskStart.mode === 'answer') {
    await ledger.setObjective(root(), taskStart.text)
    emit({ type: 'objective', text: taskStart.text })
    return taskStart.text
  }

  const objective = taskStart.text
  await ledger.setObjective(root(), objective)
  emit({ type: 'objective', text: objective })

  // TRIVIAL: skips the Planner AND the Tester entirely — a single well-scoped
  // Implementer, instructed to test its own work if the assignment calls for it (see
  // this module's header). Deliberately untouched by this task's Tester/escalation
  // machinery: a TRIVIAL classification means the Boss judged this 1-3 iterations, so
  // hitting the 80-iteration hard cap on it is a genuine failure to report as-is, not
  // something to escalate — whatever the Implementer concluded IS the final answer.
  // It still gets appendImplementerResultFormat's SUCCESS:/FAIL: instructions (every
  // Implementer's assignment does, per this task's brief), but that verdict is never
  // parsed here — it's just echoed back verbatim as part of the raw conclusion, same
  // as any other text the model might have concluded with before this task existed.
  if (taskStart.mode === 'trivial') {
    const frame = await spawnFrame(
      { role: 'implementer', parentFrameId: null, assignment: appendImplementerResultFormat(buildImplementerAssignment(objective)) },
      emit,
      undefined,
      objective,
    )
    if (config.autoCommit) await frame.agent.autoCommit(emit)
    return `Objective: ${objective}\n\n${frame.result.summary}`
  }

  // SIMPLE: tries ONE well-scoped Implementer first, exactly like TRIVIAL — no Planner
  // ceremony up front. Per the brief: "Implementer → Tester → done (same SUCCESS/FAIL
  // parsing). If Implementer hits cap → escalate to OBJECTIVE path."
  if (taskStart.mode === 'simple') {
    const implementerAssignment = buildImplementerAssignment(objective)
    const frame = await spawnFrame(
      { role: 'implementer', parentFrameId: null, assignment: appendImplementerResultFormat(implementerAssignment) },
      emit,
      undefined,
      objective,
    )
    // The task was measurably bigger than the Boss's "3-20 iterations" judgment —
    // escalate to the full OBJECTIVE pipeline (runObjectiveViaPlanner, the SAME
    // iterative Planner+Implementer+Tester loop an OBJECTIVE task gets) rather than
    // reporting a raw "Reached maximum iterations" string as failure.
    if (frame.agent.getLastRunOutcome() === 'cap') {
      return await runObjectiveViaPlanner(objective, emit)
    }

    const implResult = parseImplementerResult(frame.result.summary)
    if (!implResult.succeeded) {
      // FAIL, and SIMPLE has no Planner conversation to route the failure back to —
      // the Implementer's own explanation of what it tried and why it failed IS the
      // final answer, same as this branch's pre-Tester behavior for any failure text.
      if (config.autoCommit) await frame.agent.autoCommit(emit)
      return `Objective: ${objective}\n\n${frame.result.summary}`
    }

    // SUCCESS → the harness spawns a Tester, with up to MAX_TESTER_FIX_ATTEMPTS
    // fix-and-retest rounds if it finds a problem — "same SUCCESS/FAIL parsing" as
    // the OBJECTIVE path, via the SAME shared runTesterValidation helper.
    const cycle = await runTesterValidation(null, implementerAssignment, frame.result.summary, emit)

    // Either a fix-attempt Implementer hit its own hard cap, or the Tester still
    // found a problem after using up its fix attempts. SIMPLE has no ongoing Planner
    // conversation to escalate a failure INTO (unlike OBJECTIVE, where this becomes
    // the Planner's next detail-call context) — so, mirroring the cap-hit escalation
    // immediately above, hand the WHOLE objective to the full iterative pipeline
    // instead of reporting an unresolved failure as the final answer. Deliberately no
    // autoCommit call here first: runObjectiveViaPlanner does its own, and whatever
    // is already dirty in the workspace is picked up there regardless of which frame
    // last touched it (see that function's own commitAgent comment).
    if (cycle.fixAttempts.some(fa => fa.capped) || !cycle.passed) {
      return await runObjectiveViaPlanner(objective, emit)
    }

    if (config.autoCommit) await cycle.lastAgent.autoCommit(emit)
    return `Objective: ${objective}\n\n${cycle.message}`
  }

  // OBJECTIVE: the Planner drives the full iterative loop from the start
  // (docs/subagents-plan.md) — see runObjectiveViaPlanner above for the design.
  return await runObjectiveViaPlanner(objective, emit)
}
