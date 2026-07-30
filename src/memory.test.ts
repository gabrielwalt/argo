import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseMarkdownSections,
  scoreSectionRelevance,
  selectAgentsSections,
  selectMemoryEntries,
  renderRecallPointer,
  formatMemoryAppend,
  dedupeAgainst,
  persistToMemory,
  type MarkdownSection,
} from './memory.js'

// ── parseMarkdownSections ─────────────────────────────────────────

test('parseMarkdownSections: empty string yields no sections', () => {
  assert.deepEqual(parseMarkdownSections(''), [])
})

test('parseMarkdownSections: preamble-only doc is one level-0 section', () => {
  const secs = parseMarkdownSections('just some intro text\nno headings here')
  assert.equal(secs.length, 1)
  assert.equal(secs[0].heading, '')
  assert.equal(secs[0].level, 0)
  assert.equal(secs[0].body, 'just some intro text\nno headings here')
})

test('parseMarkdownSections: multiple headings incl. nested levels', () => {
  const md = 'preamble\n# Top\ntop body\n## Nested\nnested body\n### Deep\ndeep body'
  const secs = parseMarkdownSections(md)
  assert.deepEqual(secs.map(s => [s.heading, s.level]), [
    ['', 0],
    ['Top', 1],
    ['Nested', 2],
    ['Deep', 3],
  ])
  assert.equal(secs[1].body, 'top body')
  assert.equal(secs[2].body, 'nested body')
})

test('parseMarkdownSections: leading heading has no blank preamble section', () => {
  const secs = parseMarkdownSections('# Only\nbody')
  assert.equal(secs.length, 1)
  assert.equal(secs[0].heading, 'Only')
})

test('parseMarkdownSections: CRLF input is normalised', () => {
  const secs = parseMarkdownSections('# H\r\nline one\r\nline two\r\n')
  assert.equal(secs[0].heading, 'H')
  assert.equal(secs[0].body, 'line one\nline two')
})

test('parseMarkdownSections: heading trailing whitespace is trimmed', () => {
  const secs = parseMarkdownSections('#   Spaced   \nx')
  assert.equal(secs[0].heading, 'Spaced')
})

test('parseMarkdownSections: # inside a fenced code block is not a heading', () => {
  const md = '# Real\n```\n# not a heading\n```\nafter'
  const secs = parseMarkdownSections(md)
  assert.equal(secs.length, 1)
  assert.equal(secs[0].heading, 'Real')
})

test('parseMarkdownSections: raw round-trips (concatenation reconstructs the doc)', () => {
  const md = 'preamble line\n# One\nbody one\n## Two\nbody two'
  const secs = parseMarkdownSections(md)
  assert.equal(secs.map(s => s.raw).join('\n'), md)
})

// ── scoreSectionRelevance ─────────────────────────────────────────

function section(heading: string, body: string): MarkdownSection {
  return { heading, level: heading ? 2 : 0, body, raw: heading ? `## ${heading}\n${body}` : body }
}

test('scoreSectionRelevance: heading match outweighs a body-only match', () => {
  const query = { text: 'update the checkout flow' }
  const inHeading = scoreSectionRelevance(section('Checkout rules', 'unrelated body'), query)
  const inBody = scoreSectionRelevance(section('Misc', 'the checkout logic lives here'), query)
  assert.ok(inHeading > inBody, `heading ${inHeading} should beat body ${inBody}`)
})

test('scoreSectionRelevance: filename basenames become query tokens', () => {
  const query = { text: 'fix a bug', files: ['src/store/cart.ts'] }
  const hit = scoreSectionRelevance(section('Cart', 'shopping cart invariants'), query)
  assert.ok(hit > 0, 'cart.ts basename should match a Cart section')
})

test('scoreSectionRelevance: stopwords and short tokens are ignored', () => {
  // "the", "to", "is" are stopwords; "we" and "it" too — no content overlap.
  const s = scoreSectionRelevance(section('Payments', 'invoices'), { text: 'the it is to we' })
  assert.equal(s, 0)
})

test('scoreSectionRelevance: no overlap scores 0', () => {
  const s = scoreSectionRelevance(section('Database', 'postgres migrations'), { text: 'frontend styling colors' })
  assert.equal(s, 0)
})

test('scoreSectionRelevance: empty query scores 0', () => {
  const s = scoreSectionRelevance(section('Anything', 'text'), { text: '' })
  assert.equal(s, 0)
})

// ── selectAgentsSections ──────────────────────────────────────────

