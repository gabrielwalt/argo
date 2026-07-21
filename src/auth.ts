import crypto from 'crypto'
import express from 'express'
import type { Express, Request, Response, NextFunction } from 'express'
import { config } from './config.js'

const COOKIE_NAME = 'argo_auth'
const passwordHash = crypto.createHash('sha256').update(config.password).digest('hex')

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

function loginPage(error: string | undefined, next: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Argo — Sign in</title>
<style>
  :root { --bg:#090b12; --surface:#111520; --border:#1e2235; --text:#e2e4f0; --muted:#565e7a; --gold:#c9a227; --red:#ef4444; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  form { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 32px; width: 320px; text-align: center; }
  .logo { font-size: 32px; display: inline-block; transform: scaleX(-1); filter: sepia(1) saturate(4) hue-rotate(5deg) brightness(1.1); margin-bottom: 16px; }
  h1 { font-size: 16px; font-weight: 600; margin-bottom: 20px; }
  input { width: 100%; background: var(--bg); border: 1px solid var(--border); color: var(--text); padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; outline: none; }
  input:focus { border-color: rgba(201, 162, 39, .45); }
  button { width: 100%; background: var(--gold); color: var(--bg); border: none; border-radius: 6px; padding: 10px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .err { color: var(--red); font-size: 12px; margin-bottom: 12px; min-height: 16px; }
</style></head>
<body>
  <form method="POST" action="/login">
    <span class="logo">⛵</span>
    <h1>Argo</h1>
    <div class="err">${error ?? ''}</div>
    <input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</body></html>`
}

// Accepts either the browser session cookie (set by /login) or the
// X-Argo-Password header (used by bin/argo's own CLI calls to central).
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/login' || req.path.startsWith('/internal/')) { next(); return }

  const cookies = parseCookies(req.headers.cookie)
  if (cookies[COOKIE_NAME] === passwordHash) { next(); return }

  const headerPw = req.headers['x-argo-password']
  if (typeof headerPw === 'string' && crypto.createHash('sha256').update(headerPw).digest('hex') === passwordHash) {
    next()
    return
  }

  if (req.method === 'GET' && req.accepts('html')) {
    res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`)
    return
  }
  res.status(401).json({ error: 'Unauthorized' })
}

export function installAuth(app: Express): void {
  app.get('/login', (req, res) => {
    res.type('html').send(loginPage(undefined, typeof req.query.next === 'string' ? req.query.next : '/'))
  })
  // express.urlencoded() is scoped to this route only — applying it globally
  // would consume the request body before central's proxy can pipe it to workers.
  app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
    const { password, next } = req.body as { password?: string; next?: string }
    const dest = next && next.startsWith('/') ? next : '/'
    if (password && crypto.createHash('sha256').update(password).digest('hex') === passwordHash) {
      res.cookie(COOKIE_NAME, passwordHash, { httpOnly: true, sameSite: 'strict', maxAge: 365 * 24 * 60 * 60 * 1000 })
      res.redirect(dest)
      return
    }
    res.type('html').send(loginPage('Wrong password', dest))
  })
  app.use(requireAuth)
}
