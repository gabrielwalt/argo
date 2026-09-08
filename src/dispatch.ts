// THE ORCHESTRATOR. Harness code, not an LLM — a strictly sequential dispatch loop
// over the ledger. Every role (Planner, Implementer, Dispatcher) is one scoped
// `Agent` instance (agent.ts) reused as the call-frame execution primitive; this
// module owns spawning them and driving the ITERATIVE PLANNER flow.
//
// HARD RULE: no two LLM calls ever run concurrently, for any reason — every `await`
// below fully resolves before the next one starts. One GPU, one resident model.
//
// THE FLOW:
//   Dispatcher → SIMPLE     → Implementer → done
//   Dispatcher → OBJECTIVE  → Planner → Implementer (per task) → done
//
// PLANNER DISPATCH. The Planner is called ONCE for an overall plan
// (`buildInitialPlannerPrompt`, plain text, `conclude`d — no harness-owned plan
// object, no graph, no list, no step ids), then RESUMED repeatedly
// (`buildNextTaskPrompt`) to detail exactly one self-contained Implementer assignment
// at a time, each call informed by the previous Implementer's own conclusion. Every
// frame (Planner included) ends its turn by calling the `conclude` tool (frames.ts's
// ROLE_TOOLS, every role), and the Planner's `conclude` answer is used AS the next
// Implementer's assignment verbatim — unless it reads as "no further work needed",
// detected by `isPlannerDone` below (a natural-language heuristic, deliberately not a
// rigid marker — see that function's own comment for why).
//
// v1 SIMPLIFICATIONS, still true and noted explicitly:
//  - A frame's FrameResult is derived from its `conclude` answer + diffed files.
//  - There is no separate "replan" step: adaptation is just what happens naturally on
//    the Planner's next detail call, which always sees the prior Implementer's own
//    conclusion (including any failure) and can act on it however it judges best.

import { Agent } from './agent.js'
import { config } from './config.js'
import type { AgentEvent, FrameSpawnRequest, FrameResult, FrameStatus, ModelOptions, Role, ToolName } from './types.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS, ROLE_NAME, buildAssignment, capSummary, parseTaskStartVerdict, TASK_START_TOOLS, type TaskStartVerdict } from './frames.js'
import * as ledger from './ledger.js'

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
// resume-Planner rounds one dispatch run will make before giving up. 50 is
// comfortably above the 2-5 steps a typical objective decomposes into while bounding
// a Planner that never says it's done. If this is ever hit in practice, the real
// lever is almost certainly the Planner's own per-call iteration budget
// (ROLE_MAX_ITERATIONS.planner, frames.ts), not this count; raise that first before
// raising this.
const MAX_PLANNER_ROUNDS = 50

// Safety cap for repeated Implementer cap-hits on the SAME objective: each cap-hit
// gets the Planner one chance to reframe the task narrower
// (buildImplementerCapFollowUp, below) rather than failing the run outright, but a
// Planner that keeps handing back tasks the Implementer can't finish even after
// reframing means the loop isn't converging — 2 lets it try twice more before the
// OBJECTIVE loop gives up and reports the failure to the user instead of burning the
// full MAX_PLANNER_ROUNDS budget on a task that is never going to land.
const MAX_IMPLEMENTER_CAP_RETRIES = 2

// Model/options for the CURRENT dispatch run, set once at the top of runDispatchLoop
// and read by every spawnFrame call below. Module-level state is safe here only
// because server.ts's `isBusy` guard already prevents a second /chat request from
// starting a new runDispatchLoop while one is in flight — the same invariant that
// makes "no two LLM calls ever run concurrently" hold in the first place.
let currentModel: string | undefined
let currentOptions: ModelOptions | undefined

// PER-FRAME LEDGER REGISTRY COORDINATES (ledger.ts's registerFrame/sessions.json).
// currentSessionId identifies the whole session this run belongs to (server.ts's
// own session concept — falls back to a freshly minted id when the caller doesn't
// have one yet, e.g. a standalone/test invocation with no session tracking at
// all). currentRunIndex is which run WITHIN that session this is — 0 for a
// session's first runDispatchLoop call, incremented once per call for the SAME
// session id, so a multi-turn session's frames land in successive `runs` entries
// rather than all piling into run 0. Both captured once at the top of
// runDispatchLoop, same module-level-state rationale as currentModel/
// currentOptions above.
let currentSessionId = ''
let currentRunIndex = 0
// Tracks the last sessionId a run index was allocated for, so a NEW session starts
// back at run 0 instead of continuing whatever count a previous, different session
// left off at.
let lastRunIndexSessionId: string | null = null

// THE ORIGINAL USER QUERY (dispatch.ts's own runDispatchLoop's `userMessage` param),
// captured once at the top of runDispatchLoop and read by every spawnFrame call
// below — same module-level-state rationale as currentModel/currentOptions
// above (safe only because server.ts's `isBusy` guard prevents two concurrent
// runDispatchLoop calls). This is NOT the same text as a frame's own `assignment`
// (buildAssignment's output, e.g. a Dispatcher task-start checkpoint or an
// Implementer's CHECKPOINT: iteration-N prompt) — it is what the human actually
// typed, threaded down to each Agent purely so its TraceLogger (al-logger.ts) can
// title its trace file with the real request instead of the internal checkpoint
// text. Passed to each Agent via agent.setUserQuery(), called right after
// construction in spawnFrame below.
let currentUserQuery: string = ''

// PERSISTENT DISPATCHER FRAME — THE THREE-TIER CONTEXT MODEL'S TOP TIER. The
// Dispatcher keeps FULL context across the entire user conversation (every prompt
// in a session), unlike the Planner (fresh between user prompts, resumed within one)
// or the Implementer (fresh per planned task) — see docs/architecture.md's "Context
// Memory" section for the full three-tier model.
//
// Mechanically: ONE frameId per session, minted the first time this session's
// Dispatcher runs and reused for every subsequent run of the SAME session (see
// runDispatchLoop below, where currentSessionId is captured). Every run —
// including the first — passes this frameId to spawnFrame as
// FrameSpawnRequest.persistentFrameId (types.ts), which preloads a brand-new Agent
// instance's history from that frameId's ledger file (Agent.loadHistory) before
// calling chat() — see spawnFrame below for the mechanism. On the session's FIRST
// run there is no ledger file yet, so the preload reads back an empty array and
// loadHistory([]) is a harmless no-op — functionally identical to the old
// fresh-Agent-with-no-history behavior, just routed through the same one
// mechanism rather than a special case. Every run's own per-run state (loopState,
// iteration counters, editedPaths, ...) always starts fresh regardless — see
// agent.ts's chat() non-resume reset — only the CONTEXT carries forward. Every
// message either run pushes still lands in the SAME ledger file (agent.ts's
// pushCtx keys purely off frameId), so the ledger simply keeps growing across the
// whole session — there is no separate digest/summary to keep in sync with it any
// more.
let dispatcherFrameId: string | null = null
// The session this dispatcherFrameId belongs to — a NEW session (a different
// sessionId, e.g. after /reset) must mint a fresh dispatcherFrameId rather than
// resuming a previous session's accumulated history.
let dispatcherFrameSessionId: string | null = null

