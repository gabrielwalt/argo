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
// TRIVIAL was merged into SIMPLE (this task) — there is no longer a mode that skips
// the Tester entirely; every Implementer that reports SUCCESS gets one. frames.ts's `ROLE_TOOLS.tester`/
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

import { promises as fs } from 'fs'
import path from 'path'
import { Agent } from './agent.js'
import { config } from './config.js'
import { SessionLogger } from './logger.js'
import type { AgentEvent, FrameSpawnRequest, FrameResult, FrameStatus, ModelOptions, Role, ToolName } from './types.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS, systemPromptFor, buildAssignment, capSummary, parseTaskStartVerdict, policyFor, TASK_START_TOOLS, type TaskStartVerdict } from './frames.js'
import * as ledger from './ledger.js'
// SCHEMA-CONSTRAINED CONTROL PLANE (config.schemaControlPlane, docs/research/
// 09-small-model-scaffolding.md §1/§7; see src/schema.ts for the full design rationale).
// Still used for the task-start checkpoint's ANSWER/SIMPLE/OBJECTIVE marker
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

// PERSISTENT BOSS MEMORY ACROSS MULTI-TURN CALLS (this task,
// /shared/argo-ui/MULTI-TURN.md). Every runDispatchLoop call spawns a completely
// FRESH Boss frame (spawnFrame, below) — the Boss has no conversation history of its
// own across turns, so a follow-up prompt like "now add tests for that" is classified
// with zero awareness of what "that" refers to. This is the harness-owned fix: a
// small, bounded record of recent turns, kept BOTH in this module's own memory (so a
// same-process second /chat sees it immediately) AND persisted to
// /workspace/.argo/turn-history.json (so it survives a container restart) — the same
// durability pattern ledger.ts already uses for its own state.json (append/rewrite a
// small JSON file under .argo/, not a database).
//
// Deliberately NOT the Boss's own raw conversation (that would mean keeping a whole
// Agent/history resident across runs, defeating "fresh Agent each turn" and quietly
// reintroducing unbounded per-turn memory growth) — just a short digest per turn,
// injected as plain text ahead of the LOCKED buildTaskStartAssignment prompt (see
// runBossTaskStart below and buildTurnHistoryBlock's own comment).
export interface TurnDigest {
  userMessage: string
  mode: string
  objective: string
  outcome: string
  timestamp: number
}

// Bounded — "last 10 turns", not a growing log. Exported (pure) so the trim
// behavior itself is directly testable without touching fs or this module's own
// mutable turnHistory binding.
export const TURN_HISTORY_MAX = 10

export function boundTurnHistory(history: TurnDigest[], max: number = TURN_HISTORY_MAX): TurnDigest[] {
  return history.length > max ? history.slice(history.length - max) : history
}

// The module-level store itself — same pattern as liveFrames/currentModel above:
// safe as plain module state only because server.ts's `isBusy` guard already
// prevents a second /chat from starting a new runDispatchLoop while one is in
// flight. Loaded fresh at the top of every runDispatchLoop (loadTurnHistory) so a
// restarted worker process picks the disk copy back up rather than starting empty.
let turnHistory: TurnDigest[] = []

function turnHistoryFile(rootDir: string): string {
  return path.join(rootDir, '.argo', 'turn-history.json')
}

async function loadTurnHistory(): Promise<void> {
  try {
    const raw = await fs.readFile(turnHistoryFile(root()), 'utf-8')
    const parsed = JSON.parse(raw)
    turnHistory = Array.isArray(parsed) ? boundTurnHistory(parsed as TurnDigest[]) : []
  } catch {
    // No file yet (first turn ever in this workspace) or unreadable/corrupt — fails
    // open to an empty history, exactly like ledger.ts's own readState()/readAll().
    turnHistory = []
  }
}

async function persistTurnHistory(): Promise<void> {
  try {
    const dir = path.join(root(), '.argo')
    await fs.mkdir(dir, { recursive: true })
    const file = turnHistoryFile(root())
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(turnHistory, null, 2))
    await fs.rename(tmp, file) // atomic swap, same convention as ledger.ts's writeState()
  } catch (err) {
    // Harness bookkeeping, never something that should be able to abort a run —
    // same fail-open stance as ledger.ts's ensureGitignored().
    console.error('[dispatch] persistTurnHistory failed (continuing):', err)
  }
}

function recordTurnDigest(digest: TurnDigest): void {
  turnHistory = boundTurnHistory([...turnHistory, digest])
}

// Set by runDispatchLoopBody right after the Boss classifies (runBossTaskStart),
// read by runDispatchLoop's own wrapper once the body settles (success, abort, or
// error) to build this turn's digest — runDispatchLoopBody only returns the final
// answer STRING, so this is how the wrapper learns which mode/objective produced
// it without threading an extra return value through every call site. Reset to
// null at the top of every runDispatchLoop, same lifecycle as currentVerbatimRequest.
let lastTaskStartVerdict: { mode: string; text: string } | null = null

