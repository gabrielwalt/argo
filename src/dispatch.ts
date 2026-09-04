// THE ORCHESTRATOR (docs/subagents-plan.md, config.agents / ARGO_AGENTS). Harness code,
// not an LLM — a strictly sequential dispatch loop over the ledger. Every role (Planner,
// Implementer, Tester, Boss) is one scoped `Agent` instance (agent.ts) reused as the
// call-frame execution primitive; this module owns spawning them and driving the
// ITERATIVE PLANNER flow (2026-09 — supersedes both the original task-graph design and
// the interim "flatten it to a task list" pass): the Planner is called ONCE for a rough
// overall plan (plain text), then RESUMED repeatedly to detail exactly one Implementer
// task at a time, informed by everything completed so far, until it says DONE. There is
// no harness-owned plan OBJECT any more — no graph, no list, no step ids — the Planner's
// own plain-text answers ARE the plan, start to finish.
//
// HARD RULE: no two LLM calls ever run concurrently, for any reason — every `await`
// below fully resolves before the next one starts. One GPU, one resident model.
//
// v1 SIMPLIFICATIONS, noted explicitly (see docs/subagents-plan.md for the full design
// this is a first pass at):
//  - A frame's FrameResult is derived from its natural final answer + diffed files,
//    not a dedicated `conclude` tool call.
//  - The Tester's verdict is parsed from a text convention at the end of its final
//    answer (RELEASE/REDO — see frames.ts). The Boss's own NONE/INJECT/RESTART/
//    ESCALATE standup/final-verification convention is still defined in frames.ts but
//    has no live call site here any more (see "REMOVED" below) — task-start's separate
//    ANSWER/TRIVIAL/SIMPLE/OBJECTIVE convention is the only one this module still acts
//    on for the Boss.
//  - There is no separate "replan" step: adaptation is just what happens naturally on
//    the Planner's next detail call, which always sees the full completed-work record
//    (including any failures) and can act on it however it judges best.
//
// REMOVED (2026-09, "iterative planner"): the Boss standup/final-verification
// checkpoints — periodic health checks over a task-graph execution loop that no
// longer exists — were removed along with the loop they reviewed. This was NOT
// explicitly requested by name, but the new flow's own spec never calls them, and
// leaving a large block of guaranteed-dead code (runBoss/runStandup and their
// trigger constants) sitting here would contradict this project's own "every line
// must earn its place" governing principle. Flagged prominently in the report for
// the owner to veto if unwanted. parseBossVerdict/BossVerdict/extractBossVerdict
// remain defined and tested in frames.ts/schema.ts (pure, harmless to keep) should a
// future checkpoint want them back.

import { Agent } from './agent.js'
import { config } from './config.js'
import { SessionLogger } from './logger.js'
import type { AgentEvent, FrameSpawnRequest, FrameResult, FrameStatus, ModelOptions, Role, ToolName } from './types.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS, systemPromptFor, buildAssignment, capSummary, parseTesterVerdict, parseTaskStartVerdict, policyFor, TESTER_VERDICT_NUDGE, TASK_START_TOOLS, type TaskStartVerdict } from './frames.js'
import * as ledger from './ledger.js'
// SCHEMA-CONSTRAINED CONTROL PLANE (config.schemaControlPlane, docs/research/
// 09-small-model-scaffolding.md §1/§7; see src/schema.ts for the full design rationale).
// A single restatement call, tried after the cheap regex parse fails. NEVER used to
// invent a decision: both extractX functions here return null on any doubt, and every
// call site below falls through to the SAME hard-stop / conservative default the
// flag-off path already uses on that null. (extractTaskGraph was removed alongside
// schema.ts's whole task-graph extraction subsystem — see that module's header; there
// is no schema-constrained recovery path for the Planner's new TASK:/TEST:/DONE
// detail replies, only the plain regex parse + one format-retry nudge below.)
import { extractTaskStart, extractTesterVerdict } from './schema.js'

// The workspace root — config.workspacePath (NOT a literal '/workspace') because
// standalone dev mode runs this Node process directly on the HOST while `bash`
// reaches the project through a separate docker-exec'd container; only in-container
// worker mode has a real '/workspace' directory on ITS OWN filesystem. Read fresh
// each call, never cached, since standalone mode's runtime "mount a folder" flow
// mutates config.workspacePath directly (see server.ts's POST /api/workspace).
function root(): string {
  return config.workspacePath || '/workspace'
}

