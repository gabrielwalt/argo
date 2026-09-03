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

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Agent } from './agent.js'
import { config } from './config.js'
import { SessionLogger } from './logger.js'
import type { AgentEvent, FrameSpawnRequest, FrameResult, FrameStatus, ModelOptions, Role } from './types.js'
import { ROLE_TOOLS, ROLE_MAX_ITERATIONS, systemPromptFor, buildAssignment, capSummary, parseTesterVerdict, parseBossVerdict, parseTaskStartVerdict, policyFor, TESTER_VERDICT_NUDGE, type TaskStartVerdict } from './frames.js'
import * as ledger from './ledger.js'
import { createTaskGraph, readyGroups, allStepsDone, type TaskGraph, type TaskStep } from './tasks.js'

// The workspace root — config.workspacePath (NOT a literal '/workspace') because
// standalone dev mode runs this Node process directly on the HOST while `bash`
// reaches the project through a separate docker-exec'd container; only in-container
// worker mode has a real '/workspace' directory on ITS OWN filesystem. Read fresh
// each call, never cached, since standalone mode's runtime "mount a folder" flow
// mutates config.workspacePath directly (see server.ts's POST /api/workspace).
function root(): string {
  return config.workspacePath || '/workspace'
}

const execFileAsync = promisify(execFile)
// Fails open to '' ("nothing changed") on any error — not a git repo, git unavailable,
// etc. — same fail-open convention as every other checkpoint here; this is a detection
// heuristic, not a correctness-critical path.
async function gitStatusShort(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--short'], { cwd })
    return stdout
  } catch {
    return ''
  }
}

// Total changed lines (added + removed) in the working tree right now — used to size a
// TRIVIAL self-attempt's actual blast radius. The Boss only has `bash`, not edit_file:
// its ONLY way to "fix" a file is a full heredoc rewrite, which is an inherently blunt,
// all-or-nothing instrument (unlike edit_file's precise, scoped replacement). Observed
// in eval: a Boss judged a 6-method feature TRIVIAL, rewrote the entire target file
// from scratch via `cat > file << EOF` to "fix" it, hallucinated large parts of the
// surrounding code it never needed to touch, and broke an unrelated constructor
// signature other files depended on — a real, damaging failure a mere `dirty` check
// (any change at all) can't distinguish from a genuinely tiny, safe edit.
async function gitDiffLineCount(cwd: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--shortstat'], { cwd })
    const m = /(\d+) insertion.*?(\d+) deletion|(\d+) insertion|(\d+) deletion/.exec(stdout)
    if (!m) return 0
    const nums = m.slice(1).filter(Boolean).map(Number)
    return nums.reduce((a, b) => a + b, 0)
  } catch {
    return 0
  }
}
// Above this many changed lines, a self-attempt no longer counts as evidence of a
// genuinely TRIVIAL (1-2 iteration) fix, regardless of whether the Boss claims it
// finished — generous enough for a real one-or-two-line change plus its imports/
// braces, nowhere near enough for a full-file rewrite.
const TRIVIAL_DIFF_LINE_LIMIT = 15
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

