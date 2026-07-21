import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

const execFileAsync = promisify(execFile)
const MAX_OUTPUT = 4000

export async function bash(command: string, cwd?: string): Promise<ToolResult> {
  // The container is the security boundary (see CLAUDE.md's Zero trust
  // section), not any particular path within it — so cwd accepts any
  // absolute path, not just an enum. Defaults to /workspace, the one
  // directory that's actually special (the user's project); this just spares
  // the model from typing "cd /workspace && ..." for the common case.
  const resolvedCwd = cwd && cwd.startsWith('/') ? cwd : '/workspace'
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
