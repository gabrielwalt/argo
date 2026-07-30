import { spawn } from 'child_process'
import { config } from './config.js'

// LAYOUT JUDGE (flag-gated, default OFF — unproven). The visual-layout analogue of
// the GROUNDING guard (see grounding.ts): a PRE-DONE check for tasks that produced a
// viewable HTML artifact. Instead of fact-checking prose against sources, it renders
// the artifact in a headless browser, screenshots it, and asks the LOCAL VISION MODEL
// (config.visionModel, qwen2.5vl) whether the RENDERED page has a clear layout
// problem — content cut off, horizontal overflow, overlapping/misaligned elements,
// text overrunning its container, huge unintended gaps, or obviously broken
// structure — before the run is allowed to finish.
//
// Self-contained, mirroring three existing patterns so nothing here is novel:
//   - selection            : editedPaths bookkeeping, same as grounding.ts's isDocPath.
//   - render + screenshot  : tools/browser-fetch.ts's subprocess Playwright launch
//                            (`require('playwright')`, chromium.launch, page.goto),
//                            just goto'ing a local file:// URL and screenshotting
//                            instead of scraping innerText.
//   - vision call           : tools/view-image.ts's Ollama /api/chat vision request.
//   - verdict parse         : critic.ts's tolerant "extract the first balanced JSON
//                            object" technique, adapted to the {ok, issues} shape.
//
// FAILS OPEN EVERYWHERE. A broken judge (render failure, unreachable Ollama, timeout,
// unparseable reply) must NEVER block a legitimate finish — every failure path here
// resolves to { ok: true, issues: [] }, never a thrown error.

export interface LayoutVerdict {
  ok: boolean
  issues: string[]
}

const HTML_EXTS = ['.html', '.htm']

// Picks the artifact to judge: the most-recently-edited path under /workspace ending
// in .html/.htm. editedPaths is oldest→newest (see agent.ts's ACTOR-CRITIC
// bookkeeping), so we scan from the end. Returns null when the run touched no HTML
// file — the check is then a no-op (nothing to render), never a block.
export function selectLayoutArtifact(editedPaths: string[]): string | null {
  for (let i = editedPaths.length - 1; i >= 0; i--) {
    const p = editedPaths[i]
    if (!p) continue
    const s = p.toLowerCase()
    if (!s.startsWith('/workspace')) continue
    if (HTML_EXTS.some(ext => s.endsWith(ext))) return p
  }
  return null
}

// The vision-model instruction. Deliberately narrow and conservative — this is a
// LAYOUT-only check (never content, wording, or design taste), and it must not flag a
// page merely for looking plain or unremarkable. Locked to the same terse JSON
// contract style as grounding.ts / critic.ts so the parser stays simple.
export const DEFAULT_LAYOUT_PROMPT = `You are reviewing a screenshot of a rendered web page or document, taken right before an AI agent declares its task finished. Examine ONLY the VISUAL LAYOUT of the rendering — never the content, wording, or design taste. Report CLEAR layout problems only:
- content that is cut off or truncated (text or elements running past the visible area)
- horizontal overflow, or a scrollbar forced by content wider than the viewport
- overlapping or misaligned elements
- text overrunning its container (spilling out of a box/card/column)
- huge, obviously unintended empty gaps
- structure that is clearly broken (a collapsed layout, a table/grid that has fallen apart)

Be conservative: a page that is merely plain, sparse, minimal, or stylistically unremarkable is NOT a problem — only flag things that are clearly, concretely broken.

Respond with EXACTLY one JSON object and nothing else (no prose, no markdown, no code fences, no <think>):
{"ok": boolean, "issues": [string, ...]}
- "ok": true when the layout looks clean (no clear problems found).
- "ok": false ONLY when you found at least one clear problem above.
- "issues": short, specific findings, one per problem; empty array when "ok" is true.`

export interface LayoutRequest {
  model: string
  messages: [{ role: 'user'; content: string; images: string[] }]
  stream: false
}

// Pure request-shape builder (no network), mirroring view-image.ts's
// buildVisionRequest — the Ollama /api/chat vision contract: one user message, raw
// base64 image bytes (no data-URI prefix) in `images`.
export function buildLayoutRequest(model: string, base64Image: string, prompt: string): LayoutRequest {
  return {
    model,
    messages: [{ role: 'user', content: prompt, images: [base64Image] }],
    stream: false,
  }
}

// Extracts the first balanced {...} object from a string, ignoring braces inside JSON
// string literals. Mirrors critic.ts's extractFirstJsonObject exactly (kept local so
// this module stays self-contained). Returns null if none is found.
function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase())
  return false
}

