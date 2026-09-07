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

let logFileSeq = 0

export class SessionLogger {
  private entries: LogEntry[] = []
  private startTs = Date.now()
  private filename: string
  private meta: LogMeta
  private writeQueue: Promise<void> = Promise.resolve()
  private metaWritten = false

  constructor(query: string, model: string, options: ModelOptions = {}, sessionId?: string) {
    const slug = query.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '')
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const seq = String(++logFileSeq).padStart(4, '0')
    this.filename = `${ts}_${seq}_${slug}`
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

    // Enqueue incremental writes in order (serial queue).
    const file = path.join(LOGS_DIR, `${this.filename}.jsonl`)
    const line = JSON.stringify(entry) + '\n'
    // Write the meta line FIRST, before the first event, so a run that never
    // reaches flush() (still in progress, or crashed) is STILL attributable to
    // its session — listLogs() reads sessionId/filename from line 0, so without
    // this the run's sessionId is unknown and it gets mis-grouped as 'legacy'
    // and lost from its session's replay. flush() rewrites this line 0 in place
    // with the final status/duration.
    if (!this.metaWritten) {
      this.metaWritten = true
      this.writeQueue = this.writeQueue
        .then(() => fs.mkdir(LOGS_DIR, { recursive: true }))
        .then(() => fs.appendFile(file, this.metaEntry() + '\n', 'utf-8'))
    }
    this.writeQueue = this.writeQueue.then(() => fs.appendFile(file, line, 'utf-8'))

    // Ensure the logs directory exists
    await fs.mkdir(LOGS_DIR, { recursive: true })
  }

  /** The `__meta__` header line (no trailing newline) — written up front by
   *  log() and rewritten with final values by flush(). */
  private metaEntry(): string {
    return JSON.stringify({ ts: this.meta.startedAt, event: { type: '__meta__', ...this.meta } })
  }

  /** Wait for all pending incremental writes, then finalize the meta line. */
  async flush() {
    this.meta.durationMs = Date.now() - this.startTs
    await this.writeQueue // wait for all prior writes to complete
    await fs.mkdir(LOGS_DIR, { recursive: true })

    const file = path.join(LOGS_DIR, `${this.filename}.jsonl`)
    // Rewrite the up-front meta line (log() wrote it as line 0) in place with
    // final status/duration/counts. Fall back to writing meta as the sole line
    // if nothing was logged (no meta yet) or the file is unexpectedly shaped.
    let existing = ''
    try { existing = await fs.readFile(file, 'utf-8') } catch { /* nothing written yet */ }
    const lines = existing.split('\n')
    if (this.metaWritten && lines[0] && lines[0].includes('"__meta__"')) {
      lines[0] = this.metaEntry()
      await fs.writeFile(file, lines.join('\n'), 'utf-8')
    } else {
      await fs.writeFile(file, this.metaEntry() + '\n' + existing, 'utf-8')
    }
  }

  /** Read the JSONL file and return parsed events, skipping malformed lines. */
  async readLogLines(): Promise<LogEntry[]> {
    try {
      const content = await fs.readFile(path.join(LOGS_DIR, `${this.filename}.jsonl`), 'utf-8')
      const lines = content.trim().split('\n').filter(l => l.trim())
      return lines
        .map(line => {
          const parsed = JSON.parse(line) as LogEntryJson
          // Skip the meta line (not a real event entry for replay purposes).
          // The persisted meta line's event is `{ type: '__meta__', ... }`, which
          // isn't part of the AgentEvent union — cast for the discriminant read.
          if (parsed.event && typeof parsed.event === 'object' && (parsed.event as { type: string }).type === '__meta__') return null
          return parsed as unknown as LogEntry
        })
        .filter((l): l is LogEntry => l !== null)
    } catch {
      return []
    }
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

export async function readLog(filename: string): Promise<{ jsonl: string } | null> {
  try {
    const jsonl = await fs.readFile(path.join(LOGS_DIR, `${filename}.jsonl`), 'utf-8')
    return { jsonl }
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
      // Skip the meta line (its event is `{ type: '__meta__', ... }`, outside the
      // AgentEvent union — cast for the discriminant read; see readLogLines).
      if (parsed.event && typeof parsed.event === 'object' && (parsed.event as { type: string }).type === '__meta__') continue
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
        .filter(f => f.endsWith('.jsonl') || f.startsWith('history') || f === 'current-session.txt' || f === 'sessions-registry.json')
        .map(f => fs.unlink(path.join(LOGS_DIR, f)).catch(() => {}))
    )
  } catch { /* dir may not exist */ }
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sessions = await listSessions()
  const session = sessions.find(s => s.id === sessionId)
  if (!session) return
  await Promise.all([
    ...session.runs.map(run =>
      fs.unlink(path.join(LOGS_DIR, `${run.filename}.jsonl`)).catch(() => {}),
    ),
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
