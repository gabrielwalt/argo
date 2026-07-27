import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from '../config.js'
import { readFile, writeFile, editFile } from './file-ops.js'

// file-ops.ts is pure Node fs against config.workspacePath — no Docker needed
// to test the real logic, just real directories to point at. Only /workspace
// is confined; everywhere else in the container is ordinary, unmanaged
// filesystem (see CLAUDE.md's Zero trust / Phase 8 filesystem-model notes).
let root: string

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-file-ops-test-'))
  await fs.mkdir(path.join(root, 'workspace'))
  await fs.mkdir(path.join(root, 'outside'))
  await fs.writeFile(path.join(root, 'outside', 'marker.txt'), 'SECRET_MARKER')
  config.workspacePath = path.join(root, 'workspace')
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('allowed workspace access works', async () => {
  const w = await writeFile('/workspace/a.txt', 'hello')
  assert.equal(w.error, undefined)
  const r = await readFile('/workspace/a.txt')
  assert.equal(r.output, 'hello')
})

test('a path outside /workspace is reachable directly, no confinement', async () => {
  const r = await readFile(path.join(root, 'outside', 'marker.txt'))
  assert.equal(r.error, undefined)
  assert.equal(r.output, 'SECRET_MARKER')
})

test('../ traversal out of workspace is rejected', async () => {
  const r = await readFile('/workspace/../outside/marker.txt')
  assert.match(r.error ?? '', /traversal/)
})

test('a symlink inside workspace pointing outside is rejected on read', async () => {
  const link = path.join(config.workspacePath, 'escape-link')
  await fs.symlink(path.join(root, 'outside'), link)
  try {
    const r = await readFile('/workspace/escape-link/marker.txt')
    assert.match(r.error ?? '', /traversal/)
  } finally {
    await fs.unlink(link)
  }
})

test('a literal path merely sharing "/workspace" as a string prefix is not resolved against the real workspace', async () => {
  // "/workspace-evil/..." must not match the workspace branch — a bare
  // .startsWith('/workspace') would incorrectly treat it as inside it, then
  // silently redirect the read/write into the real workspace directory.
  const r = await readFile('/workspace-evil/marker.txt')
  assert.ok(r.error)
  assert.ok(r.error!.includes('/workspace-evil/marker.txt'), `expected the real attempted path in the error, got: ${r.error}`)
  assert.ok(!r.error!.includes(config.workspacePath), `must not have been resolved against the real workspace: ${r.error}`)
})

test('readFile output over the 8000-char cap keeps a verbatim tail, not just the head', async () => {
  const content = 'y'.repeat(9000) + 'TAIL_MARKER_7c1d'
  const w = await writeFile('/workspace/big.txt', content)
  assert.equal(w.error, undefined)
  const r = await readFile('/workspace/big.txt')
  assert.match(r.output, /TAIL_MARKER_7c1d$/)
})

// ── edit_file: the point is unambiguous feedback, not the replace itself ──

test('editFile replaces a unique match, applies it, and reports what changed with line numbers', async () => {
  await writeFile('/workspace/edit-a.txt', 'line one\nconst k = (2 * R)\nline three')
  const e = await editFile('/workspace/edit-a.txt', '(2 * R)', '(8 * R)')
  assert.equal(e.error, undefined)
  assert.match(e.output, /replaced 1 occurrence/)
  assert.match(e.output, /2: const k = \(8 \* R\)/)      // shows the changed line, numbered
  // The change actually landed on disk.
  assert.equal((await readFile('/workspace/edit-a.txt')).output, 'line one\nconst k = (8 * R)\nline three')
})

test('editFile errors (and changes nothing) when old_string is not found — no silent no-op', async () => {
  await writeFile('/workspace/edit-b.txt', 'alpha\nbeta\n')
  const e = await editFile('/workspace/edit-b.txt', 'GAMMA_NOT_PRESENT', 'x')
  assert.match(e.error ?? '', /not found/)
  assert.match(e.error ?? '', /NOT modified/)
  assert.equal((await readFile('/workspace/edit-b.txt')).output, 'alpha\nbeta\n')   // untouched
})

test('editFile refuses an ambiguous (non-unique) match unless replace_all', async () => {
  await writeFile('/workspace/edit-c.txt', 'x=1\nx=1\nx=1\n')
  const ambiguous = await editFile('/workspace/edit-c.txt', 'x=1', 'x=2')
  assert.match(ambiguous.error ?? '', /matches 3 places/)
  assert.equal((await readFile('/workspace/edit-c.txt')).output, 'x=1\nx=1\nx=1\n')  // untouched
  const all = await editFile('/workspace/edit-c.txt', 'x=1', 'x=2', true)
  assert.equal(all.error, undefined)
  assert.match(all.output, /replaced 3 occurrences/)
  assert.equal((await readFile('/workspace/edit-c.txt')).output, 'x=2\nx=2\nx=2\n')
})

test('editFile reports a missing file rather than creating it', async () => {
  const e = await editFile('/workspace/does-not-exist.txt', 'a', 'b')
  assert.match(e.error ?? '', /File not found/)
})
