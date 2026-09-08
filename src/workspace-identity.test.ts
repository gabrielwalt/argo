import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  readWorkspaceId,
  ensureWorkspaceId,
  workspaceHasContent,
  decideSessionResume,
  type WorkspaceIdentityIO,
} from './workspace-identity.js'

// ── in-memory fs harness (same shape as memory.test.ts's persistToMemory tests) ──

function makeIo(files: Record<string, string> = {}): WorkspaceIdentityIO & { files: Record<string, string>; dirs: Set<string> } {
  const dirs = new Set<string>()
  return {
    files,
    dirs,
    readFile: async (p: string) => {
      if (!(p in files)) throw new Error('ENOENT')
      return files[p]
    },
    writeFile: async (p: string, c: string) => {
      files[p] = c
    },
    mkdir: async (p: string) => {
      dirs.add(p)
    },
    readdir: async (p: string) => {
      // Only the workspace root is ever listed by workspaceHasContent — simulate
      // top-level entries as whatever the test seeds under this key.
      if (!(p in files)) throw new Error('ENOENT')
      return JSON.parse(files[p]) as string[]
    },
  }
}

const ID_PATH = path.join('/ws', '.argo', 'workspace-id')

// ── readWorkspaceId ────────────────────────────────────────────────

test('readWorkspaceId: returns null when the file is absent', async () => {
  const io = makeIo()
  assert.equal(await readWorkspaceId('/ws', io), null)
})

test('readWorkspaceId: returns null on an unreadable file (read throws)', async () => {
  const io: WorkspaceIdentityIO = { readFile: async () => { throw new Error('EACCES') } }
  assert.equal(await readWorkspaceId('/ws', io), null)
})

test('readWorkspaceId: returns the trimmed id when present', async () => {
  const io = makeIo({ [ID_PATH]: 'abc-123\n' })
  assert.equal(await readWorkspaceId('/ws', io), 'abc-123')
})

test('readWorkspaceId: an empty file is treated the same as absent', async () => {
  const io = makeIo({ [ID_PATH]: '   \n' })
  assert.equal(await readWorkspaceId('/ws', io), null)
})

// ── ensureWorkspaceId ──────────────────────────────────────────────

test('ensureWorkspaceId: fresh workspace gets a new id, persisted to .argo/workspace-id', async () => {
  const io = makeIo()
  const id = await ensureWorkspaceId('/ws', io)
  assert.ok(typeof id === 'string' && id.length > 0)
  assert.equal(io.files[ID_PATH], id)
  assert.ok(io.dirs.has(path.join('/ws', '.argo')))
})

test('ensureWorkspaceId: existing id is returned unchanged, no write', async () => {
  const io = makeIo({ [ID_PATH]: 'already-there' })
  let wroteAgain = false
  io.writeFile = async (p, c) => { wroteAgain = true; io.files[p] = c }
  const id = await ensureWorkspaceId('/ws', io)
  assert.equal(id, 'already-there')
  assert.equal(wroteAgain, false)
})

test('ensureWorkspaceId: fails open (returns null) when the write fails', async () => {
  const io = makeIo()
  io.mkdir = async () => { throw new Error('EROFS: read-only file system') }
  const id = await ensureWorkspaceId('/ws', io)
  assert.equal(id, null)
})

test('ensureWorkspaceId: fails open when writeFile itself fails', async () => {
  const io = makeIo()
  io.writeFile = async () => { throw new Error('EROFS') }
  const id = await ensureWorkspaceId('/ws', io)
  assert.equal(id, null)
})

// ── workspaceHasContent ────────────────────────────────────────────

test('workspaceHasContent: false for a directory with only dotfiles', async () => {
  const io = makeIo({ '/ws': JSON.stringify(['.git', '.argo', '.gitignore']) })
  assert.equal(await workspaceHasContent('/ws', io), false)
})

test('workspaceHasContent: true when a non-dotfile entry exists', async () => {
  const io = makeIo({ '/ws': JSON.stringify(['.git', 'index.html']) })
  assert.equal(await workspaceHasContent('/ws', io), true)
})

test('workspaceHasContent: false (fails safe) when the directory cannot be read', async () => {
  const io: WorkspaceIdentityIO = { readdir: async () => { throw new Error('ENOENT') } }
  assert.equal(await workspaceHasContent('/ws', io), false)
})

test('workspaceHasContent: false for a genuinely empty directory', async () => {
  const io = makeIo({ '/ws': JSON.stringify([]) })
  assert.equal(await workspaceHasContent('/ws', io), false)
})

// ── decideSessionResume ─────────────────────────────────────────────
// The pointer this feeds decideSessionResume is now built directly from the
// ledger's registry (ledger.ts's getCurrentSession), not parsed from any file —
// see workspace-identity.ts's own SessionPointer comment. decideSessionResume
// itself stays pointer-format-agnostic, so these tests are unchanged.

test('decideSessionResume: no pointer at all -> fresh', () => {
  assert.deepEqual(decideSessionResume(null, 'w1', true), { resume: false, reason: 'no-pointer' })
})

test('decideSessionResume: recorded workspace id matches current -> resume', () => {
  const pointer = { sessionId: 's1', workspaceId: 'w1' }
  assert.deepEqual(decideSessionResume(pointer, 'w1', false), { resume: true, reason: 'workspace-id-match' })
})

test('decideSessionResume: recorded workspace id does not match current -> fresh (the reported bug\'s fixed case)', () => {
  const pointer = { sessionId: 's1', workspaceId: 'w1' }
  assert.deepEqual(decideSessionResume(pointer, 'w2', true), { resume: false, reason: 'workspace-id-mismatch' })
})

test('decideSessionResume: recorded workspace id but current workspace has none (e.g. emptied folder) -> fresh', () => {
  const pointer = { sessionId: 's1', workspaceId: 'w1' }
  assert.deepEqual(decideSessionResume(pointer, null, false), { resume: false, reason: 'workspace-id-mismatch' })
})

test('decideSessionResume: legacy pointer + workspace still has content -> resume (first run after deployment, common case)', () => {
  const pointer = { sessionId: 's1', workspaceId: null }
  assert.deepEqual(decideSessionResume(pointer, 'w1', true), { resume: true, reason: 'legacy-pointer-nonempty-workspace' })
})

test('decideSessionResume: legacy pointer + empty workspace -> fresh (the exact reported bug)', () => {
  const pointer = { sessionId: 's1', workspaceId: null }
  assert.deepEqual(decideSessionResume(pointer, 'w1', false), { resume: false, reason: 'legacy-pointer-empty-workspace' })
})

test('decideSessionResume: legacy pointer + no workspace id could be established + content present -> still resumes', () => {
  // e.g. ensureWorkspaceId failed open (read-only mount) — we can't stamp a new id,
  // but the content check still lets a genuine restart behave as it did pre-fix.
  const pointer = { sessionId: 's1', workspaceId: null }
  assert.deepEqual(decideSessionResume(pointer, null, true), { resume: true, reason: 'legacy-pointer-nonempty-workspace' })
})
