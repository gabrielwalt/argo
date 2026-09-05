import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 4000

// Explicit marker for genuinely empty stdout — both the UI and the model read
// result.output directly and benefit from a visible marker instead of blank
// text. Callers that need to detect "no output" programmatically (rather than
// just displaying it) should compare against this constant, not against ''.
export const NO_OUTPUT = '(no output)'

// Raised from 30s to 120s: Argo runs its bash tool inside Docker, where
// npm install, npm test, python3 scripts, and build commands routinely take
// 30-60s on their own before any real work-specific slowness is added. The old
// 30s default was catching normal container overhead, not just genuine hangs —
// wasting agent iterations on retries for commands that were always going to
// finish, just not within 30s. 120s gives real commands room to finish while
// still failing a genuinely stuck command well before it can block a run
// indefinitely.
const DEFAULT_TIMEOUT_MS = 120_000
// Playwright commands routinely need a browser launch + page load + a real
// wait for a page/animation to do something — the plain default isn't a fair
// baseline for them specifically (confirmed live: a verification run burned 5
// retries and ~7 minutes hitting the old 30s wall before switching approach
// entirely, because "Command failed" gave no hint the real cause was just the
// clock). Now equal to DEFAULT_TIMEOUT_MS (both 120s) since the plain default
// was raised for the same underlying reason (Docker overhead) — but the
// Playwright-specific FLOOR below is still meaningful: it stops a model from
// underrequesting (e.g. timeout_ms: 5000) on a command that needs browser
// launch + page load time no matter how generous the general default is.
const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 120_000
// A ceiling on the model's own timeout_ms request — long enough for real
// Playwright work and heavy builds (npm install, full test suites), short
// enough that a stuck command can't block a run indefinitely. Raised from
// 180s to 300s: 180s could be insufficient for npm install or heavy builds
// inside a container; 300s (5 minutes) is generous but still a real ceiling —
// if a command takes longer than that, something is probably wrong rather
// than just slow.
const MAX_TIMEOUT_MS = 300_000
const PLAYWRIGHT_PATTERN = /playwright|chromium|firefox\.launch|webkit\.launch/i

// Pure and separately testable: given the command text and whatever the model
// asked for, what timeout should actually apply. A command that mentions
// Playwright gets a FLOOR at PLAYWRIGHT_DEFAULT_TIMEOUT_MS (120s) even when
// the model explicitly asked for less: confirmed live, a Tester passed
// timeout_ms:30000 on a Playwright script (the model has no real sense of
// browser launch + page load cost and routinely underestimates it), which —
// before this floor existed — overrode the Playwright default entirely and
// produced the exact under-time-budget failure this floor exists to prevent,
// indistinguishable from a real hang. The floor stays meaningful even now
// that the Playwright and plain defaults are numerically equal (both 120s),
// because it only kicks in when the model explicitly underrequests — a plain
// command that underrequests is honored as asked (see the last test below).
export function resolveTimeoutMs(command: string, requestedMs?: number): number {
  const isPlaywright = PLAYWRIGHT_PATTERN.test(command)
  const base = isPlaywright ? PLAYWRIGHT_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS
  const wanted = requestedMs != null && requestedMs > 0 ? requestedMs : base
  const floor = isPlaywright ? PLAYWRIGHT_DEFAULT_TIMEOUT_MS : 0
  return Math.min(Math.max(wanted, floor), MAX_TIMEOUT_MS)
}

export async function bash(command: string, cwd?: string, timeoutMs?: number): Promise<ToolResult> {
  // The container is the security boundary (see CLAUDE.md's Zero trust
  // section), not any particular path within it — so cwd accepts any
  // absolute path, not just an enum. Defaults to /workspace, the one
  // directory that's actually special (the user's project); this just spares
  // the model from typing "cd /workspace && ..." for the common case.
  const resolvedCwd = cwd && cwd.startsWith('/') ? cwd : '/workspace'
  const timeout = resolveTimeoutMs(command, timeoutMs)
  try {
    // execFile (argv array, no shell) — not exec (a single command string).
    // exec() always runs its string through an *additional* shell (`/bin/sh -c`)
    // before the command even reaches the `bash -c` below. That extra shell
    // does not treat JSON.stringify's `\n` escapes as newlines (POSIX double
    // quotes don't), so multi-line commands arrived as literal backslash-n and
    // got corrupted mid-token — and it still expands `$VAR`/`$(...)` inside
    // double quotes, so variables and substitutions were evaluated twice, once
    // by the wrong shell in the wrong environment (e.g. TMPDIR=$(mktemp -d)
    // silently returning empty). execFile hands `command` to `bash -c` as one
    // argv element, byte-for-byte, with no intermediate shell at all.
    const [file, args]: [string, string[]] = config.inContainer
      ? ['bash', ['-c', command]]
      : ['docker', ['exec', '-w', resolvedCwd, config.sandboxContainer, 'bash', '-c', command]]

    const { stdout, stderr } = await execFileAsync(file, args, {
      timeout,
      ...(config.inContainer ? { cwd: resolvedCwd } : {}),
    })
    const output = truncateOutput(stdout + stderr, MAX_OUTPUT)
    return { output: output || NO_OUTPUT }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string; killed?: boolean }
    const output = truncateOutput(((e.stderr ?? '') + (e.stdout ?? '')) || (e.message ?? 'Unknown error'), MAX_OUTPUT)
    // execFile sets killed:true when its own timeout option fired — distinct from a
    // real crash/non-zero-exit, and previously indistinguishable from one (both just
    // said "Command failed"), which is what made a slow-but-working command look like
    // a broken one with no signal pointing at the actual cause.
    const error = e.killed ? `Command timed out after ${timeout / 1000}s` : 'Command failed'
    return { output, error }
  }
}
