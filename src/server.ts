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
import { listLogs, readLog, listSessions, deleteAllLogs, deleteSession, getSessionMessages, registerSession, LOGS_DIR } from './logger.js'
import type { AgentEvent, ModelOptions } from './types.js'
import { checkEnvironment, logEnvironment, type EnvCheck } from './health.js'
import { installAuth } from './auth.js'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const bus = new EventEmitter()
bus.setMaxListeners(50)

app.use(cors())
app.use(express.json())

// Worker mode is only reachable through central's proxy, which is the one
// place the password gate needs to be enforced — see installAuth in central.ts.
if (!config.inContainer) installAuth(app)

// Static files only in standalone dev mode (not when proxied by central server)
if (!config.workerMode) {
  app.use(express.static(path.join(__dirname, '..', 'public')))
}

const agent = new Agent((event: AgentEvent) => {
  bus.emit('agent', event)
})

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

  const { message, model, options, maxIterations } = req.body as { message: string; model?: string; options?: ModelOptions; maxIterations?: number }
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

  isBusy = true
  res.json({ ok: true })

  try {
    await agent.chat(message)
  } finally {
    isBusy = false
  }
})

// Current chat history (user + assistant messages only, survives browser refresh)
app.get('/history', (req, res) => {
  res.json(agent.getChatHistory())
})

// Stop current agent run (soft abort — takes effect between iterations)
app.post('/stop', (_req, res) => {
  agent.abort()
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

// Git log for workspace
app.get('/git-log', async (req, res) => {
  try {
    const { stdout } = await execAsync(
      'git log --format="%H|%h|%s|%ai|%an" -30 2>/dev/null || echo ""',
      { cwd: config.workspacePath }
    )
    const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
      const [hash, short, message, date, author] = line.split('|')
      return { hash, short, message, date, author }
    })
    res.json(commits)
  } catch {
    res.json([])
  }
})

// Git diff for a specific commit
app.get('/git-diff/:hash', async (req, res) => {
  const { hash } = req.params
  if (!/^[0-9a-f]{4,64}$/.test(hash)) { res.status(400).send('Invalid hash'); return }
  try {
    const { stdout } = await execAsync(
      `git show ${hash} --stat --patch 2>/dev/null`,
      { cwd: config.workspacePath }
    )
    res.type('text/plain').send(stdout.slice(0, 50_000))
  } catch {
    res.status(404).send('Not found')
  }
})

// Health / status
app.get('/status', (req, res) => {
  res.json({
    busy: isBusy,
    model: config.model,
    sessionId: currentSessionId,
    workspacePath: config.workspacePath || null,
    env: envStatus,
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

// Get a specific log (jsonl or md)
app.get('/logs/:filename', async (req, res) => {
  const { filename } = req.params
  if (path.basename(filename) !== filename) { res.status(400).send('Invalid filename'); return }
  const format = (req.query.format as string) ?? 'md'
  const log = await readLog(filename)
  if (!log) { res.status(404).send('Not found'); return }
  if (format === 'jsonl') {
    res.type('text/plain').send(log.jsonl)
  } else {
    res.type('text/plain').send(log.md)
  }
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

const SKIP = new Set(['node_modules', '.git'])
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
