import fs from 'fs/promises'
import path from 'path'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'

// path.resolve() is purely lexical — it does not follow symlinks. A symlink
// created inside /workspace or /scratch pointing elsewhere (trivially doable
// via the unrestricted `bash` tool: `ln -s /etc /workspace/x`) would pass the
// lexical check below, then fs.readFile/writeFile would follow it for real.
// This does not cross the actual security boundary (the container — see
// CLAUDE.md's Zero trust section; bash already has unrestricted access to
// everything reachable this way), but it means write_file/read_file's own
// stated guarantee ("outside workspace not allowed") wasn't actually true
// once a symlink was involved. realpathBoundary re-checks the *real* path
// after resolving whatever prefix of it already exists.
async function realpathBoundary(resolved: string, root: string): Promise<string> {
  const realRoot = await fs.realpath(root).catch(() => root)
  let dir = resolved
  const suffix: string[] = []
  // Walk up to the first existing ancestor — write_file's target may not
  // exist yet, but realpath requires an existing path.
  for (;;) {
    try {
      await fs.access(dir)
      break
    } catch {
      suffix.unshift(path.basename(dir))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const realDir = await fs.realpath(dir).catch(() => dir)
  const real = suffix.length ? path.join(realDir, ...suffix) : realDir
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new Error(`Path traversal outside ${path.basename(root)} not allowed (resolved outside the sandbox via symlink)`)
  }
  return real
}

async function safePath(filePath: string): Promise<string> {
  // /scratch/... paths → resolve against scratchPath
  if (filePath.startsWith('/scratch')) {
    const rel = filePath.replace(/^\/scratch\/?/, '')
    const resolved = path.resolve(config.scratchPath, rel)
    // Exact-match or path-separator boundary, not a bare prefix — otherwise a
    // sibling directory like /scratch-evil would incorrectly pass a plain
    // .startsWith(config.scratchPath) check.
    if (resolved !== config.scratchPath && !resolved.startsWith(config.scratchPath + path.sep)) {
      throw new Error('Path traversal outside scratch not allowed')
    }
    return realpathBoundary(resolved, config.scratchPath)
  }
  // /workspace/... paths (or bare relative paths) → resolve against workspacePath
  if (!config.workspacePath) throw new Error('No workspace mounted')
  const rel = filePath.replace(/^\/workspace\/?/, '')
  const resolved = path.resolve(config.workspacePath, rel)
  if (resolved !== config.workspacePath && !resolved.startsWith(config.workspacePath + path.sep)) {
    throw new Error('Path traversal outside workspace not allowed')
  }
  return realpathBoundary(resolved, config.workspacePath)
}

export async function readFile(filePath: string): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    const content = await fs.readFile(abs, 'utf-8')
    return { output: content.slice(0, 8000) }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}

export async function writeFile(filePath: string, content: string): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, 'utf-8')
    return { output: `Written: ${filePath}` }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
