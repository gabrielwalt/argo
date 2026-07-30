import { Ollama } from 'ollama'
import type { Message } from 'ollama'
import { promises as fs } from 'fs'
import path from 'path'
import { config } from './config.js'
import { toolDefinitions, executeTool } from './tools/index.js'
import { bash, NO_OUTPUT } from './tools/bash.js'
import { truncateOutput } from './tools/truncate.js'
import { SessionLogger, LOGS_DIR } from './logger.js'
import type { AgentEvent, ToolName, ModelOptions } from './types.js'
import { runCritic, isTestOrSpecPath, type Critique, type CriticCheckpoint } from './critic.js'
import { runGroundingCritic, isDocPath, findNumericConflicts } from './grounding.js'
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
  createTaskList,
  reconcile as reconcileTasks,
  activeTask,
  completeActiveTask,
  allDone as tasksAllDone,
  renderTaskLedger,
} from './tasks.js'
import {
  type RelevanceQuery,
  selectAgentsSections,
  selectMemoryEntries,
  renderRecallPointer,
  persistToMemory,
} from './memory.js'
import { createLoopState, noteMutation, evaluateCall, type LoopState } from './loop.js'

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
const SYSTEM_PROMPT = `You are the coding agent inside Argo, a local-first coding harness. Your project is mounted at /workspace in an isolated Ubuntu Docker container (the host is not accessible). Your thoughts, tool calls, and results stream live to the user, and changes under /workspace are committed to git when auto-commit is enabled.

TOOLS — invoke them through the function-calling API; never write a tool call as text, JSON, or XML in your reply.
- bash: run shell commands. Pass the working directory via the cwd argument (e.g. /workspace); do not prefix with "cd /workspace &&".
- read_file / write_file: whole-file I/O at any absolute path.
- edit_file: replace an exact string in a file; it reports the changed lines and errors if the text is missing or matches more than once.
- update_plan: record or refine your plan (a concrete objective plus steps). It is a tool call, so it does not end your turn.
- fetch_url / browser_fetch: fetch a page (browser_fetch runs JavaScript). web_search: look up things you do not already know.
When the task is complete, give your final answer and stop.

HOW TO WORK
- A simple question or a one-line change: answer or do it directly — no plan needed.
- Non-trivial work: read the relevant files first, then call update_plan with ONE concrete, verifiable objective — exactly what the user asked for, never a broader or more interesting goal — plus the steps to reach it, and carry it out. You cannot modify files under /workspace until a plan is recorded.
- Weigh the request against the project before you plan: if it is unclear, or looks mistaken or counter-productive in this project's context, ask one concise question or say what seems off — do not blindly execute something that does not make sense. Otherwise proceed.
- Stay on the plan. Call update_plan again only when the work contradicts one of its assumptions. Rewriting the same thing many different ways with nothing forcing it is drift — stop and return to the plan.
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

export function repetitionKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`
}

// A "project mutation" is an edit_file/write_file targeting the git-tracked
// workspace (scratch writes elsewhere don't count). The plan/act gate in chat()
// uses this to enforce plan-before-act: the model may investigate (read/grep)
// freely, but cannot change the project until it has recorded a plan via
// update_plan — separating "figure out what to do" from "do it" as a state with
// different rules, gated by *about to mutate the project* rather than a task
// classifier, so read-only runs and plain questions never trigger planning.
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

export class Agent {
  private ollama: Ollama
  private history: Message[] = []
  private model: string
  private options: ModelOptions = {}
  // Per-run toggle for the grounding guard (see runGroundingCheckpoint). Defaults to
  // config.grounding (env ARGO_GROUNDING, default ON); the web UI's "Grounding check"
  // toggle overrides it per run via setGrounding().
  private grounding = config.grounding
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
  // HARNESS TASK LEDGER (ARGO_TASKS / this.tasks). Built from the LLM's plan in
  // handleUpdatePlan (createTaskList) and reconciled on a re-plan; the harness drives
  // it ONE task at a time (recite → verify-nudge → advance). null until the first plan
  // and reset per run. taskVerifyNudged tracks which task ids have already received the
  // verify nudge, so a second "no tool call = done" for the same task advances it.
  // All only read/written when this.tasks is on → baseline untouched.
  private taskList: TaskList | null = null
  private taskVerifyNudged = new Set<number>()
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