test('selectAgentsSections: empty/whitespace input → empty', () => {
  const r = selectAgentsSections('   \n  ', { text: 'anything' })
  assert.equal(r.mode, 'empty')
  assert.equal(r.text, '')
  assert.deepEqual(r.selectedHeadings, [])
})

test('selectAgentsSections: small file → whole', () => {
  const md = '# Rules\nrun the linter before done'
  const r = selectAgentsSections(md, { text: 'lint' })
  assert.equal(r.mode, 'whole')
  assert.equal(r.text, md)
})

test('selectAgentsSections: large file → selected, keeps preamble + alwaysHeadings + top-N relevant', () => {
  const pad = 'x'.repeat(400)
  const md = [
    `project preamble ${pad}`,
    `# Rules\nalways run the linter ${pad}`,
    `# Cart\ncart checkout invariants ${pad}`,
    `# Database\npostgres migrations ${pad}`,
    `# Styling\ncss colors and fonts ${pad}`,
  ].join('\n')
  const r = selectAgentsSections(
    md,
    { text: 'update checkout', files: ['src/store/cart.ts'] },
    { wholeFileMaxChars: 100, maxSections: 1, alwaysHeadings: ['Rules'] },
  )
  assert.equal(r.mode, 'selected')
  // Rules kept (always), Cart kept (relevant, top-1); Database/Styling dropped.
  assert.ok(r.selectedHeadings.includes('Rules'))
  assert.ok(r.selectedHeadings.includes('Cart'))
  assert.ok(!r.selectedHeadings.includes('Database'))
  assert.ok(!r.selectedHeadings.includes('Styling'))
  // Preamble content is retained.
  assert.ok(r.text.startsWith('project preamble'))
})

test('selectAgentsSections: selected output preserves original document order', () => {
  const pad = 'y'.repeat(400)
  const md = [
    `# Alpha\nfoo checkout ${pad}`,
    `# Beta\nbar ${pad}`,
    `# Gamma\ncheckout again ${pad}`,
  ].join('\n')
  const r = selectAgentsSections(md, { text: 'checkout' }, { wholeFileMaxChars: 50, maxSections: 5 })
  // Alpha before Gamma in output regardless of scores.
  const ai = r.text.indexOf('# Alpha')
  const gi = r.text.indexOf('# Gamma')
  assert.ok(ai !== -1 && gi !== -1 && ai < gi)
})

// ── selectMemoryEntries ───────────────────────────────────────────

test('selectMemoryEntries: bullet-style memory picks relevant entries', () => {
  const md = [
    '- The cart uses optimistic updates',
    '- Payments run through Stripe',
    '- CSS lives in styles/',
  ].join('\n')
  const r = selectMemoryEntries(md, { text: 'checkout', files: ['src/store/cart.ts'] })
  assert.ok(r.entries.some(e => /cart/i.test(e)))
  assert.ok(!r.entries.some(e => /CSS/i.test(e)))
})

test('selectMemoryEntries: section-style memory works too', () => {
  const md = '## Cart\nthe cart uses optimistic updates\n## Styling\ncss tokens'
  const r = selectMemoryEntries(md, { text: 'cart invariants' })
  assert.ok(r.entries.length >= 1)
  assert.ok(/cart/i.test(r.entries[0]))
})

test('selectMemoryEntries: caps at maxEntries', () => {
  const md = Array.from({ length: 10 }, (_, i) => `- cart note number ${i}`).join('\n')
  const r = selectMemoryEntries(md, { text: 'cart' }, { maxEntries: 3 })
  assert.equal(r.entries.length, 3)
})

test('selectMemoryEntries: empty input and no-match both yield empty', () => {
  assert.deepEqual(selectMemoryEntries('', { text: 'cart' }), { text: '', entries: [] })
  const r = selectMemoryEntries('- payments via stripe', { text: 'frontend styling' })
  assert.deepEqual(r, { text: '', entries: [] })
})

test('selectMemoryEntries: entries render in original order', () => {
  const md = ['- zeta cart alpha', '- earlier cart beta'].join('\n')
  const r = selectMemoryEntries(md, { text: 'cart' })
  assert.equal(r.entries[0], 'zeta cart alpha')
  assert.equal(r.entries[1], 'earlier cart beta')
})

// ── renderRecallPointer ───────────────────────────────────────────

test('renderRecallPointer: both present mentions both files', () => {
  const s = renderRecallPointer({ agentsPresent: true, memoryPresent: true })
  assert.ok(s.includes('AGENTS.md'))
  assert.ok(s.includes('MEMORY.md'))
})

