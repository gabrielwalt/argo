import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentEvent, ModelOptions } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOGS_DIR = path.join(__dirname, '..', 'logs')

const REGISTRY_FILE = path.join(LOGS_DIR, 'sessions-registry.json')

interface RegistryEntry {
  id: string
  startedAt: string
}

async function readRegistry(): Promise<RegistryEntry[]> {
  try {
    return JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf-8'))
  } catch {
    return []
  }
}

async function writeRegistry(entries: RegistryEntry[]): Promise<void> {
  await fs.mkdir(LOGS_DIR, { recursive: true })
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(entries))
}

export async function registerSession(id: string): Promise<void> {
  const entries = await readRegistry()
  if (!entries.some(e => e.id === id)) {
    entries.unshift({ id, startedAt: new Date().toISOString() })
    await writeRegistry(entries)
  }
}

export async function unregisterSession(id: string): Promise<void> {
  await writeRegistry((await readRegistry()).filter(e => e.id !== id))
}

interface LogEntry {
  ts: string
  seq: number
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
  sessionId?: string
}

export interface SessionGroup {
  id: string
  startedAt: string
  runs: LogMeta[]
}

/** Serializable form of a log entry (used when writing JSONL lines). */
interface LogEntryJson {
  ts: string
  seq: number
  event: AgentEvent
}

