import { Ollama } from 'ollama'
import type { Message } from 'ollama'
import { promises as fs } from 'fs'
import path from 'path'
import { config } from './config.js'
import { toolDefinitions, executeTool } from './tools/index.js'
import { bash, NO_OUTPUT } from './tools/bash.js'
import { truncateOutput } from './tools/truncate.js'
import { SessionLogger, LOGS_DIR } from './logger.js'
import type { AgentEvent, ToolName, ModelOptions, FramePolicy } from './types.js'
import { runCritic, isTestOrSpecPath, type Critique, type CriticCheckpoint } from './critic.js'
import { runGroundingCritic, isDocPath, findNumericConflicts } from './grounding.js'
import { checkLayout, selectLayoutArtifact, type LayoutVerdict } from './layout.js'
import {
  type CompactionState,
  emptyCompactionState,
  coerceCompactionState,
  renderCompactionState,
  messagesToText,
  splitForCompaction,
  updateCompactionState,
  validateCompactionState,
  summarizeActiveMiddle,
  validateActiveSummary,
} from './compaction.js'
import {
  type TaskList,
  type StepInput,
  createTaskList,
  reconcile as reconcileTasks,
  activeTask,
  completeActiveTask,
  recordActiveTaskSummary,
  allDone as tasksAllDone,
  renderTaskLedger,
  renderTaskSummaries,
} from './tasks.js'
import {
  type RelevanceQuery,
  selectAgentsSections,
  selectMemoryEntries,
  renderRecallPointer,
  persistToMemory,
} from './memory.js'
import {
  createLoopState, noteMutation, noteBashExecution, evaluateCall, normalizeCallKey, recordResult, type LoopState,
  // H21 (this batch, 2026-09-04): closes the unbounded-retry hole where a call the
  // role gate or the plan/act gate refuses is invisible to evaluateCall (both
  // `continue` past it on rejection — see the tool-call loop below). See loop.ts's
  // H21 header note for the evidence and /shared/argo-gateloop/REPORT.md for the
  // design.
  noteGateRejection, clearPlanGateRejections, gateEscalationMessage, gateStopMessage, type GateReason,
} from './loop.js'
import { classifyTool, inferDependencies, evict, type EpisodeMeta } from './eviction.js'
import { recordEpisode, markEpisodeEvicted, newId as newLedgerId } from './ledger.js'

// SYSTEM PROMPT — authoring guidance (for maintainers, not the model):
// Use this for HIGH-LEVEL steering of *how to work*, awareness of the tools the
// harness provides, and the Argo context the agent runs in. Do NOT add obvious,
// low-level do/don't rules the model should already know or can infer (e.g.
// "locate before you edit", "verify your change") — we cannot enumerate correct
// behavior, and a growing wall of such rules dilutes the prompt and effectively
// dumbs the model down. When a basic failure mode shows up, prefer fixing it in
// the HARNESS (a better tool with real feedback, a loop steer, a guard) over
// adding a line here — e.g. the edit_file tool replaced a prompt rule about not
// reusing a stale remembered block; the harness now makes that failure impossible.
// hasUpdatePlan (2026-09-05): true only for the baseline single-loop agent
// (allowedTools null — no per-role restriction, nothing else ever seeds its plan,
// so update_plan is its only path to satisfy the plan/act gate at all) and any
// future role whose ROLE_TOOLS entry still lists the tool — currently none. False
// for every multi-agent frame (dispatch.ts's seedPlan runs before chat() for the
// only role that used to hold it, the Implementer — see frames.ts's ROLE_TOOLS and
// Agent.canUpdatePlan). Teaching a role a tool it does not have would tell it to do
// something that then gets rejected as "not available in this role" on its very
// first attempt — the same class of contradiction fixed for the Boss task-start
// checkpoint (frames.ts, dispatch.ts) earlier in this project.
function buildSystemPrompt(hasUpdatePlan: boolean): string {
  return `You are the coding agent inside Argo, a local-first coding harness. Your project is mounted at /workspace in an isolated Ubuntu Docker container (the host is not accessible). Your thoughts, tool calls, and results stream live to the user, and changes under /workspace are committed to git when auto-commit is enabled.

TOOLS — invoke them through the function-calling API; never write a tool call as text, JSON, or XML in your reply.
- bash: run shell commands. Pass the working directory via the cwd argument (e.g. /workspace); do not prefix with "cd /workspace &&".
- read_file / write_file: whole-file I/O at any absolute path.
- edit_file: replace an exact string in a file; it reports the changed lines and errors if the text is missing or matches more than once.
${hasUpdatePlan ? '- update_plan: record or refine your plan (a concrete objective plus steps). It is a tool call, so it does not end your turn.\n' : ''}- fetch_url / browser_fetch: fetch a page (browser_fetch runs JavaScript). web_search: look up things you do not already know.
When the task is complete, give your final answer and stop.

A turn where you make no tool calls is how you signal completion — the harness treats your text as the final answer and ends the session. There is no "finish" or "done" tool to call.

HOW TO WORK
- A simple question or a one-line change: answer or do it directly — no plan needed.
${hasUpdatePlan
    ? '- Non-trivial work: read the relevant files first, then call update_plan with ONE concrete, verifiable objective — exactly what the user asked for, never a broader or more interesting goal — plus the steps to reach it, and carry it out. You cannot modify files under /workspace until a plan is recorded.'
    : '- Your plan is set by the harness before you start — your job is to execute it, not to define or refine it. Read the relevant files first, then carry out the objective.'}
- Weigh the request against the project before you plan: if it is unclear, or looks mistaken or counter-productive in this project's context, ask one concise question or say what seems off — do not blindly execute something that does not make sense. Otherwise proceed.
${hasUpdatePlan
    ? '- Stay on the plan. Call update_plan again only when the work contradicts one of its assumptions. Rewriting the same thing many different ways with nothing forcing it is drift — stop and return to the plan.'
    : '- Stay on this objective; do not drift to a different goal. If it cannot be met as scoped, say so explicitly in your final answer rather than grinding indefinitely — state what you tried, what failed, and why.'}
- For repetitive work (many files or pages), write one script instead of repeating a tool call.
- Before finishing, verify the objective against the original request — run the relevant command or test — then give your final answer.

PRECISION
- Never reconstruct an exact identifier, path, URL, flag, or package name from memory — copy it verbatim from the tool result where it appeared, or re-read the source.
- Distinguish what you verified from what you assumed; do not present a guess as a fact.

FILESYSTEM
- /workspace is the git-tracked project — the only place that is committed. Keep scratch, experiments, and downloads elsewhere (/tmp, your home directory); none of that is committed or shown to the user.
- Use absolute paths. For commands about the project itself (npm test, git, node <file>), set the bash cwd to /workspace.

MEMORY
- /workspace/AGENTS.md (project instructions) and /workspace/MEMORY.md (durable memory), if present, are already appended below. Update MEMORY.md only for durable, reusable facts — tersely, in place — never one-off task state.

ENVIRONMENT
- Ubuntu 24.04. CLI includes bash, git, jq, node, python3, rg, fd, sqlite3, curl. In Node use require() (NODE_PATH is set), not import; native fetch() is available; cheerio and playwright are preinstalled.`
}

// Parses tool calls that a model wrote as JSON code blocks in its text content
// instead of using the native tool-calling API (common with smaller models).
function extractToolCallsFromContent(content: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const results: Array<{ name: string; arguments: Record<string, unknown> }> = []
  // Match ```json ... ``` blocks
  const blockRe = /```(?:json)?\s*\n([\s\S]*?)\n```/g
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(content)) !== null) {
    try {
      const obj = JSON.parse(m[1].trim())
      if (obj && typeof obj.name === 'string' && obj.arguments && typeof obj.arguments === 'object')
        results.push({ name: obj.name, arguments: obj.arguments })
    } catch { /* not JSON */ }
  }
  return results
}

// Wraps a promise with a hard timeout; rejects if the promise doesn't resolve in time.
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Ollama did not respond within ${ms / 1000}s`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
}

// Compaction sub-calls can legitimately take over a minute (see config.compactTimeoutMs) —
// without a periodic signal, "is it hung or just slow?" is unanswerable from the UI alone.
// Emits a compact_progress tick every 15s while the call is in flight, and labels the
// eventual timeout error with which step it was (update/validate/summarize), since all
// three share the same generic "did not respond" message otherwise.
async function withCompactHeartbeat<T>(
  promise: Promise<T>,
  timeoutMs: number,
  step: string,
  emitAndLog: (e: AgentEvent) => void,
): Promise<T> {
  const start = Date.now()
  const interval = setInterval(() => {
    emitAndLog({ type: 'compact_progress', step, elapsedMs: Date.now() - start, timeoutMs })
  }, 15_000)
  try {
    return await withTimeout(promise, timeoutMs)
  } catch (err) {
    throw new Error(`[${step}] ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    clearInterval(interval)
  }
}

// Turns `git status --porcelain` lines ("XY path" or "XY a -> b" for renames)
// into a plain list of affected paths, for the no-LLM fallback commit message.
// bash() returns the NO_OUTPUT sentinel (not '') for genuinely empty stdout —
// a clean `git status --porcelain` must be recognized as clean either way.
export function isCleanStatus(output: string): boolean {
  const trimmed = output.trim()
  return trimmed === '' || trimmed === NO_OUTPUT
}

export function parseChangedFiles(porcelainStatus: string): string[] {
  // Each line is "XY path" — two status chars (which may themselves be
  // spaces, e.g. " M", "??") then a space then the path. Trimming the whole
  // line first would eat a leading status-code space and shift the slice
  // into the filename, so only trim() for the blank-line check, never before
  // slicing off the fixed-width prefix.
  return porcelainStatus
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => line.slice(3).trim().split(' -> ').pop()!.trim())
}

// Used when the commit-message LLM call errors or times out — a commit
// should still happen even when the summarizer is slow/unavailable.
export function buildFallbackCommitMessage(changedFiles: string[]): string {
  if (changedFiles.length === 0) return 'Agent: update workspace'
  if (changedFiles.length <= 3) return `Agent: update ${changedFiles.join(', ')}`.slice(0, 72)
  return `Agent: update ${changedFiles.length} files`
}

// Harness-level loop STEERING — deliberately not a stop. When the model repeats
// a tool call that yields no new information, the run is never terminated:
// instead the redundant call is skipped and replaced with an escalating steer
// that hands the model a different observation and concrete escape routes, so it
// can break out on its own and keep working toward a conclusion. MAX_ITERATIONS
// and the user's stop button remain the only hard bounds. The threshold is loose
// (steer only from the 3rd repeat) to leave room for a legitimate repeat (e.g.
// re-running one test to confirm a fix). Thought-text repetition is intentionally
// not a separate detector: in every observed incident it co-occurred with an
// identical tool call, which this already catches.
export const REPEAT_WINDOW = 6
export const REPEAT_THRESHOLD = 3

// Deterministic context editing (see chatCall): the most recent N tool results are
// kept verbatim in the context sent to the model; older ones longer than M chars are
// collapsed to a short restorable stub. This keeps the LIVE window small over long
// runs — which is what keeps small local models emitting native tool calls — and
// makes the (expensive) LLM compaction fire far less often. Non-destructive:
// this.history keeps the full results for the JSONL log and for compaction.
export const KEEP_RECENT_TOOL_RESULTS = 4
export const TOOL_RESULT_COLLAPSE_OVER = 600

// EXECUTABLE per-task verification (Change 3, ARGO_TASKS): how many CONSECUTIVE
// verify-command failures for the same task id before the per-task gate escalates
// its steer from "fix this" to "stop repeating yourself — really fix it or re-plan".
// Purely a wording escalation, not a hard stop — maxIterations/the stall re-ground
// are what actually guarantee a permanently-failing verify can't wedge the run.
export const VERIFY_FAIL_ESCALATE = 3

export function repetitionKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`
}

// A "project mutation" is an edit_file/write_file targeting the git-tracked
// workspace (scratch writes elsewhere don't count). The plan/act gate in chat()
// uses this to enforce plan-before-act: the model may investigate (read/grep)
// freely, but cannot change the project until a plan exists — either recorded by
// the model itself via update_plan (the baseline single-loop agent, which has no
// other path to one) or pre-seeded by the harness before chat() ever runs (every
// multi-agent Implementer frame — dispatch.ts's seedPlan; that role no longer
// holds update_plan at all, see frames.ts's ROLE_TOOLS) — separating "figure out
// what to do" from "do it" as a state with different rules, gated by *about to
// mutate the project* rather than a task classifier, so read-only runs and plain
// questions never trigger planning.
export function isProjectMutation(name: string, args: Record<string, unknown>): boolean {
  if (name !== 'edit_file' && name !== 'write_file') return false
  const p = typeof args.path === 'string' ? args.path : ''
  return p.startsWith('/workspace')
}

// The escalating steer injected when a call repeats with no new information (see
// the loop in chat()). Kept OUT of the system prompt on purpose: it's contextual
// harness help, surfaced only when a loop is actually detected — not a blanket
// instruction the model must always carry. Level 1 observes and offers options;
// level 2+ is firmer. It names the single most common cause (verifying a change
// that doesn't appear to take) because that is the loop seen in practice.
export function loopSteerMessage(name: string, priorRepeats: number, level: number, objective: string): string {
  // A sustained loop (level 3+) has ignored the gentler hints — escalate to a grounded
  // re-anchor that restates the objective and forces a concrete action or a conclusion.
  if (level >= 3 && objective) {
    return regroundSteer(objective, `you have repeated the same \`${name}\` call ${priorRepeats}+ times with no new result`)
  }
  const lead = level >= 2
    ? `STOP — you keep calling \`${name}\` with identical arguments and getting the same result (${priorRepeats}+ times). Repeating it will not help.`
    : `That \`${name}\` call used identical arguments and returned the same result as before — no new information.`
  return `${lead} If you were checking whether a change took effect, verify it where it actually applies — edit_file reports the exact lines it changed, and a view that looks unchanged can mean the edit didn't match or you're looking at the wrong place. Otherwise: try genuinely different arguments or a different tool, or give your final answer if you already have what you need.`
}

// A GROUNDED re-anchor for a stuck run — a call repeated many times, or many tool calls
// with no change to the project (re-inspecting instead of acting: the failure mode where
// the plain loop-steer, even escalated, does not recover the model). Unlike the gentle
// hint, it restates the OBJECTIVE and demands ONE concrete action toward it or a final
// answer — never more aimless inspecting, and never a broader/different goal (chasing a
// new goal is exactly how a stuck run drifts). Kept terse — it is injected mid-run.
export function regroundSteer(objective: string, detail: string): string {
  return `You appear stuck — ${detail}. Re-anchor to the objective: "${objective}". Do ONE thing now: either make the single most important change (an edit) that advances that objective, or — if it is already met, or you are genuinely blocked — give your final answer, stating what you accomplished and (if blocked) exactly what is blocking you. Stop re-inspecting the same things, and do not broaden or switch the objective.`
}

// Same cap as read_file's own truncation (file-ops.ts) — these are the same
// kind of content (a file the agent would otherwise have to read_file itself),
// just auto-loaded instead of requiring a tool call. Missing files are not an
// error — most projects won't have either yet, and behavior is then unchanged.
const PROJECT_CONTEXT_CHAR_CAP = 8000

async function readProjectContextFile(absPath: string): Promise<string | null> {
  try {
    return truncateOutput(await fs.readFile(absPath, 'utf-8'), PROJECT_CONTEXT_CHAR_CAP)
  } catch {
    return null
  }
}

// Loads AGENTS.md (human-authored project instructions) and MEMORY.md
// (agent-maintained durable memory) from the workspace root once per run,
// fresh each time so an update made earlier in the same session is visible on
// the next run. Deliberately not re-read on every iteration within a run: the
// model may edit MEMORY.md mid-run, and re-reading per-iteration would make
// the system message inconsistent across a single run's own iterations.
// workspaceRoot defaults to the real mount; overridable only so tests don't
// need an actual /workspace on the host running them.
export async function loadProjectContext(workspaceRoot = '/workspace'): Promise<string> {
  const [agentsMd, memoryMd] = await Promise.all([
    readProjectContextFile(path.join(workspaceRoot, 'AGENTS.md')),
    readProjectContextFile(path.join(workspaceRoot, 'MEMORY.md')),
  ])
  const sections: string[] = []
  if (agentsMd) sections.push(`--- /workspace/AGENTS.md (project instructions) ---\n${agentsMd}`)
  if (memoryMd) sections.push(`--- /workspace/MEMORY.md (durable project memory) ---\n${memoryMd}`)
  return sections.join('\n\n')
}

