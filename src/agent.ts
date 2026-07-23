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

const SYSTEM_PROMPT = `You are a capable local agent running in an isolated Ubuntu 24.04 Docker container. The host machine is not accessible.

PRECISION
Never reconstruct exact technical strings from memory. Any identifier, URL, domain, path, package name, flag, or key that must appear in a new script or command must be copied verbatim from the tool result where it appeared — not recalled. When uncertain, re-read the source with a tool call first.

REASONING
For concurrency, derive the valid serial orderings before calling an observed result a race or lost update — it is only a defect if no valid ordering explains it or an invariant is violated.
Before claiming a regression, show a concrete case where old and new behavior differ and the new result violates a requirement or invariant; a difference alone is not a regression.
Label evidence by how it was obtained: verified (you ran it and checked the output), reproduced (the experiment directly exercised the claimed mechanism), inferred, hypothesized, or untested. Do not present a weaker label as a stronger one.
When the user states an explicit constraint (e.g. "do not modify any files," "read-only," "do not commit"), it overrides any other part of the same request that could imply a conflicting action. If a task could be satisfied by either a mutating or a non-mutating action, choose the non-mutating one. If no non-mutating option exists, say so explicitly instead of proceeding anyway.

EFFICIENCY
Never call the same tool more than twice in a row with similar inputs — write a script instead. Fetching 10 pages one by one, running the same command on multiple files, processing a list item by item: all of these must be a script, not repeated tool calls.
Test before bulk: run the script on one item first, verify the output is correct, then scale to the full set.
When editing the same file repeatedly across many iterations, don't match a multi-line block by reusing a string you remember from earlier — re-read the exact current lines immediately before each edit. A remembered block silently no-ops or partially matches once the file has drifted, corrupting structure instead of failing loudly.
Return conclusions and file paths only: never raw page or file contents as tool output.
Multi-line JS: prefer writing to a script file (e.g. /tmp/script.js) and running with node — easier to inspect and rerun than an inline command. Multi-line node -e now works correctly too; use it for anything short-lived that doesn't need to be rerun.

FILESYSTEM
The whole container is your working environment. /workspace is the one special directory: the user's project, git-tracked, and the only place autoCommit() operates — treat it like a clean codebase and only put intentional project changes and deliverables there. Everywhere else (/tmp, your home directory, wherever) is ordinary, disposable filesystem — freely usable for scripts, downloads, and intermediate work; none of it is committed or shown to the user.
Commands about the project itself (npm test, npm run <script>, node <project file>, git, etc.) need cwd set to /workspace on the bash call — they assume the project root and fail otherwise. Do not prefix commands with "cd /workspace &&"; use the tool's cwd argument instead.
A script outside /workspace that needs to import or require project code must reference it as /workspace/... — a relative import like './src/foo.js' resolves against the script's own cwd, not the project root.
Always use absolute paths.
Scripts that produce output required in the workspace must write directly to /workspace/... (e.g. via an OUTPUT_DIR env var) — don't assume the script's own cwd is the project root.
Before declaring done: re-read the original request, verify every item is addressed, and if the task produced files run ls /workspace/ to confirm they are there.

MEMORY
/workspace/AGENTS.md (if present) is project-level instructions, already loaded below — don't rewrite it unless explicitly asked to do so. /workspace/MEMORY.md (if present) is durable project memory, don't re-derive what it already states. After completing a task, update MEMORY.md only when you learned something durable and reusable across sessions: an architecture fact, a convention, a decision, a recurring pitfall. Never record one-off task state, debugging detail, or anything derivable by rereading the code. Update the relevant point in place — don't append duplicates. Use terse bullet points and one-liners; MEMORY is always loaded into context, so brevity saves tokens. If MEMORY.md grows large, move a section into memory/<topic>.md and leave a one-line pointer to it in MEMORY.md, so you know it exists without needing it loaded every run.

TOOLS
Invoke tools immediately and directly — never describe plans or write tool calls as JSON/prose first.
- bash: shell commands, run scripts
- write_file / read_file: file I/O
- fetch_url: static pages (fast, no JS)
- browser_fetch: JS-rendered pages, or when fetch_url returns empty/incomplete content
- web_search: find information you don't already have (facts, docs, unknown URLs). Never use it when you already have the URL — use fetch_url or browser_fetch directly instead.
A tool's stated hard limits (timeouts, size caps) are enforced by the harness itself — wrapping a call in your own retry/timeout/backoff logic cannot extend one; only an explicit override parameter, where the tool's own description offers one, has any effect.
When the task is complete, give the final answer and stop.

CURRENCY
Training data has a cutoff and goes stale. For anything that can change over time — current events, sports/election results, standings, prices, versions, "latest"/"current"/"who holds the record" claims — verify with web_search before answering, even when you're confident you already know the answer. Report what the sources say, not what memory says.

ENVIRONMENT
CLI: bash, curl, wget, git, jq, node, ripgrep (rg), fd, sqlite3, mlr, parallel, tree, unzip, zip, pv, dig, nc, ping
Node.js: NODE_PATH is set — always use require(), never import. Pre-installed: cheerio, js-yaml, csv-parse, xlsx, pdf-parse, marked, turndown, handlebars, chalk, commander, date-fns, iconv-lite, glob, playwright. Install others with npm. fetch() is native. git is configured as "Local Agent".
HTML: const $ = cheerio.load(html); $('sel').text(); $('a').attr('href'); $.html(el)
`

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

