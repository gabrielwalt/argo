import express from 'express'
import cors from 'cors'
import { EventEmitter } from 'events'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { config, localTimestamp } from './config.js'
import { Agent } from './agent.js'
// LEGACY (pre-ledger) session log replay only — readLog/readLogEvents are the
// only survivors of logger.ts's old writer actually used here (listLogs has no
// caller in this file); every other session-tracking concern (current session
// pointer, registry, resume) now lives on the ledger (ledger.ts) — see the
// imports below.
import { readLog, readLogEvents, LOGS_DIR } from './logger.js'
import * as ledger from './ledger.js'
import type { AgentEvent, ModelOptions, Role, ToolName, LedgerMessage, SessionRegistry } from './types.js'
import { checkEnvironment, logEnvironment, type EnvCheck } from './health.js'
import { installAuth } from './auth.js'
import { runDispatchLoop, abortDispatch, listLiveFrames, getLiveFrame, getActiveFrameId, type LiveFrame } from './dispatch.js'
import { ROLE_MAX_ITERATIONS } from './frames.js'
import { ensureWorkspaceId, workspaceHasContent, decideSessionResume, type SessionResumeReason } from './workspace-identity.js'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

export const app = express()
const bus = new EventEmitter()
bus.setMaxListeners(50)

// Last-resort net: this worker process is the container's only process (--rm),
// so an uncaught error here doesn't just fail one request — it kills the whole
// container, silently, with no way to recover its logs afterward. agent.chat()
// now catches its own failures (see agent.ts), but this covers anything else
// that might still slip through uncaught.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (worker process would otherwise have crashed):', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (worker process would otherwise have crashed):', err)
})

app.use(cors())
app.use(express.json())

// Worker mode is only reachable through central's proxy, which is the one
// place the password gate needs to be enforced — see installAuth in central.ts.
if (!config.inContainer) installAuth(app)

// Static files only in standalone dev mode (not when proxied by central server)
if (!config.workerMode) {
  app.use(express.static(path.join(__dirname, '..', 'public')))
}

// Forward the per-run seq alongside the event so the browser can dedupe replayed
// (persisted) events against this live SSE stream at the reconnect boundary — the
// JSONL replay (readLogEvents) carries the same __seq. Named (not inline) so
// dispatch.ts's runDispatchLoop can share the exact same emit path for every
// role-scoped Agent instance it spawns — one SSE stream either way.
function emitEvent(event: AgentEvent, seq?: number) {
  bus.emit('agent', typeof seq === 'number' ? { ...event, __seq: seq } : event)
}

const agent = new Agent(emitEvent)

// The workspace root the ledger reads/writes .argo/ under — same fallback
// dispatch.ts's own root() uses (config.workspacePath is '' in standalone dev
// mode before a folder is mounted).
function ledgerRoot(): string {
  return config.workspacePath || '/workspace'
}

function makeSessionId(): string {
  return localTimestamp()
}

let currentSessionId = makeSessionId()
let isBusy = false
let envStatus: EnvCheck | null = null

// Content identity of the mounted workspace (see workspace-identity.ts) — set once by
// startServer(). Null in standalone dev mode before a workspace is mounted, or if the
// workspace is unwritable (ensureWorkspaceId fails open rather than blocking startup).
let currentWorkspaceId: string | null = null

// Set once by startServer()'s resume-vs-fresh decision, surfaced on GET /status as
// `startupSession` so a future UI change can say "started a fresh session — the
// previous one belonged to a different workspace" instead of silently showing nothing.
// /reset and /resume/:sessionId are explicit user actions, not a silent auto-decision,
// so they don't update this — only the startup-time choice needs to be visible.
let startupSessionInfo: { resumed: boolean; reason: SessionResumeReason; previousSessionId?: string } | null = null

// THE CURRENT-SESSION POINTER now lives on the ledger's own registry
// (.argo/sessions.json's currentSessionId field, ledger.ts's setCurrentSession/
// getCurrentSession) — INSIDE the mounted workspace, unlike the old
// logs/current-session.txt file, which lived alongside this repo's own code
// (LOGS_DIR) and so survived a workspace content swap untouched. That was the
// actual root cause workspace-identity.ts's workspaceId-tagged pointer worked
// around: a pointer stored outside the workspace can never be told apart from a
// stale one. Stored inside .argo/ instead, the pointer now travels with the
// workspace's own content by construction — decideSessionResume's
// workspaceHasContent fallback (the "someone ran `rm -rf *`, which skips
// dotfiles, so .argo/ survives but the real content didn't" case) still applies
// and is still checked below; only the workspaceId-mismatch branch is now moot; see
// startServer() (docs/architecture.md's session-resume section, if any, may still
// reference the old current-session.txt file — the registry field replaces it 1:1).
function writeSessionPointer(sessionId: string): Promise<void> {
  return ledger.setCurrentSession(ledgerRoot(), sessionId).catch(() => {})
}

// SSE — streams all agent events to connected browsers
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const listener = (event: AgentEvent) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  bus.on('agent', listener)
  req.on('close', () => bus.off('agent', listener))
})

// Submit a chat query
app.post('/chat', async (req, res) => {
  if (isBusy) {
    res.status(409).json({ error: 'Agent is busy' })
    return
  }

  const { message, model, options, maxIterations, autoCommit } = req.body as { message: string; model?: string; options?: ModelOptions; maxIterations?: number; autoCommit?: boolean }
  if (!message?.trim()) {
    res.status(400).json({ error: 'message required' })
    return
  }
  if (!config.workspacePath) {
    res.status(400).json({ error: 'No workspace mounted' })
    return
  }

  if (model) agent.setModel(model)
  if (options) agent.setOptions(options)
  if (maxIterations != null) agent.setMaxIterations(maxIterations)
  if (autoCommit != null) agent.setAutoCommit(autoCommit)

  isBusy = true
  res.json({ ok: true })

  try {
    // The dispatch loop drives Planner/Implementer/Dispatcher as scoped Agent instances of
    // its own, sharing this same emit path — `agent` (the shared module-level
    // instance above) is never used to run a turn; it stays only as the vehicle for
    // /history, /context, /reset, session persistence, etc. Per-request overrides
    // (model/options/maxIterations/autoCommit) above still apply to `agent` even
    // though this route never calls `agent.chat()` directly, since some of those
    // fields (sessionId, model default) are read elsewhere off the same instance.
    await runDispatchLoop(message, emitEvent, { model, options, sessionId: currentSessionId })
  } finally {
    // Set BEFORE any async cleanup (logger flush already happened inside
    // runDispatchLoop/chat before they returned). The `done` SSE event was
    // emitted before this point; if isBusy stays true any longer, a client
    // reconnecting (es.onopen → /status) sees busy:true AFTER the done event
    // already cleared the UI, and re-sets it to busy with nothing left to
    // clear it — the "refresh fixes it" race the owner reported.
    isBusy = false
  }
})