// Matches Agent's own constructor param exactly (agent.ts), so a tagged emit can be
// handed straight to `new Agent(...)` — the optional `seq` is what the SSE/JSONL replay
// dedup logic (server.ts, app.js) keys on.
type Emit = (e: AgentEvent, seq?: number) => void

// STOP BUTTON (server.ts's POST /stop). The shared module-level Agent's own .abort()
// only affects the ONE shared instance server.ts constructs at module scope — every
// frame here is a SEPARATE Agent instance, so that call alone does nothing for a
// dispatch run. Track whichever frame is currently mid-chat() and abort THAT one too;
// the dispatch loop itself also checks stopRequested between frames (a frame stopping
// mid-chat only ends that one frame's turn, not the whole run) and unwinds via
// DispatchAborted, mirroring Agent.chat()'s own "Stopped." return convention exactly.
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

// LIVE FRAME REGISTRY (context viewer backend). GET /context used to only read the
// shared module-level Agent, which /chat bypasses entirely — so the real per-frame
// contexts this Map records were never reachable from the API otherwise. A
// module-level Map, same pattern as stopRequested/activeFrameAgent above —
// deliberately not a class, this module already holds its run state as plain
// module-level bindings.
//
// Retention: cleared at the START of runDispatchLoop, not the end, so the LAST run's
// frames stay fully inspectable (server.ts's GET /frames, GET /context?frame=) right
// up until the next run begins — post-run inspection is the primary use of this
// feature, a user reading trace output while nothing is executing.
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
// capSummary's 2000-char-capped text, kept for display where a cap is appropriate.
// `rawSummary` is the untruncated finalAnswer that every control-flow decision below
// (isPlannerDone/isPlannerGiveUp, the next Implementer assignment,
// parseImplementerResult, and every prompt built from any of their text) must read
// instead — a phrase a model puts at the END of a long message, or a fix assignment
// that runs past 2000 characters, must never be silently cut off before the harness
// gets to look at it. Still structurally a FrameResult (extends, doesn't replace), so
// it flows through every existing FrameResult-typed call unchanged.
export interface FrameResultRaw extends FrameResult {
  rawSummary: string
}

// Exported so ctrlplane.test.ts can build a fixture (a fake Agent + a FrameResult) without
// re-declaring the shape.
export interface SpawnedFrame {
  agent: Agent
  result: FrameResultRaw
}

// Tags EVERY event this frame's Agent instance ever emits (thought/tool_call/
// tool_result/done/...) with which role produced it and where it sits in the
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

// toolOverride lets ONE call site (runDispatcherTaskStart's classification frame)
// restrict tools below ROLE_TOOLS[role] without a parallel spawning mechanism —
// every other caller omits it and gets the per-role default exactly as before.
// Deliberately not a FrameSpawnRequest field: a tool override is a harness decision
// about ONE hardcoded checkpoint, never something a model-produced reply should be
// able to request for itself.
async function spawnFrame(req: FrameSpawnRequest, emit: Emit, toolOverride?: ToolName[]): Promise<SpawnedFrame> {
  checkAborted()
  // PERSISTENT FRAME (req.persistentFrameId, see types.ts): reuse the given frameId
  // instead of minting a new one, and treat it as already registered in
  // sessions.json from a previous run — see the isPersistent branch below.
  const isPersistent = !!req.persistentFrameId
  const frameId = req.persistentFrameId ?? ledger.newId(req.role)

  const agent = new Agent(tagEmit(emit, frameId, req.role, req.parentFrameId), currentModel)
  agent.setUserQuery(currentUserQuery) // TraceLogger header title — see currentUserQuery's own comment above
  if (currentOptions) agent.setOptions(currentOptions)
  agent.setAllowedTools(toolOverride ?? ROLE_TOOLS[req.role])
  // agent.ts's chat() reads frames.ts's ROLE_IDENTITY/ROLE_INSTRUCTIONS directly off
  // this role tag to build the frame's opening [system]/[user]/[system] messages —
  // no separate setRoleInstructions() call needed any more.
  agent.setRole(req.role) // also drives role-specific progress-check thresholds/messages
  agent.setFrameId(frameId)
  agent.setMaxIterations(req.maxIterations ?? ROLE_MAX_ITERATIONS[req.role])
  agent.setSessionId(frameId) // isolates history/eviction-state files per frame

  // PERSISTENT FRAME PRELOAD: this is a BRAND-NEW Agent instance (so every per-run
  // counter/flag starts fresh, same as any other frame — see agent.ts's chat()
  // non-resume reset), but its CONTEXT should carry forward. Reading the existing
  // ledger file and loading it as plain {role, content} pairs (Agent.loadHistory)
  // gives the fresh Agent the prior conversation as READ-ONLY history without
  // reviving any of the old Agent instance's run-scoped state (loopState,
  // iteration counters, editedPaths, ...) — those all still start at their normal
  // zero/empty defaults for this run. A first-ever run for this frameId (no ledger
  // file yet) reads back an empty array, so loadHistory([]) is a harmless no-op —
  // byte-identical to the pre-existing fresh-Agent behavior.
  //
  // ledger.readFrame() ALREADY returns the eviction-aware, deduplicated view (last
  // entry per id wins — see that function's own comment): if a message was ever
  // evicted, this is the compact stub, not the full original that would otherwise
  // silently re-expand the context right back to the size eviction just fought to
  // bring down. That guarantee is exactly what a persistent-frame reload needs, but
  // it is not the whole story here — this preload ALSO filters to user messages and
  // tool_call-free assistant messages only, the SAME filter agent.ts's own
  // getChatHistory() applies (server.ts's /resume/:sessionId route now just
  // switches the ledger's currentSessionId pointer — this preload, run the next
  // time the Dispatcher frame for that session spawns, is what actually restores
  // its context). Two independent reasons, not just precedent: (1) a raw ledger file also holds
  // system messages (this frame's own opening identity/instructions, which the
  // fresh chat() call below re-pushes itself — replaying them here would duplicate
  // them) and tool/tool-result entries; (2) Ollama's chat API expects a strict
  // assistant/tool alternation, and an assistant message's `tool_calls` array is
  // never persisted to the ledger (ledger.ts's LedgerMessage has no such field) —
  // replaying a `tool_calls`-bearing assistant turn without its calls, followed by
  // orphaned tool-result entries with no matching call, would desync that
  // alternation. A plain text summary of "what was asked, what was answered" is
  // exactly what the Dispatcher needs across turns; it does not need its own past
  // tool-call mechanics replayed back into a fresh run. (Eviction/collapse markers
  // can now be written for role:'assistant' entries too, not just role:'tool' —
  // agent.ts's manageContext shortens both — but this filter's own tool-role/
  // tool_calls exclusion above already drops every candidate entry regardless;
  // the eviction-aware dedup in readFrame() is what protects every OTHER consumer
  // of the ledger — the `ledger` tool's own `messages` action, disk-frame
  // reconstruction — that doesn't apply this same narrower filter.)
  //
  // Since agent.ts's tool-call restructure (each tool call now gets its OWN
  // dedicated "<Tool> called:" assistant message — see formatToolCallContent —
  // rather than an empty-content assistant message carrying `tool_calls`), a
  // literal `role === 'assistant'` no longer implies "the model's own
  // conversational reply": a call-description turn is also role 'assistant' with
  // non-empty content, and reloading it here would replay tool-call mechanics
  // exactly as unwanted as before, just under a different shape. agent.ts's
  // pushCtx tags every such turn with uiMeta.toolName (LedgerMessage's own
  // `toolName` field) specifically so this filter can still tell the two apart —
  // excluded here the same way tool/tool-result entries always were.
  if (isPersistent) {
    const previous = await ledger.readFrame(root(), frameId)
    const chatOnly = previous.filter(m => m.role === 'user' || m.role === 'assistant')
      .filter(m => !!m.content && !m.toolName)
    agent.loadHistory(chatOnly.map(m => ({ role: m.role, content: m.content })))
  }

  // PER-FRAME LEDGER REGISTRY: record this frame's identity (role/parentage) in
  // sessions.json BEFORE it runs — same "visible while executing" rationale as
  // liveFrames.set below. currentSessionId/currentRunIndex are this run's own
  // registry coordinates, captured once at the top of runDispatchLoop. Skipped for
  // a persistent frame's SUBSEQUENT runs — it was already registered on the run
  // that first minted this frameId; re-registering here would just append a
  // duplicate entry to this run's frame list under the same frameId.
  if (!isPersistent) {
    await ledger.registerFrame(root(), currentSessionId, currentRunIndex, { frameId, role: req.role, parentFrameId: req.parentFrameId })
  }

  const assignment = await buildAssignment(root(), req)
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
  // PERSISTENT FRAME: append a CLEAN assistant entry with the frame's actual final
  // answer to its own ledger file — see recordCleanAnswer's own comment for why
  // this is necessary (agent.ts's pushCtx never records one on its own). Only when
  // the frame actually concluded ('ok') — a cap-hit/error/abort's "final answer" is
  // agent.ts's own harness-generated notice text (e.g. "Reached maximum iterations
  // (20) without a final answer."), not a real reply, and must never be replayed
  // back into a later run as if the Dispatcher had said it.
  if (isPersistent && agent.getLastRunOutcome() === 'ok') await recordCleanAnswer(frameId, finalAnswer)
  // PARENT VISIBILITY: every frame's conclusion is also appended to the persistent
  // Dispatcher's own ledger (never to a frame's OWN ledger — the conclude tool
  // call, and recordCleanAnswer above for a persistent frame, already put it
  // there) — see recordConclusionToParent's own comment for why. Skipped when
  // dispatcherFrameId is unset (should not happen once runDispatchLoop's very
  // first call has run — see dispatcherFrameId's own comment — but this frame
  // could theoretically spawn before that, e.g. under test) and when THIS frame
  // IS the Dispatcher (its own conclusion is already in its own ledger).
  if (dispatcherFrameId && frameId !== dispatcherFrameId) {
    await recordConclusionToParent(dispatcherFrameId, req.role, finalAnswer)
  }
  return { agent, result }
}