// Harness-level stop against the agent spinning on identical tool calls. The
// soft system-prompt rule ("never call the same tool more than twice in a row")
// was ignored 9-11x consecutively in real runs, so this enforces it in code.
// Thresholds are deliberately loose: real incidents ran into double digits, so
// intervening only at the 3rd repeat leaves wide margin over a legitimate
// repeat (e.g. re-running the same test twice to confirm a fix).
export const REPEAT_WINDOW = 6
export const REPEAT_THRESHOLD = 3

export function repetitionKey(name: string, args: Record<string, unknown>): string {
  return `${name}:${JSON.stringify(args)}`
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
  private maxIterations: number = config.maxIterations
  private sessionId = ''
  private aborted = false
  // Persisted structured memory that survives across compactions — see compaction.ts.
  private compactionState: CompactionState = emptyCompactionState()
  // Rolling record of the last REPEAT_WINDOW executed (name+args) keys. Reset per
  // chat() run, never persisted — a legitimately repeated action in a later run
  // must start from a clean slate (see the repetition guard in chat()).
  private recentCalls: string[] = []
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

  getMaxIterations(): number {
    return this.maxIterations
  }

  setSessionId(id: string) { this.sessionId = id }

  abort() { this.aborted = true }

  // Sourced from config so it's env-tunable in production; held as a field only
  // so tests can drop it to 0 and not wait in real time. See chatWithRetry.
  private chatRetryDelayMs = config.chatRetryDelayMs
  setChatRetryDelayMs(ms: number) { this.chatRetryDelayMs = Math.max(0, Math.trunc(ms)) }

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

    const newRunStart = 1 + split.antecedent.length
    const msgsAfter = this.history.length

    await this.persistCompactionState()

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
    return withTimeout(this.ollama.chat({
      model: this.model,
      messages: [{ role: 'system', content: systemPrompt }, ...this.history],
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

    this.history.push({ role: 'user', content: userMessage })
    // The index of the message that started this run — compactHistory() always
    // keeps history[currentRunStart] verbatim, however many iterations follow it.
    // Reassigned (not recomputed) after each compaction, since compaction replaces
    // `this.history` wholesale and returns the prompt's new position in it.
    let currentRunStart = this.history.length - 1
    // Repetition guard state, scoped to this run only (see REPEAT_WINDOW above).
    this.recentCalls = []
    let repetitionInterventions = 0
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

    const projectContext = await loadProjectContext()
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
          })
          // Reserve headroom for the *next* generation, not just the input consumed so
          // far — a response near num_predict's limit can still overflow num_ctx even
          // when prompt_eval_count alone looks comfortably under the threshold.
          const usagePct = (response.prompt_eval_count + config.compactGenerationReserve) / numCtx
          if (usagePct >= config.compactThreshold) {
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
          this.history.push(msg)
          emitAndLog({ type: 'message', role: 'assistant', content: msg.content })
          emitAndLog({ type: 'done', content: msg.content })
          await this.autoCommit(emitAndLog)
          return msg.content
        }

        this.history.push(msg)

        const callsToRun = nativeCalls.length > 0
          ? nativeCalls.map(tc => ({ name: tc.function.name as ToolName, args: tc.function.arguments as Record<string, unknown> }))
          : fallbackCalls.map(fc => ({ name: fc.name as ToolName, args: fc.arguments }))

        for (const { name, args } of callsToRun) {
          // Repetition guard. The record holds calls actually executed this run,
          // so REPEAT_THRESHOLD prior occurrences means this would be the (N+1)th
          // identical call — the model already saw the same result N times.
          // Thought-text repetition (the model re-emitting a near-verbatim thought
          // before each call) is intentionally NOT a separate detector: in every
          // observed incident it co-occurred with an identical tool call, which
          // this record already catches, so a second signal would add complexity
          // without changing behavior on any real case.
          const key = repetitionKey(name, args)
          const priorRepeats = this.recentCalls.filter(k => k === key).length
          if (priorRepeats >= REPEAT_THRESHOLD) {
            if (repetitionInterventions >= 1) {
              // The model repeated the identical call even after the warning
              // below was injected — stop the run with a final answer rather than
              // warning (and re-warning) forever. autoCommit so any real work done
              // earlier in the run still honors the every-change-is-committed
              // guarantee, same as the normal final-answer path.
              const msg = `Ended the run: the ${name} tool was called with identical arguments repeatedly, even after a warning, without producing new information. Stopping with what is already known.`
              emitAndLog({ type: 'warning', message: `Repetition guard: ${name} repeated again after a warning — ending the run.` })
              emitAndLog({ type: 'done', content: msg })
              await this.autoCommit(emitAndLog)
              return msg
            }
            repetitionInterventions++
            const warning = `This exact tool call (${name} with identical arguments) has been repeated ${priorRepeats} times with no new information. Do not repeat it again. Either provide your final answer now based on what you already know, or call a genuinely different tool or arguments.`
            emitAndLog({ type: 'warning', message: warning })
            this.history.push({ role: 'tool', content: warning })
            continue
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

          this.history.push({
            role: 'tool',
            content: result.error
              ? `Error: ${result.error}\n${result.output}`
              : result.output,
          })

          this.recentCalls.push(key)
          if (this.recentCalls.length > REPEAT_WINDOW) this.recentCalls.shift()
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