// Current chat history (user + assistant messages only, survives browser refresh)
app.get('/history', (req, res) => {
  res.json(agent.getChatHistory())
})

// ── Frame context (context viewer backend) ─────────────────────────
// This section defines the shape for GET /frames and GET /context?frame=<id> —
// see ConversationSummary/FrameSummary below for the authoritative types. The root
// cause this exists for: GET /context
// used to only read the shared module-level `agent`, which /chat never actually
// runs a turn on (dispatch.ts's runDispatchLoop drives scoped Agent instances of
// its own instead) — so the real per-frame contexts were simply never reachable
// from the API. GET /context with no `frame` param keeps its pre-existing
// shape/meaning for backward compatibility.

const FRAME_ROLES: readonly Role[] = ['planner', 'implementer', 'dispatcher']

// frameId format is `${role}-${base36 timestamp}-${counter}` (ledger.ts's newId) —
// none of the role names contain a hyphen, so the segment before the first hyphen
// is reliable. Returns null for anything else, in particular the shared `agent`
// instance's own session ids (ISO-derived timestamps like `2026-09-04T07-03-37`,
// whose first segment is never one of these role words) — this is what lets the
// disk scan below tell a frame's history file apart from that instance's own
// history-<id>.json.
export function parseFrameRole(frameId: string): Role | null {
  const cut = frameId.indexOf('-')
  const prefix = cut === -1 ? frameId : frameId.slice(0, cut)
  return (FRAME_ROLES as readonly string[]).includes(prefix) ? (prefix as Role) : null
}

const HISTORY_FILENAME_RE = /^history-(.+)\.json$/

// Extracts the id portion of a `history-<id>.json` filename, or null for anything
// else LOGS_DIR holds (the shared `agent` instance's own bare `history.json`,
// `.jsonl` run logs, `sessions-registry.json`, `current-session.txt`,
// `compaction-*.json`, ...).
export function frameIdFromHistoryFilename(filename: string): string | null {
  const m = HISTORY_FILENAME_RE.exec(filename)
  return m ? m[1] : null
}

// Mirrors agent.ts's getContext(): content returned IN FULL, never truncated —
// the context viewer's entire purpose is showing exactly what the model saw
// (or, for a deleted entry, what it USED to see), so capping it here would
// make the one place meant to show ground truth lie about it. Kept as a named
// function (contract: "the identical no-truncation behavior on both paths")
// rather than inlined at each call site, so a future change to this policy
// only needs to happen once.
function truncateContextMessage(full: string): { content: string; chars: number } {
  return { content: full, chars: full.length }
}

export interface DiskContextMessage {
  role: string
  content: string
  chars: number
  ts: null
}

// Pure reconstruction of getContext()'s `messages`/`messageCount`/`totalChars` from
// an already-parsed history-<frameId>.json array — no fs here, so this is
// unit-testable without touching disk. `ts` is always null: per-message timestamps
// live in agent.ts's historyTs WeakMap, which does not survive the process
// (contract: "Do not fabricate timestamps").
export function buildDiskContextMessages(rawMessages: unknown): { messages: DiskContextMessage[]; messageCount: number; totalChars: number } {
  const arr = Array.isArray(rawMessages) ? rawMessages : []
  let totalChars = 0
  const messages = arr.map(m => {
    const rec = (m ?? {}) as { role?: unknown; content?: unknown }
    const full = typeof rec.content === 'string' ? rec.content : String(rec.content ?? '')
    totalChars += full.length
    const { content, chars } = truncateContextMessage(full)
    return { role: typeof rec.role === 'string' ? rec.role : 'unknown', content, chars, ts: null }
  })
  return { messages, messageCount: messages.length, totalChars }
}

export interface ContextMessage {
  id?: string
  role: string
  content: string
  chars: number
  ts: number | null
  deleted: boolean
}

// GET /context's "show deleted messages too" pass: agent.ts's own splice-based
// removals (a superseded call+result pair, a spent failed-attempt pair, an
// out-of-date "[Reasoning]" artifact) leave nothing behind in the LIVE
// this.history any more — by design, none of them write any ledger marker
// either, so the ledger's plain per-id last-write IS still the message's full
// original content (contrast agent.ts's manageContext, which DOES write a
// follow-up `evicted: true` marker, so a collapsed/evicted-but-still-live
// message already shows up here as its own stub, no special handling needed).
// That means the full ledger record — `ledger.readFrame`, already
// first-insertion-ordered with last-write-wins per id — is a strict SUPERSET
// of the live context in the same relative order (removals only ever drop
// entries, never reorder the survivors), so walking it once and checking each
// id against the live set is enough to reconstruct "what the model saw, plus
// everything it used to see," each message flagged so the UI can grey out
// whatever's gone. `live` messages are used verbatim (already truncated, with
// a real push timestamp); a `deleted` entry gets the same char-cap treatment
// applied fresh here, and `ts: null` (dying entry never had one preserved).
export function mergeWithDeleted(
  ledgerMessages: LedgerMessage[],
  liveMessages: Array<{ id?: string; role: string; content: string; chars: number; ts: number | null }>,
): ContextMessage[] {
  const liveById = new Map(liveMessages.filter(m => m.id).map(m => [m.id!, m]))
  return ledgerMessages.map(lm => {
    const live = liveById.get(lm.id)
    if (live) return { ...live, deleted: false }
    const { content, chars } = truncateContextMessage(lm.content)
    return { id: lm.id, role: lm.role, content, chars, ts: null, deleted: true }
  })
}

export interface FrameSummary {
  frameId: string
  role: Role
  parentFrameId: string | null
  live: boolean
  startedAt: number | null
  messageCount: number
  totalChars: number
  promptTokens: number | null
  numCtx: number | null
  // 1-based ordinal among the Implementer frames one Planner spawned for one
  // objective (types.ts's FrameSpawnRequest.implementerIndex) — null for every
  // other frame (Dispatcher, Planner, and a SIMPLE-mode's lone Implementer, which
  // needs no disambiguation).
  implementerIndex: number | null
}

// Oldest-first merge of the live registry's summaries with disk-recovered ones —
// pure so ordering/dedup is testable without a filesystem. A frameId present in
// both groups (should not happen in practice: a live frame's history file also
// exists on disk, but scanDiskFrames is told to exclude live ids) keeps the LIVE
// entry, which carries a real startedAt/promptTokens instead of the disk fallback's
// nulls. Disk-recovered frames have startedAt: null (contract-sanctioned
// "unknown") and sort as older than anything with a known timestamp — a frame only
// reachable via disk recovery is, in every case this backend can build, from
// further back than anything still live in this run's own registry.
export function mergeFrameSummaries(live: FrameSummary[], diskOnly: FrameSummary[]): FrameSummary[] {
  const liveIds = new Set(live.map(f => f.frameId))
  const merged = [...live, ...diskOnly.filter(f => !liveIds.has(f.frameId))]
  return merged.sort((a, b) => (a.startedAt ?? -Infinity) - (b.startedAt ?? -Infinity))
}