// THE MISSING HALF OF THE LEDGER. agent.ts's pushCtx faithfully records every
// message THIS Agent instance pushes onto its own in-memory history — but the
// `conclude` tool handler (agent.ts's chat()) never pushes the answer text itself
// as an assistant message; it only pushes the tool_call/tool_result pair for the
// `conclude` call (whose ledger `content` is the call's flattened label/"Concluded.",
// never the answer) and separately EMITS (not pushCtx's, so never ledger-recorded)
// a `type: 'message', role: 'assistant'` event carrying the real answer text — that
// event previously only reached the top-level SessionLogger JSONL (now removed
// entirely — logger.ts's surviving readLog/readLogEvents/listLogs only ever
// replay OLD pre-removal session logs, and never read a per-frame ledger file
// either way). For a normal,
// one-shot frame this is harmless: nothing ever reads that frame's ledger back into
// a later Agent. For a PERSISTENT frame it is not: spawnFrame's own preload (above)
// reads this exact ledger file back into the NEXT run's fresh Agent, so without this,
// every past turn's user question would reload with no matching answer at all.
//
// This is the harness-level fix: once a persistent frame's chat() call returns,
// append one ordinary assistant LedgerMessage recording its own final answer —
// exactly the shape spawnFrame's preload filter already expects (role 'assistant',
// non-empty content, no tool_calls to desync). Fire-and-forget is deliberately NOT
// used here (unlike agent.ts's own pushCtx) — a persistent frame's very next run
// depends on this write having landed, so it must be awaited.
async function recordCleanAnswer(frameId: string, answer: string): Promise<void> {
  if (!answer) return // e.g. "Stopped." on an aborted run — nothing worth replaying back
  try {
    await ledger.recordMessage(root(), frameId, { id: ledger.newId('msg'), role: 'assistant', content: answer })
  } catch (err) {
    // Harness bookkeeping, never something that should be able to abort a run —
    // same fail-open stance as every other ledger call site in this codebase.
    console.error('[dispatch] recordCleanAnswer failed (continuing):', err)
  }
}