test('renderRecallPointer: only one present mentions only that one', () => {
  const a = renderRecallPointer({ agentsPresent: true, memoryPresent: false })
  assert.ok(a.includes('AGENTS.md'))
  assert.ok(!a.includes('MEMORY.md'))
  const m = renderRecallPointer({ agentsPresent: false, memoryPresent: true })
  assert.ok(m.includes('MEMORY.md'))
  assert.ok(!m.includes('AGENTS.md'))
})

test('renderRecallPointer: neither present → empty string', () => {
  assert.equal(renderRecallPointer({ agentsPresent: false, memoryPresent: false }), '')
})

// ── formatMemoryAppend ────────────────────────────────────────────

test('formatMemoryAppend: dated heading + bullets, blanks skipped', () => {
  const out = formatMemoryAppend(['fact one', '  ', 'fact two'], new Date('2026-02-03T10:00:00Z'))
  assert.equal(out, '## Session memory (2026-02-03)\n- fact one\n- fact two\n')
})

test('formatMemoryAppend: all-blank input → empty string', () => {
  assert.equal(formatMemoryAppend(['', '   '], new Date('2026-02-03T00:00:00Z')), '')
})

// ── dedupeAgainst ─────────────────────────────────────────────────

test('dedupeAgainst: case/whitespace/bullet-insensitive split', () => {
  const existing = '## Session memory (2026-01-01)\n- Uses Postgres.\n- Auth via JWT'
  const { fresh, duplicate } = dedupeAgainst(existing, [
    'uses   postgres', // dup (case + whitespace + trailing punctuation)
    '- auth via jwt', // dup (bullet marker)
    'New fact about caching',
  ])
  assert.deepEqual(fresh, ['New fact about caching'])
  assert.equal(duplicate.length, 2)
})

test('dedupeAgainst: within-batch repeats are deduped too', () => {
  const { fresh, duplicate } = dedupeAgainst('', ['same fact', 'Same Fact', 'other'])
  assert.deepEqual(fresh, ['same fact', 'other'])
  assert.deepEqual(duplicate, ['Same Fact'])
})

// ── persistToMemory (injected in-memory io) ───────────────────────

test('persistToMemory: appends only fresh items, preserves existing content', async () => {
  const store: Record<string, string> = {
    '/w/MEMORY.md': '## Session memory (2026-01-01)\n- Uses Postgres\n',
  }
  const io = {
    readFile: async (p: string) => {
      if (!(p in store)) throw new Error('ENOENT')
      return store[p]
    },
    writeFile: async (p: string, c: string) => {
      store[p] = c
    },
  }
  const res = await persistToMemory(
    '/w/MEMORY.md',
    ['uses postgres', 'Caching added'],
    io,
    new Date('2026-02-02T00:00:00Z'),
  )
  assert.deepEqual(res.written, ['Caching added'])
  assert.deepEqual(res.skipped, ['uses postgres'])
  const written = store['/w/MEMORY.md']
  assert.ok(written.includes('- Uses Postgres')) // preserved
  assert.ok(written.includes('## Session memory (2026-02-02)'))
  assert.ok(written.includes('- Caching added'))
})

test('persistToMemory: missing file treated as empty (never throws)', async () => {
  const store: Record<string, string> = {}
  const io = {
    readFile: async (p: string) => {
      if (!(p in store)) throw new Error('ENOENT')
      return store[p]
    },
    writeFile: async (p: string, c: string) => {
      store[p] = c
    },
  }
  const res = await persistToMemory('/w/MEMORY.md', ['first fact'], io, new Date('2026-03-03T00:00:00Z'))
  assert.deepEqual(res.written, ['first fact'])
  assert.deepEqual(res.skipped, [])
  assert.equal(store['/w/MEMORY.md'], '## Session memory (2026-03-03)\n- first fact\n')
})

test('persistToMemory: nothing written when all items are duplicates', async () => {
  const store: Record<string, string> = { '/w/MEMORY.md': '- existing fact\n' }
  let wrote = false
  const io = {
    readFile: async (p: string) => store[p] ?? '',
    writeFile: async (p: string, c: string) => {
      wrote = true
      store[p] = c
    },
  }
  const res = await persistToMemory('/w/MEMORY.md', ['Existing Fact'], io)
  assert.deepEqual(res.written, [])
  assert.deepEqual(res.skipped, ['Existing Fact'])
  assert.equal(wrote, false, 'no write when nothing fresh')
})