// dispatch.ts's own hard "no two LLM calls ever run concurrently" rule means at
// most one frame is ever actually executing, so this is normally just
// `liveActiveFrameId` verbatim. The contract's own wording ("when several are
// live... it is the most recently spawned live one") is honoured as a defensive
// fallback: if that id is unset for any reason, pick the most recently started
// frame still marked live rather than reporting nothing while frames demonstrably
// exist.
export function chooseActiveFrame(liveActiveFrameId: string | null, liveFrames: FrameSummary[]): string | null {
  if (liveActiveFrameId) return liveActiveFrameId
  const live = liveFrames.filter(f => f.live)
  if (live.length === 0) return null
  return live.reduce((latest, f) => (f.startedAt ?? -Infinity) > (latest.startedAt ?? -Infinity) ? f : latest).frameId
}

// Disk-only candidates for GET /frames: every `history-<frameId>.json` in LOGS_DIR
// not already covered by the live registry. Unlike ledger-based frames (which DO
// have a persisted session→frameId index now — `.argo/sessions.json`, read by
// buildConversations below), these pre-ledger files carry no session association
// at all (frameId encodes no session, and this legacy format has no sessionId
// field either) — so they're surfaced as one trailing "legacy" group in GET
// /frames rather than attributed to any real conversation.
//
// LEGACY SOURCE, POST-LEDGER-MIGRATION: Agent.loadHistory no longer writes
// history-<frameId>.json as a side effect (session tracking has moved to the
// ledger, .argo/frames/<frameId>.jsonl — see ledger.ts) — so this only ever
// recovers a frame from BEFORE that migration. A frame spawned after it that
// isn't in the live registry any more (process restarted) has no disk-recovery
// path here at all; reading it back would mean reading .argo/frames/<frameId>.jsonl
// via ledger.readFrame instead, which this function does not yet do (Phase 2, not
// this change — see GET /logs' own comment for the same framing on session replay).
async function scanDiskFrames(excludeIds: Set<string>): Promise<FrameSummary[]> {
  let files: string[]
  try {
    files = await fs.readdir(LOGS_DIR)
  } catch {
    return []
  }
  const out: FrameSummary[] = []
  for (const f of files) {
    const frameId = frameIdFromHistoryFilename(f)
    if (!frameId || excludeIds.has(frameId)) continue
    const role = parseFrameRole(frameId)
    if (!role) continue // not a frame history file (e.g. the shared `agent` instance's own history-<sessionId>.json)
    try {
      const raw = JSON.parse(await fs.readFile(path.join(LOGS_DIR, f), 'utf-8'))
      const { messageCount, totalChars } = buildDiskContextMessages(raw)
      out.push({ frameId, role, parentFrameId: null, live: false, startedAt: null, messageCount, totalChars, promptTokens: null, numCtx: null, implementerIndex: null })
    } catch {
      // Unreadable/corrupt history file — skip it, don't fail the whole listing.
    }
  }
  return out
}

function liveFrameSummary(f: LiveFrame): FrameSummary {
  const ctx = f.agent.getContext()
  return {
    frameId: f.frameId,
    role: f.role,
    parentFrameId: f.parentFrameId,
    live: true,
    startedAt: f.startedAt,
    messageCount: ctx.messageCount,
    totalChars: ctx.totalChars,
    // Prefer the last real `token_usage` event over the Agent's configured
    // options.num_ctx (usually unset — see dispatch.ts's LiveFrame comment): this is
    // what "last known values... lets the context sidebar's token bar follow a
    // frame" means, and it is deliberately NOT what GET /context's own (unchanged)
    // numCtx field does below.
    promptTokens: f.lastTokenUsage?.promptTokens ?? null,
    numCtx: f.lastTokenUsage?.numCtx ?? ctx.numCtx,
    implementerIndex: f.implementerIndex,
  }
}

// Fallback for a REGISTERED frame (ledger.ts's SessionRegistry) that isn't in the
// current process's liveFrames — a past conversation's frame, or an earlier run of
// the still-current one (liveFrames is cleared at the start of every new run — see
// dispatch.ts's LiveFrame comment). Reads the frame's own ledger file directly
// (ledger.readFrame — the eviction-aware, deduplicated view) rather than the old
// disk-scan's pre-ledger history-<frameId>.json, which this frame never has.
// promptTokens/numCtx are recovered from whatever the ledger happened to capture
// (see agent.ts's pushCtx: promptTokens is written on the model's own response
// turn, modelOptions.num_ctx on the frame's opening [system] identity message) —
// null when nothing was ever recorded (e.g. a frame that never got a model
// response), same "unknown" convention as scanDiskFrames.
async function summarizeLedgerFrame(
  root: string, frameId: string, role: Role, parentFrameId: string | null, implementerIndex: number | null,
): Promise<FrameSummary> {
  const messages = await ledger.readFrame(root, frameId)
  let totalChars = 0
  let promptTokens: number | null = null
  let numCtx: number | null = null
  for (const m of messages) {
    totalChars += m.content.length
    if (m.promptTokens != null) promptTokens = m.promptTokens
    if (numCtx === null && m.modelOptions?.num_ctx != null) numCtx = m.modelOptions.num_ctx
  }
  return {
    frameId, role, parentFrameId, live: false, startedAt: null,
    messageCount: messages.length, totalChars, promptTokens, numCtx, implementerIndex,
  }
}

export interface ConversationSummary {
  sessionId: string | null   // null only for the trailing legacy/pre-ledger group
  current: boolean
  startedAt: string | null   // ledger registry's runs[0].startedAt (ISO) — null for the legacy group
  frames: FrameSummary[]
}

// One conversation (= session — see CLAUDE.md's "Session" definition) per ledger
// registry entry, each holding EVERY frame ever spawned across that session's whole
// life (the persistent Dispatcher, plus every Planner/Implementer any of its runs
// spawned) — a session's frame list only ever grows, so a new Implementer spawning
// never hides an earlier Planner/Implementer from the same conversation. Order:
// first-seen across runs (oldest-first, matching registerFrame's own append order),
// deduped by frameId — the ONE dedup that matters is the persistent Dispatcher,
// registered once in run 0 but reused (never re-registered) by every later run of
// the same session. Each frameId is resolved via the LIVE registry when possible
// (current token/message counts) and the ledger file otherwise (summarizeLedgerFrame).
async function buildConversations(root: string, currentSessionId: string): Promise<ConversationSummary[]> {
  const registry = await ledger.getRegistry(root)
  const conversations = await Promise.all(registry.sessions.map(async session => {
    const seen = new Set<string>()
    const frames: FrameSummary[] = []
    for (const run of session.runs) {
      for (const f of run.frames) {
        if (seen.has(f.frameId)) continue
        seen.add(f.frameId)
        const live = getLiveFrame(f.frameId)
        frames.push(
          live
            ? liveFrameSummary(live)
            : await summarizeLedgerFrame(root, f.frameId, f.role, f.parentFrameId, f.implementerIndex ?? null),
        )
      }
    }
    return {
      sessionId: session.id,
      current: session.id === currentSessionId,
      startedAt: session.runs[0]?.startedAt ?? null,
      frames,
    }
  }))
  // Current conversation first, then past ones most-recent-first.
  conversations.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    return (b.startedAt ?? '').localeCompare(a.startedAt ?? '')
  })
  return conversations
}

