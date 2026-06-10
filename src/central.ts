import express from 'express'
import cors from 'cors'
import http from 'http'
import net from 'net'
import { exec, spawn } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import { promises as fs } from 'fs'
import { config } from './config.js'
import type { Request, Response } from 'express'

const execAsync = promisify(exec)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const AGENT_PROJECT_DIR = process.env.AGENT_PROJECT_DIR ?? path.resolve(__dirname, '..')
const PUBLIC_DIR        = path.join(AGENT_PROJECT_DIR, 'public')
const HOME              = process.env.HOME ?? '/tmp'
const CONFIG_DIR        = path.join(HOME, '.config', 'argo')
const SCRATCH_BASE      = path.join(HOME, '.local', 'share', 'argo', 'scratch')
const LOGS_BASE         = path.join(HOME, '.local', 'share', 'argo', 'logs')
const REGISTRY_FILE     = path.join(CONFIG_DIR, 'workspaces.json')
const GLOBAL_ENV_FILE   = path.join(CONFIG_DIR, 'env')
const AGENT_IMAGE       = process.env.AGENT_IMAGE ?? 'argo:latest'
const CONTAINER_PREFIX  = 'argo-'
const PORT_START        = 3101
const PORT_END          = 3199

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

async function startWorker(ws: WorkspaceEntry): Promise<string> {
  const scratchDir = path.join(SCRATCH_BASE, ws.name)
  const logsDir    = path.join(LOGS_BASE, ws.name)
  await fs.mkdir(scratchDir, { recursive: true })
  await fs.mkdir(logsDir,    { recursive: true })

  const envVars = await loadGlobalEnv()

  const args = [
    'run', '-d',
    '--name', `${CONTAINER_PREFIX}${ws.name}`,
    '--rm',
    '-p', `${ws.port}:3000`,
    '-v', `${ws.path}:/workspace`,
    '-v', `${scratchDir}:/scratch`,
    '-v', `${logsDir}:/app/logs`,
    '--add-host=host.docker.internal:host-gateway',
    '-e', 'RUNNING_IN_CONTAINER=1',
    '-e', 'WORKER_MODE=1',
    '-e', `OLLAMA_HOST=http://host.docker.internal:11434`,
  ]

  for (const [k, v] of Object.entries(envVars)) {
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

function proxyToWorker(req: Request, res: Response, port: number): void {
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
  // express.json() is NOT applied globally — it would consume req body before the proxy can pipe it.
  // Apply it only to the /api/* routes that actually need parsed bodies.
  app.use(express.static(PUBLIC_DIR, { index: false }))

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

  // List workspaces
  app.get('/api/workspaces', async (_req, res) => {
    const registry = await loadRegistry()
    const result = await Promise.all(registry.map(async ws => ({
      ...ws,
      running: await isContainerRunning(ws.name),
      url: `http://localhost:${config.port}/ws/${ws.name}/`,
    })))
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
        existing.containerId = await startWorker(existing)
        await waitForWorker(existing.port)
        await saveRegistry(registry)
      }
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
    await stopWorker(req.params.name)
    registry.splice(idx, 1)
    await saveRegistry(registry)
    res.json({ ok: true })
  })

  // Proxy everything else under /ws/:name/* to the worker
  app.use('/ws/:name', async (req, res) => {
    const registry = await loadRegistry()
    const ws = registry.find(w => w.name === req.params.name)
    if (!ws) { res.status(404).json({ error: 'Workspace not found' }); return }
    proxyToWorker(req, res, ws.port)
  })

  app.listen(config.port, () => {
    console.log(`Argo at http://localhost:${config.port}`)
  })
}
