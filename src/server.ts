import express from 'express'
import cors from 'cors'
import { EventEmitter } from 'events'
import { exec } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'
import type { Dirent } from 'fs'
import { config } from './config.js'
import { Agent } from './agent.js'
import { listLogs, readLog, readLogEvents, listSessions, deleteAllLogs, deleteSession, getSessionMessages, registerSession, LOGS_DIR } from './logger.js'
import type { AgentEvent, ModelOptions, Role } from './types.js'
import { checkEnvironment, logEnvironment, type EnvCheck } from './health.js'
import { installAuth } from './auth.js'
import { runDispatchLoop, abortDispatch, listLiveFrames, getLiveFrame, getActiveFrameId, type LiveFrame } from './dispatch.js'
import { ensureWorkspaceId, workspaceHasContent, parseSessionPointer, formatSessionPointer, decideSessionResume, type SessionResumeReason } from './workspace-identity.js'
import { coerceCompactionState, emptyCompactionState, renderCompactionState, type CompactionState } from './compaction.js'

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
// role-scoped Agent instance it spawns (config.agents) — one SSE stream either way.
function emitEvent(event: AgentEvent, seq?: number) {
  bus.emit('agent', typeof seq === 'number' ? { ...event, __seq: seq } : event)
}

const agent = new Agent(emitEvent)

const SESSION_ID_FILE = path.join(LOGS_DIR, 'current-session.txt')

function makeSessionId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
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