// Frames of the current process's most recent dispatch run, oldest first — see
// dispatch.ts's liveFrames registry comment for the retention policy (cleared at
// the START of the next run, not the end, so the last run stays inspectable).
// Grouped by conversation (ledger session) for the context sidebar (app.js's
// renderCtxAgentList) — `active` is unchanged (still the single frameId actually
// executing right now, dispatch.ts's own "no two LLM calls ever run concurrently"
// rule), everything else is now nested under `conversations`.
app.get('/frames', async (req, res) => {
  const liveSummaries = listLiveFrames().map(liveFrameSummary)
  const conversations = await buildConversations(ledgerRoot(), currentSessionId)
  // Legacy, pre-ledger frames (scanDiskFrames/mergeFrameSummaries — see their own
  // comments) have no session mapping at all, so they can't join a real
  // conversation group; keep them reachable as one trailing group instead of
  // dropping them. Excludes anything a conversation group already covers.
  const coveredIds = new Set(conversations.flatMap(c => c.frames.map(f => f.frameId)))
  const diskOnly = await scanDiskFrames(new Set([...liveSummaries.map(f => f.frameId), ...coveredIds]))
  const legacy = mergeFrameSummaries([], diskOnly)
  res.json({
    // chooseActiveFrame's defensive fallback (most-recently-started still-live
    // frame) exists for a genuine mid-run gap between two frame calls, where
    // activeFrameId is momentarily null but a run IS in progress. Once the run
    // is over, activeFrameId stays null forever (liveFrames is only cleared at
    // the START of the next run — see dispatch.ts's own comment) and that same
    // fallback would otherwise keep reporting the last frame that ran as
    // "active" indefinitely, pulsing its status dot in the UI even though
    // nothing is running. Gate the whole lookup on isBusy so idle always
    // reports null, regardless of what's still sitting in the live registry.
    active: isBusy ? chooseActiveFrame(getActiveFrameId(), liveSummaries) : null,
    conversations: legacy.length
      ? [...conversations, { sessionId: null, current: false, startedAt: null, frames: legacy }]
      : conversations,
  })
})

// GET /context — the shared `agent` instance's own context by default (used for
// /history-style session bookkeeping, not a live dispatch frame); ?frame=<frameId>
// for a specific dispatch frame (live from its Agent instance, or reconstructed
// from disk).
app.get('/context', async (req, res) => {
  const frameId = typeof req.query.frame === 'string' ? req.query.frame : null
  if (frameId === null) {
    res.json({ ...agent.getContext(), frameId: null, role: null, live: false })
    return
  }

  const live = getLiveFrame(frameId)
  if (live) {
    const ctx = live.agent.getContext()
    // messages becomes the superset (live + deleted, see mergeWithDeleted's own
    // comment) for display; messageCount/totalChars stay the LIVE-only figures
    // from getContext() itself — they drive the context-usage-percent display,
    // which must reflect what the model actually sees, not what a human
    // reviewing the run can additionally see. Falls back to the live-only list
    // if the ledger read fails for any reason — this is an additive display
    // enhancement, never something that should break the context viewer.
    let messages: ContextMessage[] | typeof ctx.messages = ctx.messages
    try {
      messages = mergeWithDeleted(await ledger.readFrame(ledgerRoot(), live.frameId), ctx.messages)
    } catch { /* fall back to live-only messages */ }
    res.json({ ...ctx, messages, frameId: live.frameId, role: live.role, live: true })
    return
  }

  // Disk recovery: the frame's Agent is gone (a prior run, or a process restart),
  // but LOGS_DIR/history-<frameId>.json survives exactly like a regular session's
  // history does — reconstruct the same shape from it rather than 404ing just
  // because nothing is currently held in memory. Post-run inspection is the
  // primary use of this whole feature.
  let rawMessages: unknown
  try {
    rawMessages = JSON.parse(await fs.readFile(path.join(LOGS_DIR, `history-${frameId}.json`), 'utf-8'))
  } catch {
    res.status(404).json({ error: `Unknown frame: ${frameId}` })
    return
  }
  const { messages, messageCount, totalChars } = buildDiskContextMessages(rawMessages)
  res.json({
    frameId,
    role: parseFrameRole(frameId),
    live: false,
    messages,
    messageCount,
    totalChars,
    numCtx: null,       // not persisted anywhere once the Agent instance is gone — never fabricated
    compaction: null,   // eviction-based context management has no structured summary to show
    compactionTs: null, // same reason — lastCompactedAt is in-memory only on Agent, never persisted
  })
})

app.post('/stop', (_req, res) => {
  agent.abort()
  // agent.abort() alone only reaches the shared module-level instance above —
  // every frame a dispatch run spawns is a separate Agent, so it needs its own
  // stop path (see dispatch.ts's abortDispatch). Harmless to call unconditionally:
  // a no-op when no dispatch run is in flight.
  abortDispatch()
  res.json({ ok: true })
})

// Reset session
app.post('/reset', (req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  agent.reset()
  currentSessionId = makeSessionId()
  agent.setSessionId(currentSessionId)
  // No separate "register an empty session" call any more — the ledger's registry
  // (ledger.ts's registerFrame, called from dispatch.ts) only gains a session
  // entry once that session's first frame actually spawns; an id with no frames
  // yet simply isn't listed by GET /logs until then, same as the old registry's
  // own registerSession existed only to cover that same brief gap.
  writeSessionPointer(currentSessionId)
  res.json({ ok: true })
})

// List available Ollama models
app.get('/models', async (req, res) => {
  try {
    const resp = await fetch(`${config.ollamaHost}/api/tags`)
    const data = await resp.json() as { models?: { name: string }[] }
    res.json(data.models?.map(m => m.name) ?? [])
  } catch {
    res.json([config.model])
  }
})