const OK_VERDICT: LayoutVerdict = { ok: true, issues: [] }

// Robust parse of the vision model's raw reply: strips <think> blocks and code fences
// (some local models emit either despite an explicit "no code fences" instruction),
// takes the first balanced JSON object, and coerces it to {ok, issues}. ANY failure —
// no object found, malformed JSON, wrong shape — falls back to OK_VERDICT: this check
// must fail OPEN, never block a finish because the model's reply didn't parse.
export function parseLayoutVerdict(raw: string): LayoutVerdict {
  if (!raw) return OK_VERDICT
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '')
  const obj = extractFirstJsonObject(s)
  if (!obj) return OK_VERDICT
  try {
    const parsed = JSON.parse(obj) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return OK_VERDICT
    const issues = Array.isArray(parsed.issues) ? parsed.issues.map(x => String(x)).filter(Boolean) : []
    // Respect an explicit "ok" field; an absent one defaults to true (fail open).
    const ok = 'ok' in parsed ? asBool(parsed.ok) : true
    return { ok, issues }
  } catch {
    return OK_VERDICT
  }
}

// --- render + screenshot + judge -------------------------------------------------

// Bounded so a single stuck render can't wedge a run's completion indefinitely.
const SCREENSHOT_TIMEOUT_MS = 30_000
// qwen2.5vl can cold-load slowly (a fresh model pull into the Ollama runner) — mirrors
// view-image.ts's VISION_TIMEOUT_MS.
const VISION_TIMEOUT_MS = 120_000

// Read directly from the env (not config.ollamaHost, whose fallback is
// 'http://localhost:11434' for standalone/host dev) — mirrors view-image.ts: this
// judge only ever needs the Ollama that is reachable from wherever the harness
// process itself runs.
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://host.docker.internal:11434'

// Builds the Node script piped into the subprocess, exactly mirroring
// tools/browser-fetch.ts's makeScript: launch headless chromium, navigate, then act
// (there: scrape innerText; here: screenshot) and write the result to stdout.
function makeScreenshotScript(absPath: string): string {
  return `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1600 } });
  try {
    await page.goto('file://' + ${JSON.stringify(absPath)}, { waitUntil: 'load', timeout: 20000 });
    const buf = await page.screenshot({ type: 'png' });
    process.stdout.write(buf.toString('base64'));
  } catch (e) {
    process.stderr.write('Error: ' + e.message + '\\n');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
`.trim()
}

// Renders absPath (a container-local path, e.g. '/workspace/index.html') in headless
// chromium and returns a base64-encoded PNG screenshot. Mirrors browser-fetch.ts's
// subprocess-launch pattern exactly (works in-container directly, or via `docker
// exec` into the sandbox container when the harness process runs on the host).
// Rejects on any render failure/timeout — checkLayout below catches it and fails open.
function captureScreenshot(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const [cmd, args] = config.inContainer
      ? ['node', ['--input-type=commonjs']]
      : ['docker', ['exec', '-i', config.sandboxContainer, 'node', '--input-type=commonjs']]

    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error(`Screenshot timed out after ${SCREENSHOT_TIMEOUT_MS / 1000}s`))
    }, SCREENSHOT_TIMEOUT_MS)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !stdout.trim()) reject(new Error(stderr.slice(0, 500) || `Exit code ${code}`))
      else resolve(stdout.trim())
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    proc.stdin.write(makeScreenshotScript(absPath))
    proc.stdin.end()
  })
}

// Calls the local vision model with the screenshot + DEFAULT_LAYOUT_PROMPT, mirroring
// view-image.ts's fetch call to Ollama's /api/chat.
async function judgeScreenshot(base64Png: string): Promise<LayoutVerdict> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS)
  try {
    const resp = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLayoutRequest(config.visionModel, base64Png, DEFAULT_LAYOUT_PROMPT)),
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error(`layout judge: Ollama returned ${resp.status} ${resp.statusText}`)
    const data = (await resp.json()) as { message?: { content?: string } }
    return parseLayoutVerdict(data.message?.content ?? '')
  } finally {
    clearTimeout(timer)
  }
}

// The full pre-done layout check: render the artifact, screenshot it, ask the vision
// model to judge it, parse the verdict. Called by agent.ts only when config.layout /
// this.layout is on AND selectLayoutArtifact found an HTML artifact this run. FAILS
// OPEN on ANY error at any stage (render failure, unreachable model, timeout,
// unparseable reply) — never throws, always resolves.
export async function checkLayout(absPath: string): Promise<LayoutVerdict> {
  try {
    const b64 = await captureScreenshot(absPath)
    return await judgeScreenshot(b64)
  } catch {
    return OK_VERDICT
  }
}
