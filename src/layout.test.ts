import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectLayoutArtifact, DEFAULT_LAYOUT_PROMPT, buildLayoutRequest, parseLayoutVerdict } from './layout.js'

test('selectLayoutArtifact picks the most-recently-edited .html path under /workspace', () => {
  const edited = ['/workspace/notes.md', '/workspace/index.html', '/workspace/src/app.ts', '/workspace/about.htm']
  assert.equal(selectLayoutArtifact(edited), '/workspace/about.htm')
})

test('selectLayoutArtifact ignores non-html files and files outside /workspace', () => {
  const edited = ['/workspace/README.md', '/tmp/scratch.html', '/workspace/app.js']
  assert.equal(selectLayoutArtifact(edited), null)
})

test('selectLayoutArtifact returns null when editedPaths is empty', () => {
  assert.equal(selectLayoutArtifact([]), null)
})

test('selectLayoutArtifact is case-insensitive on extension and prefix scan order', () => {
  const edited = ['/workspace/first.HTML', '/workspace/notes.md', '/workspace/second.HTM']
  assert.equal(selectLayoutArtifact(edited), '/workspace/second.HTM')
})

test('DEFAULT_LAYOUT_PROMPT is a non-empty prompt that mentions the JSON contract', () => {
  assert.equal(typeof DEFAULT_LAYOUT_PROMPT, 'string')
  assert.ok(DEFAULT_LAYOUT_PROMPT.trim().length > 0)
  assert.match(DEFAULT_LAYOUT_PROMPT, /JSON/)
  assert.match(DEFAULT_LAYOUT_PROMPT, /"ok"/)
  assert.match(DEFAULT_LAYOUT_PROMPT, /"issues"/)
})

test('buildLayoutRequest shapes the Ollama /api/chat vision request correctly', () => {
  const req = buildLayoutRequest('qwen2.5vl:7b', 'ZmFrZS1iYXNlNjQ=', 'judge this layout')
  assert.equal(req.model, 'qwen2.5vl:7b')
  assert.equal(req.stream, false)
  assert.equal(req.messages.length, 1)
  assert.equal(req.messages[0].role, 'user')
  assert.equal(req.messages[0].content, 'judge this layout')
  assert.deepEqual(req.messages[0].images, ['ZmFrZS1iYXNlNjQ='])
})

test('parseLayoutVerdict parses a clean ok:true JSON verdict', () => {
  const v = parseLayoutVerdict('{"ok": true, "issues": []}')
  assert.deepEqual(v, { ok: true, issues: [] })
})

test('parseLayoutVerdict parses a clean ok:false JSON verdict with issues', () => {
  const v = parseLayoutVerdict('{"ok": false, "issues": ["text overflows its container", "horizontal scrollbar present"]}')
  assert.equal(v.ok, false)
  assert.deepEqual(v.issues, ['text overflows its container', 'horizontal scrollbar present'])
})

test('parseLayoutVerdict extracts a JSON object embedded in surrounding prose', () => {
  const raw = 'Sure, here is my verdict:\n{"ok": false, "issues": ["content is cut off"]}\nLet me know if you need more detail.'
  const v = parseLayoutVerdict(raw)
  assert.equal(v.ok, false)
  assert.deepEqual(v.issues, ['content is cut off'])
})

test('parseLayoutVerdict strips <think> blocks and code fences before extracting JSON', () => {
  const raw = '<think>examining the screenshot...</think>\n```json\n{"ok": false, "issues": ["overlapping elements"]}\n```'
  const v = parseLayoutVerdict(raw)
  assert.equal(v.ok, false)
  assert.deepEqual(v.issues, ['overlapping elements'])
})

test('parseLayoutVerdict fails OPEN to {ok:true, issues:[]} on unparseable garbage', () => {
  assert.deepEqual(parseLayoutVerdict('not json at all, just a description of the image'), { ok: true, issues: [] })
  assert.deepEqual(parseLayoutVerdict(''), { ok: true, issues: [] })
  assert.deepEqual(parseLayoutVerdict('{not: valid json}'), { ok: true, issues: [] })
})

test('parseLayoutVerdict defaults ok to true when the field is absent (fail open)', () => {
  const v = parseLayoutVerdict('{"issues": ["something"]}')
  assert.equal(v.ok, true)
})
