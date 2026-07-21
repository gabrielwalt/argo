import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from '../config.js'
import { readFile, writeFile } from './file-ops.js'

// file-ops.ts is pure Node fs against config.workspacePath/scratchPath — no
// Docker needed to test the real logic, just real directories to point at.
let root: string

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'argo-file-ops-test-'))
  await fs.mkdir(path.join(root, 'workspace'))
  await fs.mkdir(path.join(root, 'scratch'))
  await fs.mkdir(path.join(root, 'outside'))
  await fs.writeFile(path.join(root, 'outside', 'marker.txt'), 'SECRET_MARKER')
  config.workspacePath = path.join(root, 'workspace')
  config.scratchPath = path.join(root, 'scratch')
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

test('allowed scratch access works', async () => {
  const w = await writeFile('/scratch/b.txt', 'world')
  assert.equal(w.error, undefined)
  const r = await readFile('/scratch/b.txt')
  assert.equal(r.output, 'world')
})

test('absolute path outside both roots is rejected', async () => {
  const r = await readFile(path.join(root, 'outside', 'marker.txt'))
  assert.match(r.error ?? '', /traversal/)
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

test('a symlink inside scratch pointing outside is rejected on write, and nothing is written', async () => {
  const link = path.join(config.scratchPath, 'escape-link')
  await fs.symlink(path.join(root, 'outside'), link)
  try {
    const w = await writeFile('/scratch/escape-link/via-symlink.txt', 'should not land here')
    assert.match(w.error ?? '', /traversal/)
    const exists = await fs.access(path.join(root, 'outside', 'via-symlink.txt')).then(() => true).catch(() => false)
    assert.equal(exists, false)
  } finally {
    await fs.unlink(link)
  }
})

test('a sibling directory sharing the root as a string prefix is not treated as inside it', async () => {
  const evilSibling = config.workspacePath + '-evil'
  await fs.mkdir(evilSibling, { recursive: true })
  await fs.writeFile(path.join(evilSibling, 'marker.txt'), 'SIBLING_MARKER')
  try {
    // Reachable only via the workspace path prefix check being a bare
    // `.startsWith` — resolving through it must not accidentally match.
    const r = await readFile(path.join(evilSibling, 'marker.txt'))
    assert.match(r.error ?? '', /traversal/)
  } finally {
    await fs.rm(evilSibling, { recursive: true, force: true })
  }
})

test('readFile output over the 8000-char cap keeps a verbatim tail, not just the head', async () => {
  const content = 'y'.repeat(9000) + 'TAIL_MARKER_7c1d'
  const w = await writeFile('/workspace/big.txt', content)
  assert.equal(w.error, undefined)
  const r = await readFile('/workspace/big.txt')
  assert.match(r.output, /TAIL_MARKER_7c1d$/)
})