// The exact text prepended to the Boss's task-start assignment, BEFORE the LOCKED
// buildTaskStartAssignment output (runBossTaskStart splices this in — that function
// itself is NOT locked, only buildTaskStartAssignment's own body is). Empty on the
// very first turn of a session (no history yet), so the prompt a fresh workspace
// sees is byte-identical to before this feature existed. Pure and exported so the
// exact injected text is directly testable without spawning a real frame.
export function buildTurnHistoryBlock(history: TurnDigest[]): string {
  if (history.length === 0) return ''
  const lines = history.map((d, i) => {
    const userExcerpt = d.userMessage.length > 80 ? `${d.userMessage.slice(0, 80)}…` : d.userMessage
    const outcomeExcerpt = d.outcome.length > 100 ? `${d.outcome.slice(0, 100)}…` : d.outcome
    return `${i + 1}. User: "${userExcerpt}" \u2192 ${d.mode.toUpperCase()} \u2192 ${outcomeExcerpt}`
  }).join('\n')
  return (
    'Previous turns in this session (most recent last):\n' +
    `${lines}\n\n` +
    'The user\u2019s new request follows. If it builds on or references previous work, incorporate that ' +
    'context into your objective so the Planner and Implementer understand the broader situation without ' +
    'needing to rediscover it.\n\n'
  )
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
// below passes its own task prompt here (the SIMPLE objective, or the
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
// (see frames.ts's TASK_START_TOOLS), so `mode` is now exactly the three values the
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
  'Your last answer didn\'t use one of the three required statuses. Call conclude again with ' +
  'status set to one of: ANSWER, SIMPLE, or OBJECTIVE — and your message as the answer or objective.'

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
// READ-ONLY statement, the three status keywords — is directly testable without
// spawning a real frame.
export function buildTaskStartAssignment(userMessage: string, verbatimRequestOn: boolean): string {
  return (
    'CHECKPOINT: task-start\n' +
    'Your task is to classify the following user request into exactly one of the three modes below:\n' +
    `<argo-user-prompt>\n${userMessage}\n</argo-user-prompt>\n\n` +
    (verbatimRequestOn
      ? 'Note: the user\'s request above is ALSO threaded verbatim to every downstream frame (Planner, ' +
        'Implementer, Tester) alongside whatever you write below — this checkpoint is no longer the only place ' +
        'it survives, so your mode line can be a concise digest rather than an exhaustive transcription; the ' +
        'original is preserved separately for anyone who needs the exact wording.\n\n'
      : '') +
    'Your task is done once you call `conclude` with the appropriate status and message:\n' +
    '- Status ANSWER, message: the complete final answer — use only if you already know the answer with ' +
    'certainty and no project changes are required.\n' +
    '- Status SIMPLE, message: a concrete, verifiable objective — Use for a well-scoped change that can be ' +
    'handled by a single Implementer and verified by a Tester agent. This covers everything from trivial ' +
    'fixes to single-function changes.\n' +
    'SIMPLE should be the default unless decomposition into independently verifiable sub-tasks materially improves correctness.\n' +
    '- Status OBJECTIVE, message: a concrete, verifiable objective — Use if the task requires deeper upfront ' +
    'analysis, involves several distinct pieces of work, or contains genuine ambiguity about the approach. A ' +
    'Planner agent will break it down.\n\n' +
    'Do not implement anything. The project is READ-ONLY: you may inspect files to understand the codebase, but you must not modify anything.\n' +
    'Ground your answer or objective whenever it depends on project-specific details, current facts, or anything you cannot know with certainty. Inspect the relevant files or use the web when necessary rather than relying on assumptions.\n' +
    'When reformulating the request as an objective, preserve every material requirement and constraint. Clarify wording, but do not silently narrow, broaden, or reinterpret the requested outcome.\n' +
    `You have a hard budget of ${TASK_START_MAX_ITERATIONS} iterations to call \`conclude\` with the classified status and message.`
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
    // MULTI-TURN MEMORY (this task): buildTurnHistoryBlock's text is prepended AHEAD
    // of the LOCKED buildTaskStartAssignment output, never inside it — that function's
    // own body is off-limits and stays byte-for-byte what it always was. Empty string
    // (first turn / no history yet) makes this a no-op concatenation.
    assignment: buildTurnHistoryBlock(turnHistory) + buildTaskStartAssignment(userMessage, config.verbatimRequest),
  }
  // TASK_START_TOOLS (frames.ts), not ROLE_TOOLS.boss — this checkpoint is read-only
  // classification, see that constant's comment for why and the incident that forced it.
  const { agent, result } = await spawnFrame(req, emit, TASK_START_TOOLS)

  // STRUCTURED CONCLUDE STATUS: the `conclude` tool now validates the Boss's status
  // against ['ANSWER', 'SIMPLE', 'OBJECTIVE', 'SUMMARY']. A frame that concluded has
  // an authoritative status — prefer it over regex parsing. Falls through to the
  // legacy path only when the frame never concluded (cap-hit).
  const concludeStatus = agent.getConcludeStatus()
  if (concludeStatus) {
    const modeMap: Record<string, TaskStartVerdict['mode']> = { ANSWER: 'answer', SIMPLE: 'simple', OBJECTIVE: 'objective' }
    const mode = modeMap[concludeStatus]
    if (mode) return { mode, text: result.rawSummary }
  }

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
// Used for the SIMPLE task-start fast path below, which hands the Boss's own
// classified objective straight to one Implementer. The OBJECTIVE path's per-task
// Implementer assignment is the Planner's OWN `conclude` answer, unwrapped — see
// buildNextTaskPrompt and runDispatchLoopBody below.
export function buildImplementerAssignment(objective: string, iteration = 1): string {
  return (
    `CHECKPOINT: iteration-${iteration}\n` +
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
    'CHECKPOINT: planning-start\n' +
    'Your task is to create an implementation plan for the following user-requested objective:\n' +
    `<argo-objective>\n${objective}\n</argo-objective>\n\n` +
    'IMPLEMENTATION SIZING\n' +
    'Plan around coherent implementation work, not around the wording or number of requirements in the objective.\n\n' +
    'First decide whether the entire objective can reasonably be completed and verified by one implementation ' +
    'agent within a single run. If so, prefer ONE implementation assignment. Do not decompose merely because ' +
    'the objective contains several requirements.\n\n' +
    'An implementation assignment may contain multiple closely related implementation steps — including setup, ' +
    'data structures, implementation, wiring, interaction, and tests — when they naturally belong to one ' +
    'coherent outcome.\n\n' +
    'Prefer grouping work that:\n' +
    '- operates on the same feature, behaviour, data flow, or closely related files;\n' +
    '- must be designed together for the result to make sense;\n' +
    '- would leave an incomplete or artificial intermediate state if separated;\n' +
    '- consists of setup immediately consumed by the implementation that follows;\n' +
    '- can be implemented and verified more efficiently by one agent retaining the relevant context.\n\n' +
    'Split work only when there is a meaningful implementation boundary, such as:\n' +
    '- the combined work is unlikely to fit reliably within one Implementer\'s run;\n' +
    '- distinct subsystems can be changed and verified largely independently;\n' +
    '- a risky or uncertain dependency should be resolved before later implementation can be planned reliably;\n' +
    '- an intermediate result is independently meaningful and provides a useful verified checkpoint;\n' +
    '- later work genuinely benefits from receiving the completed earlier result rather than being implemented together.\n\n' +
    'Strong signals to MERGE proposed assignments: one merely sets up the next, they operate on the same files ' +
    'or concepts, or neither produces a meaningful result on its own.\n\n' +
    'Strong signals to SPLIT: different subsystems with a clean contract between them, substantial independent ' +
    'verification, unresolved risk that affects the later design, or expected work beyond one Implementer\'s ' +
    'execution budget.\n\n' +
    'Every assignment boundary introduces context loss and coordination overhead. Create a boundary only when ' +
    'its benefit outweighs that cost.\n\n' +
    'There is NO preferred number of implementation assignments. One is correct when one is sufficient; several ' +
    'are correct only when the implementation has natural boundaries.\n\n' +
    'As a final check, examine every boundary between adjacent assignments: "If these were given to the same ' +
    'Implementer, would separating them make the implementation clearer, safer, or more reliable?" If not, merge them.\n\n' +
    'GRANULARITY EXAMPLE\n' +
    'For a request to create a canvas containing a shared-edge hexagonal grid whose cells contain draggable ' +
    'vector segments, do NOT mechanically produce separate assignments for: (1) page/canvas scaffolding, ' +
    '(2) hex-grid rendering, (3) vector rendering, (4) drag interaction. Those are tightly coupled implementation ' +
    'steps of one modest interactive feature and would create artificial intermediate states.\n\n' +
    'Prefer one assignment such as: "Implement the complete interactive hexagonal-vector canvas: establish the ' +
    'minimal page/canvas structure, render the shared-edge hex grid, represent zero-length vectors at cell ' +
    'centres, implement endpoint dragging, and verify the specified visual and interaction behaviour."\n\n' +
    'Only split such a task if inspection reveals substantial pre-existing architecture, uncertainty, or scope ' +
    'that makes one Implementer run unreasonable.\n\n' +
    'PLAN OUTPUT\n' +
    'Your task is complete once you call `conclude` with status PLAN and your ordered list of implementation ' +
    'assignments as the message. Each assignment should make dependencies and sequencing clear, and have a ' +
    'sufficiently specific and verifiable objective.\n\n' +
    'Prefer the smallest number of independently verifiable assignments that preserve coherent implementation boundaries. Do not split work merely to create more agents.\n\n' +
    'Do not implement anything. The project is READ-ONLY: your role is to plan and orchestrate the implementation, ' +
    'and nothing may be modified. Inspect the relevant project files as needed to understand the codebase and ' +
    'ground your plan. Use the web when necessary for current or external information rather than relying on ' +
    'assumptions.\n\n' +
    'You have a hard budget of 20 iterations to call `conclude` with status PLAN and the produced plan as the ' +
    'message. If the full implementation cannot yet be predicted reliably, plan the portions that can be ' +
    'determined with confidence and identify the decision point that should be reassessed after those parts are ' +
    'implemented and verified.'
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
// Builds the Boss's end-of-run conclusion assignment. The Boss sees what the Planner
// concluded with and each Implementer's own conclusion, then provides a final summary
// of the entire run — what was done, what was verified, and the overall outcome.
export function buildBossConclusionAssignment(
  objective: string,
  plannerConclusion: string,
  completedTasks: Array<{ prompt: string; conclusion: string; testerConclusion?: string }>,
): string {
  const taskSummaries = completedTasks
    .map((t, i) => `Task ${i + 1}: ${t.prompt}\nImplementer result: ${t.conclusion}\nTester result: ${t.testerConclusion || 'not tested'}`)
    .join('\n\n')
  return (
    'CHECKPOINT: run-conclusion\n' +
    'The run is complete. Your task is to provide a final summary of how the entire run went.\n\n' +
    `<argo-objective>\n${objective}\n</argo-objective>\n\n` +
    (plannerConclusion
      ? 'The Planner concluded with:\n' +
        `<argo-planner-conclusion>\n${plannerConclusion}\n</argo-planner-conclusion>\n\n`
      : '') +
    (taskSummaries
      ? `Implementation results:\n<argo-implementation-results>\n${taskSummaries}\n</argo-implementation-results>\n\n`
      : '') +
    'Treat Tester verdicts and concrete verification evidence as the basis for claims about correctness. ' +
    'Do not describe something as verified merely because an Implementer reported success.\n\n' +
    'Summarize concisely:\n' +
    '1. What was the objective and was it fully met?\n' +
    '2. What concrete changes were made?\n' +
    '3. What was verified and how?\n' +
    '4. Any caveats, remaining issues, or follow-up recommendations?\n\n' +
    'Call `conclude` with status SUMMARY and your summary as the message.'
  )
}

export function buildNextTaskPrompt(completedMessage: string | null, taskNumber: number): string {
  if (completedMessage === null) {
    return (
      `CHECKPOINT: task-${taskNumber}\n` +
      'According to your plan, create the next implementation assignment.\n\n' +
      'The implementation agent will NOT see the overall plan or any previous planner context. Its assignment must therefore be fully self-contained and include everything needed to understand and complete this implementation unit.\n\n' +
      'Call `conclude` with one of these statuses:\n' +
      '- IMPLEMENT: your message is the complete implementation assignment for the agent.\n' +
      '- SUCCESS: inspection shows the objective is already satisfied and no implementation work remains; your message is a final concluding statement.\n' +
      '- FAIL: the objective cannot be completed; your message explains why.\n\n' +
      'When using IMPLEMENT, the message should:\n' +
      '- Clearly state what must be implemented and define the expected outcome in concrete, verifiable terms.\n' +
      '- Where relevant, include a brief description of the surrounding context and overall goal.\n' +
      '- Include all context from the overall objective and plan that is relevant to this sub-task.\n' +
      '- State any dependencies on previously completed work without assuming the agent has seen earlier assignments.\n' +
      '- Identify relevant files, components, interfaces, constraints, or existing behaviour when already known.\n' +
      '- Clearly distinguish what is in scope from what should remain unchanged or be deferred.\n' +
      '- Include appropriate testing or validation expectations.\n' +
      '- Exclude context that does not affect this implementation step.\n' +
      '- Specify required behaviour and constraints without prescribing an implementation technique, unless the technique itself is required by the objective or project architecture.\n\n' +
      'Inspect relevant project files as needed to ground the assignment in the current codebase. Also inspect `AGENTS.md` and `MEMORY.md`, and include directly in the sub-objective any relevant instructions, conventions, architectural constraints, project facts, or prior decisions. But remember, the project remains READ-ONLY at this point: do not implement anything yourself.\n\n' +
      'You have a hard budget of 20 iterations to call `conclude` with the final self-contained implementation assignment. If the next planned step is no longer appropriate given the current project state, adapt the assignment while preserving the intent and sequencing of the overall plan.'
    )
  }
  return (
    `CHECKPOINT: task-${taskNumber}\n` +
    'The previous implementation agent concluded with:\n' +
    `<argo-implemented>\n${completedMessage}\n</argo-implemented>\n\n` +
    'Review this result against your plan and the current project state, then create the next self-contained implementation assignment.\n\n' +
    'Formulate it as a clear implementation assignment with a verifiable expected outcome. Include any relevant consequences of the completed work, dependencies, and instructions or context from `AGENTS.md` and `MEMORY.md` that the agent will need. Explicitly scope what to change, preserve, or defer, including what to test.\n\n' +
    'If the result changes or invalidates your original plan, adapt the next step accordingly.\n\n' +
    'Call `conclude` with one of these statuses:\n' +
    '- IMPLEMENT: your message is the complete implementation assignment for the agent.\n' +
    '- SUCCESS: inspection shows the objective is already satisfied and no implementation work remains; your message is a final concluding statement summarizing what was accomplished and verified.\n' +
    '- FAIL: the objective cannot be completed; your message explains why.\n\n' +
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
  return `${assignment}\n\nWhen you are done, call \`conclude\` with the appropriate status:\n`
    + '- Status SUCCESS, message: description of what you implemented and how you verified it.\n'
    + '- Status FAIL, message: description of what you tried, what failed, and why.'
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

// ── THE TESTER — harness-spawned, BLIND-THEN-COMPARE two-turn design.
// Turn 1 (buildTesterAssignment): the Tester investigates the repository blind —
// deliberately NOT given the Implementer's own report, so it forms an independent
// assessment without anchoring on what the Implementer claims to have done.
// Turn 2 (buildTesterComparePrompt): the same frame is RESUMED with the Implementer's
// report for comparison. The harness reads the conclude status from turn 2 only.
export function buildTesterAssignment(implementerAssignment: string, iteration = 1): string {
  return (
    `CHECKPOINT: iteration-${iteration}\n` +
    'ASSIGNMENT UNDER TEST\n' +
    'The following assignment was given to an implementation sub-agent:\n\n' +
    `<argo-implementation-assignment>\n${implementerAssignment}\n</argo-implementation-assignment>\n\n` +
    'INDEPENDENT ASSESSMENT\n' +
    'Independently determine what correct completion requires. Inspect the resulting repository and attempt to ' +
    'falsify it. You are deliberately not given the implementer\'s account of what it changed; do not infer ' +
    'correctness from intent or apparent implementation shape.\n\n' +
    'Also account for any relevant instructions, conventions, constraints, or prior decisions in `AGENTS.md` ' +
    'and `MEMORY.md`.\n\n' +
    'When you have formed your independent assessment, call `conclude` with status ASSESSMENT.\n\n' +
    'Your message must record:\n' +
    '- whether you found any apparent defects;\n' +
    '- the concrete evidence and reproductions obtained;\n' +
    '- what you tested;\n' +
    '- any important uncertainty remaining.\n\n' +
    'This is an independent assessment, not the final verdict. Do not use SUCCESS or FAIL until the comparison turn.'
  )
}

// Turn 2: handed the Implementer's report for comparison against the independent findings.
export function buildTesterComparePrompt(implementerConclusion: string): string {
  return (
    'IMPLEMENTER REPORT\n' +
    'Now compare your independent findings with the implementer\'s own account:\n\n' +
    `<argo-implemented>\n${implementerConclusion}\n</argo-implemented>\n\n` +
    'If this report reveals issues you missed, investigate them. If your findings contradict the report, ' +
    'the repository state is the ground truth.\n\n' +
    'Call `conclude` with your final verdict: status SUCCESS if no evidence-backed defect remains after your ' +
    'verification, or status FAIL ' +
    'with evidence (observed behaviour, expected behaviour, reproduction steps, smallest known defect scope) ' +
    'and a self-contained fix prompt.'
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
  // PERSISTENT BOSS MEMORY (this task): reload the durable turn-history store fresh
  // for every run (picks up a disk copy written by a prior process, e.g. after a
  // container restart) and reset this run's own captured verdict — see both
  // declarations above for the full lifecycle.
  await loadTurnHistory()
  lastTaskStartVerdict = null

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
  // MULTI-TURN UI FIX (this task, /shared/argo-ui/MULTI-TURN.md): the multi-agent
  // dispatch loop never used to emit a role:'user' message event of its own (only
  // agent.ts's baseline chat() did) — 'start' carries `query`, but nothing renders
  // that as a chat bubble on replay. The live path already shows the user's own
  // message optimistically (app.js's startRun, before this event even reaches the
  // browser), so this is a no-op there (handleEvent's 'message' case only acts on
  // role 'assistant'); on session replay (handleEventForSession) it is what makes a
  // PRIOR turn's prompt visible again after a reload — previously silently dropped.
  emit({ type: 'message', role: 'user', content: userMessage })
  emit({ type: 'start', model, query: userMessage, options: currentOptions ?? {} })

  // MULTI-TURN MEMORY (this task): a short digest of THIS turn, recorded once the
  // run settles (success, abort, or error) — see TurnDigest's own comment. Built
  // from `lastTaskStartVerdict` (set by runDispatchLoopBody right after the Boss
  // classifies; still null if classification itself never completed, e.g. the
  // TASK_START_CAP_FAILURE_MESSAGE path returns mode 'answer' same as any other
  // classified request, so this only stays null on a genuine unhandled error before
  // or during runBossTaskStart).
  const recordDigest = async (outcome: string) => {
    recordTurnDigest({
      userMessage: userMessage.slice(0, 200),
      mode: lastTaskStartVerdict?.mode ?? 'unknown',
      objective: (lastTaskStartVerdict?.text ?? '').slice(0, 200),
      outcome: outcome.slice(0, 300),
      timestamp: Date.now(),
    })
    await persistTurnHistory()
  }

  try {
    const finalAnswer = await runDispatchLoopBody(userMessage, emit)
    emit({ type: 'message', role: 'assistant', content: finalAnswer })
    emit({ type: 'done', content: finalAnswer })
    await logger.flush()
    await recordDigest(finalAnswer)
    return finalAnswer
  } catch (err) {
    if (err instanceof DispatchAborted) {
      // No 'message' event on a user-requested stop — mirrors agent.ts's own
      // stop path exactly (done only, no assistant chat bubble for "Stopped.").
      const stopped = 'Stopped.'
      emit({ type: 'done', content: stopped })
      await logger.flush()
      await recordDigest('stopped')
      return stopped
    }
    // H13: planning that could not produce a usable decision is a REPORTED failure,
    // not an "unexpected error" and emphatically not an invented task. Same event
    // shape as the generic branch below (error + no assistant bubble), with the
    // diagnosis as the returned text so the user/eval sees why nothing ran.
    if (err instanceof PlanningFailed) {
      emit({ type: 'error', message: err.message })
      await logger.flush()
      await recordDigest('failed')
      return err.message
    }
    const message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`
    emit({ type: 'error', message })
    await logger.flush()
    await recordDigest('failed')
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
  // The Tester's own final conclusion text (the compare-turn verdict), so callers can
  // show the Planner and Boss the verified pair rather than Implementer self-reports alone.
  testerConclusion?: string
}

// THE TESTER VALIDATION CYCLE. Spawns a Tester for a BLIND independent assessment,
// then immediately resumes that SAME frame with the Implementer's own report for
// comparison (buildTesterAssignment / buildTesterComparePrompt — "blind tester, two
// turns") — the harness reads the conclude status from the SECOND (compare) turn only.
// If that verdict finds a problem, RESUMES the SAME Implementer frame (context
// retained) with the fix assignment, then RESUMES the SAME Tester frame to re-test —
// up to MAX_TESTER_FIX_ATTEMPTS times — before giving up. Re-test rounds stay
// single-turn since the Tester already carries its independent mental model from the
// blind first turn. `implAgent`/`implFrameId` are the already-concluded Implementer's
// own Agent instance and frameId (its iteration-1, spawned by the caller). This
// function never spawns a fresh Implementer frame, only resumes the existing one.
async function runTesterValidation(
  parentFrameId: string | null,
  assignment: string,
  conclusion: string,
  emit: Emit,
  implAgent: Agent,
  implFrameId: string,
): Promise<TesterValidationResult> {
  let currentConclusion = conclusion
  let lastAgent: Agent = implAgent
  const fixAttempts: TesterFixAttempt[] = []

  let testerAgent: Agent | null = null
  let testerFrameId = ''
  let testerIteration = 1
  let implIteration = 2 // iteration-1 was the original implementation

  for (let attempt = 0; attempt <= MAX_TESTER_FIX_ATTEMPTS; attempt++) {
    let testerResultRaw: FrameResultRaw

    if (testerAgent === null) {
      // First test, turn 1: BLIND independent assessment (no Implementer report).
      const testerFrame = await spawnFrame(
        { role: 'tester', parentFrameId, assignment: buildTesterAssignment(assignment, testerIteration) },
        emit,
      )
      testerAgent = testerFrame.agent
      testerFrameId = testerFrame.result.frameId
      // First test, turn 2: hand the Implementer's report for comparison. This
      // turn's conclude is the cycle's actual verdict, not turn 1's preliminary.
      testerAgent.resetIterations()
      testerResultRaw = await resumeFrame(
        testerFrameId, testerAgent, buildTesterComparePrompt(currentConclusion),
      )
    } else {
      // Re-test, turn 1: blind — Tester knows a repair was made but does NOT see
      // the repair report yet, preventing anchoring on the Implementer's claims.
      testerAgent.resetIterations()
      await resumeFrame(
        testerFrameId,
        testerAgent,
        `CHECKPOINT: iteration-${testerIteration}\n`
          + 'A repair attempt has been made. Re-test the current repository against:\n'
          + '1. the original assignment;\n'
          + '2. the defects you previously identified;\n'
          + '3. relevant regressions or adjacent behaviour.\n\n'
          + 'You are deliberately not given the repair agent\'s account yet.\n\n'
          + 'Call `conclude` with status ASSESSMENT recording your independent re-test findings.',
      )
      // Re-test, turn 2: compare with the repair report, then final verdict.
      testerAgent.resetIterations()
      testerResultRaw = await resumeFrame(
        testerFrameId,
        testerAgent,
        buildTesterComparePrompt(currentConclusion),
      )
    }
    lastAgent = testerAgent

    if (testerAgent.hitIterationCap()) {
      return { passed: false, message: testerResultRaw.rawSummary, lastAgent, fixAttempts }
    }

    const testerStatus = testerAgent.getConcludeStatus()
    const testerResult: TesterResult = testerStatus === 'SUCCESS' || testerStatus === 'FAIL'
      ? { passed: testerStatus === 'SUCCESS', fixAssignment: testerStatus === 'FAIL' ? testerResultRaw.rawSummary : undefined }
      : parseTesterResult(testerResultRaw.rawSummary)
    if (testerResult.passed) {
      return { passed: true, message: currentConclusion, lastAgent, fixAttempts, testerConclusion: testerResultRaw.rawSummary }
    }
    if (attempt === MAX_TESTER_FIX_ATTEMPTS) {
      return { passed: false, message: testerResultRaw.rawSummary, lastAgent, fixAttempts }
    }

    const fixAssignment = testerResult.fixAssignment ?? testerResultRaw.rawSummary

    // RESUME the original Implementer for the fix (context retained, fresh budget).
    implAgent.resetIterations()
    const fixResult = await resumeFrame(
      implFrameId,
      implAgent,
      `CHECKPOINT: iteration-${implIteration}\n`
        + 'The Tester found issues with your implementation:\n\n'
        + `<argo-tester-feedback>\n${fixAssignment}\n</argo-tester-feedback>\n\n`
        + 'Fix the underlying issues described above while preserving all requirements of the original assignment '
        + 'and unrelated working behaviour.\n\n'
        + 'Treat the Tester\'s reproduction as evidence of the defect, not necessarily as the complete scope of the '
        + 'problem. Identify and correct the underlying cause rather than special-casing the demonstrated failure.\n\n'
        + 'Re-run the Tester\'s reproduction where possible and the relevant broader tests. Do not weaken, remove, '
        + 'or rewrite valid tests merely to obtain a passing result.\n\n'
        + 'When done, call `conclude` with the appropriate status:\n'
        + '- Status SUCCESS, message: description of what you fixed and how you verified it.\n'
        + '- Status FAIL, message: description of what you tried, what failed, and why.',
    )
    lastAgent = implAgent
    const capped = implAgent.hitIterationCap()
    fixAttempts.push({ assignment: fixAssignment, conclusion: fixResult.rawSummary, capped })
    if (capped) {
      return { passed: false, message: fixResult.rawSummary, lastAgent, fixAttempts }
    }

    currentConclusion = fixResult.rawSummary
    implIteration++
    testerIteration++
  }

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
  // Capture the initial plan's status for parity (always PLAN when concluded)
  const _initialPlanStatus = plannerAgent.getConcludeStatus()
  const plannerFrameId = plannerFrame.result.frameId
  // What the Planner is resumed with on the NEXT round — normally buildNextTaskPrompt's
  // generic "previous sub-agent concluded with..." wording, but overridden to
  // buildImplementerCapFollowUp when the Implementer that just ran hit its own hard
  // iteration cap (see the branch below). Starts as the first detail call (no
  // Implementer has run yet).
  let taskNumber = 1
  let plannerFollowUp: string = buildNextTaskPrompt(null, taskNumber)
  const completedTasks: Array<{ prompt: string; conclusion: string; testerConclusion?: string }> = []
  let done = false
  // The Planner's own concluding text — captured from the detailResult that trips
  // isPlannerDone below — so the end-of-run Boss conclusion frame can quote exactly
  // what the Planner itself said, not a re-derived summary.
  let plannerConclusionText = ''
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

    // STRUCTURED CONCLUDE STATUS: the Planner detail call now uses IMPLEMENT/SUCCESS/FAIL.
    const plannerStatus = plannerAgent.getConcludeStatus()

    // GIVE-UP / FAIL: checked BEFORE "done" — an explicit failure signal must
    // never be misread as quiet success.
    if (plannerStatus === 'FAIL' || (!plannerStatus && isPlannerGiveUp(detailResult.rawSummary))) {
      if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
      return `Objective: ${objective}\n\nThe Planner gave up: ${detailResult.rawSummary}\n\n`
        + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
    }

    // SUCCESS: objective fully met, no more tasks.
    if (plannerStatus === 'SUCCESS' || (!plannerStatus && isPlannerDone(detailResult.rawSummary))) {
      plannerConclusionText = detailResult.rawSummary
      done = true
      break
    }

    const nextAssignment = detailResult.rawSummary
    // What's actually given to the Implementer — the Planner's task text PLUS the
    // SUCCESS:/FAIL: sign-off convention (this task, "Testers are back"). nextAssignment
    // itself stays the plain task text, used for completedTasks/buildImplementerCapFollowUp
    // and as the Tester's own "{implementer prompt}" field.
    const implementerAssignment = appendImplementerResultFormat(`CHECKPOINT: iteration-1\n${nextAssignment}`)

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
    // Kept as a direct reference so the Tester's verdict can be attached below.
    const taskEntry: { prompt: string; conclusion: string; testerConclusion?: string } = {
      prompt: nextAssignment, conclusion: implFrame.result.rawSummary,
    }
    completedTasks.push(taskEntry)

    if (implFrame.agent.hitIterationCap()) {
      implementerCapHits++
      if (implementerCapHits > MAX_IMPLEMENTER_CAP_RETRIES) {
        if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
        return `Objective: ${objective}\n\nAn implementation sub-agent hit its iteration cap `
          + `${implementerCapHits} times on this objective, even after being asked to reframe the task `
          + 'narrower each time. Reporting this instead of continuing to loop.\n\n'
          + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
      }
      plannerFollowUp = buildImplementerCapFollowUp(nextAssignment, implFrame.result.rawSummary)
      continue
    }

    // Implementer's SUCCESS/FAIL decides whether the harness spawns a Tester.
    const implStatus = implFrame.agent.getConcludeStatus()
    const implResult: ImplementerResult = implStatus === 'SUCCESS' || implStatus === 'FAIL'
      ? { succeeded: implStatus === 'SUCCESS', message: implFrame.result.rawSummary }
      : parseImplementerResult(implFrame.result.rawSummary)
    if (!implResult.succeeded) {
      taskNumber++
      plannerFollowUp = buildNextTaskPrompt(implFrame.result.rawSummary, taskNumber)
      continue
    }

    // SUCCESS → the harness spawns a Tester to validate, with up to
    // MAX_TESTER_FIX_ATTEMPTS fix-and-retest rounds if it finds a problem. The
    // Implementer's own Agent/frameId are threaded through so a fix attempt RESUMES
    // it (retaining context) instead of spawning a fresh frame.
    const cycle = await runTesterValidation(
      plannerFrameId,
      nextAssignment,
      implFrame.result.rawSummary,
      emit,
      implFrame.agent,
      implFrame.result.frameId,
    )
    commitAgent = cycle.lastAgent
    taskEntry.testerConclusion = cycle.testerConclusion ?? cycle.message
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

    taskNumber++
    // Feed the Planner VERIFIED results — both the Implementer report and the Tester's
    // independent verdict — not the Implementer's self-report alone.
    const verifiedReport = cycle.passed
      ? 'The previous implementation task has passed adversarial verification.\n\n'
        + `Implementer report:\n${cycle.message}\n\n`
        + `Tester conclusion:\n${cycle.testerConclusion ?? '(not available)'}`
      : `Tester could not validate this task after ${MAX_TESTER_FIX_ATTEMPTS} fix attempt(s). ${cycle.message}`
    plannerFollowUp = buildNextTaskPrompt(verifiedReport, taskNumber)
  }

  if (!done) {
    if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
    return `Could not complete the objective within ${MAX_PLANNER_ROUNDS} planner rounds. Objective: ${objective}\n\n`
      + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
  }

  const doneSummary = completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')

  // Boss conclusion: spawn a Boss frame at the END of the run to summarize
  // the entire objective, what the Planner and Implementers concluded, and
  // the overall outcome. Uses the same TASK_START_TOOLS (read-only) and
  // TASK_START_HARD_CAP as the classification checkpoint.
  const conclusionReq: FrameSpawnRequest = {
    role: 'boss',
    parentFrameId: null,
    maxIterations: TASK_START_HARD_CAP,
    assignment: buildBossConclusionAssignment(objective, plannerConclusionText, completedTasks),
  }
  const conclusionFrame = await spawnFrame(conclusionReq, emit, TASK_START_TOOLS)
  commitAgent = conclusionFrame.agent

  // Mirrors the baseline loop's own end-of-run auto-commit (agent.ts), opt-in via the
  // same config.autoCommit flag. Reuses whichever frame's Agent instance most recently
  // did real work purely as a vehicle — autoCommit() only needs git + a model to write
  // the message, it doesn't care which role's instance runs it. commitAgent is only
  // null here if NO frame ever spawned, which can't happen once past the Planner spawn
  // above.
  if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)

  // Use the Boss's conclusion as the run's final answer, with a fallback
  // to the task summary if the Boss somehow fails to conclude.
  const bossConclusion = conclusionFrame.result.rawSummary
  return bossConclusion || `Objective: ${objective}\n\n${doneSummary || 'No implementation tasks were required.'}`
}

async function runDispatchLoopBody(userMessage: string, emit: Emit): Promise<string> {
  await ledger.ensureGitignored(root())

  const taskStart = await runBossTaskStart(userMessage, emit)
  lastTaskStartVerdict = { mode: taskStart.mode, text: taskStart.text }

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

  // SIMPLE: tries ONE well-scoped Implementer first — no Planner ceremony up front.
  // Also covers what used to be TRIVIAL (merged into SIMPLE). Implementer → Tester →
  // done. If Implementer hits cap → escalate to OBJECTIVE path.
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

    // STRUCTURED CONCLUDE STATUS for SIMPLE path — same as the OBJECTIVE loop.
    const implFrameStatus = frame.agent.getConcludeStatus()
    const implResult: ImplementerResult = implFrameStatus === 'SUCCESS' || implFrameStatus === 'FAIL'
      ? { succeeded: implFrameStatus === 'SUCCESS', message: frame.result.rawSummary }
      : parseImplementerResult(frame.result.rawSummary)
    if (!implResult.succeeded) {
      // FAIL, and SIMPLE has no Planner conversation to route the failure back to —
      // the Implementer's own explanation of what it tried and why it failed IS the
      // final answer, same as this branch's pre-Tester behavior for any failure text.
      if (config.autoCommit) await frame.agent.autoCommit(emit)
      return `Objective: ${objective}\n\n${frame.result.rawSummary}`
    }

    // SUCCESS → the harness spawns a Tester, with up to MAX_TESTER_FIX_ATTEMPTS
    // fix-and-retest rounds if it finds a problem — "same SUCCESS/FAIL parsing" as
    // the OBJECTIVE path, via the SAME shared runTesterValidation helper.
    const cycle = await runTesterValidation(
      null, implementerAssignment, frame.result.rawSummary, emit,
      frame.agent, frame.result.frameId,
    )

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
