import fs from 'fs/promises'
import path from 'path'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'

function safePath(filePath: string): string {
  // /scratch/... paths → resolve against scratchPath
  if (filePath.startsWith('/scratch')) {
    const rel = filePath.replace(/^\/scratch\/?/, '')
    const resolved = path.resolve(config.scratchPath, rel)
    if (!resolved.startsWith(config.scratchPath)) throw new Error('Path traversal outside scratch not allowed')
    return resolved
  }
  // /workspace/... paths (or bare relative paths) → resolve against workspacePath
  const rel = filePath.replace(/^\/workspace\/?/, '')
  const resolved = path.resolve(config.workspacePath, rel)
  if (!resolved.startsWith(config.workspacePath)) throw new Error('Path traversal outside workspace not allowed')
  return resolved
}

export async function readFile(filePath: string): Promise<ToolResult> {
  try {
    const abs = safePath(filePath)
    const content = await fs.readFile(abs, 'utf-8')
    return { output: content.slice(0, 8000) }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}

export async function writeFile(filePath: string, content: string): Promise<ToolResult> {
  try {
    const abs = safePath(filePath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf-8')
    return { output: `Written: ${filePath}` }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
