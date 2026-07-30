import express from 'express'
import cors from 'cors'
import http from 'http'
import net from 'net'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'
import crypto from 'crypto'
import { config } from './config.js'
import { checkOllama, checkDocker, logEnvironment } from './health.js'
import { installAuth } from './auth.js'
import { tavilySearchWithKey } from './tools/web-search.js'
import type { Request, Response } from 'express'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const AGENT_PROJECT_DIR = process.env.AGENT_PROJECT_DIR ?? path.resolve(__dirname, '..')
const PUBLIC_DIR        = path.join(AGENT_PROJECT_DIR, 'public')
const HOME              = process.env.HOME ?? '/tmp'
const CONFIG_DIR        = path.join(HOME, '.config', 'argo')
const LOGS_BASE         = path.join(HOME, '.local', 'share', 'argo', 'logs')
const REGISTRY_FILE     = path.join(CONFIG_DIR, 'workspaces.json')
const HISTORY_FILE      = path.join(CONFIG_DIR, 'workspace-history.json')
const GLOBAL_ENV_FILE   = path.join(CONFIG_DIR, 'env')
const AGENT_IMAGE       = process.env.AGENT_IMAGE ?? 'argo:latest'
const CONTAINER_PREFIX  = 'argo-'
const PORT_START        = 3101
const PORT_END          = 3199

// Authorizes worker → central calls for tools that need secrets central holds
// (see startWorker below). Not a user-facing secret — its only power is
// "may invoke central's /internal/* proxy routes", something the agent's
// tools can already do anyway; it just keeps real credentials out of containers.
const internalToken = crypto.randomBytes(24).toString('hex')

// Env vars whose name looks secret-shaped never get injected into a worker
// container's environment — see startWorker.
const SECRET_KEY_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD)/i

interface WorkspaceEntry {
  name: string
  path: string
  port: number
  containerId?: string
}

// ── Registry ──────────────────────────────────────────────────────

async function loadRegistry(): Promise<WorkspaceEntry[]> {
  try {
    return JSON.parse(await fs.readFile(REGISTRY_FILE, 'utf-8'))
  } catch {
    return []
  }
}

async function saveRegistry(entries: WorkspaceEntry[]): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  const tmp = `${REGISTRY_FILE}.tmp`
  await fs.writeFile(tmp, JSON.stringify(entries, null, 2))
  await fs.rename(tmp, REGISTRY_FILE)
}

// ── Workspace history ─────────────────────────────────────────────

interface HistoryEntry { name: string; path: string; lastSeen: string }

async function loadHistory(): Promise<HistoryEntry[]> {
  try { return JSON.parse(await fs.readFile(HISTORY_FILE, 'utf-8')) } catch { return [] }
}

async function recordHistory(name: string, absPath: string): Promise<void> {
  const entries = await loadHistory()
  const idx = entries.findIndex(e => e.path === absPath)
  const entry: HistoryEntry = { name, path: absPath, lastSeen: new Date().toISOString() }
  if (idx >= 0) entries[idx] = entry; else entries.unshift(entry)
  const trimmed = entries.slice(0, 50)
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(HISTORY_FILE, JSON.stringify(trimmed, null, 2))
}

async function forgetHistory(absPath: string): Promise<void> {
  const entries = (await loadHistory()).filter(e => e.path !== absPath)
  await fs.writeFile(HISTORY_FILE, JSON.stringify(entries, null, 2))
}

// ── Global env ────────────────────────────────────────────────────

async function loadGlobalEnv(): Promise<Record<string, string>> {
  try {
    const result: Record<string, string> = {}
    for (const line of (await fs.readFile(GLOBAL_ENV_FILE, 'utf-8')).split('\n')) {
      const t = line.trim()
      if (!t || t.startsWith('#')) continue
      const eq = t.indexOf('=')
      if (eq < 0) continue
      const val = t.slice(eq + 1).trim()
      if (val) result[t.slice(0, eq).trim()] = val
    }
    return result
  } catch {
    return {}
  }
}

// ── Port management ───────────────────────────────────────────────

async function isPortFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => { srv.close(); resolve(true) })
    srv.listen(port, '127.0.0.1')
  })
}

async function findFreePort(): Promise<number> {
  for (let p = PORT_START; p <= PORT_END; p++) {
    if (await isPortFree(p)) return p
  }
  throw new Error('No free ports available in range')
}

// ── Docker management ─────────────────────────────────────────────