// Git log for workspace. Additive: `relative` (%cr, e.g. "3 hours ago") alongside the
// existing fields, for the Changes view's commit list — existing callers reading
// hash/short/message/date/author are unaffected.
app.get('/git-log', async (req, res) => {
  try {
    // Record-separated (\x1e per commit) + field-separated (\x1f) so the body (%b) can
    // contain newlines safely. `message` stays the SUBJECT (%s) for existing callers;
    // `body` (%b) is added so the Changes-view History can show the full message on expand.
    const { stdout } = await execAsync(
      'git log --format="%H%x1f%h%x1f%s%x1f%b%x1f%ai%x1f%an%x1f%cr%x1e" -30 2>/dev/null || echo ""',
      { cwd: config.workspacePath }
    )
    const commits = stdout.split('\x1e').map(r => r.replace(/^\n/, '')).filter(r => r.trim()).map(rec => {
      const [hash, short, message, body, date, author, relative] = rec.split('\x1f')
      return { hash, short, message, body: (body || '').trim(), date, author, relative }
    })
    res.json(commits)
  } catch {
    res.json([])
  }
})

// Git op path arguments come from the client (?path=) — confine them to the workspace
// root (config.workspacePath, the git repo root; NOT browseRoot(), which is '/' inside
// the container) and reject traversal. Returns a path relative to that root (safe to
// hand straight to a git command run with cwd: config.workspacePath), or null if it's
// missing/would escape the root.
function resolveWorkspaceRelPath(rawPath: unknown): string | null {
  const root = config.workspacePath
  if (!root) return null
  const rel = ((rawPath as string) ?? '').replace(/\.\./g, '').replace(/^\/+/, '')
  if (!rel) return null
  const abs = path.join(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) return null
  return rel
}

// exec() runs through a shell, so a path pulled from the client must never be
// interpolated unescaped into the command string — single-quote it, escaping any
// embedded single quotes. (git hashes are validated against a fixed charset instead,
// same as the existing /git-diff/:hash route, so they don't need this.)
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// Git diff for a specific commit — whole-commit (unchanged, existing callers), or, with
// ?path=<file>, just that one file's diff within the commit (Changes view: clicking a
// file under a commit).
app.get('/git-diff/:hash', async (req, res) => {
  const { hash } = req.params
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) { res.status(400).send('Invalid hash'); return }
  let rel: string | null = null
  if (req.query.path != null) {
    rel = resolveWorkspaceRelPath(req.query.path)
    if (rel === null) { res.status(400).send('Invalid path'); return }
  }
  try {
    const { stdout } = await execAsync(
      rel != null
        ? `git show ${hash} -- ${shQuote(rel)} 2>/dev/null`
        : `git show ${hash} --stat --patch 2>/dev/null`,
      { cwd: config.workspacePath }
    )
    res.type('text/plain').send(stdout.slice(0, 50_000))
  } catch {
    res.status(404).send('Not found')
  }
})

// Files changed in a specific commit — {status, path} pairs (status: A/M/D/R/C…),
// for the Changes view's per-commit file list.
app.get('/commit-files/:hash', async (req, res) => {
  const { hash } = req.params
  if (!/^[0-9a-f]{4,64}$/i.test(hash)) { res.status(400).send('Invalid hash'); return }
  try {
    const { stdout } = await execAsync(
      `git show --name-status --format= ${hash} 2>/dev/null`,
      { cwd: config.workspacePath }
    )
    const files = stdout.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t')
      // Renames/copies are "R100\told-path\tnew-path" — collapse the score to a plain
      // letter and report the new path; everything else is "M\tpath" (one path).
      const status = parts[0][0]
      const filePath = parts[parts.length - 1]
      return { status, path: filePath }
    })
    res.json(files)
  } catch {
    res.status(404).json([])
  }
})

// Uncommitted working-tree changes (staged + unstaged + untracked) — the Changes
// view's live section, most relevant now that auto-commit defaults to off.
app.get('/git-status', async (req, res) => {
  try {
    const { stdout } = await execAsync('git status --porcelain 2>/dev/null', { cwd: config.workspacePath })
    const files = stdout.split('\n').filter(Boolean).map(line => {
      const code = line.slice(0, 2)
      let filePath = line.slice(3)
      // Renames show as "old -> new" (no -z here) — report the new path.
      const arrow = filePath.indexOf(' -> ')
      if (arrow !== -1) filePath = filePath.slice(arrow + 4)
      filePath = filePath.replace(/^"|"$/g, '')
      return { status: porcelainStatus(code), path: filePath }
    })
    res.json(files)
  } catch {
    res.json([])
  }
})

// Maps a `git status --porcelain` two-char code (index-status + worktree-status) to one
// simple letter: "??" (untracked) -> 'U'; otherwise the first non-space side (index
// takes priority over worktree, since a staged change is the more meaningful state).
function porcelainStatus(code: string): string {
  if (code === '??') return 'U'
  const [x, y] = code
  return (x !== ' ' ? x : y) || 'M'
}

// Working-tree diff for a single file — tracked changes via `git diff HEAD` (this also
// renders deletions correctly); an untracked file has nothing to diff against, so it's
// rendered directly as an all-added diff instead.
app.get('/git-diff-working', async (req, res) => {
  const rel = resolveWorkspaceRelPath(req.query.path)
  if (rel === null) { res.status(400).send('Invalid path'); return }
  try {
    const { stdout: statusOut } = await execAsync(
      `git status --porcelain -- ${shQuote(rel)} 2>/dev/null`,
      { cwd: config.workspacePath }
    )
    if (statusOut.startsWith('??')) {
      const abs = path.join(config.workspacePath, rel)
      const content = await fs.readFile(abs, 'utf-8').catch(() => '')
      const body = content.length ? content.split('\n').map(l => `+${l}`).join('\n') : ''
      const diff = `--- /dev/null\n+++ b/${rel}\n${body}`
      res.type('text/plain').send(diff.slice(0, 50_000))
      return
    }
    const { stdout } = await execAsync(`git diff HEAD -- ${shQuote(rel)} 2>/dev/null`, { cwd: config.workspacePath })
    res.type('text/plain').send(stdout.slice(0, 50_000))
  } catch {
    res.status(404).send('Not found')
  }
})

// Health / status
app.get('/status', (req, res) => {
  res.json({
    busy: isBusy,
    // Fine-grained run phase (agent.ts's Agent#getPhase) — lets central's
    // /api/workspaces aggregate a real ready/running/compacting/error status for
    // the home screen's status dot, rather than just busy/idle.
    phase: agent.getPhase(),
    model: config.model,
    sessionId: currentSessionId,
    workspacePath: config.workspacePath || null,
    env: envStatus,
    // Set once at startup by the resume-vs-fresh decision (workspace-identity.ts) —
    // null in standalone dev mode before a workspace is mounted. A future UI change
    // reads this to show e.g. "started a fresh session: this folder's previous
    // session belonged to different content" instead of silently discarding the old
    // objective from view with no explanation.
    startupSession: startupSessionInfo,
    // Effective compaction trigger is near-full: fires when only compactReserveTokens of
    // headroom remain (agent.ts), NOT at the old 2/3 fraction. Report the effective
    // fraction (from the default num_ctx) so the donut's threshold tick is correct; the
    // UI can refine it from the run's live num_ctx (see /context) + compactReserveTokens.
    compactThreshold: (65536 - config.compactReserveTokens) / 65536,
    compactReserveTokens: config.compactReserveTokens,
    autoCommit: config.autoCommit,
  })
})

