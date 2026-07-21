import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { bash } from './bash.js'

// Exercise the real docker-exec branch (config.inContainer stays false, as it
// is on any host running these tests) against a running sandbox container.
// The in-container branch hardcodes cwd '/scratch', which only exists inside
// the real Argo container — but the bug these regress (exec() routing the
// command through an extra, unintended shell) affects both branches
// identically, since docker exec just prepends more argv elements ahead of
// the same `bash -c <command>` invocation.
config.sandboxContainer = process.env.TEST_SANDBOX_CONTAINER ?? 'argo-test-one'

test('command substitution and variable assignment survive intact', async () => {
  const result = await bash('TMPDIR=$(mktemp -d) && echo "Temp dir: $TMPDIR"')
  assert.equal(result.error, undefined)
  assert.match(result.output.trim(), /^Temp dir: \/\S+$/)
})

test('multiline commands run as separate statements, not fused', async () => {
  const result = await bash('echo "line1"\necho "line2"')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), 'line1\nline2')
})

test('heredocs are not corrupted', async () => {
  const result = await bash(["cat << 'EOF'", '[', '  {"id": 1, "title": "Task one"}', ']', 'EOF'].join('\n'))
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '[\n  {"id": 1, "title": "Task one"}\n]')
})

test('multiline for loops execute correctly', async () => {
  const result = await bash('for i in $(seq 1 3); do\n  echo "n=$i"\ndone')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), 'n=1\nn=2\nn=3')
})

test('redirects followed by a newline are not mangled', async () => {
  const result = await bash('true 2>&1\necho after')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), 'after')
})

test('background processes and $! survive across lines', async () => {
  const result = await bash('sleep 0.1 &\nPID=$!\necho "pid=$PID"\nwait')
  assert.equal(result.error, undefined)
  assert.match(result.output.trim(), /^pid=\d+$/)
})

test('multiline node -e scripts run without literal backslash-n corruption', async () => {
  const result = await bash('node -e "\nconst t = { title: \'x\' };\nconsole.log(JSON.stringify(t));\n"')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '{"title":"x"}')
})

test('cwd: /workspace runs project commands against the project root', async () => {
  const result = await bash('pwd', '/workspace')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '/workspace')
})

test('cwd: omitted defaults to /scratch (keeps disposable work out of git by default)', async () => {
  const result = await bash('pwd')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '/scratch')
})

test('cwd: a value outside the allowed set falls back to /scratch, never passed through', async () => {
  const result = await bash('pwd', '/etc')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '/scratch')
})

test('output over MAX_OUTPUT keeps a verbatim tail, not just the head', async () => {
  const result = await bash('node -e "process.stdout.write(\'x\'.repeat(5000) + \'TAIL_MARKER_9f3a\')"')
  assert.equal(result.error, undefined)
  assert.match(result.output, /TAIL_MARKER_9f3a$/)
})
