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
  assert.match(w.output, /Successfully wrote the file \/workspace\/a\.txt/)
  assert.match(w.output, /5 characters/)
  assert.ok(w.output.includes('hello'), 'write_file tool result should echo the written content')
  const r = await readFile('/workspace/a.txt')
  assert.equal(r.output, 'hello')
})

// write_file/edit_file echo content the AGENT ITSELF authored — unlike
// read_file/bash/fetch_url (external, uncontrolled-size content this tool
// never wrote), a truncated echo here would leave the model unsure what the
// back half of its own file actually says. Deliberately never capped, even
// far past read_file's 8000-char cap and the old (now-removed) ECHO_CAP.
test('writeFile echoes arbitrarily large content back in full, never truncated', async () => {
  const big = 'X'.repeat(50_000) + '\nEND_MARKER\n'
  const w = await writeFile('/workspace/big.txt', big)
  assert.equal(w.error, undefined)
  assert.ok(w.output.includes(big), 'the full written content must appear verbatim in the tool result')
  assert.ok(!w.output.includes('chars omitted'), 'must never apply truncateOutput\'s marker')
  assert.ok(w.output.includes('END_MARKER'), 'content past the old 8000-char/ECHO_CAP boundary must survive')
})

test('editFile echoes the full updated file back in full, never truncated, even for a large file', async () => {
  const big = 'line\n'.repeat(10_000) + 'NEEDLE\n' + 'line\n'.repeat(10_000)
  await writeFile('/workspace/big-edit.txt', big)
  const e = await editFile('/workspace/big-edit.txt', 'NEEDLE', 'REPLACED_NEEDLE')
  assert.equal(e.error, undefined)
  assert.ok(e.output.includes('REPLACED_NEEDLE'), 'the edit must appear')
  assert.ok(!e.output.includes('chars omitted'), 'must never apply truncateOutput\'s marker')
  // Content on BOTH sides of the edit, far past any old truncation boundary,
  // must still be present.
  assert.equal((e.output.match(/^line$/gm) ?? []).length, 20_000)
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
  assert.ok(e.output.includes('const k = (8 * R)'), 'edit_file tool result should echo the full updated file')
  assert.ok(e.output.includes('line one'), 'full file content includes lines before the edit')
  assert.ok(e.output.includes('line three'), 'full file content includes lines after the edit')
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

// ── read_file pattern (search mode) — see task write-up: Planner frames
// have no bash/grep, could page but not find, and two frames each burned
// their whole 40-iteration budget attempting bash 9 and 7 times, every
// attempt rejected on role. pattern lets them find a line, then page to it. ──

test('readFile with pattern absent is byte-identical to the no-argument default path — strictly additive requirement', async () => {
  const content = 'y'.repeat(9000) + 'TAIL_MARKER_pattern_control'
  await writeFile('/workspace/pattern-control.txt', content)
  const withoutFourthArg = await readFile('/workspace/pattern-control.txt')
  const withUndefinedPattern = await readFile('/workspace/pattern-control.txt', undefined, undefined, undefined)
  assert.equal(withoutFourthArg.output, truncateOutput(content, 8000))
  assert.equal(withUndefinedPattern.output, withoutFourthArg.output)
})

test('readFile with pattern absent but offset/limit present is byte-identical to the existing paged path', async () => {
  const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`)
  await writeFile('/workspace/pattern-control-paged.txt', lines.join('\n'))
  const paged = await readFile('/workspace/pattern-control-paged.txt', 5, 3)
  const pagedNoPattern = await readFile('/workspace/pattern-control-paged.txt', 5, 3, undefined)
  assert.equal(paged.output, pagedNoPattern.output)
  assert.match(paged.output, /^\[file has 20 lines; showing lines 5-7 of 20; use offset\/limit to read another range\]\n/)
})

test('readFile with an empty-string pattern is treated as no pattern, not "match every line"', async () => {
  await writeFile('/workspace/pattern-empty.txt', 'a\nb\nc')
  const r = await readFile('/workspace/pattern-empty.txt', undefined, undefined, '')
  assert.equal(r.output, 'a\nb\nc')
})

test('readFile with pattern returns matching lines prefixed with correct 1-based line numbers', async () => {
  const lines = ['const a = 1', 'const option = 1', '  return option.requires', '}', 'const b = 2']
  await writeFile('/workspace/search-basic.txt', lines.join('\n'))
  const r = await readFile('/workspace/search-basic.txt', undefined, undefined, 'option')
  assert.equal(r.error, undefined)
  assert.match(r.output, /^\[pattern "option" matched 2 times in 5 lines; use offset\/limit to read near a line number\]\n/)
  assert.match(r.output, /^2: const option = 1$/m)
  assert.match(r.output, /^3: {3}return option\.requires$/m)
  assert.doesNotMatch(r.output, /^1: /m)
})

test('readFile with pattern and no matches returns a clear statement, not an empty string or an error', async () => {
  await writeFile('/workspace/search-nomatch.txt', 'alpha\nbeta\ngamma')
  const r = await readFile('/workspace/search-nomatch.txt', undefined, undefined, 'ZZZ_NOT_PRESENT')
  assert.equal(r.error, undefined)
  assert.notEqual(r.output, '')
  assert.equal(r.output, '[pattern "ZZZ_NOT_PRESENT" matched 0 times in 3 lines; try a shorter or different substring]')
})

test('readFile with pattern caps the number of matches returned and reports the true total when truncated', async () => {
  // 200 lines all containing "hit" — well past MAX_PATTERN_MATCHES (50).
  const lines = Array.from({ length: 200 }, (_, i) => `hit line ${i + 1}`)
  await writeFile('/workspace/search-many.txt', lines.join('\n'))
  const r = await readFile('/workspace/search-many.txt', undefined, undefined, 'hit')
  assert.equal(r.error, undefined)
  assert.match(r.output, /matched 200 times \(showing first 50\) in 200 lines/)
  const matchLines = r.output.split('\n').filter((l) => /^\d+: hit/.test(l))
  assert.equal(matchLines.length, 50)
  assert.match(matchLines[0] ?? '', /^1: hit line 1$/)
})

test('readFile pattern is a literal substring, not a regular expression — metacharacters match themselves only', async () => {
  const lines = ['a.b', 'axb', 'a(b)', 'plain text with (parens) and a.b again']
  await writeFile('/workspace/search-literal.txt', lines.join('\n'))
  // If "a.b" were treated as a regex, it would also match "axb" (line 2).
  // It must match only the literal occurrences (lines 1 and 4).
  const r = await readFile('/workspace/search-literal.txt', undefined, undefined, 'a.b')
  assert.equal(r.error, undefined)
  assert.match(r.output, /matched 2 times/)
  assert.match(r.output, /^1: a\.b$/m)
  assert.match(r.output, /^4: plain text with \(parens\) and a\.b again$/m)
  assert.doesNotMatch(r.output, /^2: axb$/m)
})

test('readFile pattern with an invalid-regex-looking string does not throw — literal matching has no invalid-pattern case', async () => {
  await writeFile('/workspace/search-invalid-regex-shape.txt', 'a.b\naxb\na(b)')
  const r = await readFile('/workspace/search-invalid-regex-shape.txt', undefined, undefined, '(unclosed[')
  assert.equal(r.error, undefined)
  assert.match(r.output, /matched 0 times/)
})

// A search is NEVER scoped by offset/limit — see searchLines' header for the measured
// reason (six of seven live Planner searches returned false negatives when a window
// carried over from the previous read narrowed them to lines 1-50 of a 2790-line file).
// The window is reported as ignored rather than silently dropped.
test('readFile pattern ignores offset/limit and always searches the whole file, saying so', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => (i === 4 || i === 24 ? `needle ${i + 1}` : `filler ${i + 1}`))
  await writeFile('/workspace/search-scoped.txt', lines.join('\n'))
  // A window that WOULD have excluded the second needle under the old scoping contract.
  const windowed = await readFile('/workspace/search-scoped.txt', 1, 10, 'needle')
  assert.equal(windowed.error, undefined)
  assert.match(windowed.output, /^\[pattern "needle" matched 2 times in 30 lines \(offset\/limit ignored: a search always covers the whole file\); use offset\/limit to read near a line number\]\n/)
  assert.match(windowed.output, /^5: needle 5$/m)
  assert.match(windowed.output, /^25: needle 25$/m)
  // Without a window the result is identical apart from the ignored-window note.
  const full = await readFile('/workspace/search-scoped.txt', undefined, undefined, 'needle')
  assert.match(full.output, /^\[pattern "needle" matched 2 times in 30 lines; use offset\/limit to read near a line number\]\n/)
  assert.match(full.output, /^5: needle 5$/m)
  assert.match(full.output, /^25: needle 25$/m)
})

test('readFile pattern with an offset past end of file still searches the whole file rather than reporting nothing to search', async () => {
  const lines = Array.from({ length: 12 }, (_, i) => `line${i + 1}`)
  await writeFile('/workspace/search-past-end.txt', lines.join('\n'))
  const r = await readFile('/workspace/search-past-end.txt', 500, undefined, 'line')
  assert.equal(r.error, undefined)
  // Under the old scoping contract this returned "offset 500 is past end of file;
  // nothing to search" — a false negative caused entirely by an argument the model
  // carried over from a previous read.
  assert.match(r.output, /matched 12 times in 12 lines \(offset\/limit ignored: a search always covers the whole file\)/)
  assert.match(r.output, /^1: line1$/m)
})

test('readFile with pattern still enforces the workspace boundary (symlink escape rejected)', async () => {
  const outsideDir = path.dirname(config.workspacePath)
  const link = path.join(config.workspacePath, 'escape-link-search')
  await fs.symlink(path.join(outsideDir, 'outside'), link)
  try {
    const r = await readFile('/workspace/escape-link-search/marker.txt', undefined, undefined, 'SECRET')
    assert.match(r.error ?? '', /traversal/)
  } finally {
    await fs.unlink(link)
  }
})