// HOW A chat() TURN ENDED, as a fact rather than an inference (H13, 2026-09-04):
//   'ok'      — the model produced a final answer (no tool call) and every pre-done gate
//               (task ledger, grounding, layout, re-ground) let it through.
//   'cap'     — the iteration budget ran out first. chat() still RETURNS a string (the
//               "Reached maximum iterations (N) without a final answer." notice) and
//               emits a terminal `error` event; that string is NOT a final answer and a
//               frame that ends this way completed nothing it can be credited for.
//   'error'   — an exception reached chat()'s outer catch (e.g. the per-iteration
//               ollama.chat() rejecting after its one retry). The returned string is the
//               error text.
//   'aborted' — the stop button (abort()) ended the turn; chat() returned 'Stopped.'.
export type RunOutcome = 'ok' | 'cap' | 'error' | 'aborted'

// What chat() may be told about the turn it is starting. `resume: true` means "this is a
// follow-up turn of the SAME frame" (dispatch.ts's resumeFrame: a Tester REDO, a Planner
// replanning round, a task-start marker retry) — keep the frame's accumulated state and
// keep counting iterations from where the last turn stopped.
export interface ChatOptions {
  resume?: boolean
}

export class Agent {
  private ollama: Ollama
  private history: Message[] = []
  private model: string
  private options: ModelOptions = {}
  // Per-run toggle for the grounding guard (see runGroundingCheckpoint). Defaults to
  // config.grounding (env ARGO_GROUNDING, default ON); the web UI's "Grounding check"
  // toggle overrides it per run via setGrounding().
  private grounding = config.grounding
  // Per-run toggle for the LAYOUT JUDGE (see runLayoutCheckpoint) — the visual-layout
  // analogue of the grounding guard, for tasks that produced a viewable HTML
  // artifact. Defaults to config.layout (env ARGO_LAYOUT, default OFF — unproven);
  // overridable per instance via setLayout(), mirroring setGrounding.
  private layout = config.layout
  // Per-run toggles for the harness task ledger (ARGO_TASKS) and AGENTS.md/MEMORY.md
  // instrumentation (ARGO_MEMORY). Default to config (env), overridable per instance
  // via setTasks()/setMemory() — mirrors setGrounding so tests can toggle per Agent.
  // Every new code path in the loop is gated on THESE fields (not config directly),
  // so with both off behavior is byte-identical to the baseline.
  private tasks = config.tasks
  private memory = config.memory
  // Per-run toggle for the loop-recovery ladder (ARGO_LOOP), mirroring tasks/memory —
  // gated on THIS field so with it off behavior is byte-identical to the baseline.
  private loop = config.loopRecovery
  // Per-run toggle for auto-commit (ARGO_AUTOCOMMIT), OFF by default — gates the
  // autoCommit() call at the end of chat() (see setAutoCommit / chat()).
  private autoCommitEnabled = config.autoCommit
  private maxIterations: number = config.maxIterations
  private sessionId = ''
  private aborted = false
  // Fine-grained run phase, surfaced via getPhase() -> server.ts's GET /status ->
  // central's /api/workspaces aggregation, so the home screen's status dot can
  // show ready/running/compacting/error instead of just busy/idle. 'idle' between
  // runs (and briefly during compactNow's manual, between-runs compaction).
  private phase: 'idle' | 'running' | 'compacting' | 'error' = 'idle'
  // Persisted structured memory that survives across compactions — see compaction.ts.
  private compactionState: CompactionState = emptyCompactionState()
  // Rolling record of the last REPEAT_WINDOW executed (name+args) keys. Reset per
  // chat() run, never persisted — a legitimately repeated action in a later run
  // must start from a clean slate (see the repetition guard in chat()).
  private recentCalls: string[] = []
  // Mutation-aware loop-recovery ladder state (ARGO_LOOP). Reset per chat() run like
  // recentCalls — a legitimately repeated action in a later run starts clean.
  private loopState: LoopState = createLoopState()
  // Records when each this.history message entered the live context, keyed on the
  // message object itself (not its index/content) so it survives compaction's
  // splice/rebuild of this.history as long as surviving messages keep the same
  // object reference. Purely a UI concern for the context viewer (getContext) —
  // NEVER read by the model call path, so it cannot affect what is sent to Ollama.
  private historyTs = new WeakMap<object, number>()
  // Wall-clock time the most recent compaction finished, for the context viewer's
  // "Compaction ledger" box. null until the first compaction of this Agent instance.
  private lastCompactedAt: number | null = null
  // Harness-owned plan for the current run (objective + steps + revision). Recited
  // into the tail of context each iteration to fight goal-drift, and surfaced to
  // the UI as a 'plan' event. NEVER written to /workspace (not a committed
  // artifact). Reset per run (see chat()), so a trivial follow-up turn has no plan
  // and finishes immediately — the re-grounding done-gate only fires when a plan
  // exists, which is what keeps simple Q&A fast.
  private currentPlan: { objective: string; steps: string[]; revision: number } | null = null
  // Set by seedPlan(), consumed by chat()'s run-start reset (immediately after it
  // sets `this.currentPlan = null`) and cleared right after — see seedPlan's own
  // comment for why this indirection exists instead of seedPlan setting
  // currentPlan directly (that reset used to run AFTER seedPlan and silently wipe
  // it before the tool loop ever saw it). null on a resumed turn too: the reset
  // block that applies it only runs in the fresh-run branch, so a resumed frame
  // (which never re-seeds) can never accidentally re-apply a stale seed.
  private pendingSeed: string | null = null
  // HARNESS TASK LEDGER (ARGO_TASKS / this.tasks). Built from the LLM's plan in
  // handleUpdatePlan (createTaskList) and reconciled on a re-plan; the harness drives
  // it ONE task at a time (recite → verify → summary → advance). null until the first
  // plan and reset per run. All only read/written when this.tasks is on → baseline
  // untouched.
  private taskList: TaskList | null = null
  // Task ids whose verify command has already PASSED this run — lets the per-task
  // gate skip re-running a verify it already confirmed while it waits on the (once
  // per task) summary turn. Keyed by task id (reissued on every reconcile, so a
  // re-plan naturally starts fresh even for a same-titled task).
  private taskVerifyPassed = new Set<number>()
  // Task ids that have already been asked, once, for their per-task SUMMARY (the
  // capture step between verify passing/being absent and the actual advance). A
  // second no-tool-call turn for the SAME task id is treated as the model's summary
  // reply and advances the ledger. Replaces the old bare "confirm you're done" nudge.
  private taskSummaryAsked = new Set<number>()
  // Consecutive verify-command FAILURE count per task id, for the executable-verify
  // gate (Change 3). Keyed by task id (not title) — ids are reissued on every
  // reconcile, so a re-plan naturally starts a task's counter fresh even if it keeps
  // the same title. Cleared on verify success and on (re)plan; only ever grows when
  // this.tasks is on AND the active task carries a verify command. Guards against a
  // permanently-failing verify wedging the run: past VERIFY_FAIL_ESCALATE the steer
  // switches from "fix this" to "stop repeating yourself, reconsider or re-plan" —
  // maxIterations/the stall re-ground remain the actual hard backstop either way.
  private taskVerifyFails = new Map<number, number>()
  // Set once per run (and reset on a re-plan — see handleUpdatePlan) after the
  // FINAL RECONCILIATION steer has fired, so it cannot loop: the run-level done-gate
  // only injects it the FIRST time every task is done. A re-plan mid-reconciliation
  // clears it, so a later allDone re-arms exactly one more reconciliation pass. A
  // private field (not a local `let` in chat()) because handleUpdatePlan — reached
  // from deep inside the same loop — needs to reset it too.
  private finalReconciled = false
  // Raw AGENTS.md / MEMORY.md cached at run start when this.memory is on (read once).
  // AGENTS.md feeds section-selection for the system prompt; MEMORY.md is retrieved
  // task-scoped at the tail each step. Empty string when the file is absent/off.
  private agentsRaw = ''
  private memoryRaw = ''
  // ACTOR-CRITIC state (Phase 4, step 2). All reset per run and only ever READ
  // when config.critic is on — populating them is a harmless local append, so the
  // baseline loop path stays byte-identical. See runCriticCheckpoint / critic.ts.
  //   criticModel     — qwen3.6 self-critique model (env ARGO_CRITIC_MODEL).
  //   editedPaths     — unique file paths the actor edited/attempted (edit_file /
  //                     write_file), oldest→newest; test/spec files are flagged to
  //                     the critic so oracle-tamper detection never depends on the
  //                     model noticing the path. Records ATTEMPTS too (a failed
  //                     edit_file still ran) so intent-to-tamper is visible.
  //   lastCommandOutput — most recent bash result (truncated), the "latest test
  //                     output" the critic reviews.
  //   actionTrace     — short recent-action trace (compact labels), oldest→newest.
  private criticModel = config.criticModel
  private editedPaths: string[] = []
  // How many iterations THIS run actually consumed (1-based, updated every iteration
  // regardless of which exit path chat() ultimately takes) — what dispatch.ts reads to
  // decide whether a just-concluded frame was large enough to warrant an immediate
  // standup, on top of the aggregate action-episode counter (docs/subagents-plan.md).
  private lastIterationCount = 0
  // RESUME (H14, 2026-09-04). chat(msg, { resume: true }) continues an EXISTING frame:
  // iteration numbering picks up where the previous turn left off instead of restarting
  // at 1 (a marker-retry resume was observed reporting "ITER 1/10" for a frame that had
  // already spent iterations), and none of the per-run state below is wiped. This is
  // the count already consumed by earlier turns of the same frame; 0 for a fresh chat().
  private iterationBase = 0
  // HOW THE LAST chat() TURN ACTUALLY ENDED (H13, 2026-09-04) — the single fact that
  // used to be produced and then discarded at the frame boundary. 'cap' means the
  // iteration budget ran out with no final answer, in which case chat() RETURNS the
  // string "Reached maximum iterations (N) without a final answer." and also emits a
  // terminal `error` event; dispatch.ts's deriveFrameResult used to see only "a string
  // came back" and record status:'success' for it (measured: 43 blank cap-hit frames
  // recorded as success — Planner 9/23, Boss 26/204, Implementer 6/61, Tester 2/85,
  // baseline 7/194). Callers must consult this rather than re-deriving intent from the
  // returned text or from an iteration-count comparison (which resume now breaks: the
  // counter is cumulative across turns, so `count >= max` no longer means "stalled").
  private lastRunOutcome: RunOutcome = 'ok'
  // this.loopState.mutationCount recorded at the last 20/35/45 stall/progress
  // checkpoint (see chat()) — lets that checkpoint tell "genuinely stuck" apart from
  // "still landing real edits, just needed more than 20 iterations for a bigger task,"
  // which used to fire the same alarmed PROGRESS CHECK/STALL message either way (a
  // real false alarm observed on the aider-transpose eval task: steady edits, no
  // drift, still got nagged at iteration 20).
  private mutationCountAtLastStallCheck = 0
  // Trouble signals for THIS run, read by dispatch.ts (multi-agent) to decide whether
  // a just-concluded frame earns an IMMEDIATE Boss standup on top of the aggregate
  // action-episode counter (docs/subagents-plan.md, 2026-09-03 redesign) — a frame
  // that hit L1/L2 loop-recovery or needed an Ollama retry showed real friction even
  // if it eventually converged, which the aggregate counter alone wouldn't surface
  // for a short, single-frame task.
  private loopSteerEscalated = false // true once evaluateCall ever returns compact(L1) or replan(L2)
  private ollamaRetryCount = 0
  // MULTI-AGENT ARCHITECTURE (config.agents / ARGO_AGENTS, docs/subagents-plan.md). A
  // call frame is one scoped Agent instance: allowedTools restricts which tools are
  // offered to Ollama AND accepted by the tool-dispatch loop (null = unrestricted,
  // the baseline behavior); frameId correlates this instance's episodes/tool calls to
  // a ledger frame (null when not running as part of a dispatch — the baseline never
  // sets it, so episode recording to the ledger is a no-op then). episodes is the CWL
  // episode graph (see eviction.ts) for THIS instance's own history, reset per run.
  private allowedTools: ToolName[] | null = null
  private frameId: string | null = null
  private episodes: EpisodeMeta[] = []
  // Bounded excerpts of pages fetched this run (url + truncated content), so the
  // grounding guard can verify document specifics against what was ACTUALLY fetched
  // (the full fetch results survive in this.history, but this keeps a compact,
  // ready-to-inject copy). Populated only when config.critic || config.grounding.
  private fetchedSources: Array<{ url: string; content: string }> = []
  private lastCommandOutput = ''
  private actionTrace: string[] = []
  private get historyFile(): string {
    return path.join(LOGS_DIR, this.sessionId ? `history-${this.sessionId}.json` : 'history.json')
  }
  private get compactionStateFile(): string {
    return path.join(LOGS_DIR, this.sessionId ? `compaction-${this.sessionId}.json` : 'compaction.json')
  }

  // ollama is injectable only so tests can drive the loop deterministically
  // without a live model (same rationale as loadProjectContext's workspaceRoot);
  // production always uses the default client.
  constructor(
    private emit: (event: AgentEvent, seq?: number) => void,
    model?: string,
    ollama?: Ollama,
  ) {
    this.model = model ?? config.model
    this.ollama = ollama ?? new Ollama({ host: config.ollamaHost })
  }

  // Load full Ollama message history from disk for the current session.
  async loadPersistedHistory(): Promise<void> {
    this.history = []  // always reset before loading
    this.compactionState = emptyCompactionState()
    try {
      const raw = await fs.readFile(this.historyFile, 'utf-8')
      const saved = JSON.parse(raw)
      if (Array.isArray(saved) && saved.length > 0) {
        this.history = saved
        console.log(`[history] Restored ${saved.length} messages from ${this.historyFile}`)
      }
    } catch {
      // No history file — clean start
    }
    try {
      const raw = await fs.readFile(this.compactionStateFile, 'utf-8')
      this.compactionState = coerceCompactionState(JSON.parse(raw), emptyCompactionState())
    } catch {
      // No prior compaction state — clean start
    }
  }

