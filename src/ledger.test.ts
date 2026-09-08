// ledger.ts unit tests — pure fs operations against a real temp directory (no
// Ollama, no Agent), same pattern agent.test.ts's own config.workspacePath-backed
// tests use. Covers the eviction-aware reload design specifically:
//   - readFrame dedups by id, LAST entry wins (an eviction marker, appended after
//     its original, replaces the original in the reload/`messages` view).
//   - expand always recovers the ORIGINAL (pre-eviction) content, never a stub,
//     regardless of how many eviction markers were appended for that id.
//   - a message that was never evicted round-trips unchanged through both.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import * as ledger from './ledger.js'

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'argo-ledger-'))
}

test('readFrame: a message with no later entries round-trips unchanged', async () => {
  const root = await tempRoot()
  try {
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'user', content: 'hello' })
    const frame = await ledger.readFrame(root, 'frame-a')
    assert.deepEqual(frame, [{ id: 'msg-1', role: 'user', content: 'hello' }])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readFrame: an eviction marker (same id, evicted: true) REPLACES the original in the deduplicated view', async () => {
  const root = await tempRoot()
  try {
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'tool', content: 'x'.repeat(5000) })
    await ledger.recordMessage(root, 'frame-a', {
      id: 'msg-1', role: 'tool', content: '[evicted — 5000 chars; msg_id "msg-1" to recover]', evicted: true,
    })
    const frame = await ledger.readFrame(root, 'frame-a')
    assert.equal(frame.length, 1) // one logical message, not two lines
    assert.equal(frame[0].id, 'msg-1')
    assert.equal(frame[0].evicted, true)
    assert.equal(frame[0].content, '[evicted — 5000 chars; msg_id "msg-1" to recover]')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readFrame: preserves original chronological ORDER even when a later id is deduplicated away', async () => {
  const root = await tempRoot()
  try {
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'user', content: 'first' })
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-2', role: 'tool', content: 'y'.repeat(3000) })
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-3', role: 'assistant', content: 'third' })
    // msg-2 gets evicted AFTER msg-3 was already recorded — the marker is a later
    // LINE in the file, but msg-2's own logical position (2nd) must not move.
    await ledger.recordMessage(root, 'frame-a', {
      id: 'msg-2', role: 'tool', content: '[evicted — 3000 chars; msg_id "msg-2" to recover]', evicted: true,
    })
    const frame = await ledger.readFrame(root, 'frame-a')
    assert.deepEqual(frame.map(m => m.id), ['msg-1', 'msg-2', 'msg-3'])
    assert.equal(frame[1].evicted, true)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('expand: recovers the ORIGINAL full content even after an eviction marker was appended', async () => {
  const root = await tempRoot()
  try {
    const original = 'z'.repeat(5000)
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'tool', content: original })
    await ledger.recordMessage(root, 'frame-a', {
      id: 'msg-1', role: 'tool', content: '[evicted — 5000 chars; msg_id "msg-1" to recover]', evicted: true,
    })
    const recovered = await ledger.expand(root, 'msg-1', 'frame-a')
    assert.equal(recovered, original)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('expand: a message that was never evicted is recovered as-is', async () => {
  const root = await tempRoot()
  try {
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'user', content: 'plain content' })
    const recovered = await ledger.expand(root, 'msg-1', 'frame-a')
    assert.equal(recovered, 'plain content')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('expand: an unknown id returns null', async () => {
  const root = await tempRoot()
  try {
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'user', content: 'hello' })
    const recovered = await ledger.expand(root, 'msg-does-not-exist', 'frame-a')
    assert.equal(recovered, null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('expand: searches across every frame file when no frameId is given, and still finds the original, not a stub', async () => {
  const root = await tempRoot()
  try {
    const original = 'w'.repeat(4000)
    await ledger.recordMessage(root, 'frame-a', { id: 'msg-1', role: 'tool', content: original })
    await ledger.recordMessage(root, 'frame-a', {
      id: 'msg-1', role: 'tool', content: '[evicted — 4000 chars; msg_id "msg-1" to recover]', evicted: true,
    })
    await ledger.recordMessage(root, 'frame-b', { id: 'msg-9', role: 'user', content: 'unrelated' })
    const recovered = await ledger.expand(root, 'msg-1')
    assert.equal(recovered, original)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('readFrame: a frame that never recorded anything returns an empty array', async () => {
  const root = await tempRoot()
  try {
    const frame = await ledger.readFrame(root, 'never-existed')
    assert.deepEqual(frame, [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// ── Registry: currentSessionId pointer + registerFrame ──────────────
// Replaces the old logs/current-session.txt file — "which session is active"
// now lives on the SAME registry file frames are already recorded in.

test('getCurrentSession: null when nothing has ever been set', async () => {
  const root = await tempRoot()
  try {
    assert.equal(await ledger.getCurrentSession(root), null)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('setCurrentSession/getCurrentSession round-trip, and a later call overwrites rather than accumulates', async () => {
  const root = await tempRoot()
  try {
    await ledger.setCurrentSession(root, 'session-1')
    assert.equal(await ledger.getCurrentSession(root), 'session-1')
    await ledger.setCurrentSession(root, 'session-2')
    assert.equal(await ledger.getCurrentSession(root), 'session-2')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('setCurrentSession does not disturb frames already registered under other sessions', async () => {
  const root = await tempRoot()
  try {
    await ledger.registerFrame(root, 'session-1', 0, { frameId: 'dispatcher-1', role: 'dispatcher', parentFrameId: null })
    await ledger.setCurrentSession(root, 'session-2')
    const registry = await ledger.getRegistry(root)
    assert.equal(registry.currentSessionId, 'session-2')
    assert.ok(registry.sessions.some(s => s.id === 'session-1'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// ── deleteSession / resetAllSessions ─────────────────────────────────

test('deleteSession removes the session\'s registry entry and its frames\' ledger files', async () => {
  const root = await tempRoot()
  try {
    await ledger.registerFrame(root, 'session-1', 0, { frameId: 'dispatcher-1', role: 'dispatcher', parentFrameId: null })
    await ledger.recordMessage(root, 'dispatcher-1', { id: 'msg-1', role: 'user', content: 'hi' })

    const removedFrameIds = await ledger.deleteSession(root, 'session-1')
    assert.deepEqual(removedFrameIds, ['dispatcher-1'])

    const registry = await ledger.getRegistry(root)
    assert.ok(!registry.sessions.some(s => s.id === 'session-1'))
    const frame = await ledger.readFrame(root, 'dispatcher-1')
    assert.deepEqual(frame, [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('deleteSession is a no-op for an unknown session id', async () => {
  const root = await tempRoot()
  try {
    const removed = await ledger.deleteSession(root, 'no-such-session')
    assert.deepEqual(removed, [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('resetAllSessions clears every session and every frame file', async () => {
  const root = await tempRoot()
  try {
    await ledger.registerFrame(root, 'session-1', 0, { frameId: 'dispatcher-1', role: 'dispatcher', parentFrameId: null })
    await ledger.registerFrame(root, 'session-2', 0, { frameId: 'planner-1', role: 'planner', parentFrameId: null })
    await ledger.recordMessage(root, 'dispatcher-1', { id: 'msg-1', role: 'user', content: 'hi' })

    await ledger.resetAllSessions(root)

    const registry = await ledger.getRegistry(root)
    assert.deepEqual(registry.sessions, [])
    assert.deepEqual(await ledger.readFrame(root, 'dispatcher-1'), [])
    assert.deepEqual(await ledger.readFrame(root, 'planner-1'), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

// ── ensureGitignored: stale state.json cleanup ───────────────────────

test('ensureGitignored removes a stale .argo/state.json left by a pre-ledger build', async () => {
  const root = await tempRoot()
  try {
    await fs.mkdir(path.join(root, '.argo'), { recursive: true })
    await fs.writeFile(path.join(root, '.argo', 'state.json'), '{}')
    await ledger.ensureGitignored(root)
    await assert.rejects(fs.access(path.join(root, '.argo', 'state.json')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('ensureGitignored is a no-op (does not throw) when .argo/state.json never existed', async () => {
  const root = await tempRoot()
  try {
    await ledger.ensureGitignored(root)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
