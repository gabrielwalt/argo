import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Server } from 'http'
import { app } from './server.js'
import { config } from './config.js'

// server.ts's Express app, listening on an ephemeral port — no startServer()
// (no history loading, no session bookkeeping needed for these route-level
// checks). installAuth(app) already ran at import time since config.inContainer
// is false in this environment, so every route below is really auth-gated,
// matching production behavior.
let baseUrl: string
let server: Server

before(async () => {
  config.workspacePath = process.cwd()
  server = app.listen(0)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => new Promise<void>(resolve => server.close(() => resolve())))

const authHeaders = () => ({ 'X-Argo-Password': config.password })

// ── auth.ts's requireAuth, exercised through the real app ─────────

test('a request with no credentials is not treated as authenticated', async () => {
  const resp = await fetch(`${baseUrl}/history`, { redirect: 'manual' })
  assert.notEqual(resp.status, 200)
})

test('the correct X-Argo-Password header is accepted', async () => {
  const resp = await fetch(`${baseUrl}/history`, { headers: authHeaders() })
  assert.equal(resp.status, 200)
})

test('an incorrect X-Argo-Password header is rejected', async () => {
  // redirect: 'manual' — otherwise fetch follows requireAuth's redirect to
  // /login and reports *that* page's 200, masking the actual gate decision.
  const resp = await fetch(`${baseUrl}/history`, { headers: { 'X-Argo-Password': 'definitely-wrong' }, redirect: 'manual' })
  assert.notEqual(resp.status, 200)
})

// ── /git-diff/:hash — the regex guard is the only thing standing between
// this route's `git show ${hash}` string interpolation (run via exec(), a
// real shell) and command injection. These tests exist so a future change
// that loosens or drops the guard fails a test instead of only ever
// surfacing as a real exploit.

test('GET /git-diff/:hash rejects a hash containing a shell command separator', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/${encodeURIComponent('abcd; touch pwned')}`, { headers: authHeaders() })
  assert.equal(resp.status, 400)
})

test('GET /git-diff/:hash rejects a hash containing command substitution', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/${encodeURIComponent('$(whoami)')}`, { headers: authHeaders() })
  assert.equal(resp.status, 400)
})

test('GET /git-diff/:hash rejects a hash with a redirect/pipe metacharacter', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/${encodeURIComponent('abcd|cat /etc/passwd')}`, { headers: authHeaders() })
  assert.equal(resp.status, 400)
})

test('GET /git-diff/:hash accepts a well-formed short hash (passes the format guard)', async () => {
  const resp = await fetch(`${baseUrl}/git-diff/abcd1234`, { headers: authHeaders() })
  // Not necessarily 200 — this hash may not exist in the repo at test time —
  // just confirms it wasn't rejected by the format guard itself.
  assert.notEqual(resp.status, 400)
})