// PARENT VISIBILITY: a sub-agent's conclusion never automatically reaches its
// PARENT's own context — the Dispatcher only sees its own persistent ledger,
// the Planner only sees its own; a spawned Planner/Implementer frame's answer
// otherwise only ever lives (a) in that frame's OWN ledger and (b) in whatever
// text the caller happens to thread through as the next prompt (spawnFrame's
// callers already do this for the IMMEDIATE next step — e.g. buildNextTaskPrompt
// feeding an Implementer's conclusion to the Planner's very next resume — but that
// is transient framing text, not a durable record in the parent's own ledger
// file). This appends a plain `role: 'tool'` entry (never 'assistant' — this is a
// report ABOUT a sub-agent, not the parent's own reply) to the PARENT frame's
// ledger, bracket-prefixed with the sub-agent's role so a later reload can tell
// who said it. `role: 'tool'` deliberately mirrors how agent.ts's own tool
// results are recorded — informational content the parent frame is told about,
// not something the parent produced or said.
//
// Fire-and-forget is deliberately NOT used here (unlike agent.ts's own pushCtx) —
// same stance as recordCleanAnswer just above: whether a persistent frame's NEXT
// resume sees this sub-agent's report depends on the write having actually
// landed first.
async function recordConclusionToParent(parentFrameId: string, role: Role, finalAnswer: string): Promise<void> {
  if (!finalAnswer) return // e.g. "Stopped." on an aborted run — nothing worth reporting up
  try {
    const roleName = ROLE_NAME[role] || role
    await ledger.recordMessage(root(), parentFrameId, {
      id: ledger.newId('msg'),
      role: 'tool',
      content: `[${roleName} concluded]\n${finalAnswer}`,
    })
  } catch (err) {
    // Harness bookkeeping, never something that should be able to abort a run —
    // same fail-open stance as every other ledger call site in this codebase.
    console.error('[dispatch] recordConclusionToParent failed (continuing):', err)
  }
}

// Resumes an EXISTING frame (same Agent instance, same history) with a follow-up
// message — used for the Planner's per-task detail calls.
// The { resume: true } flag is load-bearing. Without it chat() clears the frame's
// editedPaths and iteration counter (agent.ts's per-run reset), so "same Agent
// instance, same history" would be true of the transcript and false of every piece
// of run state derived from it — a resumed frame would restart at ITER 1 with no
// memory of what it had edited.
// NOTE on parent visibility: unlike spawnFrame (below), resumeFrame does NOT
// call recordConclusionToParent. Both of its current call sites resume a frame
// as its OWN caller — runDispatcherTaskStart's marker-retry resumes the
// Dispatcher frame with itself, and runObjectiveViaPlanner's per-round detail
// call resumes the Planner frame with itself — so every resumeFrame call today
// is a SELF-conclusion (the same frame progressing its own turn), never a
// child's conclusion a parent needs to be told about. "Don't record
// self-conclusions" (see recordConclusionToParent's own doc comment) applies to
// both, which is exactly why this function has no such call: adding one keyed
// on `frameId !== dispatcherFrameId` would have wrongly recorded every one of
// the Planner's own mid-loop detail answers into the Dispatcher's ledger, none
// of which are a sub-agent's conclusion — that visibility already happens
// explicitly, once per Implementer, via runObjectiveViaPlanner's own
// recordConclusionToParent(dispatcherFrameId, 'implementer', ...) call below.
async function resumeFrame(frameId: string, agent: Agent, followUp: string): Promise<FrameResultRaw> {
  checkAborted()
  activeFrameAgent = agent
  activeFrameId = frameId
  const finalAnswer = await agent.chat(followUp, { resume: true })
  activeFrameAgent = null
  activeFrameId = null
  checkAborted()
  const result = deriveFrameResult(frameId, finalAnswer, agent)
  // PERSISTENT FRAME: same gap, same fix, same 'ok'-only guard as spawnFrame's own
  // end-of-chat call — see recordCleanAnswer's comment. The only resumeFrame call
  // site that can ever land on the persistent Dispatcher frame is
  // runDispatcherTaskStart's own marker-retry resume (this frameId then equals
  // dispatcherFrameId); every other resumeFrame call site (the Planner's per-task
  // detail resumes) never runs on a persistent frame, so this check is a no-op for
  // them.
  if (frameId === dispatcherFrameId && agent.getLastRunOutcome() === 'ok') await recordCleanAnswer(frameId, finalAnswer)
  return result
}

// THE FRAME BOUNDARY IS WHERE FAILURE WAS BEING DISCARDED. agent.ts turns a cap-hit
// into the string "Reached maximum iterations (N) without a final answer.", emits a
// terminal `error` event, and returns that string; a naive caller would see only "a
// string came back" and record status:'success'.
//
// The fix is to consult the frame's TERMINAL STATE (Agent.getLastRunOutcome(), set at
// each of chat()'s exit paths) rather than to pattern-match the returned text or
// compare iteration counts.
//
//   'cap'     → 'partial'. Not 'failed': the frame may well have done real work (files
//               touched are still reported below) — what it did NOT do is conclude, so it
//               must never read as success. 'partial' is an existing FrameStatus member.
//   'error'   → 'failed'. The returned string is an error message, not an answer.
//   'aborted' → 'killed'. Reachable only in narrow races: a stop normally unwinds through
//               checkAborted()/DispatchAborted before this runs.
//   'ok'      → the pre-existing text heuristic (gave_up vs success), unchanged.
//
// NOTE: the dispatch loop does NOT replan/retry on 'failed'/'gave_up'/'killed' by
// itself — under the iterative Planner design the failing task's own conclusion simply
// becomes part of what the Planner sees on its NEXT detail call, and it decides what
// (if anything) to do about it. This makes cap-hits visible and stops them being
// credited; it is not a trigger for any harness-level retry mechanism.
// Exported for unit tests: spawnFrame itself needs a ledger and a live model, but the
// cap-hit → 'partial' mapping must be provable without either.
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

// Task-start's routed decision. `mode` is exactly the three values the model itself
// can express via buildTaskStartAssignment's ANSWER/SIMPLE/OBJECTIVE convention.
interface RoutedTaskStart {
  mode: TaskStartVerdict['mode']
  text: string
}

// Deliberately tiny — this is the STRUCTURAL enforcement of "the Dispatcher
// shouldn't do actual work unless it's really 1-2 iterations, else it should
// delegate" (an orchestrator that can act itself needs a real bound on how much,
// not just an instruction not to). Enough room to read a couple of files and
// classify; nowhere near enough to run a real implement-then-reverify cycle to
// completion. Set to 10, not lower — Agent.setMaxIterations clamps any smaller
// request UP to 10 regardless (its own documented floor).
//
// This is now the PROMPT's stated budget only (buildTaskStartAssignment below), not
// the actual enforced cap — see TASK_START_HARD_CAP just below for why the two were
// split ("soft budget 10, hard cap 20"): telling the model "you have 10 iterations"
// while the harness silently killed it at exactly 10 left no room for a
// classification that was genuinely one or two turns from landing to finish late
// instead of being cut off mid-thought.
export const TASK_START_MAX_ITERATIONS = 10

// The ACTUAL iteration cap passed to spawnFrame for the task-start checkpoint —
// deliberately larger than TASK_START_MAX_ITERATIONS (the number the PROMPT states).
// The prompt's stated budget is a target/pacing cue for the model, not a hard kill;
// giving the Dispatcher real room to run past it means a classification that
// overruns 10 by a few turns still gets to conclude normally instead of being
// force-ended exactly on the model's own stated deadline. If the Dispatcher
// genuinely exhausts even THIS budget without classifying, runDispatcherTaskStart
// below returns a plain failure message to the user rather than either the raw
// "Reached maximum iterations" cap-hit string or a silent fallback that treats the
// unclassified request as an OBJECTIVE anyway.
export const TASK_START_HARD_CAP = 20

