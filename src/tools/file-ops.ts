import fs from 'fs/promises'
import path from 'path'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

// path.resolve() is purely lexical — it does not follow symlinks. A symlink
// created inside /workspace pointing elsewhere (trivially doable via the
// unrestricted `bash` tool: `ln -s /etc /workspace/x`) would pass the
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
  // /workspace is the only path whose confinement matters — it's the user's
  // git-tracked deliverable, not a security boundary (the container already
  // is one — see CLAUDE.md's Zero trust section; bash has unrestricted reach
  // regardless) but a workflow guarantee: a write must land inside the real
  // repo, not silently escape it via ../ or (trivially, via bash) a symlink.
  // Exact match or a real path-separator boundary, not a bare .startsWith —
  // otherwise "/workspace-evil/..." would incorrectly match this branch too.
  if (filePath === '/workspace' || filePath.startsWith('/workspace/')) {
    if (!config.workspacePath) throw new Error('No workspace mounted')
    const rel = filePath.replace(/^\/workspace\/?/, '')
    const resolved = path.resolve(config.workspacePath, rel)
    if (resolved !== config.workspacePath && !resolved.startsWith(config.workspacePath + path.sep)) {
      throw new Error('Path traversal outside workspace not allowed')
    }
    return realpathBoundary(resolved, config.workspacePath)
  }
  // Anywhere else in the container is ordinary, unmanaged filesystem — bash
  // already has unrestricted reach here, so rejecting it bought nothing but
  // confusion. No confinement, just normal path resolution.
  return path.resolve(filePath)
}

export async function readFile(filePath: string): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    const content = await fs.readFile(abs, 'utf-8')
    return { output: truncateOutput(content, 8000) }
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

// A few lines of context around the edited region, line-numbered, so the caller
// can confirm the change landed where expected WITHOUT re-reading the file —
// the "did my edit apply? let me look again…" round trip is the loop this
// avoids. matchIndex is the byte offset of the (first) replacement in `updated`.
function editedRegion(updated: string, newString: string, matchIndex: number): string {
  const startLine = updated.slice(0, matchIndex).split('\n').length - 1  // 0-based
  const newLineCount = newString ? newString.split('\n').length : 1
  const lines = updated.split('\n')
  const from = Math.max(0, startLine - 2)
  const to = Math.min(lines.length, startLine + newLineCount + 2)
  return lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n')
}

// Exact-string replace that always reports what it did — the point is the
// feedback, not the mechanism. It confirms how many occurrences changed and
// echoes the updated region; it errors loudly (and changes nothing) when the
// text is missing or ambiguous, instead of silently no-op'ing the way `sed -i`
// does. That unambiguous signal is what lets the model stop guessing.
export async function editFile(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<ToolResult> {
  try {
    const abs = await safePath(filePath)
    let content: string
    try {
      content = await fs.readFile(abs, 'utf-8')
    } catch {
      return { output: '', error: `File not found: ${filePath} — read it first, or use write_file to create it.` }
    }
    if (oldString === '') {
      return { output: '', error: 'old_string is empty — give the exact existing text to replace (or use write_file to create/overwrite a file).' }
    }
    if (oldString === newString) {
      return { output: '', error: 'old_string and new_string are identical — nothing to change.' }
    }
    const matchIndex = content.indexOf(oldString)
    if (matchIndex === -1) {
      return { output: '', error: `old_string not found in ${filePath}; the file was NOT modified. It must match exactly, including whitespace and indentation — read the current file and copy the target text verbatim.` }
    }
    const occurrences = content.split(oldString).length - 1
    if (occurrences > 1 && !replaceAll) {
      return { output: '', error: `old_string matches ${occurrences} places in ${filePath}; the file was NOT modified. Include surrounding context to target a single one, or pass replace_all: true to change all ${occurrences}.` }
    }
    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.slice(0, matchIndex) + newString + content.slice(matchIndex + oldString.length)
    await fs.writeFile(abs, updated, 'utf-8')
    const n = replaceAll ? occurrences : 1
    return { output: truncateOutput(`Edited ${filePath} — replaced ${n} occurrence${n === 1 ? '' : 's'}. Updated region:\n${editedRegion(updated, newString, matchIndex)}`, 4000) }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
