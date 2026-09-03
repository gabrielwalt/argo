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
import type { AgentEvent, ModelOptions } from './types.js'
import { checkEnvironment, logEnvironment, type EnvCheck } from './health.js'
import { installAuth } from './auth.js'
import { runDispatchLoop, abortDispatch } from './dispatch.js'

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
    isBusy = false
  }
})

// Current chat history (user + assistant messages only, survives browser refresh)
app.get('/history', (req, res) => {
  res.json(agent.getChatHistory())
})

app.get('/context', (req, res) => {
  res.json(agent.getContext())
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
  fs.writeFile(SESSION_ID_FILE, currentSessionId, 'utf-8').catch(() => {})
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
  fs.writeFile(SESSION_ID_FILE, currentSessionId, 'utf-8').catch(() => {})
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
  fs.writeFile(SESSION_ID_FILE, currentSessionId, 'utf-8').catch(() => {})
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
  try {
    currentSessionId = (await fs.readFile(SESSION_ID_FILE, 'utf-8')).trim()
  } catch {
    await fs.writeFile(SESSION_ID_FILE, currentSessionId, 'utf-8').catch(() => {})
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