// One-shot corrective retry: observed repeatedly in eval — on a genuinely trivial
// question the Dispatcher answers directly ("408") and skips the required marker
// line entirely, even though the checkpoint prompt explicitly demands one. A
// targeted recovery, not a blind retry: the diagnosis is exact (marker missing,
// answer otherwise already given), so the nudge asks for precisely that —
// reformat, don't re-derive.
const TASK_START_MARKER_RETRY_NUDGE =
  'Your last answer didn\'t use one of the three required statuses. Call conclude again with ' +
  'status set to one of: ANSWER, SIMPLE, or OBJECTIVE — and your message as the answer or objective.'

// Returned to the USER (as the run's final answer, mode 'answer' — see
// runDispatcherTaskStart below) when the Dispatcher exhausts TASK_START_HARD_CAP
// without ever classifying the request. Deliberately not the raw agent.ts cap-hit
// string ("Reached maximum iterations (20) without a final answer.") and
// deliberately not a silent fall-through to mode 'objective' with the user's own
// message as the objective (the pre-existing fail-open default for an
// unparseable-but-NOT-capped reply, still used below for that separate case) — a
// stalled classification checkpoint has not decided anything, so treating it as
// either a raw internal string or a tacit "treat the whole message as an
// OBJECTIVE" is misleading in two different ways.
export const TASK_START_CAP_FAILURE_MESSAGE =
  'Could not classify the request within the iteration budget. Please try rephrasing or simplifying your request.'

// Dispatcher, checkpoint task-start: a THREE-way router. Never re-fires within one
// dispatch — the objective is emitted exactly once per task by construction
// (runDispatchLoopBody emits `objective` at most once per branch).
// The task-start checkpoint's own assignment text (this IS the assignment passed to
// frames.ts's buildAssignment for the task-start Dispatcher specifically), and this
// frame's [user] message (message 2 of the frame's opening messages; see agent.ts's
// chat()). A bare passthrough of the raw user text — no tagging, no wrapping — since
// the classification rules themselves now live entirely in frames.ts's
// ROLE_INSTRUCTIONS.dispatcher as a separate [system] message (see that constant's
// own comment below).
// The classification rules themselves (the three status keywords, READ-ONLY
// framing, grounding/fidelity instructions) now live in frames.ts's
// ROLE_INSTRUCTIONS.dispatcher — sent as its OWN separate [system] message
// (message 3), never duplicated here. What's left here is the raw user text
// verbatim — prior-turn context now comes from the persistent Dispatcher frame's
// own preloaded ledger history (see dispatcherFrameId's comment above), not from
// any text prepended here.
export function buildTaskStartAssignment(userMessage: string): string {
  return userMessage
}

async function runDispatcherTaskStart(userMessage: string, emit: Emit): Promise<RoutedTaskStart> {
  const req: FrameSpawnRequest = {
    role: 'dispatcher',
    parentFrameId: null,
    // The prompt still STATES TASK_START_MAX_ITERATIONS (10, buildTaskStartAssignment
    // below) as the Dispatcher's target budget; the actual enforced cap is the
    // larger TASK_START_HARD_CAP (20) — see that constant's comment for why the two
    // are deliberately split.
    maxIterations: TASK_START_HARD_CAP,
    assignment: buildTaskStartAssignment(userMessage),
    // PERSISTENT DISPATCHER FRAME: see dispatcherFrameId's own comment above —
    // always set by this point (minted at the top of runDispatchLoop). spawnFrame
    // preloads this frame's full accumulated ledger history (empty on a session's
    // first run) into the fresh Agent it constructs, so the Dispatcher classifies
    // this turn with the entire session's prior context already in view, no
    // separate digest/summary needed.
    persistentFrameId: dispatcherFrameId ?? undefined,
  }
  // TASK_START_TOOLS (frames.ts), not ROLE_TOOLS.dispatcher — this checkpoint is
  // read-only classification, see that constant's comment for why and the incident
  // that forced it.
  const { agent, result } = await spawnFrame(req, emit, TASK_START_TOOLS)

  // STRUCTURED CONCLUDE STATUS: the `conclude` tool now validates the Dispatcher's
  // status against ['ANSWER', 'SIMPLE', 'OBJECTIVE', 'SUMMARY']. A frame that
  // concluded has an authoritative status — prefer it over regex parsing. Falls
  // through to the legacy path only when the frame never concluded (cap-hit).
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
  // replaces a plain iteration-count comparison, which breaks once the counter is
  // cumulative across a frame's turns.
  if (!verdict.parsed && !agent.hitIterationCap()) {
    const retry = await resumeFrame(result.frameId, agent, TASK_START_MARKER_RETRY_NUDGE)
    const retryVerdict = parseTaskStartVerdict(retry.rawSummary)
    if (retryVerdict.parsed) verdict = retryVerdict
  }

  // The Dispatcher exhausted its (hard-capped) budget without ever classifying —
  // distinct from "concluded cleanly but the marker was missing/unrecoverable" just
  // below. Routed as mode 'answer' so runDispatchLoopBody returns this text
  // directly as the run's final answer, with no Planner/Implementer ever spawned on
  // an unclassified request ("soft budget 10, hard cap 20" — see
  // TASK_START_CAP_FAILURE_MESSAGE).
  if (!verdict.parsed && agent.hitIterationCap()) {
    return { mode: 'answer', text: TASK_START_CAP_FAILURE_MESSAGE }
  }

  // Fails open to 'objective' (the safest, most-capable path) exactly as
  // TaskStartVerdict's own parse does when nothing was parseable (and the frame did
  // NOT hit its cap — that case is handled above).
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
// Under the `conclude`-based design there is no rigid TASK:/TEST:/DONE line to fail
// to produce — the Planner's `conclude` answer is always usable free text, read
// straight through isPlannerDone below. So the only way a detail call now reaches
// PlanningFailed is a genuine cap-hit (agent.hitIterationCap()), never an
// "unparseable reply".
export class PlanningFailed extends Error {}

// Implementer assignments, wrapped with the same `<argo-objective>` tagging
// convention used elsewhere in this module (buildInitialPlannerPrompt below) —
// one consistent, unmistakable-boundary prompt shape across roles instead of each
// spawn site below handing over a bare, untagged string. Pure and exported so the
// exact text is directly testable without spawning a real frame.
//
// Used for the SIMPLE task-start fast path below, which hands the Dispatcher's own
// classified objective straight to one Implementer. The OBJECTIVE path's per-task
// Implementer assignment is the Planner's OWN `conclude` answer, unwrapped — see
// buildNextTaskPrompt and runDispatchLoopBody below.
export function buildImplementerAssignment(objective: string): string {
  return objective
}

// The Planner's FIRST call — VERBATIM; every word of this string reaches the model
// exactly as written here. No structural markup beyond the `<argo-objective>` tag
// (the same unmistakable-boundary convention buildImplementerAssignment above
// uses) — the Planner's deliverable is its own `conclude` answer (an ordered list
// of sub-tasks in plain text), not a harness-parsed structure. Pure and exported
// so this exact text is directly testable without spawning a real frame.
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

// Builds the Dispatcher's end-of-run conclusion assignment. The Dispatcher sees what
// the Planner concluded with and each Implementer's own conclusion, then provides a
// final summary of the entire run — what was done, what was verified, and the
// overall outcome.
export function buildDispatcherConclusionAssignment(
  objective: string,
  plannerConclusion: string,
  completedTasks: Array<{ prompt: string; conclusion: string }>,
): string {
  const taskSummaries = completedTasks
    .map((t, i) => `Task ${i + 1}: ${t.prompt}\nImplementer result: ${t.conclusion}`)
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
    'Treat concrete verification evidence as the basis for claims about correctness. Do not describe something ' +
    'as verified merely because an Implementer reported success — spot-check the workspace yourself where ' +
    'practical.\n\n' +
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
      'Inspect relevant project files as needed to ground the assignment in the current codebase. The implementation agent does NOT have access to `AGENTS.md` or `MEMORY.md` — inspect those files yourself and include directly in the assignment any relevant instructions, conventions, architectural constraints, project facts, or prior decisions. But remember, the project remains READ-ONLY at this point: do not implement anything yourself.\n\n' +
      'You have a hard budget of 20 iterations to call `conclude` with the final self-contained implementation assignment. If the next planned step is no longer appropriate given the current project state, adapt the assignment while preserving the intent and sequencing of the overall plan.'
    )
  }
  return (
    `CHECKPOINT: task-${taskNumber}\n` +
    'The previous implementation agent concluded with:\n' +
    `<argo-implemented>\n${completedMessage}\n</argo-implemented>\n\n` +
    'Review this result against your plan and the current project state, then create the next self-contained implementation assignment.\n\n' +
    'Formulate it as a clear implementation assignment with a verifiable expected outcome. Include any relevant consequences of the completed work and dependencies. The implementation agent does NOT have access to `AGENTS.md` or `MEMORY.md` — include in the assignment any relevant instructions or context from those files that the agent needs. Explicitly scope what to change, preserve, or defer, including what to test.\n\n' +
    'If the result changes or invalidates your original plan, adapt the next step accordingly.\n\n' +
    'Call `conclude` with one of these statuses:\n' +
    '- IMPLEMENT: your message is the complete implementation assignment for the agent.\n' +
    '- SUCCESS: inspection shows the objective is already satisfied and no implementation work remains; your message is a final concluding statement summarizing what was accomplished and verified.\n' +
    '- FAIL: the objective cannot be completed; your message explains why.\n\n' +
    'The project remains READ-ONLY for you. You have a hard budget of 20 iterations to call `conclude`.'
  )
}