  private async persistCompactionState(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.compactionStateFile), { recursive: true })
      await fs.writeFile(this.compactionStateFile, JSON.stringify(this.compactionState))
    } catch (err) {
      console.error('[compaction] Failed to persist state:', err)
    }
  }

  async saveHistory(): Promise<void> {
    if (this.history.length > 0) await this.persistHistory()
  }

  private async persistHistory(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true })
      const tmp = `${this.historyFile}.tmp`
      await fs.writeFile(tmp, JSON.stringify(this.history))
      await fs.rename(tmp, this.historyFile)
    } catch (err) {
      console.error('[history] Failed to save:', err)
    }
  }

  setModel(model: string) {
    this.model = model
  }

  setOptions(opts: ModelOptions) {
    this.options = opts
  }

  setMaxIterations(n: number) {
    this.maxIterations = Math.min(1000, Math.max(10, Math.trunc(n)))
  }

  setGrounding(on: boolean) {
    this.grounding = on
  }

  setLayout(on: boolean) {
    this.layout = on
  }

  setTasks(on: boolean) {
    this.tasks = on
  }

  setMemory(on: boolean) {
    this.memory = on
  }

  setLoop(on: boolean) {
    this.loop = on
  }

  // PER-FRAME MECHANISM POLICY (H17, 2026-09-04). One call that states EVERY mechanism
  // switch for this instance, instead of a scattering of optional setTasks/setMemory/
  // setLoop/setGrounding calls that a spawn site can silently forget (dispatch.ts's
  // spawnFrame forgot all four, so every role-scoped frame inherited the single-loop
  // baseline's mechanism set — see types.ts's FramePolicy for the measured consequence).
  // The individual setters above stay: they are how the web UI / server.ts toggle one
  // mechanism per session, and how the existing unit tests drive one at a time.
  setPolicy(policy: FramePolicy) {
    this.tasks = policy.tasks
    this.memory = policy.memory
    this.loop = policy.loop
    this.grounding = policy.grounding
    this.layout = policy.layout
  }

  // The policy actually in force — what a test asserts on, and what a future /status
  // endpoint should report per frame rather than re-reading config.*.
  getPolicy(): FramePolicy {
    return { tasks: this.tasks, memory: this.memory, loop: this.loop, grounding: this.grounding, layout: this.layout }
  }

  setAutoCommit(on: boolean) {
    this.autoCommitEnabled = on
  }

  // MULTI-AGENT ARCHITECTURE (config.agents). null restores unrestricted (baseline)
  // tool access — see frames.ts's ROLE_TOOLS for the per-role sets dispatch.ts passes.
  setAllowedTools(tools: ToolName[] | null) {
    this.allowedTools = tools
  }

  setFrameId(id: string | null) {
    this.frameId = id
  }

  // MULTI-AGENT ARCHITECTURE (config.agents, dispatch.ts). Seeds a plan for a frame
  // that ALREADY has a concrete objective before its first turn: dispatch.ts calls
  // this on every Implementer frame before chat() runs, with the top-level objective
  // for a TRIVIAL/SIMPLE task or a Planner step's own sub-objective for an OBJECTIVE
  // task. Forcing that same frame to restate its own assignment back through
  // update_plan just to satisfy the plan/act gate below is exactly the per-agent
  // busywork the gate was never meant to impose — a plan is an orchestration
  // artefact for decomposition ACROSS agents, not something every Implementer must
  // perform on itself before it can write.
  //
  // BUG FIX (2026-09-05, found via the seedPlan visibility test failing: expected 0
  // gate rejections, got 1): this used to set this.currentPlan DIRECTLY, right here,
  // at spawn time — but chat()'s own run-start reset (the fresh-run branch) then
  // unconditionally set this.currentPlan = null AFTER seedPlan ran and BEFORE the
  // tool loop ever saw it, silently wiping the seed before it took effect. Setting
  // this.pendingSeed instead defers the actual assignment to chat() itself,
  // immediately after that same reset line (see its own comment there) — the seed
  // now survives the reset because it's applied AFTER it, not before. pendingSeed is
  // cleared the instant it's applied, so it can never leak into a resumed turn
  // (which takes the OTHER branch of that same reset and never touches it).
  //
  // The plan/act gate itself (isProjectMutation && !this.currentPlan, below) is
  // UNCHANGED: this only ensures a SEEDED frame never reaches it with a null plan.
  // Any future caller that does NOT seed a plan hits the exact same gate as always —
  // it remains the safety net, not something this makes conditional.
  //
  // Deliberately does NOT touch this.taskList: an empty explicit step list wouldn't
  // meaningfully engage the per-task ledger gate anyway (every this.taskList check
  // site guards on `.tasks.length > 0`, and createTaskList(objective, []) is
  // vacuously "all done"), and this is a SEED, not a plan the model actually
  // composed. One real, accepted consequence: the harness's one-time "ALL PLANNED
  // TASKS ARE DONE" final-reconciliation nudge (chat(), guarded on `this.taskList`
  // being non-null) will not fire for a seeded frame — reported in
  // BOSS-READONLY.md rather than silently accepted. (2026-09-05 update: this is now
  // permanent for the Implementer, not just "unless it calls update_plan later" —
  // that role no longer holds the tool at all, see canUpdatePlan() below.)
  seedPlan(objective: string) {
    this.pendingSeed = objective
  }

  // UPDATE_PLAN REMOVED AS A CALLABLE TOOL FOR MULTI-AGENT ROLES (2026-09-05). With
  // seedPlan always called before chat() for every Implementer frame (the only role
  // that ever held update_plan — frames.ts's ROLE_TOOLS), no multi-agent agent ever
  // needs to set or refine its own plan; a real session had the Implementer call it
  // 8 times with identical content, producing 7 no-op revisions that read as log
  // noise (see handleUpdatePlan's own no-op-suppression comment). The BASELINE
  // single-loop agent (config.agents off — allowedTools stays null, no per-role
  // restriction) is the one exception: nothing seeds ITS plan, so update_plan is
  // still its only path to satisfy the plan/act gate at all — removing it there
  // would permanently block every write in Argo's default, non-multi-agent mode.
  // This predicate is the ONE place that distinction is made; every update_plan-
  // referencing string in this file branches on it instead of assuming either
  // universally. True for the baseline (`allowedTools === null`) and for any future
  // role whose ROLE_TOOLS entry still lists it — currently none.
  private canUpdatePlan(): boolean {
    return this.allowedTools === null || this.allowedTools.includes('update_plan')
  }

  // MULTI-AGENT ARCHITECTURE (config.agents): appended after the baseline SYSTEM_PROMPT
  // (whose tool-usage/filesystem conventions still apply to every role) — this is what
  // gives a role-scoped frame its distinct job description (frames.ts's
  // ROLE_SYSTEM_SUFFIX). Empty string (the default) leaves the baseline byte-identical.
  private roleInstructions = ''
  setRoleInstructions(text: string) {
    this.roleInstructions = text
  }

  // What dispatch.ts reads to build a FrameResult's filesTouched/filesWritten —
  // diff-derived from actual edit_file/write_file calls, not self-reported.
  getEditedPaths(): string[] {
    return this.editedPaths
  }

  // CUMULATIVE across a frame's turns (a resumed turn continues the count — see
  // iterationBase), so this is "how many iterations has this frame spent", not "how many
  // did its last turn spend". Do NOT compare it against getMaxIterations() to detect a
  // stall: use hitIterationCap(), which reports what actually happened.
  getIterationCount(): number {
    return this.lastIterationCount
  }

  getLastRunOutcome(): RunOutcome {
    return this.lastRunOutcome
  }

  // True ⇔ the last chat() turn ran out of iteration budget without producing a final
  // answer. This is the fact H13 needs at the frame boundary; it stays true until the
  // next chat() turn starts.
  hitIterationCap(): boolean {
    return this.lastRunOutcome === 'cap'
  }

  // A read-only snapshot of the per-frame state that a RESUME must preserve (H14) —
  // instrumentation for tests and for a future frame-state view. Deliberately reports
  // presence/counts rather than handing out the live objects, so nothing external can
  // mutate this instance's run state.
  getRunState(): {
    hasPlan: boolean
    hasTaskList: boolean
    taskListRevision: number
    episodes: number
    editedPaths: string[]
    iterationCount: number
    finalReconciled: boolean
    loopMutationCount: number
    hadTrouble: boolean
  } {
    // Same narrowing cast the rest of this file uses around currentPlan.
    const plan = this.currentPlan as { objective: string } | null
    const tl = this.taskList
    return {
      hasPlan: plan !== null,
      hasTaskList: tl !== null,
      taskListRevision: tl ? tl.revision : 0,
      episodes: this.episodes.length,
      editedPaths: [...this.editedPaths],
      iterationCount: this.lastIterationCount,
      finalReconciled: this.finalReconciled,
      loopMutationCount: this.loopState.mutationCount,
      hadTrouble: this.hadTrouble(),
    }
  }

  hadTrouble(): boolean {
    return this.loopSteerEscalated || this.ollamaRetryCount > 0
  }

  getMaxIterations(): number {
    return this.maxIterations
  }

  getPhase(): 'idle' | 'running' | 'compacting' | 'error' {
    return this.phase
  }

  setSessionId(id: string) { this.sessionId = id }

  abort() { this.aborted = true }

  // Sourced from config so it's env-tunable in production; held as a field only
  // so tests can drop it to 0 and not wait in real time. See chatWithRetry.
  private chatRetryDelayMs = config.chatRetryDelayMs
  setChatRetryDelayMs(ms: number) { this.chatRetryDelayMs = Math.max(0, Math.trunc(ms)) }

  // Push a message into the live context and record when it entered, so the
  // context viewer can show per-message timestamps. Same semantics as history.push.
  private pushCtx(m: Message): void {
    this.history.push(m)
    this.historyTs.set(m, Date.now())
  }

  // UNIFIED REJECTION SURFACING. Every harness-level block (the plan/act gate, a
  // role-restricted tool outside this frame's allowed set, a loop-steered repeat)
  // used to look completely different from a real tool failure — just a floating
  // 'warning' + a bare tool-role message, with no 'tool_call'/'tool_result' pair at
  // all. A real, observed failure mode: the model reads that as *nothing happened*
  // rather than *my action was rejected*, and proceeds as if a blocked edit had
  // actually landed (only discovering the truth several turns later when a test
  // still fails). Fix: make a rejection emit the EXACT same tool_call + tool_result
  // shape a genuine tool error does — indistinguishable in kind, so the model's
  // already-trained "my last call failed" recognition fires the same way either way.
  private rejectToolCall(name: ToolName, args: Record<string, unknown>, reason: string, emitAndLog: (e: AgentEvent) => void): void {
    emitAndLog({ type: 'tool_call', tool: name, args })
    emitAndLog({ type: 'tool_result', tool: name, output: '', error: reason, duration_ms: 0, rejected: true })
    this.pushCtx({ role: 'tool', content: `Error: ${reason}` })
  }

  // H21 (2026-09-04, /shared/argo-gateloop/REPORT.md). Wraps rejectToolCall for the
  // two gates that `continue` straight past the loop-recovery ladder on a
  // rejection — the role gate and the plan/act gate (see their call sites below) —
  // so an identical (call, reason) pair refused over and over is counted, and
  // eventually bounded, the same way the ladder already bounds an identical
  // EXECUTED call. Captured live: two Planner frames issued 9 and 7 rejected
  // `bash` calls, all refused on role, with nothing watching (DRIVER-LOG.md,
  // 2026-09-04 ~01:00) — genuinely invisible before this change, since the role
  // gate's `continue` never reached evaluateCall.
  //
  // Returns null once the rejection has been emitted and the caller should
  // `continue` the tool-call loop as before (the overwhelmingly common case —
  // below cfg.gateStopAfter). Returns the STOP message once the (call, reason)
  // pair has been refused cfg.gateStopAfter times in a row: the caller must then
  // END THE FRAME (see the two call sites below) rather than continue, exactly
  // like a genuine iteration-cap hit — never `continue` past a non-null return, or
  // the frame just keeps asking (and being refused) the same thing forever, which
  // is precisely the hole this closes.
  //
  // Gated on `this.loop` (ARGO_LOOP) — see this method's call sites for why this
  // belongs under the SAME flag as the rest of the loop-recovery ladder rather
  // than a separate one: with the flag off, `key` is undefined and this falls
  // through to the plain, pre-H21 rejection unconditionally (byte-identical to
  // before this change).
  private handleGateRejection(
    name: ToolName,
    args: Record<string, unknown>,
    key: string | undefined,
    reason: GateReason,
    plainMessage: string,
    emitAndLog: (e: AgentEvent) => void,
  ): string | null {
    if (!this.loop || key === undefined) {
      this.rejectToolCall(name, args, plainMessage, emitAndLog)
      return null
    }
    const outcome = noteGateRejection(this.loopState, key, reason)
    if (outcome.escalate) this.loopSteerEscalated = true  // friction, same as an L1/L2 ladder firing — see hadTrouble()
    if (outcome.stop) {
      const stopMsg = gateStopMessage(reason, name, outcome.count)
      this.rejectToolCall(name, args, stopMsg, emitAndLog)
      return stopMsg
    }
    const message = outcome.escalate
      ? gateEscalationMessage(reason, name, outcome.count, this.buildLoopRecite())
      : plainMessage
    this.rejectToolCall(name, args, message, emitAndLog)
    return null
  }

  // H21. Ends the CURRENT chat() turn as a stall — a call refused/repeated so many
  // times in a row that continuing would only produce more identical refusals
  // (see handleGateRejection above and the loop-recovery ladder's 'halt' kind
  // below). Reuses the existing 'cap' RunOutcome rather than adding a new value:
  // dispatch.ts's deriveFrameResult ALREADY maps 'cap' -> FrameStatus 'partial'
  // (never 'success' — the exact "never fail open" property this must have, and
  // the one this project already fixed once after 43 frames were found recorded
  // success at a blank cap-hit). Reusing it means this closes the hole with ZERO
  // changes outside this scoop's owned files: no new RunOutcome member, no
  // dispatch.ts edit, no risk of a status this method's caller forgot to map. The
  // cost is that dispatch.ts's cap-hit issue text ("frame hit its iteration cap...
  // without producing a final answer") is imprecise about WHY here — see
  // /shared/argo-gateloop/REPORT.md for the sharper alternative (a dedicated
  // RunOutcome + a one-line dispatch.ts patch) offered but not applied, since it
  // is not owned here and shipping it without that patch landing atomically would
  // itself fail open.
  private endFrameStalled(message: string, emitAndLog: (e: AgentEvent) => void): string {
    this.lastRunOutcome = 'cap'
    emitAndLog({ type: 'error', message })
    this.phase = 'idle'
    return message
  }

  // LOOP-RECOVERY LADDER, L0 cached-replay form (ARGO_LOOP; H20). Unlike
  // rejectToolCall above — which deliberately frames a block as an ERROR so the
  // model can't tell a harness rejection from a real failure — a replay is telling
  // the model something true and useful: this exact call already ran, nothing has
  // changed, and here again is exactly what it returned. Still marked rejected
  // (the tool did not actually run a second time — see AgentEvent's doc comment)
  // plus replayed (this specific reason for not running it), and still gets the
  // same tool_call/tool_result event PAIR every other outcome here gets, so
  // analytics can tell "really executed" / "harness blocked" / "harness replayed"
  // apart without guessing from message text.
  private replayToolCall(name: ToolName, args: Record<string, unknown>, cached: { output: string; error?: string }, label: string, emitAndLog: (e: AgentEvent) => void): void {
    emitAndLog({ type: 'tool_call', tool: name, args })
    emitAndLog({ type: 'tool_result', tool: name, output: cached.output, error: cached.error, duration_ms: 0, rejected: true, replayed: true })
    const body = cached.error ? `Error: ${cached.error}\n${cached.output}` : cached.output
    this.pushCtx({ role: 'tool', content: `${label}\n\n[Previous result, reproduced verbatim — nothing has changed]\n${body}` })
  }

  // Lets the user force compaction between turns (server.ts's POST /compact-now,
  // guarded the same way /reset is — only when the agent isn't mid-run). Reuses
  // compactHistory exactly as the automatic 66.7%-threshold path does: the most
  // recent message and a bounded antecedent survive verbatim, only older
  // material gets folded into CompactionState. Writes its own tiny run-shaped
  // log (JSONL/MD pair) so the manual trigger is traceable the same way an
  // automatic compaction is — see Phase 7's logging audit.
  async compactNow(): Promise<{ compacted: boolean }> {
    if (this.history.length === 0) return { compacted: false }
    const logger = new SessionLogger('Manual context compaction', this.model, this.options, this.sessionId)
    const emitAndLog = (event: AgentEvent) => {
      logger.log(event)
      this.emit(event, logger.getSeq())   // seq for UI replay/live dedup (see chat())
    }
    try {
      const currentRunStart = this.history.length - 1
      this.phase = 'compacting'
      const result = await this.compactHistory(currentRunStart, 0, emitAndLog, true)
      if (result.compacted) await this.persistHistory()
      return { compacted: result.compacted }
    } finally {
      this.phase = 'idle'
      await logger.flush()
    }
  }

  // Splits history around the active run (see compaction.ts:splitForCompaction),
  // folds the "prior" portion into persisted structured state — updated, then
  // validated against its own source rather than trusted blindly — and
  // separately compresses the active run's own middle iterations if it has
  // grown long. The active prompt, the antecedent turn, and a recent verbatim
  // tail are never touched. Returns the active prompt's new index, since an
  // earlier compaction within the same run invalidates whatever index the
  // caller was tracking.
  private async compactHistory(
    currentRunStart: number,
    contextUsagePct: number,
    emitAndLog: (e: AgentEvent) => void,
    manual = false,
  ): Promise<{ newRunStart: number; compacted: boolean }> {
    // MULTI-AGENT ARCHITECTURE (config.agents): replaces LLM-summarization compaction
    // with CWL-style deterministic episode eviction (docs/subagents-plan.md, "Context
    // management") — no LLM call, and unlike compaction it never restructures
    // this.history's indices, so currentRunStart stays valid unchanged. compaction.ts's
    // structured-summary path is kept only as the pre-existing (baseline) behavior when
    // this flag is off.
    if (config.agents) {
      const msgsBefore = this.history.length
      const { messages, evictedEpisodeIds } = evict(this.history, this.episodes)
      if (evictedEpisodeIds.length === 0) return { newRunStart: currentRunStart, compacted: false }
      this.history = messages
      this.lastCompactedAt = Date.now()
      if (this.frameId) {
        for (const id of evictedEpisodeIds) {
          try {
            await markEpisodeEvicted(config.workspacePath || '/workspace', id)
          } catch (err) {
            emitAndLog({ type: 'warning', message: `Marking episode evicted failed (${err instanceof Error ? err.message : String(err)}) — continuing` })
          }
        }
      }
      emitAndLog({
        type: 'compact',
        summary: `deterministic eviction: stubbed ${evictedEpisodeIds.length} episode(s) (recoverable via ledger expand)`,
        messagesBefore: msgsBefore,
        messagesAfter: this.history.length,
        contextUsagePct,
        rangeDescription: `evicted ${evictedEpisodeIds.length} episode(s), oldest-action-first`,
        validated: false,
        manual,
      })
      return { newRunStart: currentRunStart, compacted: true }
    }

    const msgsBefore = this.history.length
    const split = splitForCompaction(this.history, currentRunStart)

    if (split.prior.length === 0 && split.activeMiddle.length === 0) {
      return { newRunStart: currentRunStart, compacted: false }
    }

    emitAndLog({ type: 'compact_start', messageCount: msgsBefore, contextUsagePct, manual })

    let validated = false
    if (split.prior.length > 0) {
      const draft = await withCompactHeartbeat(
        updateCompactionState(this.ollama, this.model, this.options, this.compactionState, split.prior),
        config.compactTimeoutMs,
        'updating working memory',
        emitAndLog,
      )
      const sourceWorkLog = messagesToText(split.prior)
      const result = await withCompactHeartbeat(
        validateCompactionState(this.ollama, this.model, this.options, sourceWorkLog, draft),
        config.compactTimeoutMs,
        'validating update',
        emitAndLog,
      )
      this.compactionState = result.state
      validated = true
    }

    let activeWorkingState = split.activeMiddle.length > 0
      ? await withCompactHeartbeat(
          summarizeActiveMiddle(this.ollama, this.model, this.options, split.activeMiddle),
          config.compactTimeoutMs,
          'summarizing active run',
          emitAndLog,
        )
      : ''

    // The active summary was produced in a single unvalidated call and can
    // re-present something this.compactionState already recorded as invalidated
    // (a real incident: the superseded DOM-snapshot approach). Validate it
    // against the just-updated, authoritative state — not just its own source
    // messages, which may legitimately still contain the earlier discussion.
    // See compaction.ts:validateActiveSummary.
    if (activeWorkingState) {
      const activeResult = await withCompactHeartbeat(
        validateActiveSummary(
          this.ollama,
          this.model,
          this.options,
          activeWorkingState,
          messagesToText(split.activeMiddle),
          this.compactionState,
        ),
        config.compactTimeoutMs,
        'validating active summary',
        emitAndLog,
      )
      activeWorkingState = activeResult.summary
    }

    const priorMessage: Message = { role: 'assistant', content: renderCompactionState(this.compactionState) }
    const activeStateMessages: Message[] = activeWorkingState
      ? [{ role: 'assistant', content: `ACTIVE WORKING STATE (current task, in progress — compressed from earlier iterations of this same turn)\n\n${activeWorkingState}` }]
      : []

    this.history = [
      priorMessage,
      ...split.antecedent,
      split.currentPrompt,
      ...activeStateMessages,
      ...split.activeTail,
    ]

    this.lastCompactedAt = Date.now()
    for (const m of [priorMessage, ...activeStateMessages]) this.historyTs.set(m, this.lastCompactedAt)
    const newRunStart = 1 + split.antecedent.length
    const msgsAfter = this.history.length

    await this.persistCompactionState()

    // ARGO_MEMORY (this.memory), Stage 1: persist durable ledger items (verified facts +
    // decisions the compaction distilled) into the workspace MEMORY.md so they survive
    // across runs. persistToMemory dedupes against existing content. Only persist when
    // there is something to persist, and wrap it so a failure NEVER breaks compaction or
    // the run (emit a warning at most). Uses the '/workspace' root convention.
    if (this.memory) {
      const durable = [...this.compactionState.verifiedFacts, ...this.compactionState.decisionsMade]
      if (durable.length > 0) {
        try {
          // persistToMemory now REJECTS non-durable items at the write boundary (H15,
          // 2026-09-04): compaction's own distillation input is a rendered transcript
          // (compaction.ts's messagesToText emits `Called bash({...})` / `Result: ...`),
          // the prompt tells the model to copy tool-confirmed items verbatim, and this
          // call wrote them straight to a file that is then re-injected into every later
          // run in the workspace — the mechanism degraded its own future input. Surfaced
          // as a warning rather than dropped silently: a rejection means the distillation
          // prompt is producing transcript, which is worth seeing in the logs.
          const res = await persistToMemory(path.join('/workspace', 'MEMORY.md'), durable)
          if (res.rejected.length > 0) {
            emitAndLog({
              type: 'warning',
              message: `MEMORY.md write filtered ${res.rejected.length} non-durable item(s): `
                + res.rejected.map(r => `${r.reason} — ${r.item.slice(0, 80)}`).join(' | '),
            })
          }
        } catch (err) {
          emitAndLog({ type: 'warning', message: `MEMORY.md persist failed (${err instanceof Error ? err.message : String(err)}) — continuing` })
        }
      }
    }

    const rangeDescription = `folded ${split.prior.length} prior message(s) into structured state`
      + (split.activeMiddle.length > 0 ? `, summarized ${split.activeMiddle.length} active-run message(s)` : '')
      + `, kept ${split.antecedent.length} antecedent + current prompt + ${split.activeTail.length} recent verbatim`

    emitAndLog({
      type: 'compact',
      summary: renderCompactionState(this.compactionState),
      ...(activeWorkingState ? { activeWorkingStateSummary: activeWorkingState } : {}),
      messagesBefore: msgsBefore,
      messagesAfter: msgsAfter,
      contextUsagePct,
      rangeDescription,
      validated,
      manual,
    })

    return { newRunStart, compacted: true }
  }

  // Issues one main per-iteration chat call (system prompt + full history) with
  // the standard timeout. Extracted only so chatWithRetry can re-issue the
  // *identical* request on retry without duplicating the argument literal.
  // Return type is intentionally inferred (Promise<ChatResponse>) to avoid
  // importing the ollama response type.
  private chatCall(systemPrompt: string) {
    // Deterministic context editing (Tier-0, no LLM): the model only needs recent
    // tool outputs verbatim; older large ones are collapsed to a short, restorable
    // stub so the LIVE window it sees stays small over long runs — which is what
    // keeps small local models emitting native tool calls (measured: native-call
    // reliability falls as context grows). NON-destructive: this.history keeps the
    // full results (the JSONL log and compaction still see everything); only what
    // is SENT to the model shrinks. This is the cheapest way to hold the window
    // small over many turns, and it makes the (expensive) LLM compaction fire less.
    const toolPos: number[] = []
    this.history.forEach((m, i) => { if (m.role === 'tool') toolPos.push(i) })
    const collapse = new Set(toolPos.slice(0, Math.max(0, toolPos.length - KEEP_RECENT_TOOL_RESULTS)))
    const messages: Message[] = [{ role: 'system', content: systemPrompt }]
    this.history.forEach((m, i) => {
      const c = m.content
      if (collapse.has(i) && typeof c === 'string' && c.length > TOOL_RESULT_COLLAPSE_OVER) {
        messages.push({ role: 'tool', content: `[older tool output collapsed — ${c.length} chars; re-read the file or re-run the command if you need it]\n${c.slice(0, 200).replace(/\s+/g, ' ')}…` })
      } else {
        messages.push(m)
      }
    })
    // Recitation (Manus todo.md pattern): keep the current plan at the very tail
    // of context every iteration so the objective stays in the model's recent
    // attention and doesn't get lost mid-history over a long run. Transient — not
    // stored in this.history, rebuilt from this.currentPlan each call — so it can
    // never duplicate or drift out of sync with the live plan, and it survives
    // compaction (which only rewrites this.history) for free.
    // When the task ledger is active (this.tasks) recite the FULL ledger (GOAL +
    // checkboxes + CURRENT task) instead of the single-plan reminder — the #1 lever for
    // holding a small model on the current task. Otherwise the baseline plan reminder is
    // pushed unchanged. Read the ledger via a cast (same narrowing gotcha as chat()).
    const reciteList = this.taskList as TaskList | null
    if (this.tasks && reciteList && reciteList.tasks.length > 0) {
      messages.push({ role: 'tool', content: renderTaskLedger(reciteList) })
    } else if (this.currentPlan) {
      messages.push({ role: 'tool', content: this.renderPlanReminder(this.currentPlan) })
    }
    // Task-scoped MEMORY.md retrieval (this.memory): auto-inject the relevant durable
    // memory entries for the current work at the tail. Never model-fetched; a recall
    // pointer already OFFERS the full file (see buildProjectMemoryContext).
    if (this.memory && this.memoryRaw) {
      const mem = selectMemoryEntries(this.memoryRaw, this.retrievalQuery())
      if (mem.text) {
        messages.push({ role: 'tool', content: `RELEVANT MEMORY (from MEMORY.md, for the current work):\n${mem.text}` })
      }
    }
    // Task-scoped AGENTS.md (this.memory): when the file is large it is NOT in the system
    // prompt (see buildProjectMemoryContext) — inject only the sections relevant to the
    // CURRENT task at the tail, re-selected each step via retrievalQuery(), so project
    // instructions track the active task the same way MEMORY.md does. A small (whole)
    // AGENTS.md is already fully in the system prompt, so skip it here to avoid duplication.
    if (this.memory && this.agentsRaw) {
      const asel = selectAgentsSections(this.agentsRaw, this.retrievalQuery())
      if (asel.mode === 'selected' && asel.text) {
        messages.push({ role: 'tool', content: `RELEVANT PROJECT INSTRUCTIONS (from AGENTS.md, for the current task):\n${asel.text}` })
      }
    }
    // MULTI-AGENT ARCHITECTURE (config.agents): a role-scoped frame only offers Ollama
    // the tools in this.allowedTools (frames.ts's ROLE_TOOLS); null (baseline, and
    // every existing caller) offers the full set unchanged.
    const offeredTools = this.allowedTools
      ? toolDefinitions.filter(t => this.allowedTools!.includes(t.function.name as ToolName))
      : toolDefinitions
    return withTimeout(this.ollama.chat({
      model: this.model,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: offeredTools as any[],
      stream: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: this.options as any,
    }), config.chatTimeoutMs)
  }

  // The main per-iteration chat call with ONE automatic retry. This is safe to
  // retry (and only this call — never tool execution): it runs before any tool
  // has executed this iteration, so nothing has side-effected yet, making it
  // idempotent from the loop's perspective. A failure here — withTimeout's own
  // timeout, or a thrown error from the Ollama client (e.g. its Go backend
  // rejecting a malformed qwen3.6 tool-call as an XML parse error) — used to end
  // the entire run at the outer catch with no retry and no user action. Since
  // temperature is > 0 the re-issued identical request has a real chance of
  // succeeding. Only one retry is attempted: a second failure is rethrown to
  // chat()'s outer catch (the existing safety net). Returns null iff the user
  // aborted during the retry wait, so the caller stops instead of retrying into
  // a run the user already asked to stop. Return type inferred as
  // Promise<ChatResponse | null>.
  private async chatWithRetry(systemPrompt: string, emitAndLog: (e: AgentEvent) => void) {
    try {
      return await this.chatCall(systemPrompt)
    } catch (err) {
      this.ollamaRetryCount++
      emitAndLog({ type: 'warning', message: `Ollama request failed (${err instanceof Error ? err.message : String(err)}) — retrying once` })
      await new Promise(resolve => setTimeout(resolve, this.chatRetryDelayMs))
      if (this.aborted) return null
      return await this.chatCall(systemPrompt)
    }
  }

  private renderPlanReminder(plan: { objective: string; steps: string[] }): string {
    const steps = plan.steps.length
      ? `\nSteps:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : ''
    // 2026-09-05: the closing instruction used to say "Refine it with update_plan
    // only if the work contradicts an assumption" — a real instruction for the
    // baseline agent, a reference to a tool that does not exist for a seeded
    // multi-agent Implementer (canUpdatePlan() false — frames.ts's ROLE_TOOLS no
    // longer lists it there). Branches the same way buildSystemPrompt does.
    const closing = this.canUpdatePlan()
      ? 'Refine it with update_plan only if the work contradicts an assumption; finish only once the objective is verifiably met.'
      : 'Stay on this objective; do not drift to a different goal. If it cannot be met as scoped, say so explicitly in your final answer rather than grinding indefinitely — state what you tried, what failed, and why. Finish only once the objective is verifiably met.'
    return `[CURRENT PLAN — keep working toward this objective; do not drift onto a broader or different goal]\nObjective: ${plan.objective}${steps}\n${closing}`
  }

  // Re-anchor text for the loop-recovery steer (this.loop): the same objective/plan
  // recitation the context tail already uses (see the recite block in chatCall) —
  // task ledger when this.tasks is on and a ledger is active, else the plan objective.
  private buildLoopRecite(): string {
    const reciteList = this.taskList as TaskList | null
    if (this.tasks && reciteList && reciteList.tasks.length > 0) {
      return renderTaskLedger(reciteList)
    } else if (this.currentPlan) {
      return `Objective: ${(this.currentPlan as { objective: string }).objective}`
    }
    return ''
  }

  // Builds the task-scoped relevance query for MEMORY.md / AGENTS.md retrieval
  // (this.memory): the current objective + active task title (topical prose) plus the
  // recently edited paths (strong topical hints). Reads currentPlan/taskList via casts
  // (the narrowing gotcha) and guards nulls, so it is safe when no plan/ledger exists.
  private retrievalQuery(): RelevanceQuery {
    const plan = this.currentPlan as { objective: string } | null
    const tl = this.taskList as TaskList | null
    const active = tl ? activeTask(tl) : null
    const text = [plan?.objective, active?.title].filter(Boolean).join('. ')
    return { text, files: this.editedPaths.slice(-8) }
  }

  // ARGO_MEMORY (this.memory): builds the system-prompt project-context block via the
  // memory module instead of loadProjectContext. AGENTS.md is injected WHOLE into the
  // system prompt only when it is small; when it is large it is section-selected PER
  // TASK at the tail instead (see chatCall) — matching MEMORY.md — so instructions are
  // reconsidered for each task rather than frozen at the initial request. A recall
  // pointer OFFERS the full files on disk either way. MEMORY.md is deliberately NOT
  // whole-injected here — it is retrieved task-scoped at the tail each step (see
  // chatCall) — but its raw text is cached for that retrieval. Both files are read ONCE
  // per run (via the same readProjectContextFile + PROJECT_CONTEXT_CHAR_CAP as
  // loadProjectContext), using the '/workspace' root convention. When this.memory is
  // off, chat() calls loadProjectContext() unchanged, so the baseline system prompt is
  // byte-identical.
  private async buildProjectMemoryContext(userMessage: string): Promise<string> {
    const [agentsMd, memoryMd] = await Promise.all([
      readProjectContextFile(path.join('/workspace', 'AGENTS.md')),
      readProjectContextFile(path.join('/workspace', 'MEMORY.md')),
    ])
    this.agentsRaw = agentsMd ?? ''
    this.memoryRaw = memoryMd ?? ''
    // Only whole-file AGENTS.md goes into the system prompt. When it's large (selected),
    // inject nothing here — the per-task tail injection in chatCall handles it, and the
    // recall pointer below already tells the model the full file is on disk.
    const sel = selectAgentsSections(this.agentsRaw, { text: userMessage })
    const agentsBlock = (sel.mode === 'whole' && sel.text) ? '--- /workspace/AGENTS.md (project instructions) ---\n' + sel.text : ''
    const pointer = renderRecallPointer({ agentsPresent: !!this.agentsRaw, memoryPresent: !!this.memoryRaw })
    return [agentsBlock, pointer].filter(Boolean).join('\n\n')
  }

  // Harness handler for the update_plan tool. Sets the run's plan, surfaces it as
  // a 'plan' event (rendered in the UI like a message and logged for replay), and
  // returns the confirmation that becomes the tool result in history. Because the
  // model reaches this via a tool call, recording a plan never trips the
  // "no tool call = done" terminal condition — the failure that made a plan-as-prose
  // turn end the run.
  private handleUpdatePlan(args: Record<string, unknown>, emitAndLog: (e: AgentEvent) => void): string {
    const objective = typeof args.objective === 'string' ? args.objective.trim() : ''
    // Raw steps as the model supplied them — each entry may be plain text OR
    // {task, verify} (see update_plan's schema). Passed through UNCHANGED to
    // createTaskList/reconcileTasks; the string-vs-object normalization lives in
    // tasks.ts, not here. Cast at this boundary (untrusted tool-call JSON meeting a
    // typed internal API) exactly like the other this.currentPlan/this.taskList
    // narrowing casts in this file.
    const rawSteps = (Array.isArray(args.steps) ? args.steps : []) as StepInput[]
    // Title-only view for this.currentPlan / the 'plan' event / the plain-plan
    // reminder (renderPlanReminder) — those only ever show step TEXT; the verify
    // command itself is surfaced solely through the task ledger it feeds.
    const steps = rawSteps
      .map(s => (typeof s === 'string' ? s : s.task))
      .map(s => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
    if (!objective) {
      return 'update_plan needs an "objective": one concrete, verifiable success criterion. Nothing was recorded — call it again with an objective.'
    }
    // NO-OP SUPPRESSION (2026-09-05): a real session had the Implementer call
    // update_plan 8 times with byte-for-byte the same objective/steps — 7 of those
    // bumped the revision and emitted a 'plan' event for literally nothing, and the
    // resulting log noise led the owner to suspect the TESTER was causing them.
    // Compared with normalised (trim + collapse-internal-whitespace) equality only —
    // deliberately NOT a fuzzy/prefix match: this is "nothing changed at all", not
    // "close enough" — and deliberately position-sensitive on steps (a reorder IS a
    // real change worth a revision). this.currentPlan is null only before the FIRST
    // ever update_plan call, which can never be a no-op by definition.
    if (this.currentPlan) {
      const normalize = (s: string) => s.trim().replace(/\s+/g, ' ')
      const current = this.currentPlan
      const sameObjective = normalize(current.objective) === normalize(objective)
      const sameSteps = current.steps.length === steps.length
        && current.steps.every((s, i) => normalize(s) === normalize(steps[i]))
      if (sameObjective && sameSteps) {
        return 'Plan unchanged — no revision needed.'
      }
    }
    const revision = (this.currentPlan?.revision ?? 0) + 1
    this.currentPlan = { objective, steps, revision }
    // H21: the plan/act gate's OWN condition (`!this.currentPlan`) just became
    // false for every call, project-wide — not just for whichever call happened to
    // trigger this update_plan. Its gate-rejection counts must clear the same way
    // (see noteGateRejection's reset-semantics doc comment in loop.ts); harmless
    // no-op on a re-plan revision or when nothing was ever counted.
    if (this.loop) clearPlanGateRejections(this.loopState)
    emitAndLog({ type: 'plan', objective, steps, revision })
    // HARNESS TASK LEDGER (this.tasks): instrument the plan as an ordered ledger. The
    // FIRST plan builds it (createTaskList); a later update_plan is a RE-PLAN that
    // reconciles into the existing ledger (completed tasks frozen, revision bumps,
    // summaries carried forward for tasks preserved as done). A re-plan resets the
    // per-task verify/summary state so the (possibly re-ordered) current task gets a
    // fresh verify + summary gate. Read the existing ledger via a cast — TS can't see
    // that handleUpdatePlan mutates this.taskList, so after the run-start reset it
    // narrows the field to null (same gotcha as the activePlan cast in chat()).
    if (this.tasks) {
      const existing = this.taskList as TaskList | null
      const replanned = existing !== null
      // `existing !== null` (not the `replanned` const) so TS narrows `existing` to
      // TaskList inside the true branch of the ternary.
      this.taskList = existing !== null
        ? reconcileTasks(existing, objective, rawSteps)
        : createTaskList(objective, rawSteps)
      // A re-plan reissues task ids (reconcile), so any per-task verify-pass/verify-
      // fail/summary-asked state keyed on the OLD ids is meaningless against the new
      // ledger — clear it so the (possibly re-ordered/re-verified) current task
      // starts clean, and re-arm the final reconciliation gate (it may have just
      // fired the steer that CAUSED this re-plan; once the newly re-opened work is
      // allDone again, reconciliation should be able to fire once more).
      this.taskVerifyPassed.clear()
      this.taskSummaryAsked.clear()
      this.taskVerifyFails.clear()
      this.finalReconciled = false
      const tl = this.taskList as TaskList
      const done = tl.tasks.filter(t => t.status === 'done').length
      emitAndLog({
        type: 'tasks',
        action: replanned ? 'replanned' : 'planned',
        revision,
        done,
        total: tl.tasks.length,
        current: activeTask(tl)?.title ?? null,
      })
    }
    const label = revision === 1 ? 'Plan recorded' : `Plan updated (revision ${revision})`
    const stepsText = steps.length ? `\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}` : ''
    return `${label}. Objective: ${objective}${stepsText}\nNow execute toward this objective — keep going, do not stop until it is verifiably met.`
  }

  // ACTOR-CRITIC checkpoint (Phase 4, step 2). Runs the qwen3.6 self-critique
  // over compact, already-tracked run state (objective, plan, files edited with
  // test/spec flags, latest command output, recent trace), emits a 'critic' event
  // for auditability, and — when the verdict is "revise" or gamed_oracle — injects
  // the guidance as a `warning`-type steer through the SAME mechanism the plan/act
  // gate, loop-steer, stall, and done-gate all use (no parallel plumbing). Returns
  // the parsed Critique (or null) so the PRE-DONE caller can block completion.
  //
  // Fails OPEN: a critic timeout/error/unparseable reply yields null and only a
  // warning — it never crashes a run and never blocks completion on its own. Only
  // ever reached when config.critic is on, so the baseline path is untouched.
  private async runCriticCheckpoint(
    checkpoint: CriticCheckpoint,
    objective: string,
    planSteps: string[],
    emitAndLog: (e: AgentEvent) => void,
  ): Promise<Critique | null> {
    const input = {
      checkpoint,
      objective,
      planSteps,
      filesEdited: this.editedPaths.map(p => ({ path: p, testOrSpec: isTestOrSpecPath(p) })),
      latestOutput: this.lastCommandOutput,
      recentActionTrace: this.actionTrace.slice(-12),
    }
    let critique: Critique | null = null
    try {
      critique = await withTimeout(
        runCritic(this.ollama, this.criticModel, this.options, input),
        config.chatTimeoutMs,
      )
    } catch (err) {
      emitAndLog({ type: 'warning', message: `Critic (${checkpoint}) failed (${err instanceof Error ? err.message : String(err)}) — continuing without critique` })
      return null
    }
    if (!critique) {
      emitAndLog({ type: 'warning', message: `Critic (${checkpoint}) returned no parseable verdict — continuing without critique` })
      return null
    }

    emitAndLog({
      type: 'critic',
      checkpoint,
      verdict: critique.verdict,
      gamed_oracle: critique.gamed_oracle,
      issues: critique.issues,
      guidance: critique.guidance,
    })

    if (critique.gamed_oracle || critique.verdict === 'revise') {
      const tamperReminder = critique.gamed_oracle
        ? '\nDo NOT edit, weaken, delete, rename, or skip any test/spec file — that is oracle tampering. Revert any such change and implement the feature in the SOURCE modules so the UNCHANGED tests judge it.'
        : ''
      const issuesText = critique.issues.length ? `\nIssues: ${critique.issues.join('; ')}` : ''
      const guidanceText = critique.guidance ? `\n${critique.guidance}` : ''
      const steer = `CRITIC (${checkpoint}) — revise before continuing.${guidanceText}${issuesText}${tamperReminder}`
      emitAndLog({ type: 'warning', message: steer })
      this.pushCtx({ role: 'tool', content: steer })
    }
    return critique
  }

  // GROUNDING & self-consistency checkpoint (Phase 4) — the writing-task analogue of
  // the coding critic. Only reached when config.grounding is on. Runs at PRE-DONE for
  // a WRITING/RESEARCH task (the run produced a document artifact): reads that doc,
  // runs a deterministic numeric-conflict pre-scan, then a fact-checking critic pass
  // that flags fabricated/unsupported specifics + internal contradictions. On "revise"
  // it injects a concrete steer and the caller BLOCKS completion (the loop continues).
  // Returns null (no block) when it is not a writing task or the critic won't parse.
  // Fails OPEN: any timeout/error yields null and only a warning.
  private async runGroundingCheckpoint(
    objective: string,
    emitAndLog: (e: AgentEvent) => void,
  ): Promise<Critique | null> {
    const docPaths = this.editedPaths.filter(isDocPath)
    if (docPaths.length === 0) return null // not a writing task — nothing to ground

    let docText = ''
    for (const p of docPaths) {
      try {
        const r = await executeTool('read_file', { path: p })
        docText += `\n\n===== ${p} =====\n${r.output || ''}`
      } catch { /* unreadable — skip */ }
      if (docText.length > 14000) break
    }
    docText = docText
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 9000)
    if (!docText) return null

    const numericConflicts = findNumericConflicts(docText)
    // Feed the critic the pages actually fetched (bounded) so it verifies specifics
    // against real source text instead of guessing — this prevents false positives
    // that would make the actor strip correct, well-sourced facts.
    const sourceExcerpts = this.fetchedSources.slice(0, 8).map(s => ({ url: s.url, text: s.content }))

    let critique: Critique | null = null
    try {
      critique = await withTimeout(
        runGroundingCritic(this.ollama, this.criticModel, this.options, { objective, docText, sourceExcerpts, numericConflicts }),
        config.chatTimeoutMs,
      )
    } catch (err) {
      emitAndLog({ type: 'warning', message: `Grounding guard failed (${err instanceof Error ? err.message : String(err)}) — continuing without it` })
      return null
    }
    if (!critique) {
      emitAndLog({ type: 'warning', message: 'Grounding guard returned no parseable verdict — continuing without it' })
      return null
    }

    emitAndLog({
      type: 'critic',
      checkpoint: 'grounding',
      verdict: critique.verdict,
      gamed_oracle: false,
      issues: critique.issues,
      guidance: critique.guidance,
    })

    if (critique.verdict === 'revise') {
      const issuesText = critique.issues.length ? `\nIssues: ${critique.issues.join('; ')}` : ''
      const guidanceText = critique.guidance ? `\n${critique.guidance}` : ''
      const conflictText = numericConflicts.length ? `\nConfirmed internal conflicts: ${numericConflicts.join('; ')}` : ''
      // Re-inject the fetched source text so the agent can VERIFY-AND-KEEP rather than
      // delete: the sources were collapsed out of the live window, which is the root
      // condition that made it fabricate in the first place. With them back in view it
      // can confirm supported specifics (keep them) and fix only the unsupported ones —
      // preserving richness, which a delete-only revision destroys.
      const srcBlock = sourceExcerpts.length
        ? `\n\nSOURCES YOU FETCHED (the ground truth — verify against these):\n${sourceExcerpts.map(s => `- ${s.url}: ${s.text.slice(0, 700)}`).join('\n')}`
        : ''
      const steer = `GROUNDING CHECK (pre-done) — fix before finishing, then stop.${guidanceText}${issuesText}${conflictText}\nFor EACH flagged specific: if the SOURCES below support it, KEEP it exactly; if they do NOT, either web_search/fetch_url to verify it (and keep it with that source) or generalize JUST that one phrase. Do NOT delete or water down content the sources DO support — the document must stay as rich and specific as it was, only more accurate. Reconcile any restated number to a single value used everywhere.${srcBlock}`
      emitAndLog({ type: 'warning', message: steer })
      this.pushCtx({ role: 'tool', content: steer })
    }
    return critique
  }

  // LAYOUT JUDGE checkpoint (see layout.ts) — the visual-layout analogue of
  // runGroundingCheckpoint, above. Only reached when this.layout is on AND
  // selectLayoutArtifact found an HTML artifact this run (checked by the caller).
  // Renders the artifact, screenshots it, and asks the local vision model whether
  // the RENDERED page has a clear layout problem. checkLayout fails OPEN internally
  // (render error / unreachable model / timeout / unparseable reply all resolve to
  // {ok:true, issues:[]}), so this method itself never throws and never wedges a run.
  // On a problem it emits the SAME 'critic' event shape grounding uses (checkpoint
  // 'layout', gamed_oracle always false) plus a warning, and injects a concrete steer
  // naming the artifact and the issues; the caller BLOCKS completion (continue).
  private async runLayoutCheckpoint(
    artifactPath: string,
    emitAndLog: (e: AgentEvent) => void,
  ): Promise<LayoutVerdict> {
    const verdict = await checkLayout(artifactPath)

    emitAndLog({
      type: 'critic',
      checkpoint: 'layout',
      verdict: verdict.ok ? 'ok' : 'revise',
      gamed_oracle: false,
      issues: verdict.issues,
      guidance: verdict.ok ? '' : 'Fix the rendered layout problems, then finish.',
    })

    if (!verdict.ok) {
      const issuesText = verdict.issues.length ? verdict.issues.join('; ') : 'the rendered layout looks broken'
      const steer = `Before finishing: the rendered layout of ${artifactPath} has problems: ${issuesText}. Fix them, then finish.`
      emitAndLog({ type: 'warning', message: steer })
      this.pushCtx({ role: 'tool', content: steer })
    }
    return verdict
  }

  // RESUME (H14, 2026-09-04). `opts.resume` marks this turn as a continuation of the
  // SAME frame rather than a new run. Before this existed, dispatch.ts's resumeFrame
  // called plain chat(), which unconditionally cleared currentPlan, taskList, loopState,
  // editedPaths, episodes, finalReconciled, the per-task verify/summary sets and the
  // iteration counter — so a Tester REDO or a Planner replanning round restarted the
  // frame from a blank slate while claiming to continue it (observed: a marker-retry
  // resume reporting "ITER 1/10"). It was latent only because REDO/replan almost never
  // fired; H13 makes REDO reachable, so it stops being latent in this same batch.
  async chat(userMessage: string, opts?: ChatOptions): Promise<string> {
    const resume = opts?.resume === true
    const logger = new SessionLogger(userMessage, this.model, this.options, this.sessionId)

    const emitAndLog = (event: AgentEvent) => {
      logger.log(event)
      // Pass the seq log() just assigned (it pushes synchronously, before its
      // first await, so getSeq() already reflects this event) so the SSE stream
      // carries the same per-run seq the JSONL persists — this is what lets the
      // UI dedupe replayed-vs-live events at the reconnect boundary.
      this.emit(event, logger.getSeq())
    }

    this.pushCtx({ role: 'user', content: userMessage })
    this.phase = 'running'
    // The index of the message that started this run — compactHistory() always
    // keeps history[currentRunStart] verbatim, however many iterations follow it.
    // Reassigned (not recomputed) after each compaction, since compaction replaces
    // `this.history` wholesale and returns the prompt's new position in it.
    let currentRunStart = this.history.length - 1
    // How this turn ends is decided by whichever exit path below runs; assume the good
    // case so a normal final answer needs no bookkeeping, and overwrite on the cap /
    // error / abort paths. Reset for a resumed turn too: it describes the LAST turn.
    this.lastRunOutcome = 'ok'
    if (resume) {
      // RESUMED TURN (H14): keep every piece of frame state. Continue the iteration
      // count from where the previous turn stopped, so a resumed frame reports "ITER
      // 11/20" rather than starting over at 1 — and so a caller can still see the
      // frame's TOTAL effort. Everything the fresh-run branch below clears
      // (currentPlan, taskList + its verify/summary sets, loopState, editedPaths,
      // episodes, finalReconciled, the grounding evidence and the trouble flags) is
      // deliberately left in place: the follow-up message is a continuation of the
      // same work, and wiping it made a REDO/replan restart from a blank slate while
      // claiming to continue. Note loopSteerEscalated/ollamaRetryCount are STICKY per
      // frame on purpose — friction that happened in an earlier turn of this frame is
      // still friction dispatch.ts's standup trigger should see.
      this.iterationBase = this.lastIterationCount
    } else {
      this.iterationBase = 0
      this.lastIterationCount = 0
      // Loop-steering state, scoped to this run only (see REPEAT_WINDOW above).
      this.recentCalls = []
      this.loopState = createLoopState()
      this.mutationCountAtLastStallCheck = 0
      this.loopSteerEscalated = false
      this.ollamaRetryCount = 0
      this.currentPlan = null
      // Apply a plan seeded via seedPlan() (dispatch.ts, before chat() was called)
      // — MUST run after the reset directly above, not before: this reset used to
      // run unconditionally on every fresh run and silently wiped a seed set the
      // moment before chat() was invoked, so the plan/act gate still saw
      // !this.currentPlan on the frame's very first tool call. Applying it here,
      // immediately after, is what makes the seed actually survive. Cleared right
      // after so a SECOND chat() call on this same Agent (a resumed frame — the
      // OTHER branch of this if/else, never reached from here) can never replay it.
      if (this.pendingSeed !== null) {
        this.currentPlan = { objective: this.pendingSeed.trim(), steps: [], revision: 0 }
        this.pendingSeed = null
      }
      // HARNESS TASK LEDGER + MEMORY per-run state (only used when this.tasks/this.memory
      // are on; resetting them unconditionally is a harmless local write for the baseline).
      this.taskList = null
      this.taskVerifyPassed.clear()
      this.taskSummaryAsked.clear()
      this.taskVerifyFails.clear()
      this.finalReconciled = false
      this.agentsRaw = ''
      this.memoryRaw = ''
      // ACTOR-CRITIC per-run state (see field docs). Reset alongside the loop-steer
      // state so a later run starts from a clean slate.
      this.editedPaths = []
      this.fetchedSources = []
      this.lastCommandOutput = ''
      this.actionTrace = []
      this.episodes = []
    }
    let loopSteers = 0
    // No-progress detector: tool calls since the last actual change to the project.
    // A planned run that keeps inspecting without ever editing is stuck (the novel-arg
    // thrash the identical-call guard misses); noProgressSteers escalates the re-anchor.
    let callsSinceMutation = 0
    let noProgressSteers = 0
    let regrounded = false
    let groundingChecked = false
    // At most one (render + vision-model) layout check per run, mirroring
    // groundingChecked — a bounded block, never an infinite one.
    let layoutChecked = false
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

    // Baseline: loadProjectContext (AGENTS.md + MEMORY.md whole-injected). When
    // this.memory is on, build the context via the memory module instead (AGENTS.md
    // section-selected + recall pointer; MEMORY.md retrieved task-scoped at the tail).
    const projectContext = this.memory
      ? await this.buildProjectMemoryContext(userMessage)
      : await loadProjectContext()
    const rolePrompt = buildSystemPrompt(this.canUpdatePlan())
    const baseSystemPrompt = this.roleInstructions ? `${rolePrompt}\n\n${this.roleInstructions}` : rolePrompt
    const systemPrompt = projectContext ? `${baseSystemPrompt}\n\n${projectContext}` : baseSystemPrompt

    // Stall/progress-check iteration numbers for THIS run, scaled to THIS run's own
    // budget (2026-09-03: multi-agent roles run short, fixed budgets — Boss/Planner
    // 15, Tester 20, a Boss task-start checkpoint as low as 6 — and the original
    // fixed 20/35/45 checkpoints below simply never fired for them, since they hit
    // their own hard maxIterations ceiling first and got ZERO mid-run steering. Each
    // checkpoint is min(the original fixed value, a fraction of this run's own
    // maxIterations) — for any budget >=~60 (Implementer's, and the baseline's own
    // typical config) this reduces to exactly the original fixed values (unchanged,
    // still "a first guess tuned against the eval"); for a short-budget role it
    // scales down proportionally instead of never firing at all.
    // Offset by iterationBase on a RESUMED turn (H14) so the checkpoints keep firing at
    // the same positions WITHIN this turn — the alternative (absolute numbering) would
    // put every checkpoint in the past for a resumed frame and silently give it no
    // mid-run steering at all, which is the same class of bug the scaling above fixed.
    const stallCheckpoints = [0.4, 0.65, 0.85].map((frac, idx) =>
      this.iterationBase + Math.min([20, 35, 45][idx], Math.max(1, Math.round(frac * this.maxIterations))),
    )
    // A resumed turn gets its own full iteration allowance; what carries over is the
    // COUNT (for reporting and for dispatch.ts's large-frame standup trigger), not the
    // remaining budget — a targeted REDO/replan follow-up that inherited 2 leftover
    // iterations could not act on the instruction it was given, which would defeat the
    // point of resuming. `max` is reported cumulatively for the same reason, so the
    // emitted iteration event never shows current > max.
    const maxForRun = this.iterationBase + this.maxIterations

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        if (this.aborted) {
          this.aborted = false
          const msg = 'Stopped.'
          this.lastRunOutcome = 'aborted'
          emitAndLog({ type: 'done', content: msg })
          this.phase = 'idle'
          return msg
        }
        const iterCurrent = this.iterationBase + i + 1
        emitAndLog({ type: 'iteration', current: iterCurrent, max: maxForRun })
        this.lastIterationCount = iterCurrent

        // Stall re-ground (Magentic-One style). On a long run that is drifting, the
        // loop-steer guard can't help — its churn has novel args — and the reground
        // done-gate only fires at "done", never mid-run. So at fixed iteration counts
        // (well above normal convergence — observed passing tasks ≤13 iters), scaled
        // to THIS run's own budget (stallCheckpoints, above), inject a non-terminating
        // re-ground toward the objective, then force a re-plan at the top. Each fires
        // once (iterNum is strictly increasing). Cumulative across a frame's turns
        // (H14) — stallCheckpoints are offset by the same base, so the comparison and
        // the "N iterations without finishing" wording both refer to the frame's own
        // total effort rather than resetting on every resume.
        const iterNum = iterCurrent
        if (stallCheckpoints.includes(iterNum)) {
          // Real edits landing since the LAST checkpoint (not since run start — a
          // stretch of pure investigation right after an earlier burst of edits
          // should still be able to trip the alarm) mean this is a bigger task making
          // genuine progress, not a stuck loop — skip the alarmed message entirely
          // rather than nagging a model that is already doing the right thing.
          const mutationsSinceLastCheck = this.loopState.mutationCount - this.mutationCountAtLastStallCheck
          this.mutationCountAtLastStallCheck = this.loopState.mutationCount
          if (mutationsSinceLastCheck === 0) {
            const activePlan = this.currentPlan as { objective: string } | null
            const objective = activePlan?.objective || userMessage
            // Telling a role without update_plan to call it was a real observed
            // failure (a stalled Planner just got MORE confused, burning its whole
            // budget without ever emitting the JSON block dispatch.ts needed) — this
            // used to need an extra write_file check to also exclude the Planner
            // specifically, back when ROLE_TOOLS.planner still held update_plan
            // itself (removed 2026-09-04) despite never calling it for this purpose.
            // canUpdatePlan() (2026-09-05) now centralises the same distinction for
            // every update_plan-referencing string in this file, including this one
            // — no role holds the tool without also being the intended caller of it,
            // so the extra check is no longer needed.
            const hasUpdatePlan = this.canUpdatePlan()
            const isLastCheckpoint = iterNum === stallCheckpoints[stallCheckpoints.length - 1]
            const stall = isLastCheckpoint
              ? (hasUpdatePlan
                ? `STALL: ${iterNum} iterations without finishing — your approach is not converging. Call update_plan now with a revised plan that lists ONLY the remaining work as concrete steps, then carry it out. Do not repeat what has not worked.`
                : `STALL: ${iterNum} iterations without finishing — your approach is not converging. Conclude NOW with your best verdict/answer given what you have found so far, or take one genuinely different action — do not repeat what has not worked.`)
              : (hasUpdatePlan
                ? `PROGRESS CHECK: ${iterNum} iterations in and not finished. Objective: "${objective}". State which steps are DONE and which REMAIN, then make the single most important remaining change now — if you have been searching or re-reading without editing, stop and implement the next concrete step; if the approach is wrong, call update_plan to revise.`
                : `PROGRESS CHECK: ${iterNum} iterations in and not finished. Objective: "${objective}". State what you have confirmed so far, then either conclude with your verdict/answer or take the single most important remaining action — do not keep re-checking the same thing.`)
            emitAndLog({ type: 'warning', message: stall })
            this.pushCtx({ role: 'tool', content: stall })
            // ON-STALL critic checkpoint: reuse the existing stall/progress trigger
            // (no parallel plumbing). The critic reviews the recent trace + latest
            // test output and returns a CONCRETE corrective, injected as a steer.
            if (config.critic) {
              const stallPlan = this.currentPlan as { steps: string[] } | null
              await this.runCriticCheckpoint('on-stall', objective, stallPlan?.steps ?? [], emitAndLog)
            }
          }
        }

        emitAndLog({ type: 'ollama_request', iteration: i + 1, message_count: this.history.length + 1, model: this.model })

        const response = await this.chatWithRetry(systemPrompt, emitAndLog)
        if (response === null) {
          // The user aborted while chatWithRetry was waiting to retry. Mirror the
          // top-of-loop stop handling exactly rather than retrying into a run the
          // user already asked to stop.
          this.aborted = false
          const stopped = 'Stopped.'
          emitAndLog({ type: 'done', content: stopped })
          this.phase = 'idle'
          return stopped
        }

        const numCtx = this.options.num_ctx ?? 65536
        if (response.prompt_eval_count != null) {
          emitAndLog({
            type: 'token_usage',
            prompt_tokens: response.prompt_eval_count,
            generated_tokens: response.eval_count ?? 0,
            num_ctx: numCtx,
            // Ollama reports these in nanoseconds; persist as ms so the eval can
            // compute generation throughput (tokens/sec) and per-turn latency
            // without any extra probing. Optional — absent on a client that omits them.
            eval_duration_ms: response.eval_duration != null ? Math.round(response.eval_duration / 1e6) : undefined,
            total_duration_ms: response.total_duration != null ? Math.round(response.total_duration / 1e6) : undefined,
          })
          // Reserve headroom for the *next* generation, not just the input consumed so
          // far — a response near num_predict's limit can still overflow num_ctx even
          // when prompt_eval_count alone looks comfortably under the threshold.
          const usagePct = (response.prompt_eval_count + config.compactGenerationReserve) / numCtx
          // Trigger when only ~compactReserveTokens of headroom remain (near-full), instead
          // of at a fixed fraction — the context is allowed to fill more before compacting.
          if (response.prompt_eval_count >= numCtx - config.compactReserveTokens) {
            try {
              this.phase = 'compacting'
              const result = await this.compactHistory(currentRunStart, usagePct, emitAndLog)
              currentRunStart = result.newRunStart
              this.phase = 'running'
            } catch (err) {
              // Deliberately falls through to the next normal iteration rather than
              // blocking on a synchronous compaction retry: a hard block risks the
              // loop getting stuck retrying compaction forever if it's failing for a
              // structural reason (not just slow model latency), with no forward
              // progress and no way for the user to see a real answer. Letting the
              // iteration continue does mean usagePct can only climb further before
              // the next attempt — accepted here since raising compactTimeoutMs
              // above is the primary fix for the actual observed failure mode
              // (timeout, not a structural error).
              this.phase = 'running'
              emitAndLog({ type: 'warning', message: `Context compaction failed (${err instanceof Error ? err.message : String(err)}) — continuing with full history` })
            }
          }
        }

        const msg = response.message

        if (msg.content) {
          emitAndLog({ type: 'thought', content: msg.content })
        }

        // Determine tool calls — native API first, then fallback to JSON parsed from content
        const nativeCalls = msg.tool_calls ?? []
        const fallbackCalls = nativeCalls.length === 0 && msg.content
          ? extractToolCallsFromContent(msg.content)
          : []
        const hasCalls = nativeCalls.length > 0 || fallbackCalls.length > 0

        if (!hasCalls) {
          this.pushCtx(msg)
          // ── HARNESS TASK LEDGER: per-task verify → SUMMARY → advance (this.tasks). A
          // no-tool call while tasks REMAIN means the model believes the CURRENT task
          // is done.
          //
          // Step 1 — EXECUTABLE VERIFY (Change 3, unchanged): if the current task
          // carries a `verify` command and it hasn't already passed this run, the
          // harness does NOT take the self-report at face value: it RUNS the command
          // itself (via tracedBash, same trace/log path as any other tool call). A
          // failing command blocks — taskVerifyFails increments, the real output is
          // fed back (escalating past VERIFY_FAIL_ESCALATE), and the model stays on
          // THIS task; no summary is asked for. A passing command is recorded
          // (taskVerifyPassed) and FALLS THROUGH to step 2 — it does NOT advance yet.
          //
          // Step 2 — SUMMARY (NEW): the executable oracle (or its absence) is
          // necessary but not sufficient — the harness also wants the model's own
          // brief account of WHAT it did and HOW, for the final reconciliation pass.
          // First no-tool-call turn for this task id (taskSummaryAsked) asks for that
          // summary once and CONTINUEs; the NEXT no-tool-call turn for the SAME task
          // is treated as the summary itself — it is recorded onto the active task
          // (recordActiveTaskSummary) and the ledger advances (completeActiveTask). A
          // task with no verify lands here directly; a task with a verify lands here
          // only once its verify has passed. Net shape is unchanged from before for a
          // no-verify task (ask once, advance on the next turn) — the summary now
          // fills the role the old bare "confirm you're done" nudge used to.
          //
          // Either way, once advanced, emit a 'tasks' advance event, recite the next
          // task, CONTINUE. Only when the ledger is exhausted (allDone) — or when
          // this.tasks is off / there is no ledger — do we fall through to the existing
          // run-level done-gate below (final reconciliation → critic → grounding →
          // layout → re-ground → finish). Read the ledger via a cast (the narrowing
          // gotcha: handleUpdatePlan sets it where TS can't see).
          const tlGate = this.taskList as TaskList | null
          if (this.tasks && tlGate && !tasksAllDone(tlGate)) {
            const cur = activeTask(tlGate)
            if (cur && cur.verify && !this.taskVerifyPassed.has(cur.id)) {
              const verifyResult = await this.tracedBash(cur.verify, emitAndLog)
              if (verifyResult.error) {
                // VERIFY FAILED — do not advance, do not ask for a summary. Feed the
                // failure straight back, output intact (never hidden), and keep the
                // model on this one task.
                const fails = (this.taskVerifyFails.get(cur.id) ?? 0) + 1
                this.taskVerifyFails.set(cur.id, fails)
                const failOutput = truncateOutput(
                  [verifyResult.output, verifyResult.error].filter(Boolean).join('\n') || '(no output)',
                  1500,
                )
                const steer = fails < VERIFY_FAIL_ESCALATE
                  ? `Verification for the current task "${cur.title}" FAILED — command \`${cur.verify}\` did not pass:\n${failOutput}\nFix this before finishing the task.`
                  // Persistent failure (VERIFY_FAIL_ESCALATE+ in a row): stop repeating
                  // the identical "fix this" steer and push toward a different move —
                  // either the actual fix or a re-plan — while still not advancing.
                  : `Verification for "${cur.title}" has now FAILED ${fails} times in a row (\`${cur.verify}\`):\n${failOutput}\nStop repeating the same fix if it hasn't worked. Either resolve the real underlying problem, or call update_plan to revise this task (or its verify command) if it no longer makes sense as written.`
                emitAndLog({ type: 'warning', message: steer })
                this.pushCtx({ role: 'tool', content: steer })
                continue
              }
              // VERIFY PASSED — the task is genuinely done by the executable oracle;
              // record it and fall through to the summary step below (do NOT advance
              // yet — the summary is still captured for the final reconciliation).
              this.taskVerifyFails.delete(cur.id)
              this.taskVerifyPassed.add(cur.id)
              emitAndLog({ type: 'warning', message: `VERIFY PASSED for task "${cur.title}" (\`${cur.verify}\`) — capturing a summary before advancing.` })
            }
            if (cur && !this.taskSummaryAsked.has(cur.id)) {
              // First no-tool-call turn for this task (post-verify, if any) — ask for
              // the summary once and wait for the next turn.
              this.taskSummaryAsked.add(cur.id)
              const ask = `CURRENT TASK "${cur.title}" — if it is genuinely complete, reply with a brief 2-4 sentence summary of WHAT you did and HOW you solved it (this becomes the record used for the final check). If it is NOT actually done, keep working on THIS task only.`
              emitAndLog({ type: 'warning', message: ask })
              this.pushCtx({ role: 'tool', content: ask })
              continue
            } else if (cur) {
              // Already asked for this task → THIS no-tool-call turn IS the summary.
              // Record it, then advance the ledger.
              const summarized = recordActiveTaskSummary(tlGate, msg.content.trim() || '(no summary provided)')
              const advanced = completeActiveTask(summarized)
              this.taskList = advanced
              const done = advanced.tasks.filter(t => t.status === 'done').length
              const nextActive = activeTask(advanced)
              emitAndLog({
                type: 'tasks',
                action: 'advanced',
                revision: advanced.revision,
                done,
                total: advanced.tasks.length,
                current: nextActive?.title ?? null,
              })
              if (!tasksAllDone(advanced) && nextActive) {
                // Recite the next task and keep the loop going — the full ledger is in
                // the recited tail (chatCall).
                const adv = `Task complete. NEXT TASK "${nextActive.title}". Work only on this task now; the full plan is in the recited ledger. Refine via update_plan only if the work contradicts it.`
                emitAndLog({ type: 'warning', message: adv })
                this.pushCtx({ role: 'tool', content: adv })
                continue
              }
              // allDone after advancing → do NOT continue; fall through to the existing
              // run-level done-gate below (final reconciliation → critic → grounding →
              // layout → re-ground → finish).
            }
          }
          // Read through a cast: this.currentPlan is set only inside handleUpdatePlan
          // (the update_plan intercept), which TS's control-flow analysis can't see
          // from here — after the run-start `this.currentPlan = null` it still believes
          // the field is null and narrows this truthy branch to `never`. The cast
          // restores the real plan type.
          const activePlan = this.currentPlan as { objective: string; steps: string[]; revision: number } | null
          // FINAL RECONCILIATION (NEW): once every planned task is done, before any of
          // the existing critic/grounding/layout/re-ground checks run, feed the model
          // ALL the per-task summaries plus the objective and make it double-check
          // nothing is missing — it can re-open work via update_plan (which resets
          // finalReconciled, so a later allDone re-arms exactly one more pass) or give
          // its genuine final answer. At most once per run (finalReconciled) so this
          // cannot loop.
          if (this.tasks && tlGate && tasksAllDone(tlGate) && !this.finalReconciled) {
            this.finalReconciled = true
            const objective = activePlan?.objective || tlGate.objective
            const reconcileMsg = `ALL PLANNED TASKS ARE DONE — final check before finishing. Objective: "${objective}". What was done per task:\n${renderTaskSummaries(tlGate)}\nVerify this FULLY addresses the objective. If ANYTHING is missing, incomplete, or inconsistent, call update_plan to add/adjust the remaining work and keep going. If it is genuinely complete, give your FINAL ANSWER now: a clear summary for the user of what was accomplished, and suggest a sensible next step.`
            emitAndLog({ type: 'warning', message: reconcileMsg })
            this.pushCtx({ role: 'tool', content: reconcileMsg })
            continue
          }
          // PRE-DONE critic checkpoint: reuse the existing done-gate. Before taking
          // "I'm done" at face value, the critic reviews the files edited (with
          // test/spec flags), the latest test output, and the recent trace, and
          // answers: did it REALLY satisfy the objective, and did it tamper with any
          // test/spec file (ORACLE TAMPER)? On tamper or objective-unmet it injects
          // the critique (+ a hard "do NOT edit test/spec files" reminder when
          // gamed_oracle) and BLOCKS completion — the loop continues. Fails OPEN:
          // if the critic errors/won't parse, completion proceeds as in baseline.
          if (config.critic && activePlan) {
            const critique = await this.runCriticCheckpoint('pre-done', activePlan.objective, activePlan.steps, emitAndLog)
            if (critique && (critique.gamed_oracle || critique.verdict === 'revise')) {
              continue
            }
          }
          // GROUNDING & self-consistency checkpoint (writing/research tasks). At most
          // once per run. If it flags fabricated specifics or internal contradictions,
          // block completion so the agent revises. Only active when config.grounding is
          // on; runGroundingCheckpoint returns null (no block) for non-writing runs.
          if (this.grounding && activePlan && !groundingChecked) {
            groundingChecked = true
            const g = await this.runGroundingCheckpoint(activePlan.objective, emitAndLog)
            if (g && g.verdict === 'revise') continue
          }
          // LAYOUT JUDGE checkpoint (visual-layout guard, config.layout / this.layout —
          // default OFF, unproven). At most once per run (layoutChecked), mirroring
          // groundingChecked's cap so this can never block indefinitely. Only runs the
          // (render + vision-model) check at all when selectLayoutArtifact finds an
          // HTML artifact this run edited — a no-op for non-HTML tasks or when the flag
          // is off, so baseline behavior is untouched either way.
          if (this.layout && !layoutChecked) {
            const artifact = selectLayoutArtifact(this.editedPaths)
            if (artifact) {
              layoutChecked = true
              const lv = await this.runLayoutCheckpoint(artifact, emitAndLog)
              if (!lv.ok) continue
            }
          }
          // Re-grounding done-gate: if a plan is active for THIS run, don't take the
          // first "I'm done" at face value — nudge once to verify the recorded
          // objective is actually met (checking a fix against the reported symptom is
          // the exact step the 90-iteration drift run skipped). A run with no plan
          // (simple task / question) finishes immediately, so versatility is
          // untouched. At most once per run (regrounded), so it cannot loop.
          if (activePlan && !regrounded) {
            regrounded = true
            const nudge = `Before finishing, re-ground against your plan. Objective: "${activePlan.objective}". Think critically: is the objective TRULY met — not just that a command exited 0, with no corner cut and the real request satisfied? State how you verified it (the check you ran and its result). If it is not genuinely met, keep working toward THIS objective (do not drift to a different one). If it is met, give your final answer as: (1) a brief summary of what you did to achieve the objective, and (2) only if there is a clear, sensible next step for this project, one short suggestion of what to do next.`
            emitAndLog({ type: 'warning', message: nudge })
            this.pushCtx({ role: 'tool', content: nudge })
            continue
          }
          emitAndLog({ type: 'message', role: 'assistant', content: msg.content })
          emitAndLog({ type: 'done', content: msg.content })
          if (this.autoCommitEnabled) await this.autoCommit(emitAndLog)
          this.phase = 'idle'
          return msg.content
        }

        this.pushCtx(msg)

        const callsToRun = nativeCalls.length > 0
          ? nativeCalls.map(tc => ({ name: tc.function.name as ToolName, args: tc.function.arguments as Record<string, unknown> }))
          : fallbackCalls.map(fc => ({ name: fc.name as ToolName, args: fc.arguments }))

        for (const { name, args } of callsToRun) {
          // update_plan is a harness action (mutates the run's plan + emits a
          // 'plan' event), not a sandbox tool — handle it here and skip the
          // repetition guard. It IS a tool call, so recording/refining a plan can
          // never be mistaken for "no tool call = done".
          //
          // Gated on canUpdatePlan() (2026-09-05, was unconditional): a role WITHOUT
          // the tool (every multi-agent frame now — frames.ts's ROLE_TOOLS) must NOT
          // have a call intercepted here at all, even a hallucinated one the model
          // was never offered — this check used to run before the role-availability
          // gate further below, so ANY role could silently mutate the plan through a
          // call it was never given, bypassing that gate entirely. Falling through
          // when canUpdatePlan() is false routes it to that same standard rejection
          // ("not available in this role") every other disallowed tool already gets
          // — one consistent rejection path instead of a special-cased one.
          if (name === 'update_plan' && this.canUpdatePlan()) {
            // TRACE VISIBILITY (2026-09-05): update_plan used to emit only a 'plan'
            // event, never a tool_call/tool_result pair — every other tool goes
            // through the normal execution path below and appears in the trace, so
            // update_plan calls were invisible in the tool-call list. A real session
            // had 8 of them and no way to see it from the trace at all. Same event
            // shape the normal tool path uses (see the executeTool call further
            // down): tool_call BEFORE, tool_result (output = handleUpdatePlan's
            // return string) AFTER — emitted here rather than inside
            // handleUpdatePlan itself, so a no-op call (handleUpdatePlan's own
            // early return, see its comment) still gets its tool_call/tool_result
            // pair — the model DID call the tool — but no 'plan' event follows,
            // since handleUpdatePlan returns before ever reaching that emit.
            emitAndLog({ type: 'tool_call', tool: name, args })
            const planStart = Date.now()
            const planOutput = this.handleUpdatePlan(args, emitAndLog)
            emitAndLog({ type: 'tool_result', tool: name, output: planOutput, duration_ms: Date.now() - planStart })
            this.pushCtx({ role: 'tool', content: planOutput })
            // POST-PLAN critic checkpoint: right after a plan is recorded, judge
            // whether it actually addresses the objective and is complete/ordered;
            // if weak, inject guidance BEFORE execution. Reuses the steer-injection
            // path — no parallel plumbing.
            if (config.critic) {
              const newPlan = this.currentPlan as { objective: string; steps: string[] } | null
              if (newPlan) await this.runCriticCheckpoint('post-plan', newPlan.objective, newPlan.steps, emitAndLog)
            }
            continue
          }
          // H21: the normalised identity of this call, computed ONCE and shared by
          // both gates below plus the ladder's own loopKey further down (all three
          // need the identical value for their counts to compose correctly — see
          // handleGateRejection's doc comment). undefined when this.loop is off, in
          // which case handleGateRejection falls straight through to the plain,
          // pre-H21 rejection (see its own doc comment for why this is gated on the
          // SAME flag as the rest of the ladder).
          const gateKey = this.loop ? normalizeCallKey(name, args) : undefined
          // MULTI-AGENT ARCHITECTURE (config.agents): a role-scoped frame rejects any
          // tool outside its ROLE_TOOLS set — enforced here too (not just in the tools
          // offered to Ollama above), since a model can still emit a call for a tool it
          // wasn't offered. Not counted as an EXECUTED-call repeat (evaluateCall below
          // never sees it — the call simply never runs), but IS counted as a gate
          // rejection (H21) since allowedTools is fixed for this frame's whole life and
          // a role refusal can never later succeed here — see handleGateRejection.
          if (this.allowedTools && !this.allowedTools.includes(name)) {
            const stop = this.handleGateRejection(
              name, args, gateKey, 'role',
              `tool "${name}" is not available in this role — it was NOT called.`,
              emitAndLog,
            )
            if (stop !== null) return this.endFrameStalled(stop, emitAndLog)
            continue
          }
          // Plan/act gate: investigation (reads/greps) flows freely, but a project
          // mutation is BLOCKED until a plan exists — separating plan from act as a
          // state with different rules. Gated by "about to change the project"
          // (isProjectMutation), not a task classifier, so read-only runs and plain
          // questions never plan (versatility).
          //
          // DEFENSE-IN-DEPTH, NOT THE NORMAL PATH, for every multi-agent frame
          // (2026-09-05): dispatch.ts's seedPlan runs before chat() for every
          // Implementer, so `!this.currentPlan` is never true there on the normal
          // path — reaching this gate at all means seedPlan was skipped, an internal
          // harness bug, not something the model caused or can fix by calling a tool
          // (it no longer has update_plan — frames.ts's ROLE_TOOLS). It remains the
          // NORMAL, primary mechanism for the baseline single-loop agent, which
          // nothing ever seeds — canUpdatePlan() is what tells the rejection message
          // below which situation this actually is.
          //
          // Blocked, not executed; a steer takes its place and it isn't counted as
          // an EXECUTED-call repeat, so the retried call runs normally once a plan
          // exists — but IS counted as a gate rejection (H21) until then, and
          // cleared globally the instant a plan is recorded (handleUpdatePlan calls
          // clearPlanGateRejections) so that legitimate retry is never treated as
          // having "reached" any threshold.
          if (!this.currentPlan && isProjectMutation(name, args)) {
            const gate = this.canUpdatePlan()
              ? `REJECTED — this ${name} call was NOT applied, nothing changed on disk. You must record a plan first. Read the relevant files if you haven't, then call update_plan with one concrete, verifiable objective and the steps to reach it — THEN retry this exact change. Recording a plan does not end your turn.`
              : `REJECTED — this ${name} call was NOT applied, nothing changed on disk. No plan is set for this frame. This is an internal error; report it in your final answer rather than attempting to fix it.`
            const stop = this.handleGateRejection(name, args, gateKey, 'plan', gate, emitAndLog)
            if (stop !== null) return this.endFrameStalled(stop, emitAndLog)
            continue
          }
          // Loop steering (see REPEAT_* above): recentCalls holds calls actually
          // executed this run, so REPEAT_THRESHOLD prior occurrences means this
          // identical call has already produced the same result that many times.
          const key = repetitionKey(name, args)
          let priorRepeats = 0
          // Only set when this.loop is on — the normalised key the ladder actually
          // keys on (see loop.ts's normalizeCallKey doc comment for exactly what it
          // collapses). Recorded here so recordResult below (after real execution)
          // can cache the result under the SAME key evaluateCall will look up next
          // time. The baseline `key` above is untouched and still drives
          // recentCalls/REPEAT_THRESHOLD when this.loop is off.
          let loopKey: string | undefined
          if (this.loop) {
            // Mutation-aware ladder (ARGO_LOOP; H19/H20 redesign): blocks the 2nd
            // NORMALISED-identical call when nothing changed since it last ran, and
            // serves the CACHED result of the earlier call back (labeled as a
            // repeat) rather than a bare block, for as long as that key's replay
            // budget lasts — see loop.ts's evaluateCall/l0ReplayMessage. Escalates
            // L0 -> L1 compaction -> L2 forced re-plan exactly as before; only the
            // key (normalised, not raw) and the L0 payload (replay, not just a
            // steer) changed. Replaces the count-based REPEAT_THRESHOLD steer.
            // Reuses gateKey (computed once, above, before either continue-past-
            // the-ladder gate) rather than recomputing normalizeCallKey a second
            // time — see gateKey's own doc comment for why all three consumers
            // (role gate, plan/act gate, this ladder) must share the identical value.
            loopKey = gateKey
            const recite = this.buildLoopRecite()
            // args passed through so evaluateCall can enforce FIX 2 (raw-args match
            // before a replay — /shared/argo-loopfix/REPORT.md): the block/escalation
            // decision below is still keyed on loopKey alone, exactly as before.
            // `loopKey as string`: gateKey is typed string|undefined because it is
            // computed as `this.loop ? normalizeCallKey(...) : undefined` above, but this
            // entire block is inside `if (this.loop)`, so it is always a string here.
            // TypeScript cannot narrow through the intervening assignment; this is the
            // same narrowing-cast pattern the file already uses for activePlan.
            const action = evaluateCall(this.loopState, loopKey as string, args, { toolName: name, recite, hasTasks: this.tasks && recite.length > 0 })
            // H21(b): 'halt' is handled SEPARATELY from the other non-allow kinds
            // below — it has no `level` field (it fires only after L2 has already
            // been reported once for this streak, see loop.ts's LoopAction doc
            // comment), and unlike every other rung it must END THE FRAME rather
            // than `continue`. Captured live: the frame that motivated this whole
            // batch hit L2 roughly 30 times in a row with zero effect — nothing
            // before this bounded how many more times L2 alone could fire.
            if (action.kind === 'halt') {
              this.loopSteerEscalated = true
              emitAndLog({ type: 'warning', message: action.message, level: 'L2' })
              this.rejectToolCall(name, args, `SKIPPED — identical to a call already run with nothing new since. ${action.message}`, emitAndLog)
              return this.endFrameStalled(action.message, emitAndLog)
            }
            if (action.kind !== 'allow') {
              if (action.kind === 'compact' || action.kind === 'replan') this.loopSteerEscalated = true
              if (action.kind === 'compact') {
                try {
                  this.phase = 'compacting'
                  const r = await this.compactHistory(currentRunStart, 0, emitAndLog)
                  currentRunStart = r.newRunStart
                  this.phase = 'running'
                } catch (err) {
                  this.phase = 'running'
                  emitAndLog({ type: 'warning', message: `Loop-recovery compaction failed (${err instanceof Error ? err.message : String(err)}) — continuing` })
                }
              }
              // Carry the ladder rung as a STRUCTURED field (H16, 2026-09-04), not just
              // inside the prose: action.level is already L0/L1/L2 here and was being
              // discarded at exactly this line, which forced every consumer (the eval's
              // loop counters, the UI) to recover it by regex over the message wording —
              // the defect class that left two counters silently broken for months.
              emitAndLog({ type: 'warning', message: action.message, level: action.level })
              if (action.kind === 'replay') {
                this.replayToolCall(name, args, action.cached, action.message, emitAndLog)
              } else {
                this.rejectToolCall(name, args, `SKIPPED — identical to a call already run with nothing new since. ${action.message}`, emitAndLog)
              }
              continue
            }
            // NOTE: the former near-duplicate guard (checkSameToolStreak — same tool,
            // any args, no mutation in between) lived here. Deleted (2026-09, H19):
            // 180 firings across the full log corpus, 0 with any observed effect —
            // every sampled firing was followed by another call to the same tool
            // regardless of the nudge. A mechanism that reliably fires and never once
            // changes what happens next is not a mechanism worth keeping around
            // "just in case"; see MECHANISM-VERIFICATION.md §4 (Near-duplicate tool
            // guard) for the firing census this is based on.
          } else {
            priorRepeats = this.recentCalls.filter(k => k === key).length
            if (priorRepeats >= REPEAT_THRESHOLD) {
              // Skip it (re-running only reproduces a result already in context) and
              // inject an escalating steer in its place — a different observation
              // plus concrete escape routes — WITHOUT ending the run. The model
              // keeps working; MAX_ITERATIONS and the stop button are the only hard
              // bounds.
              loopSteers++
              const steer = loopSteerMessage(name, priorRepeats, loopSteers, (this.currentPlan as { objective: string } | null)?.objective ?? '')
              emitAndLog({ type: 'warning', message: steer })
              this.rejectToolCall(name, args, `SKIPPED — identical to a call already run with nothing new since. ${steer}`, emitAndLog)
              continue
            }
          }

          emitAndLog({ type: 'tool_call', tool: name, args })

          const start = Date.now()
          const result = await executeTool(name, args)
          const duration_ms = Date.now() - start

          // FIX 1 (/shared/argo-loopfix/REPORT.md, /shared/argo-review/REPORT.md
          // defect 1): a `bash` call just ran — its effect on the filesystem is
          // unknowable without a shell parser (isProjectMutation below only ever
          // sees edit_file/write_file), so every cached replay is invalidated
          // wholesale rather than risk later telling the model "nothing has
          // changed" about a file bash may have just changed. Deliberately NOT
          // gated on result.error — a command can mutate before failing (`sed -i
          // ...; false`). Must run BEFORE recordResult below, so if THIS call is
          // the one being cached, its own fresh entry survives the invalidation.
          if (this.loop && name === 'bash') noteBashExecution(this.loopState)

          // Cache this real result under the loop ladder's normalised key, so a
          // later no-progress repeat of THIS call (see evaluateCall/loopKey above)
          // can be served it back instead of a bare block. Only when this.loop is
          // on — loopKey is undefined otherwise, and this is a no-op either way if
          // no repeat ever follows. `args` recorded alongside so a later repeat can
          // be checked for a byte-exact match before replay (FIX 2, above).
          if (this.loop && loopKey !== undefined) recordResult(this.loopState, loopKey, args, { output: result.output, error: result.error })

          emitAndLog({
            type: 'tool_result',
            tool: name,
            output: result.output,
            error: result.error,
            duration_ms,
          })

          this.pushCtx({
            role: 'tool',
            content: result.error
              ? `Error: ${result.error}\n${result.output}`
              : result.output,
          })

          // ACTOR-CRITIC bookkeeping (only when enabled — a no-op for the baseline).
          // Derive the critic's compact inputs from the SAME tool-call history the
          // loop already runs: file edits (incl. failed attempts, so intent-to-
          // tamper with a test/spec file is visible), the latest command output,
          // and a short action trace.
          // MULTI-AGENT ARCHITECTURE (config.agents): every tool call becomes a CWL
          // episode (exploratory | action), linked to its inferred dependencies, and —
          // when this instance is running as part of a dispatch (this.frameId set) —
          // written to the ledger losslessly (the full result survives there even once
          // evicted from the live window; see eviction.ts / ledger.ts). update_plan and
          // ledger itself are harness/bookkeeping calls, not typed episodes. (update_plan
          // is already excluded by control flow — that branch always `continue`s above.)
          if (config.agents && name !== 'ledger') {
            const kind = classifyTool(name)
            const episodeId = newLedgerId('ep')
            const deps = inferDependencies(this.episodes, kind)
            const messageIndex = this.history.length - 1 // the tool-result message just pushed
            this.episodes.push({ episodeId, kind, tool: name, messageIndex, dependsOn: deps })
            if (this.frameId) {
              const fullContent = result.error ? `Error: ${result.error}\n${result.output}` : result.output
              try {
                await recordEpisode(config.workspacePath || '/workspace', {
                  frameId: this.frameId,
                  episodeId,
                  episodeKind: kind,
                  tool: name,
                  argsSummary: JSON.stringify(args).slice(0, 300),
                  dependsOn: deps,
                  fullContent,
                })
              } catch (err) {
                emitAndLog({ type: 'warning', message: `Episode record failed (${err instanceof Error ? err.message : String(err)}) — continuing` })
              }
            }
          }
          if (config.critic || this.grounding || this.memory || this.layout || config.agents) {
            if (name === 'edit_file' || name === 'write_file') {
              const p = typeof args.path === 'string' ? args.path : ''
              if (p && !this.editedPaths.includes(p)) this.editedPaths.push(p)
              this.actionTrace.push(`${name} ${p}${result.error ? ' [attempt failed]' : ''}`)
            } else if (name === 'fetch_url' || name === 'browser_fetch') {
              const u = typeof args.url === 'string' ? args.url : ''
              if (u) {
                this.actionTrace.push(`${name} ${u}`)
                // Keep a compact copy of what was actually fetched, so the grounding
                // guard verifies document specifics against real source text.
                if (!result.error && result.output && this.fetchedSources.length < 12) {
                  this.fetchedSources.push({ url: u, content: truncateOutput(result.output, 1400) })
                }
              }
            } else if (name === 'bash') {
              this.lastCommandOutput = truncateOutput(result.output || '', 4000)
              const cmd = typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').slice(0, 120) : ''
              this.actionTrace.push(`bash: ${cmd}`)
            } else {
              this.actionTrace.push(`${name} ${typeof args.path === 'string' ? args.path : ''}`.trim())
            }
            if (this.actionTrace.length > 16) this.actionTrace.shift()
          }

          this.recentCalls.push(key)
          if (this.recentCalls.length > REPEAT_WINDOW) this.recentCalls.shift()
          // A novel action (not already in the window) means the model moved on —
          // reset steer escalation so any later, unrelated loop starts gentle.
          if (priorRepeats === 0) loopSteers = 0

          // NO-PROGRESS re-anchor. A successful project mutation resets the counter;
          // otherwise, once a PLANNED run has made many tool calls without changing any
          // file, it is re-inspecting instead of acting (the novel-arg thrash the
          // identical-call guard misses). Fire a GROUNDED re-anchor at 12 calls, then
          // every 8 more, capped — it names the objective and demands a concrete change
          // or a conclusion, so the model redirects instead of drifting.
          const noProgPlan = this.currentPlan as { objective: string } | null
          if (isProjectMutation(name, args) && !result.error) {
            if (this.loop) noteMutation(this.loopState)
            callsSinceMutation = 0
            noProgressSteers = 0
          } else {
            callsSinceMutation++
            if (noProgPlan && callsSinceMutation >= 12 && (callsSinceMutation - 12) % 8 === 0 && noProgressSteers < 4) {
              noProgressSteers++
              const rg = regroundSteer(noProgPlan.objective, `${callsSinceMutation} tool calls without changing any file`)
              emitAndLog({ type: 'warning', message: rg })
              this.pushCtx({ role: 'tool', content: rg })
            }
          }
        }
      }

      // CAP HIT. The returned string is a NOTICE, not a final answer, and this is the
      // one place that knows the difference — record it (H13) so the frame boundary
      // (dispatch.ts's deriveFrameResult) can stop reading "a string came back" as
      // success. The terminal `error` event was already emitted here and then discarded
      // one layer up; lastRunOutcome is that same fact, in a form code can read.
      this.lastRunOutcome = 'cap'
      const errMsg = `Reached maximum iterations (${this.maxIterations}) without a final answer.`
      emitAndLog({ type: 'error', message: errMsg })
      this.phase = 'idle'
      return errMsg
    } catch (err) {
      // Nothing above this catches a failure from the main per-iteration
      // ollama.chat() call (e.g. its own withTimeout rejecting) — uncaught, it
      // used to propagate straight out of chat() and become an unhandled
      // rejection in server.ts's /chat route (which only has a `finally`),
      // crashing the whole worker process and taking the container down with it.
      // Confirmed via a real incident: a run left hanging after a host
      // sleep/wake produced a run log with no 'error'/'done' event, and the
      // --rm'd container was later found gone with no way to recover its logs.
      this.lastRunOutcome = 'error'
      const message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`
      emitAndLog({ type: 'error', message })
      this.phase = 'error'
      return message
    } finally {
      await Promise.all([logger.flush(), this.persistHistory()])
    }
  }

  reset() {
    this.history = []
    this.compactionState = emptyCompactionState()
    fs.unlink(this.historyFile).catch(() => {})
    fs.unlink(this.compactionStateFile).catch(() => {})
  }

  loadHistory(messages: Array<{ role: string; content: string }>) {
    this.history = messages as Message[]
    this.compactionState = emptyCompactionState()
    fs.writeFile(this.historyFile, JSON.stringify(this.history)).catch(() => {})
  }

  getChatHistory(): Array<{ role: string; content: string }> {
    return this.history
      .filter(msg => {
        if (msg.role === 'user') return !!msg.content
        if (msg.role === 'assistant') {
          const hasToolCalls = ((msg as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0
          return !hasToolCalls && !!msg.content
        }
        return false
      })
      .map(msg => ({ role: msg.role, content: msg.content ?? '' }))
  }

  // A JSON-serializable snapshot of the FULL context the model currently sees
  // (unlike getChatHistory, which returns only user/assistant chat turns). Used
  // by the context/compaction UI. Defensive: coerces non-string content, caps
  // per-message content so the payload stays bounded, and never throws.
  getContext(): {
    messages: Array<{ role: string; content: string; chars: number; ts: number | null }>
    messageCount: number
    totalChars: number
    numCtx: number | null
    compaction: string | null
    compactionTs: number | null
  } {
    const MAX = 4000
    let totalChars = 0
    const messages = this.history.map(m => {
      const full = typeof m.content === 'string' ? m.content : String(m.content ?? '')
      totalChars += full.length
      const content = full.length > MAX
        ? `${full.slice(0, MAX)}…(+${full.length - MAX} more chars)`
        : full
      return { role: m.role, content, chars: full.length, ts: this.historyTs.get(m) ?? null }
    })

    let compaction: string | null = null
    try {
      const state = this.compactionState
      if (state) {
        const hasContent = !!state.projectCapsule || [
          state.userRequirements,
          state.verifiedFacts,
          state.decisionsMade,
          state.changesMade,
          state.testsAndVerification,
          state.openQuestions,
          state.hypotheses,
          state.failedAttempts,
          state.invalidatedConclusions,
        ].some(arr => Array.isArray(arr) && arr.length > 0)
        if (hasContent) compaction = renderCompactionState(state)
      }
    } catch {
      compaction = null
    }

    return {
      messages,
      messageCount: this.history.length,
      totalChars,
      numCtx: this.options.num_ctx ?? null,
      compaction,
      compactionTs: this.lastCompactedAt,
    }
  }

  // Wraps bash() with the same tool_call/tool_result tracing the main loop
  // uses, so autoCommit's own commands show up in the JSONL/Markdown trace
  // instead of being invisible — this is what let the phantom/orphaned/
  // mislabeled commit bugs go unnoticed in real session logs.
  private async tracedBash(command: string, emitAndLog: (e: AgentEvent) => void) {
    emitAndLog({ type: 'tool_call', tool: 'bash', args: { command, cwd: '/workspace' } })
    const start = Date.now()
    const result = await bash(command, '/workspace')
    emitAndLog({ type: 'tool_result', tool: 'bash', output: result.output, error: result.error, duration_ms: Date.now() - start })
    return result
  }

  // Public so dispatch.ts (config.agents) can call it once at the end of a whole
  // dispatch run, using any convenient already-constructed frame's Agent instance —
  // the logic itself is instance-agnostic (just git + this.ollama for the commit
  // message), unlike the baseline loop's per-run call, which stays private.
  async autoCommit(emitAndLog: (e: AgentEvent) => void): Promise<void> {
    try {
      // Initialise git if workspace isn't tracked yet (idempotent on existing repos)
      await this.tracedBash('git rev-parse --git-dir 2>/dev/null || git init -q', emitAndLog)
      const checkResult = await this.tracedBash('git status --porcelain 2>/dev/null', emitAndLog)
      if (checkResult.error || isCleanStatus(checkResult.output)) return
      const changedFiles = parseChangedFiles(checkResult.output)

      const beforeHead = (await this.tracedBash('git rev-parse HEAD 2>/dev/null', emitAndLog)).output.trim()

      await this.tracedBash('git add -A', emitAndLog)

      // Base the message on the actual diff, not the turn's query/answer prose —
      // that decoupled the message from *which* turn happens to successfully
      // commit, which previously produced messages that didn't match the diff.
      const statResult = await this.tracedBash('git diff --cached --stat', emitAndLog)
      let message: string
      try {
        const summaryResp = await withTimeout(this.ollama.chat({
          model: this.model,
          messages: [{
            role: 'user',
            content: `Write a git commit message (max 60 chars) summarizing this diff.\n${statResult.output.slice(0, 2000)}\nReply with the commit message only — no quotes, no "Agent:" prefix.`,
          }],
        }), 30_000)
        const summary = summaryResp.message.content.trim().replace(/^["']|["']$/g, '').slice(0, 60)
        message = `Agent: ${summary}`
      } catch (err) {
        emitAndLog({ type: 'warning', message: `Auto-commit: message generation failed (${err instanceof Error ? err.message : String(err)}) — using file-list summary` })
        message = buildFallbackCommitMessage(changedFiles)
      }

      // Single-quote the message so the shell never interprets its contents;
      // escape any literal single quotes within the string using the '\'' technique.
      const safeMsg = message.replace(/'/g, "'\\''")
      await this.tracedBash(`git commit -m '${safeMsg}'`, emitAndLog)

      const afterHead = (await this.tracedBash('git rev-parse HEAD 2>/dev/null', emitAndLog)).output.trim()
      if (!afterHead || afterHead === beforeHead) return  // commit didn't actually happen — nothing new to report

      const logResult = await this.tracedBash('git log -1 --format="%h %s" 2>/dev/null', emitAndLog)
      if (!logResult.error && logResult.output.trim()) {
        const spaceIdx = logResult.output.indexOf(' ')
        const hash = logResult.output.slice(0, spaceIdx).trim()
        const commitMessage = logResult.output.slice(spaceIdx + 1).trim()
        emitAndLog({ type: 'git_commit', hash, message: commitMessage })
      }
    } catch (err) {
      emitAndLog({ type: 'warning', message: `Auto-commit failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
}
