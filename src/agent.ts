import { Ollama } from 'ollama'
import type { Message, ChatResponse } from 'ollama'
import { promises as fs } from 'fs'
import path from 'path'
import { config } from './config.js'
import { toolDefinitions, executeTool } from './tools/index.js'
import { bash, NO_OUTPUT } from './tools/bash.js'
import { truncateOutput } from './tools/truncate.js'
import { SessionLogger, LOGS_DIR } from './logger.js'
import { TraceLogger } from './al-logger.js'
import type { AgentEvent, ToolName, ModelOptions, Role } from './types.js'
import { PROGRESS_CHECK_ITERATIONS, PROGRESS_CHECK_MESSAGES, ROLE_CONCLUDE_STATUSES, concludeStatusError } from './frames.js'
import {
  createLoopState, noteMutation, noteBashExecution, evaluateCall, normalizeCallKey, recordResult, type LoopState,
  // H21 closes the unbounded-retry hole where a call the role gate refuses is
  // invisible to evaluateCall (it `continue`s past it on rejection — see the
  // tool-call loop below). See loop.ts's H21 header note for the evidence.
  noteGateRejection, gateEscalationMessage, gateStopMessage, type GateReason,
} from './loop.js'
import { classifyTool, inferDependencies, evict, type EpisodeMeta, type EvictionBudget } from './eviction.js'
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
//
// buildSystemPrompt takes the frame's REAL tool list (null for the unrestricted
// baseline) and builds the TOOLS section from only what `has()` says is actually
// there — a role that lacks write_file/edit_file is never told about them, and
// gets an explicit note instead pointing at what it DOES have for reading/
// investigating.
function buildSystemPrompt(tools: ToolName[] | null, roleInstructions?: string, role?: string): string {
  const has = (t: ToolName): boolean => tools === null || tools.includes(t)
  const canWrite = has('write_file') || has('edit_file')

  const toolLines = [
    has('bash') && '- bash: run shell commands. Pass the working directory via the cwd argument (e.g. /workspace); do not prefix with "cd /workspace &&".',
    has('read_file') && '- read_file: whole-file read at any absolute path.',
    has('write_file') && '- write_file: whole-file write at any absolute path.',
    has('edit_file') && '- edit_file: replace an exact string in a file; it reports the changed lines and errors if the text is missing or matches more than once.',
    has('fetch_url') && '- fetch_url: fetch a page\'s text content (no JavaScript execution).',
    has('browser_fetch') && '- browser_fetch: fetch a page and run its JavaScript — for pages that need it to render.',
    has('web_search') && '- web_search: look up things you do not already know.',
    '- conclude(status, message): end your session with a status keyword and a message.',
    // Read-only roles (Planner, Boss) get told explicitly what to use instead of
    // write_file/edit_file, rather than left to infer it from the absence of a bullet.
    !canWrite && '- You have no file-modification tools in this role: use the tools above (read_file, and bash/web_search/fetch_url where listed) to investigate — you cannot change the project.',
  ].filter((line): line is string => typeof line === 'string').join('\n')

  return `You are Argo, a multi-agent system with a coding harness. Your project is mounted at /workspace in an isolated Ubuntu Docker container. Your thoughts, tool calls, and results stream live to the user, and changes under /workspace are committed to git when auto-commit is enabled.
${roleInstructions ? '\n' + roleInstructions + '\n' : ''}
TOOLS — invoke them through the function-calling API; never as text in your reply.
${toolLines}

ENVIRONMENT
${has('bash')
    ? '- Ubuntu 24.04. CLI includes bash, git, jq, node, python3, rg, fd, sqlite3, curl. In Node use require() (NODE_PATH is set), not import; native fetch() is available; cheerio and playwright are preinstalled.'
    : '- Ubuntu 24.04 container. This role has no direct shell access — investigate using the tools listed above.'}

FILESYSTEM
- /workspace is the git-tracked project folder — the only place that is committed. Keep scratch, experiments, and downloads elsewhere (/tmp, your home directory).
- Use absolute paths.${has('bash') ? ' For commands about the project itself (npm test, git, node <file>), set the bash cwd to /workspace.' : ''}

${(role === 'implementer') ? '' : `MEMORY
- /workspace/AGENTS.md (project instructions) and /workspace/MEMORY.md (durable memory), are appended below.${canWrite ? ' Update MEMORY.md only for durable, reusable facts — tersely, in place — never one-off task state.' : ''}`}

PRECISION
- Before finishing, verify the objective against the original request.
- Distinguish what you verified from what you assumed; do not present a guess as a fact.
- Never reconstruct an exact identifier, path, URL, flag, or package name from memory — copy it verbatim from the tool result where it appeared, or re-read the source.

To finish, call \`conclude\` with the appropriate status keyword and your message to end your session.`
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
// The optional onTimeout callback fires exactly once, right before the timeout rejects —
// used by chatCall to abort the underlying fetch (see its own comment) since Promise.race
// merely stops WAITING on the losing promise, it never cancels it.
function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (onTimeout) onTimeout()
      reject(new Error(`Ollama did not respond within ${ms / 1000}s`))
    }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer!))
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
// makes the (much rarer) deterministic eviction pass fire less often. Non-destructive:
// this.history keeps the full results for the JSONL log; only what is SENT to the
// model shrinks.
export const KEEP_RECENT_TOOL_RESULTS = 4
export const TOOL_RESULT_COLLAPSE_OVER = 600