async function isContainerRunning(name: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `docker ps --filter name=^/${CONTAINER_PREFIX}${name}$ --format '{{.Names}}'`
    )
    return stdout.trim() === `${CONTAINER_PREFIX}${name}`
  } catch {
    return false
  }
}

// Home-screen status dot: ready / running / compacting / error / stopped. Talks
// to the worker directly on localhost (never through the password-gated proxy)
// with a short timeout so one slow/unreachable worker can't hang the whole list.
async function workspaceStatus(
  running: boolean,
  port: number
): Promise<'ready' | 'running' | 'compacting' | 'error' | 'stopped'> {
  if (!running) return 'stopped'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`, { signal: controller.signal })
    if (!res.ok) return 'running'
    const data = (await res.json()) as { busy?: boolean; phase?: string }
    if (data.phase === 'error') return 'error'
    if (data.phase === 'compacting') return 'compacting'
    if (data.busy === true || data.phase === 'running') return 'running'
    return 'ready'
  } catch {
    // Container is up but the worker didn't answer in time (still booting,
    // overloaded, or unreachable) — fall back to a status that doesn't imply
    // the workspace is unusable.
    return 'running'
  } finally {
    clearTimeout(timer)
  }
}

async function removeStaleContainer(name: string): Promise<void> {
  // `docker run --name` fails hard if that name is already held — even by a
  // stopped/exited container. Workers run with `--rm`, so a clean stop removes
  // them, but a daemon restart or a crashed start can orphan the name (observed
  // as "container name already in use" when re-attaching, e.g. argo-test-two).
  // With one worker per workspace, any pre-existing container of this name is
  // stale and we are about to start a fresh one, so force-remove it first.
  // `docker rm -f` on a missing name exits non-zero, which we ignore.
  try {
    await execAsync(`docker rm -f ${CONTAINER_PREFIX}${name}`)
  } catch { /* no such container — nothing to clean up */ }
}

async function startWorker(ws: WorkspaceEntry): Promise<string> {
  const logsDir = path.join(LOGS_BASE, ws.name)
  await fs.mkdir(logsDir, { recursive: true })
  // Guarantee our container name is free before `docker run --name` below.
  await removeStaleContainer(ws.name)

  const envVars = await loadGlobalEnv()

  const args = [
    'run', '-d',
    '--name', `${CONTAINER_PREFIX}${ws.name}`,
    '--rm',
    // Bound to localhost only — reachable exclusively through central's proxy,
    // which is the one place the password gate is enforced.
    '-p', `127.0.0.1:${ws.port}:3000`,
    // /workspace is the only special mount — the user's project, git-tracked
    // and auto-committed. Everything else in the container (including
    // /scratch, if the image still has one) is ordinary, ephemeral
    // filesystem that goes away with the container (--rm above) — nothing
    // outside /workspace needs its own host-persisted mount.
    '-v', `${ws.path}:/workspace`,
    '-v', `${logsDir}:/app/logs`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', 'RUNNING_IN_CONTAINER=1',
    '-e', 'WORKER_MODE=1',
    '-e', `OLLAMA_HOST=http://host.docker.internal:11434`,
    '-e', `ARGO_CENTRAL_URL=http://host.docker.internal:${config.port}`,
    '-e', `ARGO_INTERNAL_TOKEN=${internalToken}`,
  ]

  // Secret-shaped values (API keys, tokens, passwords) never enter the container's
  // env — the agent's bash tool would be able to read and exfiltrate them there.
  // Tools that need them (web_search) call back through /internal/* instead.
  for (const [k, v] of Object.entries(envVars)) {
    if (SECRET_KEY_PATTERN.test(k)) continue
    args.push('-e', `${k}=${v}`)
  }

  args.push(AGENT_IMAGE)

  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args)
    let out = '', err = ''
    proc.stdout.on('data', d => { out += d })
    proc.stderr.on('data', d => { err += d })
    proc.on('close', code => {
      if (code === 0) resolve(out.trim())
      else reject(new Error(err.trim() || `docker run failed (exit ${code})`))
    })
  })
}

async function stopWorker(name: string): Promise<void> {
  await new Promise<void>(resolve => {
    const proc = spawn('docker', ['stop', `${CONTAINER_PREFIX}${name}`])
    proc.on('close', () => resolve())
  })
}