  setTasks(on: boolean) {
    this.tasks = on
  }

  setMemory(on: boolean) {
    this.memory = on
  }

  setLoop(on: boolean) {
    this.loop = on
  }

  setAutoCommit(on: boolean) {
    this.autoCommitEnabled = on
  }

  getMaxIterations(): number {
    return this.maxIterations
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
      const result = await this.compactHistory(currentRunStart, 0, emitAndLog, true)
      if (result.compacted) await this.persistHistory()
      return { compacted: result.compacted }
    } finally {
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
          await persistToMemory(path.join('/workspace', 'MEMORY.md'), durable)
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
    return withTimeout(this.ollama.chat({
      model: this.model,
      messages,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: toolDefinitions as any[],
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
    return `[CURRENT PLAN — keep working toward this objective; do not drift onto a broader or different goal]\nObjective: ${plan.objective}${steps}\nRefine it with update_plan only if the work contradicts an assumption; finish only once the objective is verifiably met.`
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
    const steps = (Array.isArray(args.steps) ? args.steps : [])
      .map(s => String(s).trim())
      .filter(Boolean)
    if (!objective) {
      return 'update_plan needs an "objective": one concrete, verifiable success criterion. Nothing was recorded — call it again with an objective.'
    }
    const revision = (this.currentPlan?.revision ?? 0) + 1
    this.currentPlan = { objective, steps, revision }
    emitAndLog({ type: 'plan', objective, steps, revision })
    // HARNESS TASK LEDGER (this.tasks): instrument the plan as an ordered ledger. The
    // FIRST plan builds it (createTaskList); a later update_plan is a RE-PLAN that
    // reconciles into the existing ledger (completed tasks frozen, revision bumps). A
    // re-plan resets the per-task verify nudges so the (possibly re-ordered) current
    // task gets a fresh verify gate. Read the existing ledger via a cast — TS can't see
    // that handleUpdatePlan mutates this.taskList, so after the run-start reset it
    // narrows the field to null (same gotcha as the activePlan cast in chat()).
    if (this.tasks) {
      const existing = this.taskList as TaskList | null
      const replanned = existing !== null
      // `existing !== null` (not the `replanned` const) so TS narrows `existing` to
      // TaskList inside the true branch of the ternary.
      this.taskList = existing !== null
        ? reconcileTasks(existing, objective, steps)
        : createTaskList(objective, steps)
      this.taskVerifyNudged.clear()
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

  async chat(userMessage: string): Promise<string> {
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
    // The index of the message that started this run — compactHistory() always
    // keeps history[currentRunStart] verbatim, however many iterations follow it.
    // Reassigned (not recomputed) after each compaction, since compaction replaces
    // `this.history` wholesale and returns the prompt's new position in it.
    let currentRunStart = this.history.length - 1
    // Loop-steering state, scoped to this run only (see REPEAT_WINDOW above).
    this.recentCalls = []
    this.loopState = createLoopState()
    this.currentPlan = null
    // HARNESS TASK LEDGER + MEMORY per-run state (only used when this.tasks/this.memory
    // are on; resetting them unconditionally is a harmless local write for the baseline).
    this.taskList = null
    this.taskVerifyNudged.clear()
    this.agentsRaw = ''
    this.memoryRaw = ''
    // ACTOR-CRITIC per-run state (see field docs). Reset alongside the loop-steer
    // state so a later run starts from a clean slate.
    this.editedPaths = []
    this.fetchedSources = []
    this.lastCommandOutput = ''
    this.actionTrace = []
    let loopSteers = 0
    // No-progress detector: tool calls since the last actual change to the project.
    // A planned run that keeps inspecting without ever editing is stuck (the novel-arg
    // thrash the identical-call guard misses); noProgressSteers escalates the re-anchor.
    let callsSinceMutation = 0
    let noProgressSteers = 0
    let regrounded = false
    let groundingChecked = false
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

    // Baseline: loadProjectContext (AGENTS.md + MEMORY.md whole-injected). When
    // this.memory is on, build the context via the memory module instead (AGENTS.md
    // section-selected + recall pointer; MEMORY.md retrieved task-scoped at the tail).
    const projectContext = this.memory
      ? await this.buildProjectMemoryContext(userMessage)
      : await loadProjectContext()
    const systemPrompt = projectContext ? `${SYSTEM_PROMPT}\n\n${projectContext}` : SYSTEM_PROMPT

    try {
      for (let i = 0; i < this.maxIterations; i++) {
        if (this.aborted) {
          this.aborted = false
          const msg = 'Stopped.'
          emitAndLog({ type: 'done', content: msg })
          return msg
        }
        emitAndLog({ type: 'iteration', current: i + 1, max: this.maxIterations })

        // Stall re-ground (Magentic-One style). On a long run that is drifting, the
        // loop-steer guard can't help — its churn has novel args — and the reground
        // done-gate only fires at "done", never mid-run. So at fixed iteration counts
        // (well above normal convergence — observed passing tasks ≤13 iters) inject a
        // non-terminating re-ground toward the objective, then force a re-plan at the
        // top. Each fires once (iterNum is strictly increasing). Thresholds are a first
        // guess to be tuned against the eval.
        const iterNum = i + 1
        if (iterNum === 20 || iterNum === 35 || iterNum === 45) {
          const activePlan = this.currentPlan as { objective: string } | null
          const objective = activePlan?.objective || userMessage
          const stall = iterNum === 45
            ? `STALL: ${iterNum} iterations without finishing — your approach is not converging. Call update_plan now with a revised plan that lists ONLY the remaining work as concrete steps, then carry it out. Do not repeat what has not worked.`
            : `PROGRESS CHECK: ${iterNum} iterations in and not finished. Objective: "${objective}". State which steps are DONE and which REMAIN, then make the single most important remaining change now — if you have been searching or re-reading without editing, stop and implement the next concrete step; if the approach is wrong, call update_plan to revise.`
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

        emitAndLog({ type: 'ollama_request', iteration: i + 1, message_count: this.history.length + 1, model: this.model })

        const response = await this.chatWithRetry(systemPrompt, emitAndLog)
        if (response === null) {
          // The user aborted while chatWithRetry was waiting to retry. Mirror the
          // top-of-loop stop handling exactly rather than retrying into a run the
          // user already asked to stop.
          this.aborted = false
          const stopped = 'Stopped.'
          emitAndLog({ type: 'done', content: stopped })
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
              const result = await this.compactHistory(currentRunStart, usagePct, emitAndLog)
              currentRunStart = result.newRunStart
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
          // ── HARNESS TASK LEDGER: per-task verify-then-advance (this.tasks). A no-tool
          // call while tasks REMAIN means the model believes the CURRENT task is done.
          // First time for a task → inject a verify nudge and CONTINUE (don't advance
          // yet). If it stops AGAIN for the same task → advance (completeActiveTask),
          // emit a 'tasks' advance event, recite the next task, CONTINUE. Only when the
          // ledger is exhausted (allDone) — or when this.tasks is off / there is no
          // ledger — do we fall through to the existing run-level done-gate below
          // (critic → grounding → re-ground → finish), UNCHANGED. Read the ledger via a
          // cast (the narrowing gotcha: handleUpdatePlan sets it where TS can't see).
          const tlGate = this.taskList as TaskList | null
          if (this.tasks && tlGate && !tasksAllDone(tlGate)) {
            const cur = activeTask(tlGate)
            if (cur && !this.taskVerifyNudged.has(cur.id)) {
              // Verify-once: nudge the model to confirm THIS task is genuinely done.
              this.taskVerifyNudged.add(cur.id)
              const nudge = `CURRENT TASK "${cur.title}" — before moving on, confirm it is genuinely complete and STATE how you verified it (the check + result). If not truly done, keep working on THIS task only. If done, say so and I'll advance you.`
              emitAndLog({ type: 'warning', message: nudge })
              this.pushCtx({ role: 'tool', content: nudge })
              continue
            }
            if (cur) {
              // Already nudged for this task → accept and advance the ledger.
              const advanced = completeActiveTask(tlGate)
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
              // run-level done-gate below (critic → grounding → re-ground → finish).
            }
          }
          // Re-grounding done-gate: if a plan is active for THIS run, don't take
          // the first "I'm done" at face value — nudge once to verify the recorded
          // objective is actually met (checking a fix against the reported symptom
          // is the exact step the 90-iteration drift run skipped). A run with no
          // plan (simple task / question) finishes immediately, so versatility is
          // untouched. At most once per run (regrounded), so it cannot loop.
          // Read through a cast: this.currentPlan is set only inside handleUpdatePlan
          // (the update_plan intercept), which TS's control-flow analysis can't see
          // from here — after the run-start `this.currentPlan = null` it still believes
          // the field is null and narrows this truthy branch to `never`. The cast
          // restores the real plan type.
          const activePlan = this.currentPlan as { objective: string; steps: string[]; revision: number } | null
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
          if (name === 'update_plan') {
            this.pushCtx({ role: 'tool', content: this.handleUpdatePlan(args, emitAndLog) })
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
          // Plan/act gate: investigation (reads/greps) flows freely, but a project
          // mutation is BLOCKED until a plan is recorded — separating plan from act
          // as a state with different rules. Gated by "about to change the project"
          // (isProjectMutation), not a task classifier, so read-only runs and plain
          // questions never plan (versatility). Blocked, not executed; a steer takes
          // its place and it isn't counted as a repeat, so the retried call runs
          // normally once the plan exists.
          if (!this.currentPlan && isProjectMutation(name, args)) {
            const gate = `Before changing the project (\`${name}\` on ${typeof args.path === 'string' ? args.path : 'a file'}) you must record a plan. Read the relevant files if you haven't, then call update_plan with one concrete, verifiable objective and the steps to reach it — then make this change. Recording a plan does not end your turn.`
            emitAndLog({ type: 'warning', message: gate })
            this.pushCtx({ role: 'tool', content: gate })
            continue
          }
          // Loop steering (see REPEAT_* above): recentCalls holds calls actually
          // executed this run, so REPEAT_THRESHOLD prior occurrences means this
          // identical call has already produced the same result that many times.
          const key = repetitionKey(name, args)
          let priorRepeats = 0
          if (this.loop) {
            // Mutation-aware ladder (ARGO_LOOP): blocks the 2nd identical call when
            // nothing changed since it last ran; escalates L0 steer -> L1 compaction
            // -> L2 forced re-plan. Replaces the count-based REPEAT_THRESHOLD steer.
            const recite = this.buildLoopRecite()
            const action = evaluateCall(this.loopState, key, { toolName: name, recite, hasTasks: this.tasks && recite.length > 0 })
            if (action.kind !== 'allow') {
              if (action.kind === 'compact') {
                try {
                  const r = await this.compactHistory(currentRunStart, 0, emitAndLog)
                  currentRunStart = r.newRunStart
                } catch (err) {
                  emitAndLog({ type: 'warning', message: `Loop-recovery compaction failed (${err instanceof Error ? err.message : String(err)}) — continuing` })
                }
              }
              emitAndLog({ type: 'warning', message: action.message })
              this.pushCtx({ role: 'tool', content: action.message })
              continue
            }
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
              this.pushCtx({ role: 'tool', content: steer })
              continue
            }
          }

          emitAndLog({ type: 'tool_call', tool: name, args })

          const start = Date.now()
          const result = await executeTool(name, args)
          const duration_ms = Date.now() - start

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
          if (config.critic || this.grounding || this.memory) {
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

      const errMsg = `Reached maximum iterations (${this.maxIterations}) without a final answer.`
      emitAndLog({ type: 'error', message: errMsg })
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
      const message = `Unexpected error: ${err instanceof Error ? err.message : String(err)}`
      emitAndLog({ type: 'error', message })
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

  private async autoCommit(emitAndLog: (e: AgentEvent) => void): Promise<void> {
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