// Mount a workspace folder — standalone dev mode only (worker mode always
// has a fixed /workspace mount, set at container creation).
app.post('/api/workspace', express.json(), async (req, res) => {
  if (config.inContainer) { res.status(403).json({ error: 'Workspace is fixed in worker mode' }); return }
  const { path: wsPath } = req.body as { path?: string }
  if (!wsPath) { res.status(400).json({ error: 'path required' }); return }

  const absPath = path.resolve(wsPath)
  try {
    const stat = await fs.stat(absPath)
    if (!stat.isDirectory()) { res.status(400).json({ error: `Not a directory: ${absPath}` }); return }
  } catch {
    res.status(400).json({ error: `Path not found: ${absPath}` })
    return
  }

  config.workspacePath = absPath
  res.json({ ok: true, workspacePath: absPath })
})

// ── Ledger-based session replay ─────────────────────────────────
// Reconstructs AgentEvent[] for GET /logs directly from .argo/frames/*.jsonl,
// since nothing writes the old per-run JSONL log files any more (see this
// route's own comment below). Not a perfect replay — approximate iteration
// boundaries and tool args parsed back out of the formatted call text — but
// enough to restore the conversation, agent traces, and tool calls after a
// page refresh, which is all the UI actually needs (see app.js's
// replaySessionRuns/handleEventForSession, the consumers).

// A tool call's args aren't stored on the ASSISTANT ledger entry (only
// toolName is — see agent.ts's pushCtx call sites) but they ARE embedded in
// its formatted content (formatToolCallContent's `<tool_call>{...}</tool_call>`
// JSON), which is the only place to recover them from for replay.
function parseToolCallArgs(content: string): Record<string, unknown> {
  const m = content.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/)
  if (!m) return {}
  try {
    const parsed = JSON.parse(m[1]) as { arguments?: unknown }
    return (parsed.arguments && typeof parsed.arguments === 'object') ? parsed.arguments as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

// Splits ONE frame's full message log into per-chat()-call segments. Every
// non-resumed chat() call pushes a fresh [system] identity message carrying
// `model` (agent.ts's chat(), the `if (!resume)` branch) — for an ephemeral
// (one-shot) frame there is exactly one such message and one segment; for a
// PERSISTENT frame (the Dispatcher, reused across a whole session's runs —
// see dispatch.ts's dispatcherFrameId) spawnFrame never passes `resume: true`,
// so each of the session's runs appends its own fresh identity message,
// making segment N of the Dispatcher's ledger line up with session.runs[N].
function splitIntoSegments(messages: LedgerMessage[]): LedgerMessage[][] {
  const segments: LedgerMessage[][] = []
  let current: LedgerMessage[] = []
  for (const m of messages) {
    if (m.role === 'system' && m.model) {
      if (current.length) segments.push(current)
      current = [m]
    } else {
      current.push(m)
    }
  }
  if (current.length) segments.push(current)
  return segments
}

// Reconstructs one frame's own tagged AgentEvents from its (segment of)
// ledger messages — see the mapping this follows in the task's own doc
// comment above GET /logs. Iteration boundaries are approximate: a new
// iteration is only detected at the first assistant entry following a
// non-assistant one, so a turn that calls several tools with no visible
// thought text between them is undercountable from the ledger alone (no
// per-iteration marker survives for it) — acceptable for a replay whose job
// is showing the conversation happened, not exact iteration accounting.
function reconstructFrameEvents(
  messages: LedgerMessage[],
  frameId: string,
  role: Role,
  parentFrameId: string | null,
  implementerIndex?: number,
): AgentEvent[] {
  const events: AgentEvent[] = []
  let seq = 0
  const tag = (e: AgentEvent) => {
    seq++
    return {
      ...e, __frameId: frameId, __role: role, __parentFrameId: parentFrameId, __seq: seq,
      ...(implementerIndex !== undefined ? { __implementerIndex: implementerIndex } : {}),
    } as unknown as AgentEvent
  }
  let iteration = 0
  let inGroup = false
  let concludeArgs: Record<string, unknown> | null = null
  for (const m of messages) {
    if (m.role === 'system') {
      inGroup = false
      if (m.model) {
        iteration = 0
        events.push(tag({ type: 'start', model: m.model, query: '', options: m.modelOptions ?? {} }))
      }
      continue
    }
    if (m.role === 'user') {
      inGroup = false
      continue // this frame's own assignment text — handleFrameEvent swallows tagged 'message' events (see its own comment); the top-level run message is emitted separately by reconstructSessionEvents
    }
    if (m.role === 'assistant') {
      if (!inGroup) {
        iteration++
        events.push(tag({ type: 'iteration', current: iteration, max: ROLE_MAX_ITERATIONS[role] }))
        inGroup = true
      }
      if (m.toolName) {
        const args = parseToolCallArgs(m.content)
        events.push(tag({ type: 'tool_call', tool: m.toolName as ToolName, args }))
        if (m.toolName === 'conclude') concludeArgs = args
      } else if (m.content || m.thinking) {
        events.push(tag({ type: 'thought', content: m.content || undefined, thinking: m.thinking }))
      }
      continue
    }
    if (m.role === 'tool') {
      if (m.toolName) {
        events.push(tag({
          type: 'tool_result',
          tool: m.toolName as ToolName,
          output: m.error ? '' : m.content,
          error: m.error ? m.content : undefined,
          duration_ms: m.durationMs ?? 0,
        }))
      } else if (m.content && m.content !== 'Concluded.') {
        // e.g. dispatch.ts's recordConclusionToParent "[Role concluded]\n..."
        // report — no toolName, so it isn't a tool_result, but still worth
        // surfacing as a text item in this frame's own card.
        events.push(tag({ type: 'thought', content: m.content }))
      }
      continue
    }
  }
  // 'done': only for a frame that actually concluded. Prefer the CLEAN full
  // answer dispatch.ts's recordCleanAnswer appends right after 'Concluded.'
  // for a persistent frame (untruncated) over the conclude call's own
  // formatted args.message (agent.ts's formatToolCallContent truncates past
  // 200 chars).
  const concludeIdx = messages.findIndex(m => m.role === 'tool' && !m.toolName && m.content === 'Concluded.')
  if (concludeIdx !== -1) {
    const clean = messages[concludeIdx + 1]
    const cleanAnswer = (clean && clean.role === 'assistant' && !clean.toolName) ? clean.content : null
    const answer = cleanAnswer ?? (typeof concludeArgs?.message === 'string' ? concludeArgs.message : '')
    if (answer) events.push(tag({ type: 'done', content: answer }))
  }
  return events
}

export interface ReconstructedRun {
  startedAt: string
  filename: string
  model?: string
  options?: ModelOptions
  events: AgentEvent[]
}

// Reconstructs every run of ONE session from the ledger — see GET /logs'
// own comment for why this exists. The session's PERSISTENT top frame (the
// Dispatcher — the one registered frame with parentFrameId === null; see
// dispatch.ts's dispatcherFrameId) spans every run in ONE ledger file, split
// back into per-run segments by splitIntoSegments; every other frame
// registered under a given run belongs wholly to that run (one-shot Planner/
// Implementer instances — see dispatch.ts's spawnFrame).
export async function reconstructSessionEvents(root: string, session: SessionRegistry['sessions'][number]): Promise<ReconstructedRun[]> {
  const allFrames = new Map<string, { role: Role; parentFrameId: string | null; implementerIndex?: number }>()
  for (const run of session.runs) {
    for (const f of run.frames) {
      if (!allFrames.has(f.frameId)) allFrames.set(f.frameId, { role: f.role, parentFrameId: f.parentFrameId, implementerIndex: f.implementerIndex })
    }
  }
  const topEntry = [...allFrames.entries()].find(([, f]) => f.parentFrameId === null)
  const topFrameId = topEntry?.[0] ?? null
  const topFrameMeta = topEntry?.[1] ?? null
  const topSegments = topFrameId ? splitIntoSegments(await ledger.readFrame(root, topFrameId)) : []

  const runs: ReconstructedRun[] = []
  for (let i = 0; i < session.runs.length; i++) {
    const registryRun = session.runs[i]
    const events: AgentEvent[] = []
    let model: string | undefined
    let options: ModelOptions | undefined
    let finalAnswer = ''

    const topSeg = topSegments[i]
    if (topSeg && topFrameId && topFrameMeta) {
      const identity = topSeg.find(m => m.role === 'system' && m.model)
      model = identity?.model
      options = identity?.modelOptions
      const query = topSeg.find(m => m.role === 'user')?.content ?? ''
      const frameEvents = reconstructFrameEvents(topSeg, topFrameId, topFrameMeta.role, topFrameMeta.parentFrameId, topFrameMeta.implementerIndex)
      const doneEvent = frameEvents.find((e): e is Extract<AgentEvent, { type: 'done' }> => e.type === 'done')
      finalAnswer = doneEvent?.content ?? ''
      if (query) events.push({ type: 'message', role: 'user', content: query })
      events.push({ type: 'start', model: model ?? '', query, options: options ?? {} })
      events.push(...frameEvents)
    }

    for (const f of registryRun.frames) {
      if (f.frameId === topFrameId) continue // already covered by topSeg above
      const msgs = await ledger.readFrame(root, f.frameId)
      events.push(...reconstructFrameEvents(msgs, f.frameId, f.role, f.parentFrameId, f.implementerIndex))
    }

    if (finalAnswer) {
      events.push({ type: 'message', role: 'assistant', content: finalAnswer })
      events.push({ type: 'done', content: finalAnswer })
    }

    runs.push({ startedAt: registryRun.startedAt, filename: `${session.id}-run${i}`, model, options, events })
  }
  return runs
}

// List all session logs, reconstructing each session's runs/events straight
// from the ledger (.argo/frames/*.jsonl + .argo/sessions.json) — see
// reconstructSessionEvents above. Nothing writes the old per-run JSONL log
// files any more, so there is no other source for this; app.js's
// replaySessionRuns already handles `run.events` inline (no separate
// GET /logs/:filename fetch needed for these).
app.get('/logs', async (req, res) => {
  const registry = await ledger.getRegistry(ledgerRoot())
  const sessions = await Promise.all(registry.sessions.map(async s => ({
    id: s.id,
    startedAt: s.runs[0]?.startedAt ?? s.id,
    runs: await reconstructSessionEvents(ledgerRoot(), s),
  })))
  res.json(sessions)
})

// Delete a single session's log files — both this session's own frame files
// under .argo/frames/ + its entry in .argo/sessions.json (ledger.deleteSession),
// and any legacy history-*.json left over from a pre-ledger session with this id.
app.delete('/logs/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId
  await Promise.all([
    ledger.deleteSession(ledgerRoot(), sessionId),
    fs.unlink(path.join(LOGS_DIR, `history-${sessionId}.json`)).catch(() => {}),
  ])
  res.json({ ok: true })
})