// IMPLEMENTER CAP-HIT FOLLOW-UP. Used INSTEAD OF buildNextTaskPrompt above for the
// one Planner resume immediately following an Implementer frame that hit its own
// hard iteration cap (agent.hitIterationCap(), see runDispatchLoopBody's OBJECTIVE
// loop) — the generic "previous sub-agent concluded with..." wording doesn't
// distinguish a real conclusion from a raw "Reached maximum iterations" cap-hit
// string, and feeding the Planner the SAME framing for both risks it reading a
// cap-hit as ordinary completed work. This is explicit instead: the assignment was
// too broad for one implementation pass, and the Planner is asked to reframe it
// narrower (or decide the objective is already met) rather than simply handed the
// same failed assignment again. Pure and exported so it is directly testable without
// spawning a real frame.
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

// ── SUCCESS/FAIL — every Implementer's own verdict. Appended to every Implementer's
// assignment (buildImplementerAssignment for SIMPLE; the Planner's own per-task text
// for OBJECTIVE) so the harness can tell success from failure without needing the
// Planner to parse or restate that decision. Kept separate from the "raw" assignment
// text (buildImplementerAssignment/the Planner's own text is never itself mutated) so
// callers still have the plain task description available for completedTasks/
// buildImplementerCapFollowUp.
export function appendImplementerResultFormat(assignment: string): string {
  return assignment
}

export interface ImplementerResult {
  succeeded: boolean
  message: string
}

// Parses an Implementer's `conclude` text against the SUCCESS:/FAIL: convention
// appendImplementerResultFormat asks for. FAIL is checked first so a message that
// happens to mention "success" inside an otherwise-failing explanation is never
// misread. Neither prefix present → treat as SUCCESS ("the model didn't follow the
// format but did conclude") — the harness has no separate verification step any more,
// so the Implementer's own account of its work, corroborated by the tests/checks it
// ran and the files it touched, is the best available signal.
export function parseImplementerResult(text: string): ImplementerResult {
  const trimmed = text.trim()
  const fail = /^FAIL\s*:\s*([\s\S]+)/i.exec(trimmed)
  if (fail) return { succeeded: false, message: fail[1].trim() }
  const success = /^SUCCESS\s*:\s*([\s\S]+)/i.exec(trimmed)
  if (success) return { succeeded: true, message: success[1].trim() }
  return { succeeded: true, message: trimmed }
}

// Detects a Planner `conclude` answer that means "no further work needed" rather
// than a real Implementer assignment — the harness's only signal to stop the
// OBJECTIVE loop and treat the objective as complete.
//
// Why a heuristic over `conclude` text rather than a rigid marker (e.g. a required
// "DONE:"/"COMPLETE:" prefix): natural language degrades more gracefully than a
// required prefix a small local model can drop under load. Worst case, a
// genuinely-finished Planner phrases its answer unusually and this misreads it as
// one more (harmless, if slightly redundant) assignment — never the other way
// around, an assignment misread as "done" and dropped, because the phrase list below
// only matches completion language, not the absence of a keyword.
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
//      assignment — checked ONLY when phrase (1) didn't already match.
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

