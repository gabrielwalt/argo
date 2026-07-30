import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSupportedImage, DEFAULT_VIEW_PROMPT, buildVisionRequest } from './view-image.js'

test('isSupportedImage accepts the supported extensions, case-insensitively', () => {
  assert.equal(isSupportedImage('/workspace/screenshot.png'), true)
  assert.equal(isSupportedImage('/workspace/photo.jpg'), true)
  assert.equal(isSupportedImage('/workspace/photo.jpeg'), true)
  assert.equal(isSupportedImage('/workspace/diagram.webp'), true)
  assert.equal(isSupportedImage('/workspace/anim.gif'), true)
  assert.equal(isSupportedImage('/workspace/SCREENSHOT.PNG'), true)
  assert.equal(isSupportedImage('/workspace/Photo.JPG'), true)
})

test('isSupportedImage rejects non-image extensions and no extension', () => {
  assert.equal(isSupportedImage('/workspace/notes.txt'), false)
  assert.equal(isSupportedImage('/workspace/index.js'), false)
  assert.equal(isSupportedImage('/workspace/README'), false)
  assert.equal(isSupportedImage('/workspace/dir/'), false)
})

test('DEFAULT_VIEW_PROMPT is a non-empty, usable default', () => {
  assert.equal(typeof DEFAULT_VIEW_PROMPT, 'string')
  assert.ok(DEFAULT_VIEW_PROMPT.trim().length > 0)
})

test('buildVisionRequest shapes the Ollama /api/chat vision request correctly', () => {
  const req = buildVisionRequest('qwen2.5vl:7b', 'ZmFrZS1iYXNlNjQ=', 'What is in this image?')
  assert.equal(req.model, 'qwen2.5vl:7b')
  assert.equal(req.stream, false)
  assert.equal(req.messages.length, 1)
  assert.equal(req.messages[0].role, 'user')
  assert.equal(req.messages[0].content, 'What is in this image?')
  assert.deepEqual(req.messages[0].images, ['ZmFrZS1iYXNlNjQ='])
})
