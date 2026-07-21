import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import type { Server } from 'http'
import express from 'express'
import { proxyToWorker } from './central.js'

// Coverage for proxyToWorker(), central's HTTP proxy — the exact mechanism
// behind two real, silent-hang bugs documented in CLAUDE.md's "Common
// debugging" ("SSE Connecting… forever through the proxy"): (1) piping a
// bodyless GET's request stream instead of calling proxy.end() directly
// could leave the worker waiting for a body that never arrives; (2) missing
// 'accept-encoding: identity' let the worker gzip-encode SSE responses that
// were being piped through raw. Neither produces an error or a stack trace —
// just a request that never resolves, which is exactly the kind of failure
// a test suite should catch instead of a user staring at a stuck UI.
//
// Caveat verified while writing this: reintroducing the old unconditional
// req.pipe(proxy, {end:true}) (no hasBody branch) and rerunning the bodyless-
// GET test below did NOT reproduce a hang on Node 22 — a minimal repro
// showed req.readableEnded is still false when proxyToWorker runs even after
// an async gap, since nothing had started consuming the stream yet, so
// pipe() still drains it correctly. The hasBody branch is still the
// objectively correct HTTP semantic (never attempt to forward a body for a
// request that has none) and worth keeping, but these tests should be read
// as coverage that GET/POST/SSE forwarding behaves correctly today, not as
// proof they'd catch a regression of that exact historical race.

let workerServer: Server
let workerPort: number
let proxyServer: Server
let proxyBaseUrl: string

before(async () => {
  // Stub "worker" — stands in for the per-workspace container's own server.
  workerServer = http.createServer((req, res) => {
    if (req.url === '/sse') {
      // The worker flushes its own headers immediately (Node buffers a
      // server's headers until the first write() otherwise) so central
      // receives them right away; both body writes are delayed so a chunk
      // written immediately can't flush headers to the real client on its
      // own merit, which would mask whether central's own flushHeaders()
      // call (in proxyToWorker) actually matters.
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
      res.flushHeaders()
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ chunk: 1, acceptEncoding: req.headers['accept-encoding'] })}\n\n`)
      }, 30)
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ chunk: 2 })}\n\n`)
        res.end()
      }, 60)
      return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ received: body }))
      })
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('worker-get-ok')
  })
  await new Promise<void>(resolve => workerServer.listen(0, resolve))
  const workerAddr = workerServer.address()
  workerPort = typeof workerAddr === 'object' && workerAddr ? workerAddr.port : 0

  // Wraps proxyToWorker exactly the way central.ts's real routes do: an
  // await happens first (loadRegistry() in production) before the request is
  // ever touched, which is what makes the bodyless-GET bug reproducible —
  // without this gap, req may not yet have emitted 'end' and the bug
  // wouldn't show up.
  const proxyApp = express()
  proxyApp.all(/.*/, async (req, res) => {
    await new Promise(resolve => setTimeout(resolve, 5))
    proxyToWorker(req, res, workerPort)
  })
  proxyServer = proxyApp.listen(0)
  await new Promise<void>(resolve => proxyServer.once('listening', resolve))
  const proxyAddr = proxyServer.address()
  const proxyPort = typeof proxyAddr === 'object' && proxyAddr ? proxyAddr.port : 0
  proxyBaseUrl = `http://127.0.0.1:${proxyPort}`
})

after(() => Promise.all([
  new Promise<void>(resolve => workerServer.close(() => resolve())),
  new Promise<void>(resolve => proxyServer.close(() => resolve())),
]))

test('a bodyless GET request is forwarded and completes', async () => {
  const resp = await fetch(`${proxyBaseUrl}/anything`)
  assert.equal(resp.status, 200)
  assert.equal(await resp.text(), 'worker-get-ok')
})

test('a POST request body is forwarded to the worker intact', async () => {
  const resp = await fetch(`${proxyBaseUrl}/anything`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  })
  const json = await resp.json() as { received: string }
  assert.deepEqual(JSON.parse(json.received), { hello: 'world' })
})

test('the worker sees accept-encoding: identity, not the client\'s real header (regression: gzip corrupted piped SSE)', async () => {
  const resp = await fetch(`${proxyBaseUrl}/sse`, { headers: { 'Accept-Encoding': 'gzip, deflate, br' } })
  const text = await resp.text()
  assert.match(text, /"acceptEncoding":"identity"/)
})

test('SSE headers arrive before any body data (regression: buffered headers looked like "Connecting…" forever)', async () => {
  const start = Date.now()
  const resp = await fetch(`${proxyBaseUrl}/sse`)
  const headersElapsed = Date.now() - start
  assert.equal(resp.headers.get('content-type'), 'text/event-stream')
  assert.ok(headersElapsed < 20, `expected headers well before the worker's first 30ms-delayed chunk, took ${headersElapsed}ms`)
  const text = await resp.text()
  assert.match(text, /"chunk":1/)
  assert.match(text, /"chunk":2/)
})