// GIVE-UP — a SEPARATE signal from isPlannerDone above — "the objective is met" and
// "I cannot complete this" are opposite outcomes and must never be conflated. Checked
// BEFORE isPlannerDone at every call site (the explicit failure signal takes priority
// — a give-up phrased ambiguously enough to also brush against a "done" phrase must
// still read as a failure, never quietly as success). `GIVE_UP:` as an explicit
// prefix, OR a reasonable natural-language heuristic ("give up" / "cannot complete")
// for a model that concludes without the prefix — same "try natural language first"
// reasoning as isPlannerDone's own phrase list above.
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
  // inspectable right up until this line runs for the NEXT one.
  liveFrames.clear()
  activeFrameId = null
  // See the module-level currentUserQuery declaration above — captured unconditionally,
  // since every frame's TraceLogger header wants the real user request.
  currentUserQuery = userMessage
  const model = currentModel ?? config.model
  // See currentSessionId/currentRunIndex's own comment above. Falls back to a
  // freshly minted id when the caller has no session concept at all (rare — every
  // production call site through server.ts always has one), so registerFrame
  // always has SOME stable session id to key off, never a blank string.
  currentSessionId = overrides?.sessionId || ledger.newId('session')
  currentRunIndex = currentSessionId === lastRunIndexSessionId ? currentRunIndex + 1 : 0
  lastRunIndexSessionId = currentSessionId

  // PERSISTENT DISPATCHER FRAME: mint dispatcherFrameId once per session — see its
  // own comment above. A different sessionId than the one this id was last minted
  // for (a genuinely new session, e.g. after /reset) starts a fresh persistent
  // frame rather than resuming a previous session's accumulated history; the SAME
  // sessionId across runs reuses the existing id, which is what lets spawnFrame's
  // persistentFrameId preload find and extend the right ledger file.
  if (dispatcherFrameSessionId !== currentSessionId) {
    dispatcherFrameId = ledger.newId('dispatcher')
    dispatcherFrameSessionId = currentSessionId
  }

  // The dispatch run's own top-level narrative (start/objective/message/done) is no
  // longer persisted to a separate run-level JSONL log (SessionLogger removed) —
  // each frame's own ledger file (ledger.ts, under .argo/frames/) is the durable
  // record now. `emit` just assigns a frame-local seq (for the SSE stream's
  // replay/live-dedup mechanism) and forwards to rawEmit.
  let seq = 0
  const emit: Emit = (event) => {
    seq++
    rawEmit(event, seq)
  }

  // Top-level lifecycle events, UNTAGGED (no frame owns them) — mirrors agent.ts's own
  // chat() exactly (start ... message/done), so the existing status bar, trace block,
  // notifications, and git/file refresh in app.js work unmodified for the WHOLE
  // dispatch run; every tagged per-frame event nests inside this same trace block.
  emit({ type: 'message', role: 'user', content: userMessage })
  emit({ type: 'start', model, query: userMessage, options: currentOptions ?? {} })

  try {
    const finalAnswer = await runDispatchLoopBody(userMessage, emit)
    emit({ type: 'message', role: 'assistant', content: finalAnswer })
    emit({ type: 'done', content: finalAnswer })
    return finalAnswer
  } catch (err) {
    if (err instanceof DispatchAborted) {
      // No 'message' event on a user-requested stop — mirrors agent.ts's own
      // stop path exactly (done only, no assistant chat bubble for "Stopped.").
      const stopped = 'Stopped.'
      emit({ type: 'done', content: stopped })
      return stopped
    }
    // Planning that could not produce a usable decision is a REPORTED failure, not an
    // "unexpected error" and emphatically not an invented task. Same event shape as
    // the generic branch below (error + no assistant bubble), with the diagnosis as
    // the returned text so the user/eval sees why nothing ran.
    if (err instanceof PlanningFailed) {
      emit({ type: 'error', message: err.message })
      return err.message
    }
    const message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`
    emit({ type: 'error', message })
    return message
  }
}

// Builds the diagnostic PlanningFailed message for a Planner call (initial or a
// per-task resume) that hit its own iteration cap without ever calling `conclude`.
// Factored out because the OBJECTIVE loop below checks this after BOTH the initial
// plan call and every per-task resume — a capped frame's "final answer" is agent.ts's
// own cap-hit notice, not a decision, and there is nothing to salvage from it
// (resuming a capped frame would just re-hit the same cap).
function plannerCapFailure(stage: string, frameId: string, rawOutput: string): PlanningFailed {
  return new PlanningFailed(
    `Planning failed: the Planner hit its iteration cap while ${stage} and never called \`conclude\` `
    + `(frame ${frameId}).\nLast raw output:\n${rawOutput}`,
  )
}

