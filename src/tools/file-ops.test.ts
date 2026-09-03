import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { config } from '../config.js'
import { readFile, writeFile, editFile } from './file-ops.js'
import { truncateOutput } from './truncate.js'

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

// ── read_file offset/limit paging (see task write-up: the traced Planner
// failure on a 2790-line file with no way to reach the invisible middle) ──

test('readFile with no offset/limit is unchanged for a short file (no marker, no truncation)', async () => {
  const content = 'line1\nline2\nline3'
  await writeFile('/workspace/short.txt', content)
  const r = await readFile('/workspace/short.txt')
  assert.equal(r.output, content)
})

test('readFile with no offset/limit is byte-identical to truncateOutput(content, 8000) for an over-cap file — the non-negotiable default path', async () => {
  const content = 'y'.repeat(9000) + 'TAIL_MARKER_offset_control'
  await writeFile('/workspace/big-control.txt', content)
  const r = await readFile('/workspace/big-control.txt')
  // Computed independently via the same function readFile calls internally —
  // this is the exact contract requirement 1 in the task demands: adding
  // offset/limit must not change one byte of the no-argument path.
  assert.equal(r.output, truncateOutput(content, 8000))
})

test('readFile with offset/limit returns the requested 1-based line range with a self-describing marker', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
  await writeFile('/workspace/twenty.txt', lines.join('\n'))
  const r = await readFile('/workspace/twenty.txt', 5, 3)
  assert.equal(r.error, undefined)
  assert.match(r.output, /^\[file has 20 lines; showing lines 5-7 of 20; use offset\/limit to read another range\]\n/)
  assert.match(r.output, /line5\nline6\nline7$/)
  assert.doesNotMatch(r.output, /line4\b/)
  assert.doesNotMatch(r.output, /line8\b/)
})

test('readFile offset without limit reads through end of file', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
  await writeFile('/workspace/ten.txt', lines.join('\n'))
  const r = await readFile('/workspace/ten.txt', 8)
  assert.match(r.output, /showing lines 8-10 of 10/)
  assert.match(r.output, /line8\nline9\nline10$/)
})

test('readFile limit without offset defaults to starting at line 1', async () => {
  const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`)
  await writeFile('/workspace/ten-b.txt', lines.join('\n'))
  const r = await readFile('/workspace/ten-b.txt', undefined, 3)
  assert.match(r.output, /showing lines 1-3 of 10/)
  assert.match(r.output, /^\[.*\]\nline1\nline2\nline3$/)
})

test('readFile offset past end of file reports the true length instead of throwing or silently clamping', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`)
  await writeFile('/workspace/twelve.txt', lines.join('\n'))
  const r = await readFile('/workspace/twelve.txt', 500)
  assert.equal(r.error, undefined)
  assert.equal(r.output, '[file has 12 lines; offset 500 is past end of file; nothing to show]')
})

test('readFile offset/limit slice still exceeding the 8000-char cap is itself capped, not returned unbounded', async () => {
  // 200 lines of 100 chars each = 20000 chars, well over the cap, all requested via limit.
  const lines = Array.from({ length: 200 }, (_, i) => `L${i}`.padEnd(100, 'x'))
  await writeFile('/workspace/wide.txt', lines.join('\n'))
  const r = await readFile('/workspace/wide.txt', 1, 200)
  assert.equal(r.error, undefined)
  assert.match(r.output, /^\[file has 200 lines; showing lines 1-200 of 200; use offset\/limit to read another range\]\n/)
  assert.ok(r.output.length < 20000, 'the requested slice must still be capped, not returned in full')
  assert.match(r.output, /chars omitted/)  // the inner truncateOutput marker is still present within the slice
})

test('readFile with offset/limit still enforces the workspace boundary (symlink escape rejected)', async () => {
  const outsideDir = path.dirname(config.workspacePath)
  const link = path.join(config.workspacePath, 'escape-link-paged')
  await fs.symlink(path.join(outsideDir, 'outside'), link)
  try {
    const r = await readFile('/workspace/escape-link-paged/marker.txt', 1, 5)
    assert.match(r.error ?? '', /traversal/)
  } finally {
    await fs.unlink(link)
  }
})