// Delete all logs and reset — clears .argo/frames/ and resets .argo/sessions.json
// (ledger.resetAllSessions), plus (backward compat) any legacy JSONL/history/
// registry/pointer files still under LOGS_DIR from before session tracking moved
// to the ledger.
app.delete('/logs', async (req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  await Promise.all([
    ledger.resetAllSessions(ledgerRoot()),
    fs.readdir(LOGS_DIR).then(files =>
      Promise.all(
        files
          .filter(f => f.endsWith('.jsonl') || f.startsWith('history') || f === 'current-session.txt' || f === 'sessions-registry.json')
          .map(f => fs.unlink(path.join(LOGS_DIR, f)).catch(() => {})),
      ),
    ).catch(() => {}),
  ])
  agent.reset()
  currentSessionId = makeSessionId()
  agent.setSessionId(currentSessionId)
  writeSessionPointer(currentSessionId)
  res.json({ ok: true })
})

// Resume a past session — switches the ledger's currentSessionId pointer. The
// persistent Dispatcher frame (dispatch.ts's dispatcherFrameId) loads its history
// from its own ledger file keyed on the session id, so there is no separate
// "load history into the shared agent" step needed any more (contrast the old
// history-<sessionId>.json / getSessionMessages fallback this replaces) — the
// shared module-level `agent` instance was never what a dispatch run's context
// came from anyway (see its own comment above). getChatHistory() on it is
// therefore always empty right after a switch; this is expected, not a fidelity
// loss, since /chat never runs a turn on that instance in the first place.
app.post('/resume/:sessionId', async (req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  currentSessionId = req.params.sessionId
  agent.setSessionId(currentSessionId)
  await writeSessionPointer(currentSessionId)
  res.json({ ok: true, count: agent.getChatHistory().length })
})