export function repetitionKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`
}

// Short human-readable summary of a call's key arguments — included in the loop
// detection warning so the reader can verify WHICH call was repeated, not just that
// "the same tool" was. See loop.ts's LoopContext.callSummary.
function summarizeCall(name: string, args: Record<string, unknown>): string {
  if (name === 'fetch_url' && typeof args.url === 'string') return args.url
  if (name === 'read_file' && typeof args.path === 'string') return args.path
  if (name === 'bash' && typeof args.command === 'string') {
    const cmd = args.command
    return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd
  }
  const json = JSON.stringify(args)
  return json.length > 80 ? `${json.slice(0, 80)}…` : json
}

// A "project mutation" is an edit_file/write_file targeting the git-tracked
// workspace (scratch writes elsewhere don't count). Used by the no-progress
// re-anchor and the loop-recovery ladder's mutation tracking below.
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
  // A turn with no tool calls is a thinking turn, not a terminal one — only calling
  // `conclude` finishes a session. Stated explicitly here so this steer's own
  // urgency ("you appear stuck... do ONE thing now") isn't quietly defeated by
  // advice that reads like "just answer" but doesn't actually end anything.
  return `You appear stuck — ${detail}. Re-anchor to the objective: "${objective}". Do ONE thing now: either make the single most important change (an edit) that advances that objective, or — if it is already met, or you are genuinely blocked — call conclude with your final answer, stating what you accomplished and (if blocked) exactly what is blocking you. Stop re-inspecting the same things, and do not broaden or switch the objective.`
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
  const agentsContent = agentsMd
    ? `/workspace/AGENTS.md:\n${agentsMd}`
    : `/workspace/AGENTS.md:\n(file is empty or does not exist yet)`
  const memoryContent = memoryMd
    ? `/workspace/MEMORY.md:\n${memoryMd}`
    : `/workspace/MEMORY.md:\n(file is empty or does not exist yet)`
  return `<argo-agents-file>\n${agentsContent}\n</argo-agents-file>\n\n<argo-memory-file>\n${memoryContent}\n</argo-memory-file>`
}

// HOW A chat() TURN ENDED, as a fact rather than an inference:
//   'ok'      — the model called `conclude` with a final answer (a turn with no
//               tool calls is a thinking turn, not a terminal one — the ONLY way
//               to end a session is calling `conclude`).
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
// follow-up turn of the SAME frame" (dispatch.ts's resumeFrame: a Planner replanning
// round, a task-start marker retry) — keep the frame's accumulated state and keep
// counting iterations from where the last turn stopped.
export interface ChatOptions {
  resume?: boolean
}

export class Agent {
  private ollama: Ollama
  private history: Message[] = []
  private model: string
  // num_predict caps the maximum tokens (including thinking tokens) per Ollama call.
  // Without it, qwen3.6 with thinking enabled can generate up to num_ctx (65536)
  // tokens of thinking before producing any content, which intermittently hangs
  // Ollama's MLX runner on Apple M5 (ollama/ollama#17426). 8192 is generous for any
  // single tool-calling turn (thinking + content + tool call JSON).
  private options: ModelOptions = { temperature: 0.6, top_p: 0.95, top_k: 20, num_predict: 8192 }
  private autoCommitEnabled = config.autoCommit
  private maxIterations: number = config.maxIterations
  private sessionId = ''
  private aborted = false
  // Fine-grained run phase, surfaced via getPhase() -> server.ts's GET /status ->
  // central's /api/workspaces aggregation, so the home screen's status dot can
  // show ready/running/compacting/error instead of just busy/idle. 'idle' between
  // runs.
  private phase: 'idle' | 'running' | 'compacting' | 'error' = 'idle'
  // Rolling record of the last REPEAT_WINDOW executed (name+args) keys. Reset per
  // chat() run, never persisted — a legitimately repeated action in a later run
  // must start from a clean slate (see the repetition guard in chat()).
  private recentCalls: string[] = []
  // Mutation-aware loop-recovery ladder state. Reset per chat() run like
  // recentCalls — a legitimately repeated action in a later run starts clean.
  private loopState: LoopState = createLoopState()
  // Records when each this.history message entered the live context, keyed on the
  // message object itself (not its index/content) so it survives eviction's
  // splice/rebuild of this.history as long as surviving messages keep the same
  // object reference. Purely a UI concern for the context viewer (getContext) —
  // NEVER read by the model call path, so it cannot affect what is sent to Ollama.
  private historyTs = new WeakMap<object, number>()
  // Wall-clock time the most recent eviction pass finished, for the context viewer's
  // ledger box. null until the first eviction of this Agent instance.
  private lastCompactedAt: number | null = null
  private editedPaths: string[] = []
  // How many iterations THIS run actually consumed (1-based, updated every iteration
  // regardless of which exit path chat() ultimately takes) — what dispatch.ts reads to
  // decide whether a just-concluded frame was large enough to warrant an immediate
  // standup, on top of the aggregate action-episode counter.
  private lastIterationCount = 0
  // RESUME. chat(msg, { resume: true }) continues an EXISTING frame: iteration
  // numbering picks up where the previous turn left off instead of restarting at 1,
  // and none of the per-run state below is wiped. This is the count already
  // consumed by earlier turns of the same frame; 0 for a fresh chat().
  private iterationBase = 0
  // HOW THE LAST chat() TURN ACTUALLY ENDED — the single fact that used to be
  // produced and then discarded at the frame boundary. 'cap' means the iteration
  // budget ran out with no final answer, in which case chat() RETURNS the string
  // "Reached maximum iterations (N) without a final answer." and also emits a
  // terminal `error` event. Callers must consult this rather than re-deriving
  // intent from the returned text or from an iteration-count comparison (which
  // resume breaks: the counter is cumulative across turns, so `count >= max` no
  // longer means "stalled").
  private lastRunOutcome: RunOutcome = 'ok'
  private lastConcludeStatus = ''
  // this.loopState.mutationCount recorded at the last stall/progress checkpoint (see
  // chat()) — lets that checkpoint tell "genuinely stuck" apart from "still landing
  // real edits, just needed more iterations for a bigger task," which used to fire
  // the same alarmed PROGRESS CHECK/STALL message either way (a real false alarm
  // observed on an eval task: steady edits, no drift, still got nagged at iteration 20).
  private mutationCountAtLastStallCheck = 0
  // Trouble signals for THIS run, read by dispatch.ts to decide whether a
  // just-concluded frame earns extra scrutiny — a frame that hit L1/L2
  // loop-recovery or needed an Ollama retry showed real friction even if it
  // eventually converged.
  private loopSteerEscalated = false // true once evaluateCall ever returns compact(L1) or replan(L2)
  private ollamaRetryCount = 0
  // MULTI-AGENT ARCHITECTURE. A call frame is one scoped Agent instance:
  // allowedTools restricts which tools are offered to Ollama AND accepted by the
  // tool-dispatch loop (null = unrestricted, the baseline behavior); frameId
  // correlates this instance's episodes/tool calls to a ledger frame (null when not
  // running as part of a dispatch — episode recording to the ledger is a no-op
  // then). episodes is the CWL episode graph (see eviction.ts) for THIS instance's
  // own history, reset per run.
  private allowedTools: ToolName[] | null = null
  private frameId: string | null = null
  // The ORIGINAL user query for this run (dispatch.ts's runDispatchLoop's own
  // `userMessage` param), threaded down through setUserQuery() — distinct from
  // chat()'s own `userMessage` parameter, which for a dispatched frame is the
  // agent's ASSIGNMENT text (e.g. "CHECKPOINT: iteration-1\n..."), not what the
  // human actually typed. Used only for the TraceLogger header's `# Run:` title, so
  // a reader of the trace sees the human's real request rather than the internal
  // checkpoint prompt. Empty string (never set) falls back to chat()'s own
  // userMessage in that header, matching the pre-existing baseline behavior for the
  // unrestricted (non-dispatched) Agent, which never calls setUserQuery.
  private userQuery = ''
  // Which ROLE (Planner/Implementer/Boss) this frame is, set by dispatch.ts's
  // spawnFrame alongside setAllowedTools/setMaxIterations/etc (frames.ts's
  // ROLE_TOOLS/ROLE_MAX_ITERATIONS are the same per-role tables this mirrors). null
  // for the unrestricted baseline, which never sets it. The ONLY thing this drives
  // is which progress-check thresholds/messages chat() uses (frames.ts's
  // PROGRESS_CHECK_ITERATIONS/PROGRESS_CHECK_MESSAGES) — every other role-shaped
  // decision in this file already goes through allowedTools/roleInstructions.
  private roleTag: Role | null = null
  // NEW, ADDITIVE Markdown trace (al-logger.ts) — runs alongside SessionLogger, never
  // replacing it. Created fresh at the top of chat() (mirroring SessionLogger's own
  // per-call construction) and used by chatCall()/the tool-dispatch loop below via
  // this field, since chatCall() doesn't otherwise have a way to receive it (it's
  // private and its signature is unchanged — see al-logger integration notes at each
  // call site). null only in the narrow window before chat()'s first line runs;
  // every call site below guards with `this.traceLogger?.` for that reason, and
  // because a logger failure must never interrupt the real run.
  private traceLogger: TraceLogger | null = null
  // How many entries of this.history had already been presented as "new" to the
  // al-logger as of the START of the most recently opened turn — chatCall() slices
  // this.history from here to build beginTurn()'s newMessages, then advances it to
  // this.history.length for the NEXT call. Reset to 0 at the top of chat() (fresh
  // run) alongside the other per-run state, so turn 1 of every run reports its
  // entire starting history as new, matching a resumed frame's own history depth.
  private alLastMessageCount = 0
  private episodes: EpisodeMeta[] = []
  private lastCommandOutput = ''
  private actionTrace: string[] = []
  private get historyFile(): string {
    return path.join(LOGS_DIR, this.sessionId ? `history-${this.sessionId}.json` : 'history.json')
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
    this.options = { ...this.options, ...opts }
  }

  setMaxIterations(n: number) {
    this.maxIterations = Math.min(1000, Math.max(10, Math.trunc(n)))
  }

  // Lets a caller give a RESUMED turn (chat(msg, { resume: true })) a fresh iteration
  // budget instead of the default accumulating one (dispatch.ts's Planner loop —
  // resumeFrame keeps the frame's history/etc, but each detail call must get its own
  // 40-iteration budget and its own 20/30 progress checks, not an offset-by-whatever-
  // the-previous-call-used budget). Deliberately NOT the default for every resume:
  // other resume call sites (e.g. the Boss task-start marker-retry resume) rely on
  // the EXISTING accumulating behavior (iterationBase = lastIterationCount, set in
  // chat()'s resume branch) to report a frame's total effort across its whole life —
  // this only zeroes the ONE piece of state (lastIterationCount) that decision reads,
  // and only when a caller explicitly asks for it, immediately before the next
  // chat(..., { resume: true }) call.
  resetIterations() {
    this.lastIterationCount = 0
  }

  setAutoCommit(on: boolean) {
    this.autoCommitEnabled = on
  }

  // MULTI-AGENT ARCHITECTURE. null restores unrestricted (baseline) tool access —
  // see frames.ts's ROLE_TOOLS for the per-role sets dispatch.ts passes.
  setAllowedTools(tools: ToolName[] | null) {
    this.allowedTools = tools
  }

  setFrameId(id: string | null) {
    this.frameId = id
  }

  // See the userQuery field doc above — dispatch.ts calls this once, right after
  // constructing the Agent in spawnFrame, before agent.chat(assignment) runs.
  setUserQuery(q: string) {
    this.userQuery = q
  }

  // See the roleTag field doc above — dispatch.ts's spawnFrame calls this once, at the
  // same spawn site as setAllowedTools/setRoleInstructions/setMaxIterations.
  setRole(role: Role | null) {
    this.roleTag = role
  }

  // MULTI-AGENT ARCHITECTURE: appended after the baseline SYSTEM_PROMPT (whose
  // tool-usage/filesystem conventions still apply to every role) — this is what
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

  getConcludeStatus(): string {
    return this.lastConcludeStatus
  }

  // True ⇔ the last chat() turn ran out of iteration budget without producing a final
  // answer. This is the fact needed at the frame boundary; it stays true until the
  // next chat() turn starts.
  hitIterationCap(): boolean {
    return this.lastRunOutcome === 'cap'
  }

  // A read-only snapshot of the per-frame state that a RESUME must preserve —
  // instrumentation for tests and for a future frame-state view. Deliberately reports
  // presence/counts rather than handing out the live objects, so nothing external can
  // mutate this instance's run state.
  getRunState(): {
    episodes: number
    editedPaths: string[]
    iterationCount: number
    loopMutationCount: number
    hadTrouble: boolean
  } {
    return {
      episodes: this.episodes.length,
      editedPaths: [...this.editedPaths],
      iterationCount: this.lastIterationCount,
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

  // UNIFIED REJECTION SURFACING. A harness-level block (a role-restricted tool
  // outside this frame's allowed set, a loop-steered repeat) used to look
  // completely different from a real tool failure — just a floating 'warning' + a
  // bare tool-role message, with no 'tool_call'/'tool_result' pair at all. A real,
  // observed failure mode: the model reads that as *nothing happened* rather than
  // *my action was rejected*, and proceeds as if a blocked edit had actually
  // landed (only discovering the truth several turns later when a test still
  // fails). Fix: make a rejection emit the EXACT same tool_call + tool_result shape
  // a genuine tool error does — indistinguishable in kind, so the model's already-
  // trained "my last call failed" recognition fires the same way either way.
  private rejectToolCall(name: ToolName, args: Record<string, unknown>, reason: string, emitAndLog: (e: AgentEvent) => void): void {
    emitAndLog({ type: 'tool_call', tool: name, args })
    emitAndLog({ type: 'tool_result', tool: name, output: '', error: reason, duration_ms: 0, rejected: true })
    this.pushCtx({ role: 'tool', content: `Error: ${reason}` })
  }

  // H21. Wraps rejectToolCall for the role gate, which `continue`s straight past the
  // loop-recovery ladder on a rejection (see its call site below) — so an identical
  // (call, reason) pair refused over and over is counted, and eventually bounded,
  // the same way the ladder already bounds an identical EXECUTED call. Captured
  // live: two Planner frames issued 9 and 7 rejected `bash` calls, all refused on
  // role, with nothing watching — genuinely invisible before this change, since the
  // role gate's `continue` never reached evaluateCall.
  //
  // Returns null once the rejection has been emitted and the caller should
  // `continue` the tool-call loop as before (the overwhelmingly common case —
  // below cfg.gateStopAfter). Returns the STOP message once the (call, reason)
  // pair has been refused cfg.gateStopAfter times in a row: the caller must then
  // END THE FRAME (see the call site below) rather than continue, exactly like a
  // genuine iteration-cap hit — never `continue` past a non-null return, or the
  // frame just keeps asking (and being refused) the same thing forever, which is
  // precisely the hole this closes.
  //
  private handleGateRejection(
    name: ToolName,
    args: Record<string, unknown>,
    key: string | undefined,
    reason: GateReason,
    plainMessage: string,
    emitAndLog: (e: AgentEvent) => void,
  ): string | null {
    if (key === undefined) {
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
  // (never 'success' — the exact "never fail open" property this must have).
  private endFrameStalled(message: string, emitAndLog: (e: AgentEvent) => void): string {
    this.lastRunOutcome = 'cap'
    emitAndLog({ type: 'error', message })
    this.phase = 'idle'
    return message
  }

  // LOOP-RECOVERY LADDER, L0 cached-replay form. Unlike rejectToolCall above —
  // which deliberately frames a block as an ERROR so the model can't tell a
  // harness rejection from a real failure — a replay is telling the model
  // something true and useful: this exact call already ran, nothing has changed,
  // and here again is exactly what it returned. Still marked rejected (the tool did
  // not actually run a second time — see AgentEvent's doc comment) plus replayed
  // (this specific reason for not running it), and still gets the same tool_call/
  // tool_result event PAIR every other outcome here gets, so analytics can tell
  // "really executed" / "harness blocked" / "harness replayed" apart without
  // guessing from message text.
  private replayToolCall(name: ToolName, args: Record<string, unknown>, cached: { output: string; error?: string }, label: string, emitAndLog: (e: AgentEvent) => void): void {
    emitAndLog({ type: 'tool_call', tool: name, args })
    emitAndLog({ type: 'tool_result', tool: name, output: cached.output, error: cached.error, duration_ms: 0, rejected: true, replayed: true })
    const body = cached.error ? `Error: ${cached.error}\n${cached.output}` : cached.output
    this.pushCtx({ role: 'tool', content: `${label}\n\n[Previous result, reproduced verbatim — nothing has changed]\n${body}` })
  }

  // Lets the user force an eviction pass between turns (server.ts's POST
  // /compact-now, guarded the same way /reset is — only when the agent isn't
  // mid-run). Reuses compactHistory exactly as the automatic threshold path does.
  // Writes its own tiny run-shaped JSONL log so the manual trigger is traceable the
  // same way an automatic eviction is.
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

  // Deterministic, no-LLM eviction (CWL-style — see eviction.ts): strips the oldest
  // already-durably-persisted tool-call episodes from the live window when it grows
  // too large, never restructuring this.history's surviving indices. This is the
  // ONLY context-management mechanism in this codebase — there is no LLM-
  // summarization fallback path. Returns the active prompt's index unchanged
  // (eviction never removes or reorders the current run's own prompt).
  private async compactHistory(
    currentRunStart: number,
    contextUsagePct: number,
    emitAndLog: (e: AgentEvent) => void,
    manual = false,
  ): Promise<{ newRunStart: number; compacted: boolean }> {
    const msgsBefore = this.history.length
    // Budget in the SAME unit the trigger fires on (tokens, via numCtx), not an
    // unrelated flat char count — the root cause this replaces (see eviction.ts).
    // Target ~70% of num_ctx post-eviction so there's real headroom left, not just
    // enough to dip under the trigger threshold before immediately re-triggering.
    const numCtx = this.options.num_ctx ?? 65536
    const budget: EvictionBudget = { maxTokens: Math.floor(numCtx * 0.7) }
    const { messages, evictedEpisodeIds, tokenEstimateBefore, tokenEstimateAfter } = evict(this.history, this.episodes, budget)
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
      summary: `deterministic eviction: stubbed ${evictedEpisodeIds.length} episode(s), ~${Math.round(tokenEstimateBefore)} → ~${Math.round(tokenEstimateAfter)} est. tokens`,
      messagesBefore: msgsBefore,
      messagesAfter: this.history.length,
      contextUsagePct,
      rangeDescription: `evicted ${evictedEpisodeIds.length} episode(s), oldest-action-first`,
      validated: false,
      manual,
    })
    return { newRunStart: currentRunStart, compacted: true }
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
    // full results (the JSONL log still sees everything); only what is SENT to the
    // model shrinks. This is the cheapest way to hold the window small over many
    // turns, and it makes the (rarer) deterministic eviction pass fire less.
    const toolPos: number[] = []
    this.history.forEach((m, i) => { if (m.role === 'tool') toolPos.push(i) })
    const collapse = new Set(toolPos.slice(0, Math.max(0, toolPos.length - KEEP_RECENT_TOOL_RESULTS)))
    const messages: Message[] = systemPrompt ? [{ role: 'system', content: systemPrompt }] : []
    // NEW, ADDITIVE Markdown trace (al-logger.ts): collect the collapsed-message detail
    // (original vs. sent length) as this.history is walked below, in the SAME pass
    // that decides collapsing — rather than recomputing it separately — so this can
    // never drift out of sync with what was actually sent this turn.
    const alCollapsed: Array<{ index: number; originalChars: number; sentChars: number; role: string }> = []
    this.history.forEach((m, i) => {
      const c = m.content
      if (collapse.has(i) && typeof c === 'string' && c.length > TOOL_RESULT_COLLAPSE_OVER) {
        const stub = `[older tool output collapsed — ${c.length} chars; re-read the file or re-run the command if you need it]\n${c.slice(0, 200).replace(/\s+/g, ' ')}…`
        messages.push({ role: 'tool', content: stub })
        alCollapsed.push({ index: i, originalChars: c.length, sentChars: stub.length, role: m.role })
      } else {
        messages.push(m)
      }
    })
    // NEW, ADDITIVE Markdown trace: open this turn's `## Turn` section BEFORE the
    // Ollama call — "new" messages are exactly this.history's tail since the
    // previous call (alLastMessageCount), turn 1 of a run being the whole starting
    // history. Read via a cast since this.history's Message role/content typing is
    // the ollama package's own (broader) union; AlMessage only needs role+content
    // as strings.
    {
      const newSlice = this.history.slice(this.alLastMessageCount)
      const newAlMessages = newSlice.map(m => ({ role: String(m.role), content: typeof m.content === 'string' ? m.content : String(m.content ?? '') }))
      this.traceLogger?.beginTurn(messages.length, newAlMessages, alCollapsed.length > 0 ? alCollapsed : undefined)
      this.alLastMessageCount = this.history.length
    }
    // Recitation (Manus todo.md pattern): keep the objective at the very tail of
    // context every iteration so it stays in the model's recent attention and
    // doesn't get lost mid-history over a long run. Transient — not stored in
    // this.history, so it can never duplicate or drift out of sync, and it
    // survives eviction (which only rewrites this.history) for free.
    if (this.roleTag) {
      const recite = this.buildLoopRecite()
      if (recite) messages.push({ role: 'tool', content: recite })
    }
    // MULTI-AGENT ARCHITECTURE: a role-scoped frame only offers Ollama the tools in
    // this.allowedTools (frames.ts's ROLE_TOOLS); null (baseline, and every existing
    // caller) offers the full set unchanged.
    const offeredTools = this.allowedTools
      ? toolDefinitions.filter(t => this.allowedTools!.includes(t.function.name as ToolName))
      : toolDefinitions
    // TIMEOUT ABORT — STREAMING: the Ollama JS client only tracks a request in
    // `ongoingStreamedRequests` (what its own abort() walks and cancels) when the
    // request is STREAMED — a stream:false call's underlying fetch has no abort
    // hook at all, so a plain `this.ollama.abort()` would be a no-op for the
    // request that actually mattered. On a slow prefill that blew past
    // chatTimeoutMs, the old request kept running server-side, the retry queued
    // behind it, and if prefill genuinely needed more than chatTimeoutMs, the
    // retry timed out too. Ollama v0.33.0 added restore points so a CANCELLED
    // prefill resumes on retry instead of restarting — but only if the
    // cancellation actually reaches the server, which requires a real abort
    // signal, which requires streaming.
    //
    // Streamed chunks are DELTAS, not cumulative snapshots. content and thinking
    // must be concatenated across every chunk; tool_calls arrive whole on the
    // terminal chunk (done:true) and are never split. Every other ChatResponse
    // field (model, created_at, done, done_reason, the *_duration/*_count timing
    // fields) is only meaningful on that terminal chunk, so it is taken from there
    // and used to seed the accumulator up front.
    //
    // Test-mock compatibility: agent.test.ts's scriptedOllama()/flakyOllama() mock
    // `chat()` to return a plain ChatResponse object directly, matching the OLD
    // stream:false call — detect which shape came back and branch: a real
    // AbortableAsyncIterator has a Symbol.asyncIterator method; a mocked plain
    // response does not.
    const streamPromise = (async (): Promise<ChatResponse> => {
      const result = await this.ollama.chat({
        model: this.model,
        messages,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        tools: offeredTools as any[],
        stream: true,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: this.options as any,
      })
      if (!(result && typeof (result as AsyncIterable<ChatResponse>)[Symbol.asyncIterator] === 'function')) {
        // Mocked non-streaming shape (tests) — already the complete response.
        return result as unknown as ChatResponse
      }
      let final: ChatResponse | null = null
      let content = ''
      let thinking = ''
      let toolCalls: ChatResponse['message']['tool_calls'] | undefined
      for await (const chunk of result as AsyncIterable<ChatResponse>) {
        content += chunk.message?.content ?? ''
        thinking += chunk.message?.thinking ?? ''
        // tool_calls arrive on a NON-TERMINAL chunk (measured: chunk N-1 carries
        // the tool_calls array, chunk N is the done:true terminal with no
        // tool_calls). Capture from whichever chunk has them — never overwrite
        // a captured value with a later chunk's undefined/empty array.
        if (chunk.message?.tool_calls?.length) toolCalls = chunk.message.tool_calls
        // The terminal done:true chunk carries timing/count fields. Keep
        // overwriting so the last chunk wins for everything except the
        // accumulators above.
        final = chunk
      }
      if (!final) throw new Error('Empty stream response from Ollama')
      return { ...final, message: { ...final.message, content, thinking: thinking || undefined, tool_calls: toolCalls ?? final.message?.tool_calls } }
    })()
    return withTimeout(streamPromise, config.chatTimeoutMs, () => { try { this.ollama.abort() } catch { /* best effort */ } })
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
  // chat()'s outer catch (the existing safety net).
  // Returns null on user abort. Returns an object with `{ timeoutError: string }` when
  // both the original call and the retry timed out — the iteration loop injects this as
  // context for the agent and continues rather than killing the run. Non-timeout errors
  // (e.g. malformed response, connection refused) are still rethrown to the outer catch.
  private async chatWithRetry(systemPrompt: string, emitAndLog: (e: AgentEvent) => void) {
    const isTimeout = (e: unknown) => e instanceof Error && e.message.includes('did not respond within')
    try {
      return await this.chatCall(systemPrompt)
    } catch (err) {
      this.ollamaRetryCount++
      const msg = err instanceof Error ? err.message : String(err)
      emitAndLog({ type: 'warning', message: `Ollama request failed (${msg}) — retrying once` })
      await new Promise(resolve => setTimeout(resolve, this.chatRetryDelayMs))
      if (this.aborted) return null
      try {
        return await this.chatCall(systemPrompt)
      } catch (retryErr) {
        // Only soft-recover on timeouts — other errors (malformed response, etc.) are
        // still fatal and rethrown to chat()'s outer catch as before.
        if (isTimeout(retryErr)) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr)
          emitAndLog({ type: 'warning', message: `Ollama retry also timed out (${retryMsg}) — injecting error and continuing` })
          return { timeoutError: `The model did not respond (${retryMsg}). Your previous request was lost. Continue from where you left off — re-issue your last tool call or take a different approach.` }
        }
        throw retryErr
      }
    }
  }

  // Re-anchor text for the loop-recovery steer, and for the per-iteration tail
  // recitation in chatCall: just the run's objective, when one is known. Roles
  // without a harness-tracked objective (the unrestricted baseline) get an empty
  // string, which is a no-op wherever this is used.
  private buildLoopRecite(): string {
    return ''
  }

  async chat(userMessage: string, opts?: ChatOptions): Promise<string> {
    const resume = opts?.resume === true
    const logger = new SessionLogger(userMessage, this.model, this.options, this.sessionId)
    // NEW, ADDITIVE Markdown trace (al-logger.ts) — see the field doc comment above.
    // The tool set offered is computed the SAME way chatCall() computes offeredTools
    // (this.allowedTools ? filter : the full set) since that filtering only depends
    // on state already set before chat() runs (dispatch.ts's spawnFrame calls
    // setAllowedTools before chat()), not on anything chatCall() itself derives per
    // call — so recomputing it here for the header is equivalent, not a guess.
    const alTools = this.allowedTools
      ? toolDefinitions.filter(t => this.allowedTools!.includes(t.function.name as ToolName))
      : toolDefinitions
    // sessionId/frameId/jsonl filename are cross-reference IDs only (see al-logger.ts's
    // header) — they let a reader of the trace jump straight to the matching JSONL
    // log (logger.getFilename()) and, from there, to the session/frame this run
    // belongs to. this.sessionId is always a string (never undefined) but an empty
    // one means "no session yet", which the header should omit rather than render
    // as an empty label. this.userQuery (set via setUserQuery by dispatch.ts) is the
    // ORIGINAL human request, distinct from `userMessage` below (this frame's own
    // assignment text) — falls back to userMessage when never set, so the
    // unrestricted baseline Agent (which never calls setUserQuery) still gets a
    // sensible header.
    this.traceLogger = new TraceLogger(
      this.userQuery || userMessage, this.model, this.options, this.roleTag ?? 'agent', alTools,
      this.sessionId || undefined, this.frameId ?? undefined, logger.getFilename(),
    )
    // Each chat() call gets its OWN trace file (a fresh header + turn numbering
    // from 1), even on a resumed frame — so "new" for turn 1 of THIS file always
    // means "everything chatCall() is about to send", matching what that file's own
    // reader sees with no other file to cross-reference.
    this.alLastMessageCount = 0

    const emitAndLog = (event: AgentEvent) => {
      logger.log(event)
      // Pass the seq log() just assigned (it pushes synchronously, before its
      // first await, so getSeq() already reflects this event) so the SSE stream
      // carries the same per-run seq the JSONL persists — this is what lets the
      // UI dedupe replayed-vs-live events at the reconnect boundary.
      const seq = logger.getSeq()
      this.emit(event, seq)
      // NEW, ADDITIVE Markdown trace: forward harness-level events (eviction/
      // compact, warning, error) to the trace logger too, along with the JSONL seq
      // this event was just written at — logEvent() stores it so the NEXT turn/
      // response it renders carries a seq cross-reference. logEvent() is a no-op
      // (render-wise) for any AgentEvent variant it doesn't render (see its own
      // switch), so this is safe to call unconditionally for every event without a
      // parallel filter here.
      this.traceLogger?.logEvent(event, seq)
    }

    this.pushCtx({ role: 'user', content: userMessage })
    this.phase = 'running'
    // The index of the message that started this run — compactHistory() always
    // keeps history[currentRunStart] verbatim, however many iterations follow it.
    // Reassigned (not recomputed) after each eviction pass, since eviction can
    // replace `this.history` wholesale and returns the prompt's new position in it.
    let currentRunStart = this.history.length - 1
    // Consecutive no-tool-call ("thinking") turns, local to this chat() call (not a
    // class field — a class field would carry across a resumed frame's later chat()
    // call and could suppress or misfire the nudge for state it never actually saw).
    // Reset to 0 on any turn that DOES produce a tool call, so the count always
    // means "since the last real action," not "since the run started."
    let consecutiveThinkingTurns = 0
    let consecutiveTimeouts = 0
    // How this turn ends is decided by whichever exit path below runs; assume the good
    // case so a normal final answer needs no bookkeeping, and overwrite on the cap /
    // error / abort paths. Reset for a resumed turn too: it describes the LAST turn.
    this.lastRunOutcome = 'ok'
    this.lastConcludeStatus = ''
    if (resume) {
      // RESUMED TURN: keep every piece of frame state. Continue the iteration count
      // from where the previous turn stopped, so a resumed frame reports "ITER
      // 11/20" rather than starting over at 1 — and so a caller can still see the
      // frame's TOTAL effort. Everything the fresh-run branch below clears
      // (loopState, editedPaths, episodes, the trouble flags) is deliberately left
      // in place: the follow-up message is a continuation of the same work. Note
      // loopSteerEscalated/ollamaRetryCount are STICKY per frame on purpose —
      // friction that happened in an earlier turn of this frame is still friction
      // dispatch.ts's standup trigger should see.
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
      this.editedPaths = []
      this.lastCommandOutput = ''
      this.actionTrace = []
      this.episodes = []
    }
    let loopSteers = 0
    // No-progress detector: tool calls since the last actual change to the project.
    // A run that keeps inspecting without ever editing is stuck (the novel-arg
    // thrash the identical-call guard misses); noProgressSteers escalates the re-anchor.
    let callsSinceMutation = 0
    let noProgressSteers = 0
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

    // Implementer never gets AGENTS.md/MEMORY.md content (the Planner reads those
    // files and folds anything relevant directly into the assignment instead).
    const skipProjectContext = this.roleTag === 'implementer'
    const projectContext = skipProjectContext ? '' : await loadProjectContext()
    // this.allowedTools (null for the unrestricted baseline) is the frame's REAL
    // tool set — buildSystemPrompt derives which tools to describe from it directly,
    // so passing it here is what lets the TOOLS section itself stay truthful per role.
    const rolePrompt = buildSystemPrompt(this.allowedTools, this.roleInstructions || undefined, this.roleTag || undefined)
    const systemPrompt = projectContext ? `${rolePrompt}\n\n${projectContext}` : rolePrompt
    // Logging-only: makes the full prompt (tool list + role suffix + AGENTS.md/
    // MEMORY.md context) visible in the run log. Emitted before the first
    // iteration/tool_call so a reader sees it ahead of anything it produced.
    // Does not affect what is sent to the model.
    emitAndLog({ type: 'system_prompt', content: systemPrompt })

    // Prepend the system prompt to the FIRST user message of this run only,
    // instead of sending it as a separate Ollama 'system' role message on every
    // call. currentRunStart still points at the entry pushCtx added for
    // userMessage above (eviction hasn't run yet at this point in chat()), so
    // mutate it in place. On a RESUMED turn (opts.resume) this is skipped: the
    // follow-up text pushed for this turn is a continuation of a frame whose
    // history already carries the system prompt embedded in its own first message
    // from the original (non-resumed) chat() call — prepending again would
    // duplicate it on every resumed turn.
    if (!resume) {
      const startEntry = this.history[currentRunStart]
      if (startEntry && startEntry.role === 'user' && typeof startEntry.content === 'string') {
        startEntry.content = `${systemPrompt}\n\n${startEntry.content}`
      }
    }

    // Stall/progress-check iteration numbers for THIS run, scaled to THIS run's own
    // budget (multi-agent roles run short, fixed budgets — Boss/Planner 15-40, a Boss
    // task-start checkpoint as low as 6 — and the original fixed 20/35/45 checkpoints
    // below simply never fired for them, since they hit their own hard maxIterations
    // ceiling first and got ZERO mid-run steering. Each checkpoint is min(the
    // original fixed value, a fraction of this run's own maxIterations) — for any
    // budget >=~60 (Implementer's, and the baseline's own typical config) this
    // reduces to exactly the original fixed values (unchanged); for a short-budget
    // role it scales down proportionally instead of never firing at all.
    // Offset by iterationBase on a RESUMED turn so the checkpoints keep firing at
    // the same positions WITHIN this turn — the alternative (absolute numbering)
    // would put every checkpoint in the past for a resumed frame and silently give
    // it no mid-run steering at all.
    // The Boss task-start classification checkpoint (dispatch.ts's
    // buildTaskStartAssignment, marked 'CHECKPOINT: task-start') gets its first
    // check pushed all the way to its own 10-iteration cap instead of 0.4 of it
    // (=4) — classification is expected to finish fast, and a mid-run steer at 4
    // was firing well before the model had a real chance to converge.
    const isBossTaskStartCheckpoint = userMessage.startsWith('CHECKPOINT: task-start')
    // PER-ROLE FIXED PROGRESS CHECKS (frames.ts's PROGRESS_CHECK_ITERATIONS/
    // PROGRESS_CHECK_MESSAGES). When this frame's role has an entry there (currently
    // Planner and Implementer only), its checkpoints are these EXACT per-call
    // iteration numbers with EXACT message text, replacing the generic fraction-of-
    // maxIterations mechanism below for this frame only. null for every other role
    // (Boss, the unrestricted baseline), which keeps the generic mechanism exactly
    // as it was.
    const roleProgressIterations = this.roleTag ? PROGRESS_CHECK_ITERATIONS[this.roleTag] : undefined
    const roleProgressMessages = this.roleTag ? PROGRESS_CHECK_MESSAGES[this.roleTag] : undefined
    const stallCheckpoints = roleProgressIterations
      ? roleProgressIterations.map(n => this.iterationBase + n)
      : [isBossTaskStartCheckpoint ? 1 : 0.4, 0.65, 0.85].map((frac, idx) =>
          this.iterationBase + Math.min([20, 35, 45][idx], Math.max(1, Math.round(frac * this.maxIterations))),
        )
    // A resumed turn gets its own full iteration allowance; what carries over is the
    // COUNT (for reporting), not the remaining budget — a targeted follow-up that
    // inherited only a couple of leftover iterations could not act on the
    // instruction it was given, which would defeat the point of resuming. `max` is
    // reported cumulatively for the same reason, so the emitted iteration event
    // never shows current > max.
    const maxForRun = this.iterationBase + this.maxIterations

    try {
      iterations: for (let i = 0; i < this.maxIterations; i++) {
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
        // loop-steer guard can't help — its churn has novel args. So at fixed
        // iteration counts (well above normal convergence — observed passing tasks
        // ≤13 iters), scaled to THIS run's own budget (stallCheckpoints, above),
        // inject a non-terminating re-ground toward the objective. Each fires once
        // (iterNum is strictly increasing). Cumulative across a frame's turns
        // (stallCheckpoints are offset by the same base), so the comparison and the
        // "N iterations without finishing" wording both refer to the frame's own
        // total effort rather than resetting on every resume.
        const iterNum = iterCurrent
        if (roleProgressMessages) {
          // FIXED PER-ROLE PROGRESS CHECK (Planner/Implementer, see stallCheckpoints
          // above) — fires unconditionally at each listed iteration, regardless of
          // whether real edits have landed since the last one: these are countdown
          // nudges toward a hard cap, not a stall detector, so "the model is making
          // genuine progress" is not a reason to skip one. index-aligned with
          // roleProgressIterations, which is how stallCheckpoints was built.
          const idx = stallCheckpoints.indexOf(iterNum)
          if (idx !== -1) {
            const stall = roleProgressMessages[idx]
            emitAndLog({ type: 'warning', message: stall })
            this.pushCtx({ role: 'tool', content: stall })
          }
        } else if (stallCheckpoints.includes(iterNum)) {
          // Real edits landing since the LAST checkpoint (not since run start — a
          // stretch of pure investigation right after an earlier burst of edits
          // should still be able to trip the alarm) mean this is a bigger task making
          // genuine progress, not a stuck loop — skip the alarmed message entirely
          // rather than nagging a model that is already doing the right thing.
          const mutationsSinceLastCheck = this.loopState.mutationCount - this.mutationCountAtLastStallCheck
          this.mutationCountAtLastStallCheck = this.loopState.mutationCount
          if (mutationsSinceLastCheck === 0) {
            const objective = userMessage
            const isLastCheckpoint = iterNum === stallCheckpoints[stallCheckpoints.length - 1]
            // The Boss task-start checkpoint gets its own short one-liner instead of
            // the generic PROGRESS CHECK below — that one restates the full
            // objective/userMessage, which for this checkpoint is the ENTIRE
            // original user request (often long, sometimes multi-paragraph);
            // classification only needs a reminder of the mode split, not its own
            // input echoed back at it.
            const stall = isBossTaskStartCheckpoint
              ? `PROGRESS CHECK: ${iterNum} iterations in and not finished. Your task is not to dig deep into ` +
                'the project, but to classify the original user request into one of the three modes: ANSWER, ' +
                'SIMPLE or OBJECTIVE, followed by the answer or the objective.'
              : isLastCheckpoint
              ? `STALL: ${iterNum} iterations without finishing — your approach is not converging. Call conclude NOW with your best verdict/answer given what you have found so far, or take one genuinely different action — do not repeat what has not worked.`
              : `PROGRESS CHECK: ${iterNum} iterations in and not finished. Objective: "${objective}". State what you have confirmed so far, then either call conclude with your verdict/answer or take the single most important remaining action — do not keep re-checking the same thing.`
            emitAndLog({ type: 'warning', message: stall })
            this.pushCtx({ role: 'tool', content: stall })
          }
        }

        emitAndLog({ type: 'ollama_request', iteration: i + 1, message_count: this.history.length + 1, model: this.model })

        // '' — the system prompt is no longer sent as a separate Ollama 'system' role
        // message; it was already prepended to the first user message in this.history
        // above, and chatCall omits the system message entirely when passed an empty
        // string.
        const response = await this.chatWithRetry('', emitAndLog)
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
        // Timeout recovery: both the original call and the retry failed (e.g. Ollama
        // MLX engine hung). Instead of killing the run, inject the error as context
        // and continue the iteration loop — the agent sees the error and can adapt.
        if ('timeoutError' in response) {
          consecutiveTimeouts++
          if (consecutiveTimeouts >= 3) {
            // Three consecutive timeouts — the model is genuinely unresponsive.
            const capMsg = `Stopped after ${consecutiveTimeouts} consecutive timeouts.`
            this.lastRunOutcome = 'error'
            emitAndLog({ type: 'error', message: capMsg })
            emitAndLog({ type: 'done', content: capMsg })
            this.phase = 'idle'
            return capMsg
          }
          emitAndLog({ type: 'warning', message: response.timeoutError })
          this.pushCtx({ role: 'tool', content: `Error: ${response.timeoutError}` })
          continue iterations
        }
        consecutiveTimeouts = 0 // reset on any successful response

        // NEW, ADDITIVE Markdown trace (al-logger.ts): log the raw response for
        // this turn as soon as it's known, before any of the token/eviction/
        // tool-call handling below runs — everything after this point reacts to
        // the SAME response, so logging it here captures it exactly as the model
        // returned it. toolCalls/thinking/content are read straight off
        // response.message; native tool_calls are logged here even though the loop
        // below may ALSO fall back to JSON-parsed calls from content
        // (extractToolCallsFromContent) — this block only records what the model
        // actually returned, not the harness's own fallback interpretation of it.
        this.traceLogger?.logResponse({
          thinking: response.message?.thinking,
          content: response.message?.content,
          toolCalls: (response.message?.tool_calls ?? []).map((tc) => ({ name: tc.function.name, args: tc.function.arguments as object })),
          durationMs: response.total_duration != null ? Math.round(response.total_duration / 1e6) : undefined,
          role: response.message?.role,
          done: response.done,
          doneReason: response.done_reason,
          promptEvalCount: response.prompt_eval_count,
          evalCount: response.eval_count,
        })

        const numCtx = this.options.num_ctx ?? 65536
        if (response.prompt_eval_count != null) {
          this.traceLogger?.logContext(response.prompt_eval_count, numCtx)
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
          // Trigger when only ~compactReserveTokens of headroom remain (near-full),
          // instead of at a fixed fraction — the context is allowed to fill more
          // before the eviction pass runs.
          const usagePct = response.prompt_eval_count / numCtx
          if (response.prompt_eval_count >= numCtx - config.compactReserveTokens) {
            try {
              this.phase = 'compacting'
              const result = await this.compactHistory(currentRunStart, usagePct, emitAndLog)
              currentRunStart = result.newRunStart
              this.phase = 'running'
            } catch (err) {
              // Deliberately falls through to the next normal iteration rather than
              // blocking on a synchronous retry: a hard block risks the loop getting
              // stuck retrying eviction forever if it's failing for a structural
              // reason, with no forward progress and no way for the user to see a
              // real answer.
              this.phase = 'running'
              emitAndLog({ type: 'warning', message: `Context eviction failed (${err instanceof Error ? err.message : String(err)}) — continuing with full history` })
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

        // THINKING TURN: a turn with no tool calls does not end the session — the
        // ONLY way to end the session is calling `conclude` (see its handler in the
        // per-call loop below); an iteration cap hit is the one other terminal
        // path, and it is unchanged. So this branch is just "keep the model's
        // reasoning in context and nudge it toward an explicit next move."
        if (!hasCalls) {
          this.pushCtx(msg)
          consecutiveThinkingTurns++
          // Only nudge from the 2nd consecutive thinking turn on — the model gets one
          // free turn to reason/plan without being told to hurry up; a SECOND turn in
          // a row with no tool call is when a reminder actually earns its place.
          if (consecutiveThinkingTurns >= 2) {
            const nudge = 'Your turn produced no tool calls. To finish, call conclude with your final answer. To keep working, make your next tool call.'
            emitAndLog({ type: 'warning', message: nudge })
            this.pushCtx({ role: 'tool', content: nudge })
          }
          continue
        }

        consecutiveThinkingTurns = 0
        this.pushCtx(msg)

        const callsToRun = nativeCalls.length > 0
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? nativeCalls.map((tc: any) => ({ name: tc.function.name as ToolName, args: tc.function.arguments as Record<string, unknown> }))
          : fallbackCalls.map(fc => ({ name: fc.name as ToolName, args: fc.arguments }))

        for (const { name, args } of callsToRun) {
          // CONCLUDE: the ONLY way a turn ends the session now — see the
          // thinking-turn comment above this inner loop's caller. Intercepted here
          // (a harness action, not a sandbox tool — skips the repetition guard and
          // the normal execution path), and gated defensively: a role without
          // `conclude` in its allowedTools (none currently — frames.ts gives every
          // role the tool, since every agent needs a way to finish) falls through
          // to the standard "not available in this role" rejection instead of
          // being silently intercepted here regardless of role.
          if (name === 'conclude' && (this.allowedTools === null || this.allowedTools.includes('conclude'))) {
            emitAndLog({ type: 'tool_call', tool: name, args })
            const status = typeof args.status === 'string' ? args.status.trim().toUpperCase() : ''
            const answer = typeof args.message === 'string' ? args.message.trim() : ''
            if (!status || !answer) {
              const err = 'conclude needs both a "status" keyword and a non-empty "message" string. Call it again with both parameters.'
              emitAndLog({ type: 'tool_result', tool: name, output: '', error: err, duration_ms: 0 })
              this.pushCtx({ role: 'tool', content: `Error: ${err}` })
              continue
            }
            // Validate status against the role's allowed keywords
            if (this.roleTag) {
              const validStatuses = ROLE_CONCLUDE_STATUSES[this.roleTag]
              if (validStatuses && !validStatuses.includes(status)) {
                const err = concludeStatusError(this.roleTag, status)
                emitAndLog({ type: 'tool_result', tool: name, output: '', error: err, duration_ms: 0 })
                this.pushCtx({ role: 'tool', content: `Error: ${err}` })
                continue
              }
            }
            this.lastConcludeStatus = status

            // All gates passed — genuinely done.
            emitAndLog({ type: 'tool_result', tool: name, output: 'Concluded.', duration_ms: 0 })
            this.pushCtx({ role: 'tool', content: 'Concluded.' })
            emitAndLog({ type: 'message', role: 'assistant', content: answer })
            emitAndLog({ type: 'done', content: answer })
            if (this.autoCommitEnabled) await this.autoCommit(emitAndLog)
            this.phase = 'idle'
            return answer
          }
          // H21: the normalised identity of this call, computed ONCE and shared by
          // both the gate rejection path and the ladder's own loopKey further down
          // (both need the identical value for their counts to compose correctly —
          // see handleGateRejection's doc comment).
          const gateKey = normalizeCallKey(name, args)
          // MULTI-AGENT ARCHITECTURE: a role-scoped frame rejects any tool outside
          // its ROLE_TOOLS set — enforced here too (not just in the tools offered to
          // Ollama above), since a model can still emit a call for a tool it wasn't
          // offered. Not counted as an EXECUTED-call repeat (evaluateCall below
          // never sees it — the call simply never runs), but IS counted as a gate
          // rejection (H21) since allowedTools is fixed for this frame's whole life
          // and a role refusal can never later succeed here — see handleGateRejection.
          if (this.allowedTools && !this.allowedTools.includes(name)) {
            const stop = this.handleGateRejection(
              name, args, gateKey, 'role',
              `tool "${name}" is not available in this role — it was NOT called.`,
              emitAndLog,
            )
            if (stop !== null) return this.endFrameStalled(stop, emitAndLog)
            continue
          }
          // Loop steering (see REPEAT_* above): recentCalls holds calls actually
          // executed this run, so REPEAT_THRESHOLD prior occurrences means this
          // identical call has already produced the same result that many times.
          //
          // Mutation-aware ladder: blocks the 2nd NORMALISED-identical call when
          // nothing changed since it last ran, and serves the CACHED result of the
          // earlier call back (labeled as a repeat) rather than a bare block, for as
          // long as that key's replay budget lasts — see loop.ts's evaluateCall/
          // l0ReplayMessage. Escalates L0 -> L1 eviction -> L2 forced reframe.
          const key = repetitionKey(name, args)
          let priorRepeats = 0
          const loopKey = gateKey
          const recite = this.buildLoopRecite()
          // args passed through so evaluateCall can enforce a raw-args match before
          // a replay — the block/escalation decision below is still keyed on
          // loopKey alone.
          const action = evaluateCall(this.loopState, loopKey, args, { toolName: name, recite, callSummary: summarizeCall(name, args) })
          // H21(b): 'halt' is handled SEPARATELY from the other non-allow kinds
          // below — it has no `level` field (it fires only after L2 has already
          // been reported once for this streak, see loop.ts's LoopAction doc
          // comment), and unlike every other rung it must END THE FRAME rather
          // than `continue`.
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
                emitAndLog({ type: 'warning', message: `Loop-recovery eviction failed (${err instanceof Error ? err.message : String(err)}) — continuing` })
              }
            }
            // Carry the ladder rung as a STRUCTURED field, not just inside the
            // prose: action.level is already L0/L1/L2 here.
            emitAndLog({ type: 'warning', message: action.message, level: action.level })
            if (action.kind === 'replay') {
              this.replayToolCall(name, args, action.cached, action.message, emitAndLog)
            } else {
              this.rejectToolCall(name, args, `SKIPPED — identical to a call already run with nothing new since. ${action.message}`, emitAndLog)
            }
            continue
          }

          emitAndLog({ type: 'tool_call', tool: name, args })

          const start = Date.now()
          const result = await executeTool(name, args)
          const duration_ms = Date.now() - start

          // A `bash` call just ran — its effect on the filesystem is unknowable
          // without a shell parser (isProjectMutation below only ever sees
          // edit_file/write_file), so every cached replay is invalidated wholesale
          // rather than risk later telling the model "nothing has changed" about a
          // file bash may have just changed. Deliberately NOT gated on
          // result.error — a command can mutate before failing (`sed -i ...;
          // false`). Must run BEFORE recordResult below, so if THIS call is the
          // one being cached, its own fresh entry survives the invalidation.
          if (name === 'bash') noteBashExecution(this.loopState)

          // Cache this real result under the loop ladder's normalised key, so a
          // later no-progress repeat of THIS call (see evaluateCall/loopKey above)
          // can be served it back instead of a bare block. `args` recorded
          // alongside so a later repeat can be checked for a byte-exact match
          // before replay.
          recordResult(this.loopState, loopKey, args, { output: result.output, error: result.error })

          emitAndLog({
            type: 'tool_result',
            tool: name,
            output: result.output,
            error: result.error,
            duration_ms,
          })
          // NEW, ADDITIVE Markdown trace (al-logger.ts): one tool-result block per
          // tool actually run this turn (conclude is intercepted earlier and never
          // reaches this line, matching the existing tool_result event's own scope).
          this.traceLogger?.logToolExecution(name, args, result.output, result.error, duration_ms)

          this.pushCtx({
            role: 'tool',
            content: result.error
              ? `Error: ${result.error}\n${result.output}`
              : result.output,
          })

          // MULTI-AGENT ARCHITECTURE: every tool call becomes a CWL episode
          // (exploratory | action), linked to its inferred dependencies, and —
          // when this instance is running as part of a dispatch (this.frameId set)
          // — written to the ledger losslessly (the full result survives there
          // even once evicted from the live window; see eviction.ts / ledger.ts).
          // `ledger` itself is a query-only bookkeeping call, not a typed episode.
          if (name !== 'ledger') {
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
          if (name === 'edit_file' || name === 'write_file') {
            const p = typeof args.path === 'string' ? args.path : ''
            if (p && !this.editedPaths.includes(p)) this.editedPaths.push(p)
            this.actionTrace.push(`${name} ${p}${result.error ? ' [attempt failed]' : ''}`)
          } else if (name === 'fetch_url' || name === 'browser_fetch') {
            const u = typeof args.url === 'string' ? args.url : ''
            if (u) this.actionTrace.push(`${name} ${u}`)
          } else if (name === 'bash') {
            this.lastCommandOutput = truncateOutput(result.output || '', 4000)
            const cmd = typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').slice(0, 120) : ''
            this.actionTrace.push(`bash: ${cmd}`)
          } else {
            this.actionTrace.push(`${name} ${typeof args.path === 'string' ? args.path : ''}`.trim())
          }
          if (this.actionTrace.length > 16) this.actionTrace.shift()

          this.recentCalls.push(key)
          if (this.recentCalls.length > REPEAT_WINDOW) this.recentCalls.shift()
          // A novel action (not already in the window) means the model moved on —
          // reset steer escalation so any later, unrelated loop starts gentle.
          if (priorRepeats === 0) loopSteers = 0

          // NO-PROGRESS re-anchor. A successful project mutation resets the counter;
          // otherwise, once a run has made many tool calls without changing any
          // file, it is re-inspecting instead of acting (the novel-arg thrash the
          // identical-call guard misses). Fire a GROUNDED re-anchor at 12 calls, then
          // every 8 more, capped — it names the objective and demands a concrete change
          // or a conclusion, so the model redirects instead of drifting.
          if (isProjectMutation(name, args) && !result.error) {
            noteMutation(this.loopState)
            callsSinceMutation = 0
            noProgressSteers = 0
          } else {
            callsSinceMutation++
            if (callsSinceMutation >= 12 && (callsSinceMutation - 12) % 8 === 0 && noProgressSteers < 4) {
              noProgressSteers++
              const rg = regroundSteer(userMessage, `${callsSinceMutation} tool calls without changing any file`)
              emitAndLog({ type: 'warning', message: rg })
              this.pushCtx({ role: 'tool', content: rg })
            }
          }
        }
      }

      // CAP HIT. The returned string is a NOTICE, not a final answer, and this is the
      // one place that knows the difference — record it so the frame boundary
      // (dispatch.ts's deriveFrameResult) can stop reading "a string came back" as
      // success. The terminal `error` event was already emitted here.
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
      await Promise.all([logger.flush(), this.persistHistory(), this.traceLogger?.close()])
    }
  }

  reset() {
    this.history = []
    fs.unlink(this.historyFile).catch(() => {})
  }

  loadHistory(messages: Array<{ role: string; content: string }>) {
    this.history = messages as Message[]
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

    return {
      messages,
      messageCount: this.history.length,
      totalChars,
      numCtx: this.options.num_ctx ?? null,
      compaction: null,
      compactionTs: this.lastCompactedAt,
    }
  }

  // Wraps bash() with the same tool_call/tool_result tracing the main loop
  // uses, so autoCommit's own commands show up in the JSONL trace instead of
  // being invisible — this is what let the phantom/orphaned/mislabeled commit
  // bugs go unnoticed in real session logs.
  private async tracedBash(command: string, emitAndLog: (e: AgentEvent) => void) {
    emitAndLog({ type: 'tool_call', tool: 'bash', args: { command, cwd: '/workspace' } })
    const start = Date.now()
    const result = await bash(command, '/workspace')
    emitAndLog({ type: 'tool_result', tool: 'bash', output: result.output, error: result.error, duration_ms: Date.now() - start })
    return result
  }

  // Public so dispatch.ts can call it once at the end of a whole dispatch run,
  // using any convenient already-constructed frame's Agent instance — the logic
  // itself is instance-agnostic (just git + this.ollama for the commit message),
  // unlike the baseline loop's per-run call, which stays private.
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
