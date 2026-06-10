import { Ollama } from 'ollama'
import type { Message } from 'ollama'
import { promises as fs } from 'fs'
import path from 'path'
import { config } from './config.js'
import { toolDefinitions, executeTool } from './tools/index.js'
import { bash } from './tools/bash.js'
import { SessionLogger, LOGS_DIR } from './logger.js'
import type { AgentEvent, ToolName, ModelOptions } from './types.js'

const SYSTEM_PROMPT = `You are a capable local agent running in an isolated Ubuntu 24.04 Docker container. The host machine is not accessible.

PRECISION
Never reconstruct exact technical strings from memory. Any identifier, URL, domain, path, package name, flag, or key that must appear in a new script or command must be copied verbatim from the tool result where it appeared — not recalled. When uncertain, re-read the source with a tool call first.

EFFICIENCY
Batch over iterate: one script that processes all inputs and prints a concise summary beats many single tool calls.
Test before bulk: run on one item, verify output, then scale to the full set.
Return conclusions and file paths only: never raw page or file contents as tool output.
Multi-line JS: write to /scratch/script.js and run with node. Never use node -e for multi-line code.

FILESYSTEM
Two directories exist — do not create them:
- /scratch: your cwd for every bash command. Use for temp files, internal scripts, intermediate data, or anything the user doesn't need in his workspace.
- /workspace: the user's project, git-tracked. All output the user expects to see must land here.
Always use absolute paths as relative paths like "scratch/file" resolve to "/scratch/scratch/file".
Scripts that produce output that is required in the workspace must set OUTPUT_DIR="/workspace/..." inside the script.
Before declaring done: if the task produced files, run ls /workspace/ to confirm they are there.

TOOLS
Invoke tools immediately and directly — never describe plans or write tool calls as JSON/prose first.
- bash: shell commands, run scripts
- write_file / read_file: file I/O
- fetch_url: static pages (fast, no JS)
- browser_fetch: JS-rendered pages, or when fetch_url returns empty/incomplete content
- web_search: current information from the internet
When the task is complete, give the final answer and stop.

ENVIRONMENT
CLI: bash, curl, wget, git, jq, node, ripgrep (rg), fd, sqlite3, mlr, parallel, tree, unzip, zip, pv, dig, nc, ping
Node.js: NODE_PATH is set — always use require(), never import. Pre-installed: cheerio, js-yaml, csv-parse, xlsx, pdf-parse, marked, turndown, handlebars, chalk, commander, date-fns, iconv-lite, glob, playwright. Install others with npm. fetch() is native. git is configured as "Local Agent".
HTML: const $ = cheerio.load(html); $('sel').text(); $('a').attr('href'); $.html(el)
`

const COMPACT_THRESHOLD = 0.80  // compact when context is this full

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
  private sessionId = ''
  private aborted = false
  private get historyFile(): string {
    return path.join(LOGS_DIR, this.sessionId ? `history-${this.sessionId}.json` : 'history.json')
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
    this.options = opts
  }

  setSessionId(id: string) { this.sessionId = id }

  abort() { this.aborted = true }

  // Serialises a slice of history to a compact work log for the compaction summary call.
  private messagesToText(messages: Message[]): string {
    const lines: string[] = []
    for (const msg of messages) {
      if (msg.role === 'user' && msg.content) {
        lines.push(`User: ${msg.content.slice(0, 300)}`)
      } else if (msg.role === 'assistant') {
        const tc = (msg as { tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }).tool_calls
        if (tc?.length) {
          for (const call of tc) {
            lines.push(`Called ${call.function.name}(${JSON.stringify(call.function.arguments).slice(0, 120)})`)
          }
        } else if (msg.content) {
          lines.push(`Agent: ${msg.content.slice(0, 300)}`)
        }
      } else if (msg.role === 'tool' && msg.content) {
        lines.push(`Result: ${msg.content.slice(0, 300)}`)
      }
    }
    return lines.join('\n')
  }

  private async compactHistory(
    userMessage: string,
    emitAndLog: (e: AgentEvent) => void
  ): Promise<void> {
    // Keep: first message (original user prompt) + last KEEP_RECENT messages verbatim.
    // Compact: everything in between. This preserves the task goal and the most recent
    // tool results (exact URLs, paths, errors) which are the most likely to be needed next.
    const KEEP_RECENT = 8
    const msgsBefore = this.history.length

    if (msgsBefore <= KEEP_RECENT + 2) return  // nothing meaningful to compact

    const firstMsg = this.history[0]
    const toCompact = this.history.slice(1, msgsBefore - KEEP_RECENT)
    const recentMsgs = this.history.slice(-KEEP_RECENT)

    if (toCompact.length === 0) return

    emitAndLog({ type: 'warning', message: `Compacting context: ${msgsBefore} messages → keeping ${KEEP_RECENT} recent verbatim…` })

    const workLog = this.messagesToText(toCompact)

    const summaryResp = await withTimeout(this.ollama.chat({
      model: this.model,
      messages: [{
        role: 'user',
        content: `Summarize an AI agent's prior work log. Rules:
- Copy all URLs, file paths, and error messages VERBATIM — never paraphrase or reconstruct them
- State explicitly what succeeded and what failed
- Note the current state: which files exist, which are missing
- Be dense — every sentence must carry unique information

Work log:
${workLog}`,
      }],
      stream: false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: this.options as any,
    }), 60_000)

    const summary = summaryResp.message.content.trim()
    this.history = [
      firstMsg,
      { role: 'assistant', content: `[Prior work summary]\n\n${summary}` },
      ...recentMsgs,
    ]
    const msgsAfter = this.history.length
    emitAndLog({ type: 'compact', summary })
    emitAndLog({ type: 'warning', message: `Context compacted: ${msgsBefore} → ${msgsAfter} messages` })
  }

  async chat(userMessage: string): Promise<string> {
    const logger = new SessionLogger(userMessage, this.model, this.options, this.sessionId)

    const emitAndLog = (event: AgentEvent) => {
      logger.log(event)
      this.emit(event)
    }

    this.history.push({ role: 'user', content: userMessage })
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

    // Stall detection: track last N tool signatures to catch infinite loops
    const recentToolSigs: string[] = []
    const STALL_WINDOW = 4  // identical consecutive signatures = stall

    try {
      for (let i = 0; i < config.maxIterations; i++) {
        if (this.aborted) {
          this.aborted = false
          const msg = 'Stopped.'
          emitAndLog({ type: 'done', content: msg })
          return msg
        }
        emitAndLog({ type: 'iteration', current: i + 1, max: config.maxIterations })

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
          if (response.prompt_eval_count / numCtx >= COMPACT_THRESHOLD) {
            try {
              await this.compactHistory(userMessage, emitAndLog)
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

          // Stall detection: if the same tool+args appear STALL_WINDOW times in a row, abort
          const sig = `${name}:${JSON.stringify(args)}`
          recentToolSigs.push(sig)
          if (recentToolSigs.length > STALL_WINDOW) recentToolSigs.shift()
          if (recentToolSigs.length === STALL_WINDOW && recentToolSigs.every(s => s === sig)) {
            const stallMsg = `Stalled: identical tool call repeated ${STALL_WINDOW} times — ${name}(${JSON.stringify(args).slice(0, 80)})`
            emitAndLog({ type: 'error', message: stallMsg })
            return stallMsg
          }

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

      const errMsg = `Reached maximum iterations (${config.maxIterations}) without a final answer.`
      emitAndLog({ type: 'error', message: errMsg })
      return errMsg
    } finally {
      await Promise.all([logger.flush(), this.persistHistory()])
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