// Every write site that used to persist a bare session id now persists it together
// with the workspace content id it was written under, so a later restart can tell
// whether the recorded session still belongs to this folder (decideSessionResume in
// workspace-identity.ts). Fire-and-forget, matching the previous bare-write sites.
function writeSessionPointer(sessionId: string): Promise<void> {
  return fs.writeFile(SESSION_ID_FILE, formatSessionPointer({ sessionId, workspaceId: currentWorkspaceId }), 'utf-8').catch(() => {})
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

  // Per-request harness toggles mirror `grounding`: env sets the default (config.*),
  // the UI/eval can override per run. Lets the A/B eval flip tasks/memory/loop on the
  // SAME worker (no rebuild) and lets the settings panel dogfood them live.
  const { message, model, options, maxIterations, grounding, tasks, memory, loop, autoCommit } = req.body as { message: string; model?: string; options?: ModelOptions; maxIterations?: number; grounding?: boolean; tasks?: boolean; memory?: boolean; loop?: boolean; autoCommit?: boolean }
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
  if (grounding != null) agent.setGrounding(grounding)
  if (tasks != null) agent.setTasks(tasks)
  if (memory != null) agent.setMemory(memory)
  if (loop != null) agent.setLoop(loop)
  if (autoCommit != null) agent.setAutoCommit(autoCommit)

  isBusy = true
  res.json({ ok: true })

  try {
    // MULTI-AGENT ARCHITECTURE (config.agents / ARGO_AGENTS, docs/subagents-plan.md):
    // the dispatch loop drives Planner/Implementer/Tester/Boss as scoped Agent
    // instances of its own, sharing this same emit path — `agent` (the baseline
    // single-loop instance above) is bypassed entirely while this flag is on, so its
    // /history, /context, /reset etc. reflect the baseline path only. Per-request
    // overrides (model/options/maxIterations/...) above still apply to `agent` even
    // when unused here, matching every other flag's existing pattern in this route.
    if (config.agents) {
      await runDispatchLoop(message, emitEvent, { model, options, sessionId: currentSessionId })
    } else {
      await agent.chat(message)
    }
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
// /shared/argo-ui/CONTEXT-VIEWER-CONTRACT.md is the authoritative shape for GET
// /frames and GET /context?frame=<id>. The root cause this exists for: GET /context
// below always read the baseline single-loop `agent`, which /chat bypasses entirely
// whenever config.agents is on (dispatch.ts's runDispatchLoop drives scoped Agent
// instances of its own instead) — so the real per-frame contexts were simply never
// reachable from the API. GET /context with no `frame` param keeps its pre-existing
// shape/meaning for backward compatibility — a deployed frontend against a new
// backend must keep working, since the two halves of this feature land separately.

const FRAME_ROLES: readonly Role[] = ['planner', 'implementer', 'tester', 'boss']

// frameId format is `${role}-${base36 timestamp}-${counter}` (ledger.ts's newId) —
// none of the four role names contain a hyphen, so the segment before the first
// hyphen is reliable. Returns null for anything else, in particular the baseline
// agent's own session ids (ISO-derived timestamps like `2026-09-04T07-03-37`, whose
// first segment is never one of these four words) — this is what lets the disk scan
// below tell a frame's history file apart from the baseline's own history-<id>.json.
export function parseFrameRole(frameId: string): Role | null {
  const cut = frameId.indexOf('-')
  const prefix = cut === -1 ? frameId : frameId.slice(0, cut)
  return (FRAME_ROLES as readonly string[]).includes(prefix) ? (prefix as Role) : null
}

const HISTORY_FILENAME_RE = /^history-(.+)\.json$/

// Extracts the id portion of a `history-<id>.json` filename, or null for anything
// else LOGS_DIR holds (the baseline's bare `history.json`, `.jsonl` run logs,
// `sessions-registry.json`, `current-session.txt`, `compaction-*.json`, ...).
export function frameIdFromHistoryFilename(filename: string): string | null {
  const m = HISTORY_FILENAME_RE.exec(filename)
  return m ? m[1] : null
}

// Mirrors agent.ts's getContext() MAX=4000 truncation exactly (contract: "the
// identical 4000-char message truncation on both paths"). Duplicated rather than
// imported/shared because agent.ts is out of scope for this change (dispatch.ts and
// server.ts only) — if that constant ever moves, this one needs updating alongside it.
const CONTEXT_MESSAGE_CHAR_CAP = 4000

function truncateContextMessage(full: string): { content: string; chars: number } {
  const chars = full.length
  const content = chars > CONTEXT_MESSAGE_CHAR_CAP
    ? `${full.slice(0, CONTEXT_MESSAGE_CHAR_CAP)}…(+${chars - CONTEXT_MESSAGE_CHAR_CAP} more chars)`
    : full
  return { content, chars }
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

// Mirrors agent.ts getContext()'s own "does this compaction state actually have
// anything to show" check exactly, so the disk-recovery path renders compaction
// identically to the live path instead of showing an empty-but-present state as if
// it were real content.
export function compactionHasContent(state: CompactionState): boolean {
  return !!state.projectCapsule || [
    state.userRequirements,
    state.verifiedFacts,
    state.decisionsMade,
    state.changesMade,
    state.testsAndVerification,
    state.openQuestions,
    state.hypotheses,
    state.failedAttempts,
    state.invalidatedConclusions,
  ].some(arr => Array.isArray(arr) && arr.length > 0)
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
// not already covered by the live registry. NOT scoped to the current session
// specifically — there is no persisted session→frameId index anywhere in this
// codebase (frameId encodes no session, and the workspace-side ledger has no
// sessionId field either), so this necessarily surfaces this WORKSPACE's frame
// history broadly rather than one session's. Accepted limitation, documented in
// FRAME-CONTEXT-BACKEND.md — the alternative (showing nothing for a resumed
// session after a restart) is worse for the "post-run inspection" this exists for.
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
    if (!role) continue // not a frame history file (e.g. the baseline's own history-<sessionId>.json)
    try {
      const raw = JSON.parse(await fs.readFile(path.join(LOGS_DIR, f), 'utf-8'))
      const { messageCount, totalChars } = buildDiskContextMessages(raw)
      out.push({ frameId, role, parentFrameId: null, live: false, startedAt: null, messageCount, totalChars, promptTokens: null, numCtx: null })
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
    // what "last known values... lets the donut follow a frame" means, and it is
    // deliberately NOT what GET /context's own (unchanged) numCtx field does below.
    promptTokens: f.lastTokenUsage?.promptTokens ?? null,
    numCtx: f.lastTokenUsage?.numCtx ?? ctx.numCtx,
  }
}

// Frames of the current process's most recent dispatch run, oldest first — see
// dispatch.ts's liveFrames registry comment for the retention policy (cleared at
// the START of the next run, not the end, so the last run stays inspectable).
app.get('/frames', async (req, res) => {
  const liveSummaries = listLiveFrames().map(liveFrameSummary)
  const diskOnly = await scanDiskFrames(new Set(liveSummaries.map(f => f.frameId)))
  res.json({
    baselineBypassed: config.agents,
    active: chooseActiveFrame(getActiveFrameId(), liveSummaries),
    frames: mergeFrameSummaries(liveSummaries, diskOnly),
  })
})

// GET /context — baseline agent by default; ?frame=<frameId> for a specific
// dispatch frame (live from its Agent instance, or reconstructed from disk).
app.get('/context', async (req, res) => {
  const frameId = typeof req.query.frame === 'string' ? req.query.frame : null
  if (frameId === null) {
    // Unchanged shape/meaning (backward compat: an old frontend against a new
    // backend keeps working) plus the three additive fields plus baselineBypassed.
    res.json({ ...agent.getContext(), frameId: null, role: null, live: false, baselineBypassed: config.agents })
    return
  }

  const live = getLiveFrame(frameId)
  if (live) {
    res.json({ ...live.agent.getContext(), frameId: live.frameId, role: live.role, live: true })
    return
  }

  // Disk recovery: the frame's Agent is gone (a prior run, or a process restart),
  // but LOGS_DIR/history-<frameId>.json survives exactly like a baseline session's
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
  let compaction: string | null = null
  try {
    const raw = JSON.parse(await fs.readFile(path.join(LOGS_DIR, `compaction-${frameId}.json`), 'utf-8'))
    const state = coerceCompactionState(raw, emptyCompactionState())
    if (compactionHasContent(state)) compaction = renderCompactionState(state)
  } catch {
    // No persisted compaction state for this frame — compaction stays null, not an error.
  }
  res.json({
    frameId,
    role: parseFrameRole(frameId),
    live: false,
    messages,
    messageCount,
    totalChars,
    numCtx: null,       // not persisted anywhere once the Agent instance is gone — never fabricated
    compaction,
    compactionTs: null, // same reason — lastCompactedAt is in-memory only on Agent, never persisted
  })
})

app.post('/stop', (_req, res) => {
  agent.abort()
  // MULTI-AGENT ARCHITECTURE (config.agents): agent.abort() alone only reaches the
  // shared baseline instance above — every frame a dispatch run spawns is a separate
  // Agent, so it needs its own stop path (see dispatch.ts's abortDispatch). Harmless to
  // call unconditionally: a no-op when no dispatch run is in flight.
  abortDispatch()
  res.json({ ok: true })
})

// Manually trigger compaction (only between turns — compaction only makes
// sense on settled history, not mid-run)
app.post('/compact-now', async (_req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  isBusy = true
  try {
    const result = await agent.compactNow()
    res.json(result)
  } finally {
    isBusy = false
  }
})

// Reset session
app.post('/reset', (req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  agent.reset()
  currentSessionId = makeSessionId()
  agent.setSessionId(currentSessionId)
  writeSessionPointer(currentSessionId)
  registerSession(currentSessionId).catch(() => {})
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
    // Harness feature flags (defaults; per-run overridable via the /chat body). Let the
    // settings UI reflect current state and the eval confirm what it's testing.
    grounding: config.grounding,
    tasks: config.tasks,
    memory: config.memory,
    loop: config.loopRecovery,
    // Dispatch-path flags (src/dispatch.ts, src/frames.ts, src/schema.ts). Unlike the four
    // above these are PROCESS-level, not per-run overridable via the /chat body, because
    // they are read inside the dispatch pipeline at frame-spawn time rather than set on an
    // Agent instance. They are reported here so an eval arm can be attributed from the
    // WORKER ITSELF instead of from ~/.config/argo/env — the env file has silently
    // diverged from code defaults three times, and 17 of 33 rows in the old eval ledger
    // were unattributable for exactly this reason. Adding a flag to the pipeline without
    // adding it here makes every run using it unverifiable after the fact.
    schemaControlPlane: config.schemaControlPlane,
    verbatimRequest: config.verbatimRequest,
    autoCommit: config.autoCommit,
    // MULTI-AGENT ARCHITECTURE (docs/subagents-plan.md). Lets the settings panel hide
    // controls that don't apply to the dispatch path (e.g. grounding isn't wired to
    // dispatch.ts's frames) instead of showing a toggle that would silently do nothing.
    agents: config.agents,
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

// List all session logs
app.get('/logs', async (req, res) => {
  const sessions = await listSessions()
  res.json(sessions)
})

// Delete a single session's log files
app.delete('/logs/:sessionId', async (req, res) => {
  await deleteSession(req.params.sessionId)
  res.json({ ok: true })
})

// Delete all logs and reset
app.delete('/logs', async (req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  await deleteAllLogs()
  agent.reset()
  currentSessionId = makeSessionId()
  agent.setSessionId(currentSessionId)
  writeSessionPointer(currentSessionId)
  res.json({ ok: true })
})

// Resume a past session
app.post('/resume/:sessionId', async (req, res) => {
  if (isBusy) { res.status(409).json({ error: 'Agent is busy' }); return }
  // Save current session history before switching
  await agent.saveHistory()
  // Switch session
  currentSessionId = req.params.sessionId
  agent.setSessionId(currentSessionId)
  writeSessionPointer(currentSessionId)
  // Load per-session history file if it exists (full fidelity with tool calls),
  // otherwise reconstruct from log events (user+assistant messages only)
  await agent.loadPersistedHistory()
  if (agent.getChatHistory().length === 0) {
    const messages = await getSessionMessages(req.params.sessionId)
    if (messages.length > 0) agent.loadHistory(messages)
  }
  res.json({ ok: true, count: agent.getChatHistory().length })
})

// Get structured events from a log file for replay (returns JSON event array)
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

// .argo (config.agents) is harness bookkeeping — the multi-agent ledger and scratch
// work, not a project deliverable — same treatment as .git.
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
  // Initialize session ID before loading history so historyFile points to the right file
  await fs.mkdir(path.dirname(SESSION_ID_FILE), { recursive: true })

  // Content identity of the mounted workspace (workspace-identity.ts). Null in
  // standalone dev mode before a folder is mounted (config.workspacePath === ''), or
  // if the workspace turns out to be unwritable — ensureWorkspaceId fails open rather
  // than blocking startup over a bookkeeping file.
  currentWorkspaceId = config.workspacePath ? await ensureWorkspaceId(config.workspacePath) : null

  let rawPointer = ''
  try {
    rawPointer = await fs.readFile(SESSION_ID_FILE, 'utf-8')
  } catch {
    // No pointer file yet — parseSessionPointer('') returns null below, handled the
    // same as any other "nothing recorded to resume" case.
  }
  const pointer = parseSessionPointer(rawPointer)

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
    // THE FIX: resume the persisted session only if it's provably this workspace's
    // — see decideSessionResume's own comment for the full reasoning, in particular
    // why a legacy pointer (no recorded workspace id, the state of every session
    // written before this change) falls back to a content check rather than an
    // unconditional resume OR an unconditional reset.
    const hasContent = await workspaceHasContent(config.workspacePath)
    const decision = decideSessionResume(pointer, currentWorkspaceId, hasContent)
    const previousSessionId = pointer?.sessionId
    if (decision.resume && pointer) {
      currentSessionId = pointer.sessionId
      console.log(`[session] Resuming session ${currentSessionId} (${decision.reason})`)
    } else {
      currentSessionId = makeSessionId()
      // Visible-on-purpose: a silent reset here would be the same class of defect as
      // the silent resume this fix removes. Nothing is deleted — the previous
      // session's run logs/history stay on disk, reachable via listSessions()/
      // POST /resume/:sessionId — only the "current" pointer moves.
      console.log(`[session] Starting fresh session ${currentSessionId} — ${decision.reason}${previousSessionId ? ` (previous session ${previousSessionId} left on disk, still reachable via past sessions)` : ''}`)
    }
    startupSessionInfo = { resumed: decision.resume, reason: decision.reason, ...(previousSessionId ? { previousSessionId } : {}) }
    await writeSessionPointer(currentSessionId)
  }

  agent.setSessionId(currentSessionId)
  await Promise.all([
    agent.loadPersistedHistory(),
    registerSession(currentSessionId),
  ])
  app.listen(config.port, () => {
    console.log(`Agent running at http://localhost:${config.port}`)
  })

  envStatus = await checkEnvironment()
  logEnvironment(config.workerMode ? 'worker' : 'standalone', envStatus)
}