const MAX_TESTER_ROUNDS = 3

// Safety valve for the iterative Planner loop (2026-09) — bounds how many
// TASK:/TEST:/DONE detail calls one dispatch run will make before giving up, the
// same role MAX_REPLAN_ROUNDS used to play for the old graph-replan design. 30 is
// generous headroom above the 2-5 steps a typical objective decomposes into
// (docs/subagents-plan.md) while still bounding a Planner that never says DONE —
// if this is ever hit in practice, the real lever is almost certainly the Planner's
// own per-call iteration budget (ROLE_MAX_ITERATIONS.planner, frames.ts), not this
// count; raise that first before raising this.
const MAX_PLANNER_TASKS = 30

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
// re-wrapping needed. An UNTAGGED event (the objective/boss_verdict/replan narrative
// events below, emitted via the raw `emit` param) is the harness's own top-level
// narrative, not any one frame's turn.
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
// FrameSpawnRequest field: that type is shared with schema.ts's extraction request
// shapes, and a tool override is a harness decision about ONE hardcoded checkpoint,
// never something a model-produced reply should be able to request for itself.
//
// seedObjective (2026-09-05): pre-satisfies agent.ts's plan/act gate for an
// Implementer that already has a concrete objective before its first turn — see
// Agent.seedPlan's own comment for the full reasoning. Every Implementer spawn site
// below passes its own task prompt here (the TRIVIAL/SIMPLE objective, or the
// Planner's own per-task detail prompt); every other role omits it (Tester/Boss
// never hold write_file/edit_file, so the gate can never trip for them; the Planner
// never writes either).
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
// message — used for the Planner's per-task detail calls and the Tester's "redo"
// verdict. Writes a NEW conclusion entry for the same frameId (the ledger is
// append-only; the latest conclusion for a frameId is authoritative — same
// convention as episode eviction records).
// H14 (2026-09-04): the { resume: true } flag is load-bearing. Without it chat() cleared
// the frame's currentPlan, taskList, loopState, editedPaths, episodes, reconciliation
// state and iteration counter (agent.ts's per-run reset), so "same Agent instance, same
// history" was true of the transcript and false of every piece of run state derived from
// it — a resumed frame restarted at ITER 1 with no plan and no memory of what it had
// edited. Latent while REDO never fired; live the moment H13 makes REDO reachable.
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
// NOTE, deliberately not changed here: the dispatch loop does NOT replan/retry on
// 'failed'/'gave_up'/'killed' by itself any more — under the iterative Planner design
// the failing task's own conclusion simply becomes part of what the Planner sees on
// its NEXT detail call, and it decides what (if anything) to do about it. This makes
// cap-hits visible and stops them being credited; it is not a trigger for any
// harness-level retry mechanism.
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

