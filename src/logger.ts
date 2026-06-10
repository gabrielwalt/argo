import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentEvent, ModelOptions } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOGS_DIR = path.join(__dirname, '..', 'logs')

interface LogEntry {
  ts: string
  event: AgentEvent
}

export interface LogMeta {
  filename: string
  query: string
  model: string
  options: ModelOptions
  startedAt: string
  durationMs?: number
  iterations?: number
  toolCalls: number
  status: 'running' | 'done' | 'error'
}

export class SessionLogger {
  private entries: LogEntry[] = []
  private startTs = Date.now()
  private filename: string
  private meta: LogMeta

  constructor(query: string, model: string, options: ModelOptions = {}) {
    const slug = query.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    this.filename = `${ts}_${slug}`
    this.meta = {
      filename: this.filename,
      query,
      model,
      options,
      startedAt: new Date().toISOString(),
      toolCalls: 0,
      status: 'running',
    }
  }

  log(event: AgentEvent) {
    const entry: LogEntry = { ts: new Date().toISOString(), event }
    this.entries.push(entry)

    if (event.type === 'tool_call') this.meta.toolCalls++
    if (event.type === 'iteration') this.meta.iterations = event.current
    if (event.type === 'done') this.meta.status = 'done'
    if (event.type === 'error') this.meta.status = 'error'
  }

  async flush() {
    this.meta.durationMs = Date.now() - this.startTs
    await fs.mkdir(LOGS_DIR, { recursive: true })

    // JSONL: one event per line, easy to grep/parse
    const jsonl = [
      JSON.stringify({ ts: this.meta.startedAt, event: { type: '__meta__', ...this.meta } }),
      ...this.entries.map(e => JSON.stringify(e)),
    ].join('\n') + '\n'

    // Markdown: human-readable trace
    const md = this.toMarkdown()

    await Promise.all([
      fs.writeFile(path.join(LOGS_DIR, `${this.filename}.jsonl`), jsonl, 'utf-8'),
      fs.writeFile(path.join(LOGS_DIR, `${this.filename}.md`), md, 'utf-8'),
    ])
  }

  private toMarkdown(): string {
    const lines: string[] = []
    const dur = ((Date.now() - this.startTs) / 1000).toFixed(1)

    lines.push(`# Agent Trace`)
    lines.push(``)
    lines.push(`| | |`)
    lines.push(`|---|---|`)
    const opts = this.meta.options
    const optsStr = [
      opts.temperature != null ? `temp=${opts.temperature}` : null,
      opts.top_p != null ? `top_p=${opts.top_p}` : null,
      opts.top_k != null ? `top_k=${opts.top_k}` : null,
      opts.num_ctx != null ? `ctx=${opts.num_ctx}` : null,
    ].filter(Boolean).join(' ') || 'defaults'

    lines.push(`| **Query** | ${this.meta.query} |`)
    lines.push(`| **Model** | ${this.meta.model} |`)
    lines.push(`| **Options** | \`${optsStr}\` |`)
    lines.push(`| **Started** | ${this.meta.startedAt} |`)
    lines.push(`| **Duration** | ${dur}s |`)
    lines.push(`| **Tool calls** | ${this.meta.toolCalls} |`)
    lines.push(`| **Status** | ${this.meta.status} |`)
    lines.push(``)
    lines.push(`---`)
    lines.push(``)

    let currentIter = 0

    for (const { ts, event } of this.entries) {
      const time = ts.slice(11, 23)

      switch (event.type) {
        case 'message':
          if (event.role === 'user') {
            lines.push(`## 💬 User`)
            lines.push(``)
            lines.push(event.content)
            lines.push(``)
          } else {
            lines.push(`## ✅ Final Answer`)
            lines.push(``)
            lines.push(event.content)
            lines.push(``)
          }
          break

        case 'iteration':
          currentIter = event.current
          lines.push(`---`)
          lines.push(``)
          lines.push(`### Iteration ${event.current} / ${event.max}`)
          lines.push(``)
          break

        case 'ollama_request':
          lines.push(`*→ Ollama · ${event.message_count} msgs in context · \`${event.model}\`*`)
          lines.push(``)
          break

        case 'thought':
          lines.push(`**💭 Thought** \`${time}\``)
          lines.push(``)
          lines.push(`> ${event.content.replace(/\n/g, '\n> ')}`)
          lines.push(``)
          break

        case 'tool_call':
          lines.push(`**🔧 \`${event.tool}\`** \`${time}\``)
          lines.push(``)
          lines.push(`\`\`\`json`)
          lines.push(JSON.stringify(event.args, null, 2))
          lines.push(`\`\`\``)
          lines.push(``)
          break

        case 'tool_result':
          const status = event.error ? `ERROR · ${event.error}` : `${event.duration_ms}ms`
          lines.push(`**📥 Result** \`${status}\``)
          lines.push(``)
          lines.push(`\`\`\``)
          lines.push((event.output || '').slice(0, 2000))
          if ((event.output || '').length > 2000) lines.push(`... [truncated]`)
          lines.push(`\`\`\``)
          lines.push(``)
          break

        case 'git_commit':
          lines.push(`**🔀 Committed** \`${event.hash}\` — ${event.message}`)
          lines.push(``)
          break

        case 'error':
          lines.push(`**⚠️ Error**`)
          lines.push(``)
          lines.push(`> ${event.message}`)
          lines.push(``)
          break

        case 'warning':
          lines.push(`**⚡ Warning** ${event.message}`)
          lines.push(``)
          break
      }
    }

    return lines.join('\n')
  }

  getFilename() { return this.filename }
}

export async function listLogs(): Promise<LogMeta[]> {
  await fs.mkdir(LOGS_DIR, { recursive: true })
  const files = await fs.readdir(LOGS_DIR)
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl')).sort().reverse()

  const metas = await Promise.all(jsonlFiles.map(async (f) => {
    const content = await fs.readFile(path.join(LOGS_DIR, f), 'utf-8')
    const firstLine = content.split('\n')[0]
    try {
      const { event } = JSON.parse(firstLine)
      const { type: _, ...meta } = event
      return meta as LogMeta
    } catch {
      return { filename: f.replace('.jsonl', ''), query: f, model: '?', startedAt: '', toolCalls: 0, status: 'done' } as LogMeta
    }
  }))

  return metas
}

export async function readLog(filename: string): Promise<{ jsonl: string; md: string } | null> {
  try {
    const [jsonl, md] = await Promise.all([
      fs.readFile(path.join(LOGS_DIR, `${filename}.jsonl`), 'utf-8'),
      fs.readFile(path.join(LOGS_DIR, `${filename}.md`), 'utf-8'),
    ])
    return { jsonl, md }
  } catch {
    return null
  }
}
