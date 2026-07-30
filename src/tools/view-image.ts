import fs from 'fs/promises'
import path from 'path'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'

// Same set of formats Ollama's vision models accept as raw image bytes.
const SUPPORTED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])

// Pure — no fs access — so it's cheaply unit-testable and reusable before ever
// touching disk (checked before the read, so a wrong extension fails fast with
// a clear message instead of an opaque decode error from the vision model).
export function isSupportedImage(filePath: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLowerCase())
}

// Generic enough for a plain "what's in this image" ask, but explicitly names the
// UI-layout-judging use case (alignment/overflow/overlap/truncation) since that's
// the harness's main reason to reach for this tool over just describing a screenshot.
export const DEFAULT_VIEW_PROMPT =
  'Describe this image in detail. Note any text, and for a UI/layout, flag alignment problems, overflow, overlap, or truncation.'

export interface VisionRequest {
  model: string
  messages: [{ role: 'user'; content: string; images: string[] }]
  stream: false
}

// Pure request-shape builder, kept separate from the fetch call so it's testable
// without a network — the Ollama /api/chat vision contract: one user message,
// base64 image bytes (no data-URI prefix) in `images`.
export function buildVisionRequest(model: string, base64Image: string, prompt: string): VisionRequest {
  return {
    model,
    messages: [{ role: 'user', content: prompt, images: [base64Image] }],
    stream: false,
  }
}

// Mirrors file-ops.ts's safePath: only /workspace is confined (the user's
// git-tracked project — a workflow guarantee, not the real security boundary,
// which is the container itself). Anywhere else in the container is ordinary,
// unmanaged filesystem, resolved as-is. Lexical only (no realpath/symlink
// re-check) — acceptable here since this tool only ever reads bytes to hand to
// the vision model, never writes.
function resolveImagePath(filePath: string): string {
  if (filePath === '/workspace' || filePath.startsWith('/workspace/')) {
    if (!config.workspacePath) throw new Error('No workspace mounted')
    const rel = filePath.replace(/^\/workspace\/?/, '')
    const resolved = path.resolve(config.workspacePath, rel)
    if (resolved !== config.workspacePath && !resolved.startsWith(config.workspacePath + path.sep)) {
      throw new Error('Path traversal outside workspace not allowed')
    }
    return resolved
  }
  return path.resolve(filePath)
}

// qwen2.5vl can cold-load slowly (a fresh model pull into the Ollama runner) —
// generous enough that a first call doesn't spuriously time out, short enough
// that a genuinely stuck request doesn't block a run indefinitely.
const VISION_TIMEOUT_MS = 120_000

// Read directly from the env here (not config.ollamaHost, whose fallback is
// 'http://localhost:11434' for standalone/host dev) — view_image only ever runs
// inside the sandboxed worker container, where Ollama lives on the host.
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://host.docker.internal:11434'

// Lets the model SEE an image (screenshot, diagram, rendered UI) and ask a
// question about it, answered by a local vision model (config.visionModel).
// Never throws — every failure mode (bad extension, missing file, traversal,
// network/HTTP error, timeout, empty response) returns the {output, error}
// shape executeTool expects.
export async function viewImage(filePath: string, prompt?: string): Promise<ToolResult> {
  if (!isSupportedImage(filePath)) {
    return { output: '', error: `Unsupported image type: ${filePath} — supported: ${[...SUPPORTED_EXTENSIONS].join(', ')}` }
  }

  let abs: string
  try {
    abs = resolveImagePath(filePath)
  } catch (err) {
    return { output: '', error: String(err) }
  }

  let bytes: Buffer
  try {
    bytes = await fs.readFile(abs)
  } catch {
    return { output: '', error: `File not found: ${filePath}` }
  }

  const effectivePrompt = prompt?.trim() ? prompt : DEFAULT_VIEW_PROMPT
  const b64 = bytes.toString('base64')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS)
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildVisionRequest(config.visionModel, b64, effectivePrompt)),
      signal: controller.signal,
    })
    if (!resp.ok) {
      return { output: '', error: `view_image failed: Ollama returned ${resp.status} ${resp.statusText}` }
    }
    const data = await resp.json() as { message?: { content?: string } }
    const content = data.message?.content
    if (!content) {
      return { output: '', error: 'view_image failed: empty response from vision model' }
    }
    return { output: content }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    const reason = timedOut ? `timed out after ${VISION_TIMEOUT_MS / 1000}s` : String(err)
    return { output: '', error: `view_image failed: ${reason}` }
  } finally {
    clearTimeout(timer)
  }
}