// the Tester verifies a claim (an Implementer task's, or — 2026-09-03 — the Boss's own
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
//      `warning` event.
// It deliberately does NOT retry the Implementer itself on a missing verdict: a Tester
// failing to format a verdict is not evidence the implementation is wrong.
//
// `implPrompt` is the harness-authored (2026-09, "iterative planner") verification
// context — see buildTesterPromptFromImpl below — built by the HARNESS from the
// Implementer's own prompt plus its conclusion, never by the Planner: the Planner's
// job is to decide WHETHER a task needs testing (its TEST: yes/no answer), not to
// draft the Tester's own assignment text.
async function runTesterRounds(frame: SpawnedFrame, implPrompt: string, emit: Emit): Promise<SpawnedFrame> {
  let verdictNudge = ''
  // At most ONE extra Tester frame is spent on a missing verdict line, deliberately: the
  // Boss's own measured record is 16/22 markers present, 6/22 unusable, and if the Tester's
  // rate is similar then retrying every remaining round would triple the verification cost
  // of ~a quarter of all tasks to recover a formatting slip. One targeted retry, then say
  // "unverified" and move on — leaving the remaining round available for a real REDO cycle.
  let verdictRetries = 0
  for (let round = 0; round < MAX_TESTER_ROUNDS; round++) {
    const testerReq: FrameSpawnRequest = {
      role: 'tester',
      parentFrameId: frame.result.frameId,
      assignment: buildTesterPromptFromImpl(implPrompt, frame.result.summary) + verdictNudge,
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

// Raised when the Planner cannot produce a readable answer even after a targeted
// retry — either its INITIAL plan call (which cannot fail this way; there is no
// required format for the rough plan, so anything it says is accepted) or, in
// practice, a per-task DETAIL call that never produces a readable TASK:/DONE line
// (see detailNextTask below). Unwound by runDispatchLoop, which reports it to the
// user as a planning failure instead of inventing a task. The Planner is the one
// checkpoint whose OUTPUT IS THE PLAN — there is no conservative default available
// to it, so this is the one place in the pipeline that stops rather than degrades.
export class PlanningFailed extends Error {}

// Implementer/Tester assignments, wrapped the same way as the Boss task-start
// checkpoint's `<argo-user-prompt>` tags (buildTaskStartAssignment, above) — one
// prompt shape across every role instead of each spawn site below handing over a
// bare, untagged string. Pure and exported so the exact text is directly testable
// without spawning a real frame.
//
// NOTE (2026-09, "iterative planner"): buildImplementerAssignment is used ONLY for
// the TRIVIAL/SIMPLE task-start fast paths below, which hand the Boss's own
// classified objective straight to one Implementer. The OBJECTIVE path's
// per-task Implementer prompt is the Planner's OWN TASK: text, unwrapped — see
// buildNextTaskPrompt's format instruction ("a concrete, self-contained prompt for
// the Implementer agent") and runDispatchLoopBody below.
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

// The Tester's assignment for an iterative-Planner task (2026-09) — built by the
// HARNESS, never the Planner: the Planner only decides WHETHER a task needs testing
// (its TEST: yes/no answer), never drafts the Tester's own prompt. Reuses
// buildTesterAssignment's existing <argo-objective> wrapping convention so this is
// one more instance of the same tagging shape every role's assignment already uses,
// not a new one.
export function buildTesterPromptFromImpl(implPrompt: string, implConclusion: string): string {
  return buildTesterAssignment(`The Implementer was asked to: ${implPrompt}\nIt reported: ${implConclusion}`)
}

// The Planner's FIRST call: a rough overall plan in plain text, not a formal
// structure — no JSON, no step list, nothing this harness parses. The Planner is
// resumed repeatedly afterward (buildNextTaskPrompt below) to turn this into
// concrete, one-at-a-time Implementer tasks. `<argo-objective>` tags mirror the same
// unmistakable-boundary convention as the task-start checkpoint's
// `<argo-user-prompt>` tags (buildTaskStartAssignment, above) — pure and exported so
// this exact text is directly testable without spawning a real frame.
export function buildInitialPlannerPrompt(objective: string): string {
  return (
    `<argo-objective>\n${objective}\n</argo-objective>\n\n` +
    'The project is READ-ONLY for you. Create a rough overall plan for addressing this objective. Describe ' +
    'the pieces of work you see, in what order they should be done, and any considerations. This is a ' +
    'high-level plan — you will be asked to detail each task one at a time afterward.'
  )
}

// Resumes the Planner to detail exactly ONE task, informed by the plan it already
// gave and everything completed so far (including any failures — the Planner sees
// them here and decides what, if anything, to do about it; there is no separate
// harness-triggered replan). Pure and exported so the exact prompt text is directly
// testable without spawning a real frame.
export function buildNextTaskPrompt(
  overallPlan: string,
  completedTasks: ReadonlyArray<{ prompt: string; conclusion: string; tested: boolean }>,
): string {
  const completedBlock = completedTasks.length > 0
    ? '\n\nWork completed so far:\n' + completedTasks
        .map(t => `- Task: ${t.prompt}\n  Result: ${t.conclusion}\n  Tested: ${t.tested ? 'yes' : 'no'}`)
        .join('\n')
    : ''
  return (
    `Your overall plan:\n${overallPlan}${completedBlock}\n\n` +
    'Detail the NEXT implementing task. Produce a concrete, self-contained prompt for the Implementer agent ' +
    '(it will only see this prompt, not your plan). State whether this task needs a separate testing pass ' +
    'afterward.\n\n' +
    'End your answer with exactly one of:\n' +
    '- TASK: <the implementer prompt>\nTEST: yes|no\n' +
    '- DONE (if the objective is fully met and no more tasks are needed)'
  )
}

// The per-task detail reply's parsed shape. `parsed: false` (text/prompt then '')
// means neither TASK:/TEST: nor a bare DONE could be read — see detailNextTask's
// retry-then-PlanningFailed handling, the same "never fail open to an invented
// decision" discipline H13 established for the old task-graph parse.
export interface NextTaskResult {
  done: boolean
  prompt: string
  needsTesting: boolean
  parsed: boolean
}

// TASK:/TEST:/DONE — the per-iteration detail reply's ending convention (2026-09,
// "iterative planner"). TASK: is checked FIRST deliberately: it is the more
// specific, harder-to-produce-by-accident marker (it requires both a prompt AND a
// following TEST: yes/no line), so a stray use of the word "done" elsewhere in a
// TASK-bearing reply (e.g. "once this is done, the next task is...") cannot
// false-positive it into the terminal branch. DONE is only checked once no TASK:
// block was found.
export function parseNextTask(plannerAnswer: string): NextTaskResult {
  const taskMatch = /TASK\s*:\s*([\s\S]*?)\n\s*TEST\s*:\s*(yes|no)\b/i.exec(plannerAnswer)
  if (taskMatch) {
    const prompt = taskMatch[1].trim()
    if (prompt) {
      return { done: false, prompt, needsTesting: /^yes$/i.test(taskMatch[2]), parsed: true }
    }
  }
  if (/\bDONE\b/.test(plannerAnswer)) {
    return { done: true, prompt: '', needsTesting: false, parsed: true }
  }
  return { done: false, prompt: '', needsTesting: false, parsed: false }
}

// The format-retry nudge for a per-task detail reply — the same targeted-recovery
// shape as task-start's marker retry (the decision may well be there and only the
// marker line is missing/mangled), not a blind "try again".
const NEXT_TASK_RETRY_NUDGE =
  'Your last answer did not end with one of the required lines, so nothing could be dispatched from it. Reply ' +
  'again and end your answer with exactly one of: TASK: <the implementer prompt> followed by TEST: yes or ' +
  'TEST: no on the next line, or the single word DONE — nothing else after it.'

// Resumes the Planner frame to detail exactly one task, retrying ONCE with a
// format-only nudge before giving up. Returns the parsed result and the (possibly
// updated) frame; throws PlanningFailed rather than inventing a task or silently
// treating an unparseable reply as DONE. The retry is a resume of the SAME Planner
// frame, so it keeps the reasoning it already did (H14).
async function detailNextTask(
  plannerFrame: SpawnedFrame,
  overallPlan: string,
  completedTasks: ReadonlyArray<{ prompt: string; conclusion: string; tested: boolean }>,
  emit: Emit,
): Promise<{ next: NextTaskResult; frame: SpawnedFrame }> {
  const first = await resumeFrame(plannerFrame.result.frameId, plannerFrame.agent, buildNextTaskPrompt(overallPlan, completedTasks))
  let frame: SpawnedFrame = { agent: plannerFrame.agent, result: first }
  const next = parseNextTask(first.summary)
  if (next.parsed) return { next, frame }

  emit({
    type: 'warning',
    message: `Planner frame ${first.frameId} produced no readable TASK/DONE line `
      + `(frame ended: ${frame.agent.getLastRunOutcome()}) — asking once for the marker only. `
      + 'An unreadable detail reply is NOT treated as DONE.',
  })

  // A capped frame's "final answer" is agent.ts's own cap-hit notice, not a decision —
  // there is nothing in it to restate, and resuming it would just re-hit the same cap
  // (H14's own reasoning, reused here).
  if (frame.agent.hitIterationCap()) {
    throw new PlanningFailed(
      `Planning failed: the Planner hit its iteration cap while detailing the next task and never produced a `
      + `readable TASK/DONE line (frame ${first.frameId}).\nLast raw output:\n${first.summary}`,
    )
  }

  const retry = await resumeFrame(first.frameId, frame.agent, NEXT_TASK_RETRY_NUDGE)
  frame = { agent: frame.agent, result: retry }
  const second = parseNextTask(retry.summary)
  if (second.parsed) return { next: second, frame }

  throw new PlanningFailed(
    `Planning failed: the Planner produced no readable TASK/DONE line even after an explicit format retry `
    + `(frame ${first.frameId} ended: ${frame.agent.getLastRunOutcome()}).\nLast raw output:\n${retry.summary}`,
  )
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
  // of the run. Only UNTAGGED events (no __frameId) are logged HERE — a tagged
  // event already has its own home in its frame's own log; logging it again here
  // would just duplicate it.
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
    // H13: planning that could not produce a readable decision is a REPORTED
    // failure, not an "unexpected error" and emphatically not an invented task.
    // Same event shape as the generic branch below (error + no assistant bubble),
    // with the diagnosis as the returned text so the user/eval sees why nothing ran.
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

  // Whichever frame's Agent instance most recently did real work — reused purely as
  // the vehicle for the end-of-run autoCommit (it only needs git + a model, not a
  // specific role), so a run that never spawns a Planner still has one.
  let commitAgent: Agent | null = null

  // TRIVIAL/SIMPLE skip the Planner entirely — a single well-scoped Implementer task,
  // with a Tester pass added only for SIMPLE. There is no plan OBJECT built for this
  // any more (buildTaskStartGraph, removed) — just a direct spawn.
  if (taskStart.mode === 'trivial' || taskStart.mode === 'simple') {
    let frame = await spawnFrame(
      { role: 'implementer', parentFrameId: null, assignment: buildImplementerAssignment(objective) },
      emit,
      undefined,
      objective,
    )
    commitAgent = frame.agent
    if (taskStart.mode === 'simple') {
      frame = await runTesterRounds(frame, objective, emit)
    }
    if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
    return `Objective: ${objective}\n\n${frame.result.summary}`
  }

  // OBJECTIVE: the Planner drives an ITERATIVE loop (2026-09, "iterative planner" —
  // see the module header for the full design and why it replaces the earlier
  // task-graph/task-list designs). One initial call produces a rough overall plan
  // as plain text; each subsequent call resumes the SAME Planner frame to detail
  // exactly one Implementer task, informed by everything completed so far —
  // including any failures, which the Planner sees on its very next call and
  // decides how to handle. There is no separate "replan" step: the Planner IS the
  // loop.
  let plannerFrame = await spawnFrame(
    { role: 'planner', parentFrameId: null, assignment: buildInitialPlannerPrompt(objective) },
    emit,
  )
  commitAgent = plannerFrame.agent
  const overallPlan = plannerFrame.result.summary

  const completedTasks: Array<{ prompt: string; conclusion: string; tested: boolean }> = []
  let exhausted = true

  for (let i = 0; i < MAX_PLANNER_TASKS; i++) {
    const detailed = await detailNextTask(plannerFrame, overallPlan, completedTasks, emit)
    plannerFrame = detailed.frame
    commitAgent = plannerFrame.agent

    if (detailed.next.done) {
      exhausted = false
      break
    }

    // Seed the Implementer's plan with its own task prompt (2026-09-05's seedPlan
    // mechanism, unchanged) so it can write from its FIRST iteration, never forced
    // through update_plan just to restate what it was already told. The Planner's
    // TASK: text is used VERBATIM as the assignment — it is already written to be
    // "concrete, self-contained... it will only see this prompt, not your plan"
    // (buildNextTaskPrompt above), so wrapping it again would be redundant.
    let implFrame = await spawnFrame(
      { role: 'implementer', parentFrameId: plannerFrame.result.frameId, assignment: detailed.next.prompt },
      emit,
      undefined,
      detailed.next.prompt,
    )
    commitAgent = implFrame.agent

    let tested = false
    if (detailed.next.needsTesting) {
      implFrame = await runTesterRounds(implFrame, detailed.next.prompt, emit)
      tested = true
    }

    completedTasks.push({ prompt: detailed.next.prompt, conclusion: implFrame.result.summary, tested })
  }

  if (exhausted) {
    if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
    return `Could not complete the objective within ${MAX_PLANNER_TASKS} planner iterations. Objective: ${objective}\n\n`
      + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
  }

  const doneSummary = completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')

  // Mirrors the baseline loop's own end-of-run auto-commit (agent.ts), opt-in via the
  // same config.autoCommit flag. Reuses whichever frame's Agent instance most recently
  // did real work purely as a vehicle — autoCommit() only needs git + a model to write
  // the message, it doesn't care which role's instance runs it. commitAgent is only
  // null here if NO frame ever spawned, which can't happen once we're past the
  // 'answer' early-return above.
  if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)

  return `Objective: ${objective}\n\n${doneSummary || overallPlan}`
}
