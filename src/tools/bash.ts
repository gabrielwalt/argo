import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 4000

// The only two working directories bash may start in. Not a security boundary
// (the container is — see CLAUDE.md's Zero trust section) — this just keeps
// the model's choice structured (an enum field) instead of a free-form shell
// idiom ("cd /workspace && ...") it has to remember to type correctly every
// time. Anything else supplied falls back to the default, it never lets the
// model set an arbitrary cwd.
const ALLOWED_CWD = new Set(['/workspace', '/scratch'])

export async function bash(command: string, cwd?: string): Promise<ToolResult> {
  const resolvedCwd = cwd && ALLOWED_CWD.has(cwd) ? cwd : '/scratch'
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
      timeout: 30_000,
      ...(config.inContainer ? { cwd: resolvedCwd } : {}),
    })
    const output = truncateOutput(stdout + stderr, MAX_OUTPUT)
    return { output: output || '(no output)' }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const output = truncateOutput(((e.stderr ?? '') + (e.stdout ?? '')) || (e.message ?? 'Unknown error'), MAX_OUTPUT)
    return { output, error: 'Command failed' }
  }
}
