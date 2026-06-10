import { Ollama } from 'ollama'
import type { Message } from 'ollama'
import { promises as fs } from 'fs'
import path from 'path'
import { config } from './config.js'
import { toolDefinitions, executeTool } from './tools/index.js'
import { bash } from './tools/bash.js'
import { SessionLogger, LOGS_DIR } from './logger.js'
import type { AgentEvent, ToolName, ModelOptions } from './types.js'

const SYSTEM_PROMPT = `You are a capable local agent with access to tools. You have a sandbox workspace at /workspace where you can freely create, edit, and delete files.

When given a task:
- Think step by step and use the appropriate tools
- Use web_search for current information from the internet
- Use bash to run shell commands, inspect files, or execute scripts in the sandbox container
- Use read_file/write_file for direct file access in the workspace
- Use fetch_url for static pages (fast, no JS execution)
- Use browser_fetch for JS-rendered pages (SPAs, dynamic content) or when fetch_url returns empty/incomplete content
- When you have a complete answer or finished the task, respond directly with your final answer — do not call any more tools

Environment — you are inside an isolated Ubuntu 24.04 Docker container. The host machine is not accessible.
- /workspace — the project you are working on (git-tracked; auto-committed after each task)
- /scratch   — your private working directory for scripts, temp files, intermediate data (not git-tracked)

CLI tools: bash, curl, wget, git, jq, node, ripgrep (rg), fd, sqlite3, mlr (miller), parallel, tree, file, pv, dig, nc, ping, unzip, zip

Node.js packages (NODE_PATH is set — use require(), not import; ESM import won't resolve NODE_PATH):
cheerio, js-yaml, csv-parse, xlsx, pdf-parse, marked, turndown, handlebars, chalk, commander, date-fns, iconv-lite, glob, playwright
- For anything else: npm install <package>
- fetch() is available natively — no import needed
- git is configured as "Local Agent" — commits work in /workspace

Scripting: always write multi-line scripts to a .js file first (write_file), then run: node script.js
HTML parsing: const $ = cheerio.load(html); $('selector').text(); $('a').attr('href'); $.html(el) to serialize`

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
  private readonly historyFile = path.join(LOGS_DIR, 'history.json')

  constructor(
    private emit: (event: AgentEvent) => void,
    model?: string
  ) {
    this.model = model ?? config.model
    this.ollama = new Ollama({ host: config.ollamaHost })
  }

  // Load full Ollama message history from disk (called once on server startup).
  async loadPersistedHistory(): Promise<void> {
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

  async chat(userMessage: string): Promise<string> {
    const logger = new SessionLogger(userMessage, this.model, this.options)

    const emitAndLog = (event: AgentEvent) => {
      logger.log(event)
      this.emit(event)
    }

    this.history.push({ role: 'user', content: userMessage })
    emitAndLog({ type: 'message', role: 'user', content: userMessage })
    emitAndLog({ type: 'start', model: this.model, query: userMessage, options: this.options })

    try {
      for (let i = 0; i < config.maxIterations; i++) {
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

        if (response.prompt_eval_count != null) {
          emitAndLog({
            type: 'token_usage',
            prompt_tokens: response.prompt_eval_count,
            generated_tokens: response.eval_count ?? 0,
            num_ctx: this.options.num_ctx ?? 8192,
          })
        }

        const msg = response.message

        if (msg.content) {
          emitAndLog({ type: 'thought', content: msg.content })
        }

        if (!msg.tool_calls || msg.tool_calls.length === 0) {
          this.history.push(msg)
          emitAndLog({ type: 'message', role: 'assistant', content: msg.content })
          emitAndLog({ type: 'done', content: msg.content })
          await this.autoCommit(userMessage, msg.content, emitAndLog)
          return msg.content
        }

        this.history.push(msg)

        for (const toolCall of msg.tool_calls) {
          const name = toolCall.function.name as ToolName
          const args = toolCall.function.arguments as Record<string, unknown>

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

      const errMsg = `Reached maximum iterations (${config.maxIterations}) without a final answer.`
      emitAndLog({ type: 'error', message: errMsg })
      return errMsg
    } finally {
      await Promise.all([logger.flush(), this.persistHistory()])
    }
  }

  reset() {
    this.history = []
    fs.writeFile(this.historyFile, '[]').catch(() => {})
  }

  getChatHistory(): Array<{ role: string; content: string }> {
    return this.history
      .filter(msg => {
        if (msg.role === 'user') return !!msg.content
        if (msg.role === 'assistant') {
          const hasToolCalls = (msg as { tool_calls?: unknown[] }).tool_calls?.length ?? 0 > 0
          return !hasToolCalls && !!msg.content
        }
        return false
      })
      .map(msg => ({ role: msg.role, content: msg.content ?? '' }))
  }

  private async autoCommit(query: string, answer: string, emitAndLog: (e: AgentEvent) => void): Promise<void> {
    try {
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
