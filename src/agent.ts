import { Ollama } from 'ollama'
import type { Message } from 'ollama'
import { promises as fs } from 'fs'
import path from 'path'
import { config } from './config.js'
import { toolDefinitions, executeTool } from './tools/index.js'
import { bash } from './tools/bash.js'
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
} from './compaction.js'

const SYSTEM_PROMPT = `You are a capable local agent running in an isolated Ubuntu 24.04 Docker container. The host machine is not accessible.

PRECISION
Never reconstruct exact technical strings from memory. Any identifier, URL, domain, path, package name, flag, or key that must appear in a new script or command must be copied verbatim from the tool result where it appeared — not recalled. When uncertain, re-read the source with a tool call first.

REASONING
For concurrency, derive the valid serial orderings before calling an observed result a race or lost update — it is only a defect if no valid ordering explains it or an invariant is violated.
Before claiming a regression, show a concrete case where old and new behavior differ and the new result violates a requirement or invariant; a difference alone is not a regression.
Label evidence by how it was obtained: verified (you ran it and checked the output), reproduced (the experiment directly exercised the claimed mechanism), inferred, hypothesized, or untested. Do not present a weaker label as a stronger one.

EFFICIENCY
Never call the same tool more than twice in a row with similar inputs — write a script instead. Fetching 10 pages one by one, running the same command on multiple files, processing a list item by item: all of these must be a script, not repeated tool calls.
Test before bulk: run the script on one item first, verify the output is correct, then scale to the full set.
Return conclusions and file paths only: never raw page or file contents as tool output.
Multi-line JS: prefer writing to /scratch/script.js and running with node — easier to inspect and rerun than an inline command. Multi-line node -e now works correctly too; use it for anything short-lived that doesn't need to be rerun.

FILESYSTEM
/workspace is the project you are working on — the git-tracked repository, and the only place autoCommit() operates. /scratch is your private workbench for temp files, throwaway scripts, and intermediate data — it is inside the same isolated container as /workspace, not outside it or less trusted; it just isn't the deliverable location, so it's never committed and the user never sees it. These two are your workspace model — other container paths exist but nothing about your work belongs there. Do not create either directory.
Commands about the project itself (npm test, npm run <script>, node <project file>, git, etc.) need cwd set to /workspace on the bash call — they assume the project root and fail otherwise. Do not prefix commands with "cd /workspace &&"; use the tool's cwd argument instead. Leave cwd unset (or /scratch) for scratch scripts.
A script in /scratch that needs to import or require project code must reference it as /workspace/... — a relative import like './src/foo.js' resolves against /scratch, not the project, because that script's own cwd is wherever it was invoked from, not the project root.
Always use absolute paths — a relative path like "scratch/file" resolves to "/scratch/scratch/file", not /scratch/file.
Scripts that produce output required in the workspace must set OUTPUT_DIR="/workspace/..." inside the script.
Before declaring done: re-read the original request, verify every item is addressed, and if the task produced files run ls /workspace/ to confirm they are there.

TOOLS
Invoke tools immediately and directly — never describe plans or write tool calls as JSON/prose first.
- bash: shell commands, run scripts
- write_file / read_file: file I/O
- fetch_url: static pages (fast, no JS)
- browser_fetch: JS-rendered pages, or when fetch_url returns empty/incomplete content
- web_search: find information you don't already have (facts, docs, unknown URLs). Never use it when you already have the URL — use fetch_url or browser_fetch directly instead.
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
  private get historyFile(): string {
    return path.join(LOGS_DIR, this.sessionId ? `history-${this.sessionId}.json` : 'history.json')
  }
  private get compactionStateFile(): string {
    return path.join(LOGS_DIR, this.sessionId ? `compaction-${this.sessionId}.json` : 'compaction.json')
  }

  constructor(
    private emit: (event: AgentEvent) => void,
    model?: string
  ) {
    this.model = model ?? config.model
    this.ollama = new Ollama({ host: config.ollamaHost })
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
    emitAndLog: (e: AgentEvent) => void
  ): Promise<number> {
    const msgsBefore = this.history.length
    const split = splitForCompaction(this.history, currentRunStart)

    if (split.prior.length === 0 && split.activeMiddle.length === 0) return currentRunStart

    emitAndLog({ type: 'compact_start', messageCount: msgsBefore, contextUsagePct })

    let validated = false
    if (split.prior.length > 0) {
      const draft = await withTimeout(
        updateCompactionState(this.ollama, this.model, this.options, this.compactionState, split.prior),
        60_000,
      )
      const sourceWorkLog = messagesToText(split.prior)
      const result = await withTimeout(
        validateCompactionState(this.ollama, this.model, this.options, sourceWorkLog, draft),
        60_000,
      )
      this.compactionState = result.state
      validated = true
    }

    const activeWorkingState = split.activeMiddle.length > 0
      ? await withTimeout(summarizeActiveMiddle(this.ollama, this.model, this.options, split.activeMiddle), 60_000)
      : ''

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
      messagesBefore: msgsBefore,
      messagesAfter: msgsAfter,
      contextUsagePct,
      rangeDescription,
      validated,
    })

    return newRunStart
  }

  async chat(userMessage: string): Promise<string> {
    const logger = new SessionLogger(userMessage, this.model, this.options, this.sessionId)

    const emitAndLog = (event: AgentEvent) => {
      logger.log(event)
      this.emit(event)
    }

    this.history.push({ role: 'user', content: userMessage })
    // The index of the message that started this run — compactHistory() always
    // keeps history[currentRunStart] verbatim, however many iterations follow it.
    // Reassigned (not recomputed) after each compaction, since compaction replaces
    // `this.history` wholesale and returns the prompt's new position in it.
    let currentRunStart = this.history.length - 1
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

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

        const response = await withTimeout(this.ollama.chat({
          model: this.model,
          messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: toolDefinitions as any[],
          stream: false,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          options: this.options as any,
        }), 120_000)

        const numCtx = this.options.num_ctx ?? 32768
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
              currentRunStart = await this.compactHistory(currentRunStart, usagePct, emitAndLog)
            } catch (err) {
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
          await this.autoCommit(userMessage, msg.content, emitAndLog)
          return msg.content
        }

        this.history.push(msg)

        const callsToRun = nativeCalls.length > 0
          ? nativeCalls.map(tc => ({ name: tc.function.name as ToolName, args: tc.function.arguments as Record<string, unknown> }))
          : fallbackCalls.map(fc => ({ name: fc.name as ToolName, args: fc.arguments }))

        for (const { name, args } of callsToRun) {
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
        }
      }

      const errMsg = `Reached maximum iterations (${this.maxIterations}) without a final answer.`
      emitAndLog({ type: 'error', message: errMsg })
      return errMsg
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

  private async autoCommit(query: string, answer: string, emitAndLog: (e: AgentEvent) => void): Promise<void> {
    try {
      // Initialise git if workspace isn't tracked yet (idempotent on existing repos)
      await bash('cd /workspace && git rev-parse --git-dir 2>/dev/null || git init -q')
      const checkResult = await bash('cd /workspace && git status --porcelain 2>/dev/null')
      if (checkResult.error || !checkResult.output.trim()) return

      const summaryResp = await withTimeout(this.ollama.chat({
        model: this.model,
        messages: [{
          role: 'user',
          content: `Write a git commit message (max 60 chars) describing what was accomplished.\nTask: "${query.slice(0, 150)}"\nWork done: "${answer.slice(0, 400)}"\nReply with the commit message only — no quotes, no "Agent:" prefix.`,
        }],
      }), 30_000)
      const summary = summaryResp.message.content.trim().replace(/^["']|["']$/g, '').slice(0, 60)

      // Single-quote the message so the shell never interprets its contents;
      // escape any literal single quotes within the string using the '\'' technique.
      const safeMsg = `Agent: ${summary}`.replace(/'/g, "'\\''")
      await bash(`cd /workspace && git add -A && git commit -m '${safeMsg}'`)

      const logResult = await bash('cd /workspace && git log -1 --format="%h %s" 2>/dev/null')
      if (!logResult.error && logResult.output.trim()) {
        const spaceIdx = logResult.output.indexOf(' ')
        const hash = logResult.output.slice(0, spaceIdx).trim()
        const message = logResult.output.slice(spaceIdx + 1).trim()
        emitAndLog({ type: 'git_commit', hash, message })
      }
    } catch (err) {
      emitAndLog({ type: 'warning', message: `Auto-commit failed: ${err instanceof Error ? err.message : String(err)}` })
    }
  }
}
