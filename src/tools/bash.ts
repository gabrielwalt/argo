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

// Most commands finish in well under this; keeping it low means a genuinely
// stuck command fails fast rather than blocking the run for minutes.
const DEFAULT_TIMEOUT_MS = 30_000
// Playwright commands routinely need a browser launch + page load + a real
// wait for a page/animation to do something — 30s isn't a fair default for
// them specifically (confirmed live: a verification run burned 5 retries and
// ~7 minutes hitting this exact wall before switching approach entirely,
// because "Command failed" gave no hint the real cause was just the clock).
const PLAYWRIGHT_DEFAULT_TIMEOUT_MS = 120_000
// A ceiling on the model's own timeout_ms request — long enough for real
// Playwright work, short enough that a stuck command can't block a run
// indefinitely.
const MAX_TIMEOUT_MS = 180_000
const PLAYWRIGHT_PATTERN = /playwright|chromium|firefox\.launch|webkit\.launch/i

// Pure and separately testable: given the command text and whatever the model
// asked for, what timeout should actually apply. A command that mentions
// Playwright gets a higher default even if the model didn't ask for one —
// it's the one case where 30s was never realistic to begin with. It also gets
// a FLOOR at that same 120s default even when the model DID explicitly ask for
// less: confirmed live, a Tester passed timeout_ms:30000 on a Playwright script
// (the model has no real sense of browser launch + page load cost and routinely
// underestimates it), which — before this floor — overrode the Playwright
// default entirely and produced the exact 30s-wall failure this default exists
// to prevent, indistinguishable from a real hang.
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
