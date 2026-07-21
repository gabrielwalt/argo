import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, parseChangedFiles, buildFallbackCommitMessage } from './agent.js'

test('setMaxIterations clamps out-of-range values into [10, 1000]', () => {
  const agent = new Agent(() => {})
  agent.setMaxIterations(0)
  assert.equal(agent.getMaxIterations(), 10)
  agent.setMaxIterations(5000)
  assert.equal(agent.getMaxIterations(), 1000)
  agent.setMaxIterations(500)
  assert.equal(agent.getMaxIterations(), 500)
})

test('parseChangedFiles extracts paths from git status --porcelain output', () => {
  const status = ' M src/agent.ts\n?? src/new-file.ts\nR  old-name.ts -> new-name.ts\n'
  assert.deepEqual(parseChangedFiles(status), ['src/agent.ts', 'src/new-file.ts', 'new-name.ts'])
})

test('parseChangedFiles returns an empty list for clean/blank status', () => {
  assert.deepEqual(parseChangedFiles(''), [])
  assert.deepEqual(parseChangedFiles('\n  \n'), [])
})

test('buildFallbackCommitMessage names files directly when there are few', () => {
  const msg = buildFallbackCommitMessage(['a.ts', 'b.ts'])
  assert.equal(msg, 'Agent: update a.ts, b.ts')
})

test('buildFallbackCommitMessage falls back to a count when there are many files', () => {
  const msg = buildFallbackCommitMessage(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])
  assert.equal(msg, 'Agent: update 5 files')
})

test('buildFallbackCommitMessage handles no changed files', () => {
  assert.equal(buildFallbackCommitMessage([]), 'Agent: update workspace')
})
