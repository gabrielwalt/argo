import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findNumericConflicts,
  extractTemperaturesC,
  clusterValues,
  isDocPath,
  normalizeText,
  buildGroundingUserPrompt,
} from './grounding.js'

test('flags two conflicting furnace temperatures (space-separated, °C)', () => {
  const t = 'Le four chauffe le sable à 1 150 °C. Plus tard, le verre atteint 2 100 °C.'
  assert.equal(findNumericConflicts(t).length, 1)
})

test('no conflict when one temperature is repeated in several forms', () => {
  const t = 'à 1 200 °C ... encore 1200°C ... et toujours 1 200 °C.'
  assert.deepEqual(findNumericConflicts(t), [])
})

test('°F is converted to °C and clusters with a consistent °C mention', () => {
  // 2000 °F ≈ 1093 °C, within tolerance of 1100 °C → consistent, no conflict.
  const t = 'about 2000 °F which is roughly 1 100 °C'
  assert.deepEqual(findNumericConflicts(t), [])
})

test('intro/step/stat temperatures that disagree are flagged', () => {
  const t = 'plus de 1 400 °C ... on chauffe la canne à 2 000 °F ... trois chiffres : 1 100 °C'
  assert.equal(findNumericConflicts(t).length, 1)
})

test('&nbsp; and &deg; entities are handled', () => {
  const t = 'chauffé à 1&nbsp;150&nbsp;&deg;C puis à 2&nbsp;100&nbsp;&deg;C'
  assert.equal(findNumericConflicts(t).length, 1)
})

test('"degrés Celsius" spelled out is detected', () => {
  const t = 'environ 1150 degrés Celsius dans le four, puis 2100 degrés Celsius'
  assert.equal(findNumericConflicts(t).length, 1)
})

test('extractTemperaturesC ignores non-temperature numbers', () => {
  const t = 'fondé en 1987, 4 pages, 5 étapes, 24 h de repos, à 1 200 °C'
  assert.deepEqual(extractTemperaturesC(t), [1200])
})

test('clusterValues splits on a gap larger than tolerance', () => {
  assert.equal(clusterValues([1093, 1100, 1400], 75).length, 2)
  assert.equal(clusterValues([1180, 1200, 1220], 75).length, 1)
})

test('isDocPath: workspace docs only', () => {
  assert.equal(isDocPath('/workspace/bille.html'), true)
  assert.equal(isDocPath('/workspace/notes.md'), true)
  assert.equal(isDocPath('/workspace/README.txt'), true)
  assert.equal(isDocPath('/workspace/src/app.ts'), false)
  assert.equal(isDocPath('/workspace/src/index.js'), false)
  assert.equal(isDocPath('/tmp/scratch.md'), false)
  assert.equal(isDocPath(''), false)
})

test('normalizeText strips tags and flattens NBSP', () => {
  assert.equal(normalizeText('<p>1&nbsp;200&nbsp;&deg;C</p>'), '1 200 \u00b0C')
})

test('buildGroundingUserPrompt embeds source excerpts, conflicts, and doc text', () => {
  const p = buildGroundingUserPrompt({
    objective: 'build a booklet',
    docText: 'HELLO DOC',
    sourceExcerpts: [{ url: 'https://example.com', text: 'SOURCE BODY 1987' }],
    numericConflicts: ['temperature conflict ~1150°C vs 2100°C'],
  })
  assert.match(p, /https:\/\/example\.com/)
  assert.match(p, /SOURCE BODY 1987/)
  assert.match(p, /temperature conflict/)
  assert.match(p, /HELLO DOC/)
  assert.match(p, /WRITING \/ RESEARCH task/)
})