export class SessionLogger {
  private entries: LogEntry[] = []
  private startTs = Date.now()
  private filename: string
  private meta: LogMeta
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(query: string, model: string, options: ModelOptions = {}, sessionId?: string) {
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
      ...(sessionId ? { sessionId } : {}),
    }
  }

  /** Current highest sequence number (0 before any events). */
  getSeq(): number {
    return this.entries.length > 0
      ? this.entries[this.entries.length - 1].seq
      : 0
  }

  /** Enqueue an event for incremental JSONL write. Returns immediately. */
  async log(event: AgentEvent): Promise<void> {
    const seq = this.entries.length + 1
    const entry: LogEntry = { ts: new Date().toISOString(), seq, event }
    this.entries.push(entry)

    if (event.type === 'tool_call') this.meta.toolCalls++
    if (event.type === 'iteration') this.meta.iterations = event.current
    if (event.type === 'done') this.meta.status = 'done'
    if (event.type === 'error') this.meta.status = 'error'

    // Enqueue incremental write in order (serial queue)
    const line = JSON.stringify(entry) + '\n'
    this.writeQueue = this.writeQueue.then(() =>
      fs.appendFile(path.join(LOGS_DIR, `${this.filename}.jsonl`), line, 'utf-8')
    )

    // Ensure the logs directory exists
    await fs.mkdir(LOGS_DIR, { recursive: true })
  }

  /** Wait for all pending incremental writes, then append meta line. */
  async flush() {
    this.meta.durationMs = Date.now() - this.startTs
    await this.writeQueue // wait for all prior writes to complete
    await fs.mkdir(LOGS_DIR, { recursive: true })

    // Write meta as the first line (prepend via read-modify-write)
    const existingContent = await fs.readFile(path.join(LOGS_DIR, `${this.filename}.jsonl`), 'utf-8')
    const metaLine = JSON.stringify({ ts: this.meta.startedAt, event: { type: '__meta__', ...this.meta } }) + '\n'
    await fs.writeFile(path.join(LOGS_DIR, `${this.filename}.jsonl`), metaLine + existingContent, 'utf-8')

    // Markdown: human-readable trace (unchanged)
    const md = this.toMarkdown()
    await fs.writeFile(path.join(LOGS_DIR, `${this.filename}.md`), md, 'utf-8')
  }

  /** Read the JSONL file and return parsed events, skipping malformed lines. */
  async readLogLines(): Promise<LogEntry[]> {
    try {
      const content = await fs.readFile(path.join(LOGS_DIR, `${this.filename}.jsonl`), 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.trim())
      return lines
        .map(line => {
          const parsed = JSON.parse(line) as LogEntryJson
          // Skip the meta line (not a real event entry for replay purposes)
          if (parsed.event && typeof parsed.event === 'object' && parsed.event.type === '__meta__') return null
          return parsed as unknown as LogEntry
        })
        .filter((l): l is LogEntry => l !== null)
    } catch {
      return []
    }
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
        case 'start':
          lines.push(`*Run started · \`${event.model}\`*`)
          lines.push(``)
          break

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
          break

        case 'ollama_request':
          lines.push(`*Ollama request · iter \`${event.iteration}\` · ${event.message_count} messages · \`${event.model}\`*`)
          lines.push(``)
          break

        case 'token_usage': {
          const pct = Math.round(event.prompt_tokens / event.num_ctx * 100)
          lines.push(`*Context usage · **${event.prompt_tokens.toLocaleString()}** / ${event.num_ctx.toLocaleString()} ctx (${pct}%)*`)
          lines.push(``)
          break
        }

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

        case 'done':
          // An aborted run emits only 'done' (see agent.ts's abort branch) — no
          // 'message' event precedes it — so this is sometimes the only place
          // the outcome appears at all, not just a duplicate of 'message'.
          lines.push(`*Run finished* — ${event.content}`)
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

        case 'compact_start':
          lines.push(`**📦 Compacting context** \`${time}\` — ${event.messageCount} messages, ${(event.contextUsagePct * 100).toFixed(0)}% context (incl. generation reserve)`)
          lines.push(``)
          break

        case 'compact_progress':
          lines.push(`*…still compacting* \`${time}\` — ${event.step} (${Math.round(event.elapsedMs / 1000)}s / ${Math.round(event.timeoutMs / 1000)}s)`)
          lines.push(``)
          break

        case 'compact':
          lines.push(`**📦 Context compacted** \`${time}\` — ${event.messagesBefore} → ${event.messagesAfter} messages, was ${(event.contextUsagePct * 100).toFixed(0)}% context, validation pass ${event.validated ? 'ran' : 'skipped (nothing to fold in)'}`)
          lines.push(``)
          lines.push(`${event.rangeDescription}`)
          lines.push(``)
          lines.push(`\`\`\``)
          lines.push(event.summary)
          lines.push(`\`\`\``)
          lines.push(``)
          if (event.activeWorkingStateSummary) {
            lines.push(`*Active working state (unvalidated, single-pass summary of the current run's own progress):*`)
            lines.push(``)
            lines.push(`\`\`\``)
            lines.push(event.activeWorkingStateSummary)
            lines.push(`\`\`\``)
            lines.push(``)
          }
          break

        default: {
          // Compile-time guard: a new AgentEvent variant without a case above
          // fails the build here instead of silently vanishing from the .md
          // trace while still appearing in the .jsonl.
          const _exhaustive: never = event
          void _exhaustive
        }
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

export async function readLogEvents(filename: string): Promise<Array<AgentEvent & { __seq: number }> | null> {
  try {
    const content = await fs.readFile(path.join(LOGS_DIR, `${filename}.jsonl`), 'utf-8')
    const lines_arr = content.trim().split('\n').filter(l => l.trim())
    const events: Array<AgentEvent & { __seq: number }> = []
    for (const line of lines_arr) {
      const parsed = JSON.parse(line) as LogEntryJson
      // Skip the meta line (not a real event entry for replay purposes)
      if (parsed.event && typeof parsed.event === 'object' && parsed.event.type === '__meta__') continue
      // Merge the per-run seq onto the event: the browser dedupes replayed events
      // against the live SSE stream (which carries the same __seq) at reconnect.
      // Object.assign is typed to return the intersection, so no cast is needed.
      events.push(Object.assign({ __seq: parsed.seq }, parsed.event))
    }
    return events
  } catch {
    return null
  }
}

export async function listSessions(): Promise<SessionGroup[]> {
  const [logs, registry] = await Promise.all([listLogs(), readRegistry()])

  // Build map from log files (has full run metadata)
  const map = new Map<string, LogMeta[]>()
  for (const log of logs) {
    const sid = log.sessionId ?? 'legacy'
    if (!map.has(sid)) map.set(sid, [])
    map.get(sid)!.push(log)
  }

  // Add registry entries that have no log files (e.g. sessions created but no messages sent)
  for (const entry of registry) {
    if (!map.has(entry.id)) map.set(entry.id, [])
  }

  return Array.from(map.entries())
    .map(([id, runs]) => {
      const sorted = runs.slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      const registryEntry = registry.find(e => e.id === id)
      const startedAt = sorted[0]?.startedAt ?? registryEntry?.startedAt ?? id
      return { id, startedAt, runs: sorted }
    })
    .sort((a, b) => {
      const aLast = a.runs[a.runs.length - 1]?.startedAt ?? a.startedAt
      const bLast = b.runs[b.runs.length - 1]?.startedAt ?? b.startedAt
      return bLast.localeCompare(aLast)
    })
}

export async function deleteAllLogs(): Promise<void> {
  try {
    const files = await fs.readdir(LOGS_DIR)
    await Promise.all(
      files
        .filter(f => f.endsWith('.jsonl') || f.endsWith('.md') || f.startsWith('history') || f === 'current-session.txt' || f === 'sessions-registry.json')
        .map(f => fs.unlink(path.join(LOGS_DIR, f)).catch(() => {}))
    )
  } catch { /* dir may not exist */ }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sessions = await listSessions()
  const session = sessions.find(s => s.id === sessionId)
  if (!session) return
  await Promise.all([
    ...session.runs.flatMap(run => [
      fs.unlink(path.join(LOGS_DIR, `${run.filename}.jsonl`)).catch(() => {}),
      fs.unlink(path.join(LOGS_DIR, `${run.filename}.md`)).catch(() => {}),
    ]),
    fs.unlink(path.join(LOGS_DIR, `history-${sessionId}.json`)).catch(() => {}),
    unregisterSession(sessionId),
  ])
}

export async function getSessionMessages(sessionId: string): Promise<Array<{ role: string; content: string }>> {
  const sessions = await listSessions()
  const session = sessions.find(s => s.id === sessionId)
  if (!session) return []
  const messages: Array<{ role: string; content: string }> = []
  for (const run of session.runs) {
    const log = await readLog(run.filename)
    if (!log) continue
    for (const line of log.jsonl.trim().split('\n')) {
      try {
        const parsed = JSON.parse(line) as LogEntryJson
        const { event } = parsed
        if (event.type === 'message' && event.content) {
          messages.push({ role: event.role, content: event.content })
        }
      } catch { /* skip bad lines */ }
    }
  }
  return messages
}
