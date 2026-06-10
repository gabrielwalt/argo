import { exec } from 'child_process'
import { promisify } from 'util'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'

const execAsync = promisify(exec)
const MAX_OUTPUT = 4000

export async function bash(command: string): Promise<ToolResult> {
  try {
    const cmd = config.inContainer
      ? `bash -c ${JSON.stringify(command)}`
      : `docker exec ${config.sandboxContainer} bash -c ${JSON.stringify(command)}`

    const { stdout, stderr } = await execAsync(cmd, {
      timeout: 30_000,
      ...(config.inContainer ? { cwd: '/scratch' } : {}),
    })
    const output = (stdout + stderr).slice(0, MAX_OUTPUT)
    return { output: output || '(no output)' }
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const output = (((e.stderr ?? '') + (e.stdout ?? '')) || (e.message ?? 'Unknown error')).slice(0, MAX_OUTPUT)
    return { output, error: 'Command failed' }
  }
}