interface SpawnedFrame {
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
function tagEmit(emit: Emit, frameId: string, role: Role, parentFrameId: string | null) {
  return (event: AgentEvent, seq?: number) => {
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

async function spawnFrame(req: FrameSpawnRequest, emit: Emit): Promise<SpawnedFrame> {
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
  agent.setAllowedTools(ROLE_TOOLS[req.role])
  agent.setRoleInstructions(systemPromptFor(req.role))
  agent.setFrameId(frameId)
  agent.setMaxIterations(req.maxIterations ?? ROLE_MAX_ITERATIONS[req.role])
  agent.setSessionId(frameId) // isolates history/compaction-state files per frame
  applyFramePolicy(agent, req.role) // H17 — never inherit the single-loop baseline's mechanisms

  const assignment = await buildAssignment(root(), req)
  activeFrameAgent = agent
  const finalAnswer = await agent.chat(assignment)
  activeFrameAgent = null
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
async function resumeFrame(frameId: string, agent: Agent, followUp: string): Promise<FrameResult> {
  checkAborted()
  activeFrameAgent = agent
  const finalAnswer = await agent.chat(followUp, { resume: true })
  activeFrameAgent = null
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

// dispatch.ts's own harness-level override on top of the Boss's text verdict — see
// the 'preempted'/'preempted-incomplete' cases in runBossTaskStart below.
interface RoutedTaskStart {
  mode: TaskStartVerdict['mode'] | 'preempted' | 'preempted-incomplete'
  text: string
  frameId: string
  agent: Agent
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

// Boss, checkpoint task-start: a FOUR-way router (docs/subagents-plan.md, "skippable
// phases" + the 2026-09-03 redesign). Never re-fires within one dispatch — the
// objective is set exactly once per task by construction (setObjective's own
// immutability guard is the backstop if this were ever called twice).
async function runBossTaskStart(userMessage: string, emit: Emit): Promise<RoutedTaskStart> {
  const req: FrameSpawnRequest = {
    role: 'boss',
    parentFrameId: null,
    maxIterations: TASK_START_MAX_ITERATIONS,
    assignment:
      `CHECKPOINT: task-start\nThe user asked: "${userMessage}"\n` +
      'Ground this if it references project specifics, current facts, or anything you cannot already verify — ' +
      'check real files or the web where it matters, rather than answering from assumption. ' +
      `You have a hard budget of ${TASK_START_MAX_ITERATIONS} iterations for this checkpoint — plenty for reading ` +
      'and classifying, not enough for a real implementation effort, by design. Read only enough to classify, not ' +
      'enough to fully understand the codebase — the moment you notice real complexity (an unfamiliar multi-file ' +
      'area, several functions/modules involved, a design decision to make), STOP reading and classify OBJECTIVE ' +
      'immediately; Tiphys (the Planner) has a longer budget specifically to do that deeper reading, so spending ' +
      'your own short budget on it first only shrinks the room you have left to classify at all. If you do attempt ' +
      'a fix yourself (TRIVIAL below), verify it ONCE — one clean test/check run confirming it — and then CONCLUDE ' +
      'immediately with your answer line. Do not re-run the same check again "to be sure": repeated re-verification ' +
      'of a fix you already confirmed wastes the very budget that makes this checkpoint safe, and a fresh Tester ' +
      'independently re-checks your work right after anyway, so your own one-time confirmation is enough. ' +
      'Classify the request into exactly ONE of four modes and end your answer with exactly one line in that ' +
      'mode\'s format:\n' +
      '- ANSWER: <complete final answer> — you already know the full answer (a question, a lookup, something you ' +
      'just verified) and no project change is needed at all. No further frame ever spawns.\n' +
      '- TRIVIAL: <what you did, or will do> — genuinely 1-2 iterations of work (a one-character typo, a single ' +
      'obvious constant, a one-line change you can name without reading anything else first). You MAY fix it ' +
      'yourself right now, within your small budget above, before answering — a fresh Tester will independently ' +
      'verify whatever you did before this returns to the user, so you are never the only check on your own work. ' +
      'If you are not confident it is genuinely this small, do NOT attempt it — classify SIMPLE instead and let ' +
      'the Implementer do it.\n' +
      '- SIMPLE: <concrete, verifiable objective> — a single well-scoped change, even if it takes real effort to ' +
      'diagnose or isn\'t trivial to write (a bug in one file, a fix to one function) — but still ONE piece of ' +
      'work. Do NOT attempt this yourself, no matter how tempting. This delegates straight to one Implementer, ' +
      'independently verified by a Tester — no Planner ceremony.\n' +
      '- OBJECTIVE: <concrete, verifiable objective> — you anticipate this needs MULTIPLE distinct pieces of work ' +
      '(several files, several unrelated concerns, or genuine ambiguity about the approach) — the only case that ' +
      'goes to the Planner for real decomposition. Never "NONE" or "no objective" here, regardless of how simple ' +
      'the request is or whether it involves this project at all.',
  }
  const before = await gitStatusShort(root())
  const { agent, result } = await spawnFrame(req, emit)
  let finalResult = result
  let verdict = parseTaskStartVerdict(result.summary)

  // Retry once, only when the frame actually concluded on its own (a frame that stalled
  // at its cap has no budget to spend re-asking) and the model didn't already commit to a
  // mode — verdict.parsed says the marker WAS found, nothing to fix. hitIterationCap()
  // replaces the old `getIterationCount() < TASK_START_MAX_ITERATIONS` comparison, which
  // H14 breaks: the counter is now cumulative across a frame's turns, so a count at or
  // above the cap no longer implies a stall.
  if (!verdict.parsed && !agent.hitIterationCap()) {
    const retry = await resumeFrame(result.frameId, agent, TASK_START_MARKER_RETRY_NUDGE)
    const retryVerdict = parseTaskStartVerdict(retry.summary)
    if (retryVerdict.parsed) {
      verdict = retryVerdict
      finalResult = retry
    }
  }

  // Snapshot AFTER any retry above — a retry turn can in principle also call a tool,
  // so the dirty-check below must reflect everything the frame actually did, not just
  // its first pass.
  const after = await gitStatusShort(root())
  // Terminal state, not an iteration-count comparison (H13/H14): a frame that stalled at
  // its cap OR ended in an error mid-attempt is "incomplete" for the routing decision
  // below, and a resumed frame's cumulative counter can no longer stand in for either.
  const hitCap = agent.hitIterationCap() || agent.getLastRunOutcome() === 'error'
  const base = verdict.parsed ? verdict : { mode: 'objective' as const, text: userMessage }
  const dirty = after !== before && after.trim() !== ''

  // HARNESS-LEVEL OVERRIDE, not a text convention the model can express: a git-status
  // diff is unambiguous and needs no model cooperation, unlike trusting whatever the
  // Boss's own wording claims. Three distinct outcomes once we know the workspace
  // changed: the attempt looks complete and SMALL (didn't exhaust its tiny budget, and
  // the diff is genuinely tiny) — verify it independently and move on; it ran out of
  // budget mid-attempt, OR it claims completion but the diff is suspiciously large for
  // something classified TRIVIAL (a real observed failure: a full heredoc file rewrite
  // that hallucinated most of the file and broke an unrelated constructor signature) —
  // either way, don't gamble on it, hand it to a real Implementer with the attempt as
  // context and an explicit instruction to critically review (and revert, if it isn't
  // actually minimal/correct) rather than build on top of a hasty rewrite.
  if (dirty) {
    const changedLines = await gitDiffLineCount(root())
    const suspiciouslyLarge = changedLines > TRIVIAL_DIFF_LINE_LIMIT
    return {
      mode: (hitCap || suspiciouslyLarge) ? 'preempted-incomplete' : 'preempted',
      text: base.text,
      frameId: finalResult.frameId,
      agent,
    }
  }
  // Built explicitly rather than by spreading `base` — TaskStartVerdict now carries a
  // `parsed` flag that RoutedTaskStart has no business holding.
  return { mode: base.mode, text: base.text, frameId: finalResult.frameId, agent }
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
  const verdict = parseBossVerdict(result.summary)
  // H13: the same "did this checkpoint actually finish?" question, now answered from the
  // frame's terminal state instead of an iteration-count comparison (which H14's
  // cumulative counter invalidates), and extended from 'cap' to any non-clean ending.
  // The trigger is `!verdict.parsed`, not `action === 'none'`: 'none' is now returned both
  // for an explicit NONE (a real all-clear, which must be honoured even if the frame then
  // stalled) and for an unparseable reply.
  const outcome = agent.getLastRunOutcome()
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

// Lynceus verifies a claim (an Implementer step's, or — 2026-09-03 — the Boss's own
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
        `Verify this claim.\nOriginal assignment: ${combinedPrompt}\n` +
        `Conclusion (${frame.result.status}): ${frame.result.summary}\n` +
        `Files touched: ${frame.result.filesTouched.join(', ') || 'none (or made via bash, not tracked)'}` +
        verdictNudge,
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
      if (verdictRetries === 0 && round < MAX_TESTER_ROUNDS - 1) {
        verdictRetries++
        verdictNudge = `\n\n${TESTER_VERDICT_NUDGE}`
        continue
      }
      const unverified: FrameResult = {
        ...frame.result,
        status: frame.result.status === 'success' ? 'partial' : frame.result.status,
        summary: capSummary(
          `${frame.result.summary}\n\nUNVERIFIED: the Tester produced no parseable RELEASE/REDO verdict `
          + '(including after an explicit request for the verdict line), so this work has NOT been '
          + 'independently verified.',
        ),
        issues: [...(frame.result.issues ?? []), 'tester-verdict-unparseable'],
      }
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
function parseTaskGraph(objective: string, plannerAnswer: string): TaskGraph | null {
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
class PlanningFailed extends Error {}

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
async function graphFromPlanner(
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

export async function runDispatchLoop(
  userMessage: string,
  rawEmit: Emit,
  overrides?: { model?: string; options?: ModelOptions; sessionId?: string },
): Promise<string> {
  currentModel = overrides?.model
  currentOptions = overrides?.options
  stopRequested = false
  activeFrameAgent = null
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

  // ANSWER: Jason already knows, verified it himself — no Planner/Implementer/Tester
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
  // whole point of TRIVIAL/SIMPLE/preempted is skipping Tiphys's ceremony for work
  // that isn't anticipated to need MULTIPLE distinct pieces.
  let plannerFrame: SpawnedFrame | null = null
  // Whichever frame's Agent instance most recently did real work — reused purely as
  // the vehicle for the end-of-run autoCommit (it only needs git + a model, not a
  // specific role), so a run that never spawns a Planner still has one.
  let commitAgent: Agent | null = null
  let graph: TaskGraph

  const doneStepIds = new Set<string>()
  const stepFrameId = new Map<string, string>()

  if (taskStart.mode === 'trivial' || taskStart.mode === 'simple') {
    // Both delegate to exactly one Implementer, always followed by a Tester pass
    // (no skipTest here — "at least two independent frames" is the floor, not
    // something a task-start classification alone should be able to waive; only
    // Tiphys's own per-step OBJECTIVE-graph decisions use skipTest, see tasks.ts).
    graph = createTaskGraph(objective, [{ role: 'implementer', prompt: objective, dependsOn: [] }])
  } else if (taskStart.mode === 'preempted-incomplete') {
    // The Boss attempted a TRIVIAL fix itself but either ran out of its small
    // task-start budget mid-attempt, or produced a suspiciously large diff for
    // something it judged trivial (see runBossTaskStart's TRIVIAL_DIFF_LINE_LIMIT —
    // the Boss's only editing tool is bash, so its "fix" may be a full heredoc file
    // rewrite, an inherently blunt instrument prone to hallucinating large parts of
    // a file it never needed to touch). Hand it to a REAL Implementer with an
    // explicit instruction to CRITICALLY review — not just build on top of — what
    // was done. Goes through the normal Implementer+Tester path below like any
    // other single-step task.
    graph = createTaskGraph(objective, [{
      role: 'implementer',
      prompt: `${objective}\n\nA PREVIOUS ATTEMPT (by the task-start classifier, under a small iteration budget, ` +
        'with only bash available — no precise file-editing tool) got partway through, or produced a change too ' +
        `large to trust unreviewed. What it attempted: ${taskStart.text}\n` +
        'First, examine the CURRENT diff against the actual objective above: if it looks like a careful, correct, ' +
        'minimal change, finish whatever is left. If it looks like an unwarranted full-file rewrite, unrelated ' +
        'code hallucinated in, or a broken API other files depend on, REVERT it (e.g. `git checkout -- <file>`) ' +
        'and implement the objective cleanly yourself instead of building on top of a hasty rewrite.',
      dependsOn: [],
    }])
  } else if (taskStart.mode === 'preempted') {
    // The Boss already made (and, within its own small budget, apparently
    // completed) the change during task-start — detected via a workspace diff, see
    // runBossTaskStart. No Implementer frame spawns, but this still gets a genuine,
    // independent Tester pass before being marked done — never just Jason grading
    // his own work as the only check (the whole point of keeping >=2 frames
    // involved even on the fastest path).
    graph = createTaskGraph(objective, [{ role: 'implementer', prompt: objective, dependsOn: [] }])
    const preemptedFrame: SpawnedFrame = {
      agent: taskStart.agent,
      result: { frameId: taskStart.frameId, status: 'success', summary: taskStart.text, filesTouched: [], filesWritten: [] },
    }
    const verified = await runTesterRounds(preemptedFrame, objective, emit)
    stepFrameId.set(graph.steps[0].id, verified.result.frameId)
    doneStepIds.add(graph.steps[0].id)
    commitAgent = verified.agent
  } else {
    // Held in a local const as well as in plannerFrame: graphFromPlanner may resume the
    // frame, and the local keeps the non-null Agent reference obvious without depending on
    // narrowing across the awaits.
    const planner = await spawnFrame(
      {
        role: 'planner',
        parentFrameId: null,
        assignment: `Objective: ${objective}\nProduce a task graph for this objective. ${PLANNER_FORMAT_INSTRUCTION}`,
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
    const followUp =
      `REPLANNING ROUND.\n${reason}\nProduce a revised task graph for the objective's REMAINING work only ` +
      `(do not redo what already succeeded). ${PLANNER_FORMAT_INSTRUCTION}`
    let result: FrameResult
    if (plannerFrame) {
      result = await resumeFrame(plannerFrame.result.frameId, plannerFrame.agent, followUp)
      plannerFrame = { agent: plannerFrame.agent, result }
    } else {
      // A TRIVIAL start never spawned a Planner — this is the first time one is
      // actually needed, so spawn it fresh rather than resuming a frame that never
      // existed.
      plannerFrame = await spawnFrame(
        { role: 'planner', parentFrameId: null, assignment: `Objective: ${objective}\n${followUp}` },
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
        assignment: `${combinedPrompt}\n\nA PREVIOUS ATTEMPT at this task got stuck. What it did and where: ${frame.result.summary}\nTry a different approach.`,
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

      let frame = await spawnFrame(
        { role, parentFrameId: plannerFrame?.result.frameId ?? null, assignment: combinedPrompt, dependsOn: depFrameIds },
        emit,
      )
      commitAgent = frame.agent

      // skipTest is now ONLY a per-step decision Tiphys makes for a Planner-produced
      // OBJECTIVE graph (tasks.ts) — task-start's own trivial/simple/preempted paths
      // never set it, since "at least two independent frames" is a floor those paths
      // don't get to waive on their own.
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
        const frame = await spawnFrame({ role, parentFrameId: plannerFrame?.result.frameId ?? null, assignment: combinedPrompt }, emit)
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
