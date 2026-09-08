// LEGACY LOG READER. Session tracking (current-session pointer, the session
// registry, resume history) has moved entirely to the ledger (ledger.ts,
// .argo/sessions.json + .argo/frames/*.jsonl) — see that module for the
// current mechanism. What remains here is a READ-ONLY relic: old `.jsonl` run
// logs written by the now-fully-removed SessionLogger, from BEFORE that
// migration, still need to be replayable by server.ts's GET /logs/:filename
// for any session that predates it. Nothing in this codebase writes a new
// `.jsonl` run log any more — these functions only ever read files that
// already exist on disk from before this change.
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import type { AgentEvent, ModelOptions } from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOGS_DIR = path.join(__dirname, '..', 'logs')

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

/** Serializable form of a log entry (as written by the old SessionLogger). */
interface LogEntryJson {
  ts: string
  seq: number
  event: AgentEvent
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
      // AgentEvent union — cast for the discriminant read).
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