// THE FULL ITERATIVE PLANNER PIPELINE. Spawns a FRESH Planner frame with the INITIAL
// planning prompt (buildInitialPlannerPrompt — an ordered list of concrete sub-tasks,
// delivered as its `conclude` answer), then resumes that same Planner frame round by
// round to produce exactly one self-contained Implementer assignment at a time,
// informed by the previous Implementer's own conclusion, until the Planner reports
// the objective complete. There is no separate "replan" step: the Planner IS the
// loop.
//
// TWO CALLERS: the OBJECTIVE task-start mode (its original, sole caller) and the
// SIMPLE mode's ESCALATION path, when its one Implementer hits its own hard iteration
// cap. A SIMPLE task the Dispatcher judged as "3-20 iterations" that instead ran the
// full budget without concluding was measurably bigger than that judgment — rather
// than reporting a raw cap-hit string as failure, it gets the SAME decomposition
// machinery an OBJECTIVE task gets, starting completely fresh (a NEW Planner frame,
// the INITIAL prompt, not a resume of anything): the failed Implementer's own edits
// are still sitting in the workspace (git, not this function's business — whichever
// frame eventually calls autoCommit() below picks up ALL uncommitted changes, not
// just its own), and the Planner is expected to ground itself in that current
// project state (read_file/bash, same as any Planner) and plan forward from it
// rather than being told about the failure explicitly.
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
  let taskNumber = 1
  let plannerFollowUp: string = buildNextTaskPrompt(null, taskNumber)
  const completedTasks: Array<{ prompt: string; conclusion: string }> = []
  let done = false
  // The Planner's own concluding text — captured from the detailResult that trips
  // isPlannerDone below — so the end-of-run Dispatcher conclusion frame can quote
  // exactly what the Planner itself said, not a re-derived summary.
  let plannerConclusionText = ''
  // Counts Implementer cap-hits across THIS objective's whole OBJECTIVE loop — see
  // MAX_IMPLEMENTER_CAP_RETRIES above.
  let implementerCapHits = 0

  for (let round = 0; round < MAX_PLANNER_ROUNDS; round++) {
    // Each detail call gets its OWN fresh iteration budget (40, with progress checks
    // at 20/30) rather than the accumulating count resumeFrame's underlying
    // chat(..., { resume: true }) uses by default — the Planner's CONTEXT carries
    // over (same Agent instance, same history), but its iteration budget must not.
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
    // SUCCESS:/FAIL: sign-off convention. nextAssignment itself stays the plain task
    // text, used for completedTasks/buildImplementerCapFollowUp.
    const implementerAssignment = appendImplementerResultFormat(nextAssignment)

    // Implementer FAIL is NOT retried here — the failing task's own conclusion simply
    // becomes what the Planner sees on its next detail call (via plannerFollowUp
    // below), and the Planner decides what to do about it. The ONE exception
    // (iteration-cap): an Implementer that hits its own hard iteration cap
    // (agent.hitIterationCap()) gets resumed to the Planner with an explicit "this
    // task was too broad, reframe it narrower" message instead of the generic
    // wording, up to MAX_IMPLEMENTER_CAP_RETRIES times before this loop gives up and
    // reports the failure to the user rather than a raw cap-hit string or an
    // indefinite retry loop.
    const implFrame = await spawnFrame(
      { role: 'implementer', parentFrameId: plannerFrameId, assignment: implementerAssignment },
      emit,
    )
    commitAgent = implFrame.agent
    // PARENT VISIBILITY, Planner side: spawnFrame's own hook (see its call to
    // recordConclusionToParent) already appended this Implementer's conclusion to
    // the DISPATCHER's ledger; the Planner is this Implementer's actual immediate
    // parent (parentFrameId: plannerFrameId, just above) and needs its OWN durable
    // record too, not just the transient plannerFollowUp text threaded through
    // below (buildNextTaskPrompt/buildImplementerCapFollowUp) — that text is what
    // the Planner's NEXT resumeFrame call actually reads as its live prompt, but a
    // resumed frame's PRELOAD (spawnFrame's isPersistent branch) only ever replays
    // from the ledger FILE, and the Planner frame itself is not persistent across
    // separate dispatch runs the way the Dispatcher is — this call is what makes
    // the Planner's own ledger file carry the full "what each Implementer
    // reported" history, independent of whatever framing text happened to
    // accompany it turn to turn.
    await recordConclusionToParent(plannerFrameId, 'implementer', implFrame.result.rawSummary)
    const taskEntry: { prompt: string; conclusion: string } = {
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

    // The Implementer's own SUCCESS/FAIL conclusion is not retried by the harness — it
    // simply becomes part of what the Planner sees on its NEXT detail call (via
    // plannerFollowUp below), and the Planner decides what to do about a failure
    // however it judges best. There is no separate verification step any more: the
    // Implementer is expected to have already verified its own work before concluding.
    taskNumber++
    plannerFollowUp = buildNextTaskPrompt(implFrame.result.rawSummary, taskNumber)
  }

  if (!done) {
    if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)
    return `Could not complete the objective within ${MAX_PLANNER_ROUNDS} planner rounds. Objective: ${objective}\n\n`
      + completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')
  }

  const doneSummary = completedTasks.map(t => `- ${t.prompt}: ${t.conclusion}`).join('\n')

  // Dispatcher conclusion: resume the SAME persistent Dispatcher frame that
  // classified this turn (dispatcherFrameId — see its own comment above), not a
  // separate one-off Dispatcher frame. This is the mechanism, not a special case:
  // spawnFrame's persistentFrameId preloads a fresh Agent from the frame's
  // accumulated ledger history (which by now already includes this turn's own
  // classification exchange, appended by runDispatcherTaskStart's own spawnFrame
  // call above), so the conclusion becomes part of the Dispatcher's persistent,
  // whole-session context exactly like the classification that preceded it. Uses
  // the same TASK_START_TOOLS (read-only) and TASK_START_HARD_CAP as the
  // classification checkpoint. dispatcherFrameId is always set by this point —
  // runDispatcherTaskStart (dispatch loop's very first call) always sets it before
  // runObjectiveViaPlanner can ever run.
  const conclusionReq: FrameSpawnRequest = {
    role: 'dispatcher',
    parentFrameId: null,
    maxIterations: TASK_START_HARD_CAP,
    assignment: buildDispatcherConclusionAssignment(objective, plannerConclusionText, completedTasks),
    persistentFrameId: dispatcherFrameId ?? undefined,
  }
  const conclusionFrame = await spawnFrame(conclusionReq, emit, TASK_START_TOOLS)
  commitAgent = conclusionFrame.agent

  // Mirrors Agent.chat()'s own per-frame end-of-run auto-commit (agent.ts), opt-in via
  // the same config.autoCommit flag. Reuses whichever frame's Agent instance most
  // recently did real work purely as a vehicle — autoCommit() only needs git + a model to write
  // the message, it doesn't care which role's instance runs it. commitAgent is only
  // null here if NO frame ever spawned, which can't happen once past the Planner spawn
  // above.
  if (config.autoCommit && commitAgent) await commitAgent.autoCommit(emit)

  // Use the Dispatcher's conclusion as the run's final answer, with a fallback
  // to the task summary if the Dispatcher somehow fails to conclude.
  const dispatcherConclusion = conclusionFrame.result.rawSummary
  return dispatcherConclusion || `Objective: ${objective}\n\n${doneSummary || 'No implementation tasks were required.'}`
}

async function runDispatchLoopBody(userMessage: string, emit: Emit): Promise<string> {
  await ledger.ensureGitignored(root())

  const taskStart = await runDispatcherTaskStart(userMessage, emit)

  // ANSWER: the Dispatcher already knows, verified it himself — no Planner/
  // Implementer frame ever spawns. The whole point of this mode is zero further
  // iteration.
  if (taskStart.mode === 'answer') {
    emit({ type: 'objective', text: taskStart.text })
    return taskStart.text
  }

  const objective = taskStart.text
  emit({ type: 'objective', text: objective })

  // SIMPLE: tries ONE well-scoped Implementer — no Planner ceremony up front. If the
  // Implementer hits its cap → escalate to the OBJECTIVE path.
  if (taskStart.mode === 'simple') {
    const implementerAssignment = buildImplementerAssignment(objective)
    const frame = await spawnFrame(
      { role: 'implementer', parentFrameId: null, assignment: appendImplementerResultFormat(implementerAssignment) },
      emit,
    )
    // The task was measurably bigger than the Dispatcher's "3-20 iterations"
    // judgment — escalate to the full OBJECTIVE pipeline (runObjectiveViaPlanner,
    // the SAME iterative Planner+Implementer loop an OBJECTIVE task gets) rather
    // than reporting a raw "Reached maximum iterations" string as failure.
    if (frame.agent.getLastRunOutcome() === 'cap') {
      return await runObjectiveViaPlanner(objective, emit)
    }

    // SIMPLE has no Planner conversation to route a FAIL back to — the Implementer's
    // own explanation of what it did (or what it tried and why it failed) IS the final
    // answer either way; there is no separate verification step to gate on.
    if (config.autoCommit) await frame.agent.autoCommit(emit)
    return `Objective: ${objective}\n\n${frame.result.rawSummary}`
  }

  // OBJECTIVE: the Planner drives the full iterative loop from the start — see
  // runObjectiveViaPlanner above for the design.
  return await runObjectiveViaPlanner(objective, emit)
}
