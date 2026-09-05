import { test } from 'node:test'
import assert from 'node:assert/strict'
import { config } from '../config.js'
import { bash, resolveTimeoutMs } from './bash.js'

// Exercise the real docker-exec branch (config.inContainer stays false, as it
// is on any host running these tests) against a running sandbox container.
// The bug these regress (exec() routing the command through an extra,
// unintended shell) affects both branches identically, since docker exec
// just prepends more argv elements ahead of the same `bash -c <command>`
// invocation.
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

test('cwd: omitted defaults to /workspace', async () => {
  const result = await bash('pwd')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '/workspace')
})

test('cwd: any absolute path is accepted, not just an enum of two', async () => {
  const result = await bash('pwd', '/etc')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '/etc')
})

test('cwd: a non-absolute value falls back to /workspace', async () => {
  const result = await bash('pwd', 'not-a-path')
  assert.equal(result.error, undefined)
  assert.equal(result.output.trim(), '/workspace')
})

test('output over MAX_OUTPUT keeps a verbatim tail, not just the head', async () => {
  const result = await bash('node -e "process.stdout.write(\'x\'.repeat(5000) + \'TAIL_MARKER_9f3a\')"')
  assert.equal(result.error, undefined)
  assert.match(result.output, /TAIL_MARKER_9f3a$/)
})

// resolveTimeoutMs is pure (no process spawned) — cheap to exercise every
// default/override/cap combination directly rather than waiting out real timeouts.
test('resolveTimeoutMs: plain commands default to 30s', () => {
  assert.equal(resolveTimeoutMs('echo hi'), 30_000)
})

test('resolveTimeoutMs: a command mentioning Playwright/Chromium gets a 120s default, unasked', () => {
  assert.equal(resolveTimeoutMs('node -e "require(\'playwright\')"'), 120_000)
  assert.equal(resolveTimeoutMs('node -e "chromium.launch()"'), 120_000)
})

test('resolveTimeoutMs: an explicit request is honored for a plain command', () => {
  assert.equal(resolveTimeoutMs('echo hi', 60_000), 60_000)
})

test('resolveTimeoutMs: an explicit request is capped at 180s even for Playwright', () => {
  assert.equal(resolveTimeoutMs('require("playwright")', 10_000_000), 180_000)
})

test('resolveTimeoutMs: a zero or negative request falls back to the default instead of failing instantly', () => {
  assert.equal(resolveTimeoutMs('echo hi', 0), 30_000)
  assert.equal(resolveTimeoutMs('echo hi', -5), 30_000)
})

test('resolveTimeoutMs: an explicit request BELOW the Playwright default is floored to it, not honored', () => {
  // Confirmed live: the model explicitly passed timeout_ms:30000 on a real
  // Playwright script, which — before this floor existed — overrode the 120s
  // Playwright default down to the same 30s wall that default exists to avoid.
  // Models have no real sense of browser launch + page load cost.
  assert.equal(resolveTimeoutMs('npx playwright test', 30_000), 120_000)
  assert.equal(resolveTimeoutMs('node -e "chromium.launch()"', 5_000), 120_000)
})

test('resolveTimeoutMs: an explicit request AT OR ABOVE the Playwright default is still honored', () => {
  assert.equal(resolveTimeoutMs('npx playwright test', 150_000), 150_000)
})

test('resolveTimeoutMs: the floor never applies to a plain (non-Playwright) command', () => {
  assert.equal(resolveTimeoutMs('echo hi', 5_000), 5_000)
})

test('a real timeout is reported distinctly from a real command failure', async () => {
  // execFile's timeout kills the *direct* child with SIGTERM. In-container
  // (production — see config.inContainer in bash.ts) that child is `bash`
  // itself, which dies by signal and is correctly detected as killed below.
  // Through the docker-exec dev-mode wrapper the direct child is instead the
  // `docker` CLI, which was observed to catch SIGTERM and exit 0 on its own
  // (confirmed directly: child 'exit' fired with code 0, signal null, ~300ms
  // in) — Node then sees a clean exit, not a kill, and the call silently
  // "succeeds" with whatever was buffered while the real command keeps
  // running detached inside the sandbox container. That's a real gap, but
  // specific to Argo's own dev-mode tooling, not to any real workspace (which
  // always runs the in-container branch) — flip to that branch here to
  // exercise the path that actually matters, then restore it.
  const wasInContainer = config.inContainer
  config.inContainer = true
  try {
    // cwd defaults to /workspace, which only exists inside a real container —
    // this test runs directly on the host (see comment above), so it needs an
    // explicit cwd that actually exists here.
    const timedOut = await bash('sleep 5', '/tmp', 300)
    assert.equal(timedOut.error, 'Command timed out after 0.3s')

    const failed = await bash('exit 1', '/tmp')
    assert.equal(failed.error, 'Command failed')
  } finally {
    config.inContainer = wasInContainer
  }
})