// LEGACY. Get structured events from an old (pre-ledger) JSONL run-log file for
// replay (returns JSON event array). Nothing in this codebase writes a new
// `.jsonl` run log any more — this only ever serves a file that already existed
// on disk from before the migration to the ledger. A session recorded purely by
// the ledger has no `.jsonl` file at all, so GET /logs' own `runs` is always `[]`
// for it and this route is simply never called for it (see GET /logs' own
// comment) — replaying a NEW session's history from the ledger is Phase 2.
app.get('/logs/:filename', async (req, res) => {
  const filename = req.params.filename
  if (path.basename(filename) !== filename) { res.status(400).json({ error: 'Invalid filename' }); return }
  const events = await readLogEvents(filename)
  if (!events) {
    // Fallback: serve raw JSONL for legacy sessions without event structure
    try {
      const log = await readLog(filename)
      if (!log) { res.status(404).json({ error: 'Log not found' }); return }
      const lines = log.jsonl.trim().split('\n').filter(l => l.trim())
      const parsed: Array<Record<string, unknown>> = []
      for (const line of lines) {
        try { parsed.push(JSON.parse(line)) } catch {}
      }
      res.json({ events: parsed })
    } catch {
      res.status(404).json({ error: 'Log not found' })
    }
    return
  }
  res.json({ events })
})

// ── File browser ─────────────────────────────────────────────────
// A single tree rooted at the container's real filesystem (worker/production
// mode) or the mounted workspace directory (standalone dev mode, where there
// is no broader container to browse — see CLAUDE.md's filesystem-model
// notes). /workspace is the only directory the frontend treats specially
// (expanded and labeled by default); everything else is ordinary filesystem,
// listed one level at a time so browsing the real root never means eagerly
// walking the whole container up front.

interface FileEntry {
  name: string
  type: 'file' | 'dir'
  size?: number
}

// .argo is harness bookkeeping — the multi-agent ledger and scratch work, not a
// project deliverable — same treatment as .git.
const SKIP = new Set(['node_modules', '.git', '.argo'])
// Only excluded at the true filesystem root — virtual/pseudo filesystems with
// no meaningful content to browse (huge or synthetic on every read).
const ROOT_SKIP = new Set(['proc', 'sys', 'dev', 'run'])

function browseRoot(): string {
  return config.inContainer ? '/' : (config.workspacePath || '/')
}

// Both endpoints take the same ?path=, relative to browseRoot() (root itself
// if omitted), and confine resolution to that root the same way.
function resolveBrowsePath(root: string, rawPath: unknown): string {
  const rel = ((rawPath as string) ?? '').replace(/\.\./g, '').replace(/^\/+/, '')
  return path.join(root, rel)
}

async function listDir(absDir: string, isRoot: boolean): Promise<FileEntry[]> {
  let entries: Dirent[]
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true })
  } catch {
    return []
  }
  const result: FileEntry[] = []
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    if (isRoot && ROOT_SKIP.has(entry.name)) continue
    if (entry.isDirectory()) {
      result.push({ name: entry.name, type: 'dir' })
    } else {
      const stat = await fs.stat(path.join(absDir, entry.name)).catch(() => null)
      result.push({ name: entry.name, type: 'file', size: stat?.size })
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

// One directory level — ?path=relative/path (root itself if omitted)
app.get('/files', async (req, res) => {
  const root = browseRoot()
  const target = resolveBrowsePath(root, req.query.path)
  if (!target.startsWith(root)) { res.status(403).json([]); return }
  res.json(await listDir(target, target === root))
})

// Raw workspace bytes, path-based so relative resources (<link>/<img>/<script>)
// resolve — read-only, behind the same password gate as /file, binary-safe with
// correct Content-Type. Mirrors the /file security posture (confined to browseRoot).
app.use('/raw', express.static(browseRoot(), { index: false, dotfiles: 'allow', fallthrough: false }))

// File content — ?path=relative/path
app.get('/file', async (req, res) => {
  const root = browseRoot()
  const full = resolveBrowsePath(root, req.query.path)
  if (!full.startsWith(root)) { res.status(403).send('Forbidden'); return }
  try {
    const content = await fs.readFile(full, 'utf-8')
    res.type('text/plain').send(content.slice(0, 200_000))
  } catch {
    res.status(404).send('Not found')
  }
})

export async function startServer() {
  // Content identity of the mounted workspace (workspace-identity.ts). Null in
  // standalone dev mode before a folder is mounted (config.workspacePath === ''), or
  // if the workspace turns out to be unwritable — ensureWorkspaceId fails open rather
  // than blocking startup over a bookkeeping file.
  currentWorkspaceId = config.workspacePath ? await ensureWorkspaceId(config.workspacePath) : null

  // The current-session pointer now lives on the ledger's own registry, INSIDE
  // the mounted workspace (.argo/sessions.json's currentSessionId — see
  // writeSessionPointer's own comment above for why this makes the old
  // workspaceId-tagged pointer's mismatch case structurally impossible: the
  // registry travels with the workspace's content by construction, unlike the old
  // logs/current-session.txt file, which lived outside it). What's left to guard
  // against is the ledger's own equivalent of the reported bug: a `rm -rf *`
  // leaves .argo/ (dotfiles) behind, so a previously recorded sessionId can
  // survive even though the user emptied the folder's real content —
  // decideSessionResume's workspaceHasContent fallback still covers exactly that
  // case, treated the same way a legacy (workspaceId: null) pointer always was.
  const previousSessionId = config.workspacePath ? await ledger.getCurrentSession(config.workspacePath) : null
  const pointer = previousSessionId ? { sessionId: previousSessionId, workspaceId: null } : null

  if (!config.workspacePath) {
    // No workspace mounted yet at all (standalone dev mode before POST
    // /api/workspace) — there is no content to check identity against, so carry
    // over whatever pointer exists exactly as before this change.
    if (pointer) {
      currentSessionId = pointer.sessionId
    } else {
      await writeSessionPointer(currentSessionId)
    }
  } else {
    const hasContent = await workspaceHasContent(config.workspacePath)
    const decision = decideSessionResume(pointer, currentWorkspaceId, hasContent)
    if (decision.resume && pointer) {
      currentSessionId = pointer.sessionId
      console.log(`[session] Resuming session ${currentSessionId} (${decision.reason})`)
    } else {
      currentSessionId = makeSessionId()
      // Visible-on-purpose: a silent reset here would be the same class of defect as
      // the silent resume this fix removes. Nothing is deleted — the previous
      // session's frame ledger files stay on disk, reachable via GET /logs/
      // POST /resume/:sessionId — only the "current" pointer moves.
      console.log(`[session] Starting fresh session ${currentSessionId} — ${decision.reason}${previousSessionId ? ` (previous session ${previousSessionId} left on disk, still reachable via past sessions)` : ''}`)
    }
    startupSessionInfo = { resumed: decision.resume, reason: decision.reason, ...(previousSessionId ? { previousSessionId } : {}) }
    await writeSessionPointer(currentSessionId)
  }

  agent.setSessionId(currentSessionId)
  app.listen(config.port, () => {
    console.log(`Agent running at http://localhost:${config.port}`)
  })

  envStatus = await checkEnvironment()
  logEnvironment(config.workerMode ? 'worker' : 'standalone', envStatus)
}