async function waitForWorker(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/status`)
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('Worker did not become ready in time')
}

// ── Name sanitization ─────────────────────────────────────────────

function sanitizeName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'workspace'
}

// Derive a unique, human-readable workspace name from an absolute path.
// Uses the minimum number of trailing path segments needed to avoid collisions.
// E.g. two folders both named "website" become "project-a-website" and "project-b-website"
// rather than "website" and "website-1".
function deriveUniqueName(absPath: string, taken: Set<string>): string {
  const parts = absPath.split(path.sep).filter(Boolean)
  for (let depth = 1; depth <= parts.length; depth++) {
    const candidate = sanitizeName(parts.slice(-depth).join('-'))
    if (!taken.has(candidate)) return candidate
  }
  // Absolute fallback: short hash of the full path
  const hash = [...absPath].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0).toString(36)
  return sanitizeName(parts[parts.length - 1] + '-' + hash)
}

// ── HTTP proxy ────────────────────────────────────────────────────

// Hop-by-hop headers must not be forwarded by proxies (RFC 2616)
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate'])

export function proxyToWorker(req: Request, res: Response, port: number): void {
  // Strip hop-by-hop headers; disable compression so we can pipe raw bytes
  const fwdHeaders: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) fwdHeaders[k] = v
  }

  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port,
    path: req.url || '/',
    method: req.method,
    headers: { ...fwdHeaders, host: `127.0.0.1:${port}`, 'accept-encoding': 'identity' },
  }

  const proxy = http.request(options, proxyRes => {
    // Strip hop-by-hop headers from the response too (avoid double-chunking)
    const resHeaders: Record<string, string | string[] | undefined> = {}
    for (const [k, v] of Object.entries(proxyRes.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) resHeaders[k] = v
    }
    res.writeHead(proxyRes.statusCode ?? 502, resHeaders)
    res.flushHeaders()   // send 200 + SSE headers to browser immediately
    proxyRes.pipe(res, { end: true })
  })

  proxy.on('error', () => {
    if (!res.headersSent) res.status(502).json({ error: 'Worker not responding' })
  })

  // Only pipe req when there's actually a body to forward.
  // Don't pipe for bodyless requests: req may have already emitted 'end' (we awaited
  // loadRegistry above), and piping an already-ended stream never calls proxy.end(),
  // causing the worker to hang waiting for the request body.
  const contentLength = parseInt(req.headers['content-length'] ?? '0', 10)
  const hasBody = contentLength > 0 || req.headers['transfer-encoding'] === 'chunked'
  if (hasBody) {
    req.pipe(proxy, { end: true })
  } else {
    proxy.end()
  }
}

// ── Express app ───────────────────────────────────────────────────

export function startCentral(): void {
  const app = express()
  app.set('strict routing', true)   // /ws/:name ≠ /ws/:name/ — prevents redirect loops
  app.use(cors())
  installAuth(app)
  // express.json() is NOT applied globally — it would consume req body before the proxy can pipe it.
  // Apply it only to the /api/* routes that actually need parsed bodies.
  app.use(express.static(PUBLIC_DIR, {
    index: false,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }))

  // Workspace list page
  app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'workspaces.html')))

  // Redirect /ws/:name → /ws/:name/
  app.get('/ws/:name', (req, res) => res.redirect(`/ws/${req.params.name}/`))

  // Workspace UI — inject window.__WS__ so app.js knows its API prefix
  app.get('/ws/:name/', async (req, res) => {
    try {
      let html = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf-8')
      html = html.replace(
        '</head>',
        `  <script>window.__WS__=${JSON.stringify(req.params.name)}</script>\n</head>`
      )
      res.type('html').send(html)
    } catch {
      res.status(500).send('UI unavailable')
    }
  })

  // Shadow proxy: workers call this instead of holding the Tavily key themselves.
  // Guarded by internalToken, not the user password — see comment at its definition.
  app.post('/internal/web-search', express.json(), async (req, res) => {
    if (req.headers['x-argo-internal-token'] !== internalToken) {
      res.status(403).json({ error: 'Forbidden' })
      return
    }
    const { query, maxResults } = req.body as { query?: string; maxResults?: number }
    if (!query) { res.status(400).json({ error: 'query required' }); return }

    const envVars = await loadGlobalEnv()
    if (!envVars.TAVILY_API_KEY) { res.json({ output: '', error: 'not_configured' }); return }
    res.json(await tavilySearchWithKey(envVars.TAVILY_API_KEY, query, maxResults ?? 5))
  })

  // List workspaces
  app.get('/api/workspaces', async (_req, res) => {
    const registry = await loadRegistry()
    const result = await Promise.all(registry.map(async ws => {
      const running = await isContainerRunning(ws.name)
      return {
        ...ws,
        running,
        status: await workspaceStatus(running, ws.port),
        url: `http://localhost:${config.port}/ws/${ws.name}/`,
      }
    }))
    res.json(result)
  })

  // Attach workspace
  app.post('/api/attach', express.json(), async (req, res) => {
    const { path: wsPath } = req.body as { path?: string }
    if (!wsPath) { res.status(400).json({ error: 'path required' }); return }

    const absPath = path.resolve(wsPath)
    try { await fs.access(absPath) } catch {
      res.status(400).json({ error: `Path not found: ${absPath}` })
      return
    }

    const registry = await loadRegistry()

    // Already attached with same path?
    const existing = registry.find(w => w.path === absPath)
    if (existing) {
      if (!(await isContainerRunning(existing.name))) {
        // The registry's stored port can be stale (e.g. left over from a crash,
        // or — as observed — collided with another entry's port). Re-verify it's
        // actually free before trying to bind it again, rather than letting
        // `docker run` fail and, previously, crash the whole central process.
        if (!(await isPortFree(existing.port))) {
          existing.port = await findFreePort()
        }
        try {
          existing.containerId = await startWorker(existing)
          await waitForWorker(existing.port)
          await saveRegistry(registry)
        } catch (err) {
          res.status(500).json({ error: String(err) })
          return
        }
      }
      await recordHistory(existing.name, absPath)
      res.json({ name: existing.name, url: `http://localhost:${config.port}/ws/${existing.name}/` })
      return
    }

    // Derive a name that's unique and informative — uses parent path segments to disambiguate
    const taken = new Set(registry.map(w => w.name))
    const name = deriveUniqueName(absPath, taken)

    const port = await findFreePort()
    const ws: WorkspaceEntry = { name, path: absPath, port }

    try {
      ws.containerId = await startWorker(ws)
      await waitForWorker(port)
      registry.push(ws)
      await saveRegistry(registry)
      await recordHistory(name, absPath)
      res.json({ name, url: `http://localhost:${config.port}/ws/${name}/` })
    } catch (err) {
      res.status(500).json({ error: String(err) })
    }
  })

  // Detach workspace
  app.post('/api/detach/:name', express.json(), async (req, res) => {
    const registry = await loadRegistry()
    const idx = registry.findIndex(w => w.name === req.params.name)
    if (idx < 0) { res.status(404).json({ error: 'Not found' }); return }
    const { name } = req.params
    await stopWorker(name)
    registry.splice(idx, 1)
    await saveRegistry(registry)
    // Detach stops and forgets the *registry entry* — it must not also destroy the
    // run history. `argo stop` detaches every workspace to pause the whole system,
    // not to make anyone forget it; logs are the project's own stated audit trail
    // ("every run is logged... a core architectural guarantee") and are cheap to
    // keep. Intentional history deletion already has its own path: the per-session
    // "Clear" action in the UI. Re-attaching the same path later reuses the same
    // logsDir (see startWorker), so nothing here needs the directory pre-cleared.
    res.json({ ok: true })
  })

  // Recent workspace history (paths not currently active)
  app.get('/api/history', async (_req, res) => {
    const [history, registry] = await Promise.all([loadHistory(), loadRegistry()])
    const activePaths = new Set(registry.map(w => w.path))
    res.json(history.filter(e => !activePaths.has(e.path)))
  })

  // Remove a path from history
  app.post('/api/forget', express.json(), async (req, res) => {
    const { path: wsPath } = req.body as { path?: string }
    if (!wsPath) { res.status(400).json({ error: 'path required' }); return }
    await forgetHistory(path.resolve(wsPath))
    res.json({ ok: true })
  })

  // Proxy everything else under /ws/:name/* to the worker
  app.use('/ws/:name', async (req, res) => {
    const registry = await loadRegistry()
    const ws = registry.find(w => w.name === req.params.name)
    if (!ws) { res.status(404).json({ error: 'Workspace not found' }); return }
    proxyToWorker(req, res, ws.port)
  })

  const server = app.listen(config.port, () => {
    console.log(`Argo at http://localhost:${config.port}`)
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Argo is already running on port ${config.port}`)
      process.exit(1)
    }
    throw err
  })

  Promise.all([checkOllama(), checkDocker()]).then(([ollama, docker]) => {
    logEnvironment('central', { ollama, docker })
  })
}
