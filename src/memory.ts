import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises'

// HARNESS-OWNED MEMORY (docs/harness-planning-memory.md). The research finding is
// pivotal: small local models cannot reliably self-manage memory or self-page, so
// the HARNESS owns retrieval, injection, and persistence and merely OFFERS recall —
// correctness must never depend on the model choosing to look. This module is the
// DETERMINISTIC core of that plan: pure, dependency-free lexical/structural logic
// (NO embeddings, NO LLM, NO network) plus one injectable filesystem writer. It
// implements the deterministic parts of Stage 1 (memory ⇄ compaction persist),
// Stage 2 (task-scoped MEMORY.md retrieval), and Stage 4 (AGENTS.md section
// selection when the file is large). Everything is side-effect-free at import and
// straightforwardly unit-testable; the LLM-driven fallbacks live elsewhere.

// ── Markdown section parsing ──────────────────────────────────────

// A parsed markdown region. `raw` deliberately includes the heading line plus its
// body so callers can re-render selected sections VERBATIM (Stage 4 keeps some
// sections and drops others — re-rendering from `heading`/`body` would risk
// normalising away the author's exact wording of a rule). The preamble (content
// before the first heading) is represented as a section with `heading: ''`,
// `level: 0` so it is always available to keep.
export interface MarkdownSection {
  heading: string
  level: number
  body: string
  raw: string
}

// Splits a markdown doc by ATX headings (`#`..`######`). Robust to CRLF (normalised
// to `\n` up front), trailing whitespace on heading lines, and docs with no heading
// at all (the whole doc becomes a single preamble section). Fenced code blocks are
// respected so a `#` inside a ``` fence is not mistaken for a heading — otherwise a
// shell comment in an example would shatter a section.
export function parseMarkdownSections(md: string): MarkdownSection[] {
  const text = md.replace(/\r\n?/g, '\n')
  if (text === '') return []
  const lines = text.split('\n')
  const sections: MarkdownSection[] = []
  let current: { heading: string; level: number; lines: string[] } | null = null
  let inFence = false
  let fenceMarker = ''

  const flush = (): void => {
    if (!current) return
    const raw = current.lines.join('\n')
    // Body = everything after the heading line (preamble has no heading line).
    const bodyLines = current.level === 0 ? current.lines : current.lines.slice(1)
    sections.push({
      heading: current.heading,
      level: current.level,
      body: bodyLines.join('\n').trim(),
      raw,
    })
  }

  for (const line of lines) {
    const fence = line.match(/^\s*(```+|~~~+)/)
    if (fence) {
      if (!inFence) {
        inFence = true
        fenceMarker = fence[1][0]
      } else if (fence[1][0] === fenceMarker) {
        inFence = false
      }
    }

    const headingMatch = !inFence ? line.match(/^(#{1,6})\s+(.*?)\s*$/) : null
    if (headingMatch) {
      flush()
      current = { heading: headingMatch[2], level: headingMatch[1].length, lines: [line] }
      continue
    }

    if (!current) {
      // Content before the first heading → preamble section.
      current = { heading: '', level: 0, lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  flush()

  // A leading blank preamble (docs that open directly with a heading) carries no
  // information; drop it so it does not dilute relevance normalisation. A preamble
  // with real content is kept.
  if (sections.length && sections[0].level === 0 && sections[0].raw.trim() === '') {
    sections.shift()
  }
  return sections
}

// ── Lexical relevance scoring ─────────────────────────────────────

// A small, deliberately conservative English stopword set. The design mandates a
// LEXICAL/structural signal (not embeddings): dropping these + very short tokens
// keeps the overlap dominated by content words (module names, verbs of intent) so a
// section's score reflects topical match rather than shared grammar.
const STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to',
  'in', 'on', 'at', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'with', 'as', 'from', 'into',
  'out', 'up', 'down', 'not', 'no', 'do', 'does', 'did', 'you', 'your', 'we',
  'our', 'they', 'them', 'their', 'he', 'she', 'his', 'her', 'i', 'me', 'my',
  'so', 'than', 'too', 'can', 'will', 'would', 'should', 'could', 'may', 'must',
  'have', 'has', 'had', 'all', 'any', 'each', 'when', 'while', 'about', 'over',
])

// Weight for a query token appearing in a section's HEADING vs its BODY. Headings
// are the author's own topic label, so a heading hit is a much stronger signal that
// the section is ABOUT the query than a passing body mention — hence ~3x.
const HEADING_WEIGHT = 3
const BODY_WEIGHT = 1

// A task-scoped relevance query. `text` is the task/objective prose, `terms` are
// explicit extra keywords, and `files` are the paths the task touches — filenames
// are a strong topical hint (a task on `src/store/cart.ts` should pull an AGENTS.md
// "Cart" section), so we mine their basenames into query tokens.
export interface RelevanceQuery {
  text: string
  files?: string[]
  terms?: string[]
}

// Lowercase, split on any non-alphanumeric run, drop stopwords and tokens < 3 chars.
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t))
}

// Derives tokens from a file path: takes the basename, strips its extension, then
// splits on path/word separators (`-`, `_`, `/`, `.`) so `src/store/cart.ts` yields
// `cart` (and `store` from the dir tokens) — matching a section that mentions "cart".
function fileTokens(file: string): string[] {
  const noExt = file.replace(/\.[a-z0-9]+$/i, '')
  return tokenize(noExt.replace(/[\\/]/g, ' '))
}

// Builds the deduped set of query tokens from text + terms + file basenames. Kept
// separate so scoring can normalise by the number of UNIQUE query tokens, making
// scores comparable across sections regardless of how long the query is.
export function queryTokens(query: RelevanceQuery): Set<string> {
  const tokens = new Set<string>()
  for (const t of tokenize(query.text)) tokens.add(t)
  for (const term of query.terms ?? []) for (const t of tokenize(term)) tokens.add(t)
  for (const f of query.files ?? []) for (const t of fileTokens(f)) tokens.add(t)
  return tokens
}

// Weighted lexical overlap between a section and a query, normalised to a stable,
// cross-section-comparable scale. For each UNIQUE query token we credit the higher
// of a heading hit (HEADING_WEIGHT) or a body hit (BODY_WEIGHT), sum, then divide by
// (unique query tokens × HEADING_WEIGHT) so a section matching every query token in
// its heading scores 1.0 and one matching nothing scores 0. Deterministic and stable.
export function scoreSectionRelevance(section: MarkdownSection, query: RelevanceQuery): number {
  const qTokens = queryTokens(query)
  if (qTokens.size === 0) return 0
  const headingTokens = new Set(tokenize(section.heading))
  const bodyTokens = new Set(tokenize(section.body))
  let sum = 0
  for (const q of qTokens) {
    if (headingTokens.has(q)) sum += HEADING_WEIGHT
    else if (bodyTokens.has(q)) sum += BODY_WEIGHT
  }
  return sum / (qTokens.size * HEADING_WEIGHT)
}

// ── AGENTS.md selection (Stage 4) ─────────────────────────────────

export interface AgentsSelectOptions {
  // Below this many chars, inject the WHOLE file (cheapest + safest).
  wholeFileMaxChars?: number
  // Max relevant sections to add on top of the always-kept ones.
  maxSections?: number
  // Minimum relevance a section needs to be eligible.
  minScore?: number
  // Headings always kept regardless of score (case-insensitive), e.g. "Rules".
  alwaysHeadings?: string[]
}

const AGENTS_WHOLE_FILE_MAX_CHARS = 2000
const AGENTS_MAX_SECTIONS = 4
// A small positive threshold: a section must share at least SOME content with the
// task to be pulled in, so an irrelevant section is dropped rather than padding the
// window (the design warns that bad selection is worse than none).
const DEFAULT_MIN_SCORE = 0.01

// Selects the AGENTS.md content to inject for a task. Rationale per branch:
//  - Empty/whitespace → nothing to inject (`empty`).
//  - Small file → inject WHOLE (`whole`): never risk dropping a needed rule when the
//    file is cheap to include in full.
//  - Large file → parse, ALWAYS keep the preamble + any `alwaysHeadings` match (rules
//    that must always apply), then ADD the top-N sections scoring ≥ minScore. Kept
//    sections are re-rendered in ORIGINAL document order using their verbatim `raw`,
//    so the injected slice reads like a coherent excerpt of the real file.
export function selectAgentsSections(
  agentsMd: string,
  query: RelevanceQuery,
  opts?: AgentsSelectOptions,
): { text: string; mode: 'whole' | 'selected' | 'empty'; selectedHeadings: string[] } {
  const wholeMax = opts?.wholeFileMaxChars ?? AGENTS_WHOLE_FILE_MAX_CHARS
  const maxSections = opts?.maxSections ?? AGENTS_MAX_SECTIONS
  const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE
  const always = new Set((opts?.alwaysHeadings ?? []).map(h => h.trim().toLowerCase()))

  if (agentsMd.trim() === '') return { text: '', mode: 'empty', selectedHeadings: [] }
  if (agentsMd.length <= wholeMax) return { text: agentsMd, mode: 'whole', selectedHeadings: [] }

  const sections = parseMarkdownSections(agentsMd)
  // Index-tagged so we can keep original document order in the output.
  const keep = new Set<number>()
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i]
    if (s.level === 0) keep.add(i) // preamble always kept
    else if (always.has(s.heading.trim().toLowerCase())) keep.add(i)
  }

  // Rank the not-yet-kept sections by score (desc), tie-break by document order for
  // determinism, take the top-N that clear the threshold.
  const ranked = sections
    .map((s, i) => ({ i, score: scoreSectionRelevance(s, query) }))
    .filter(({ i, score }) => !keep.has(i) && score >= minScore)
    .sort((a, b) => (b.score - a.score) || (a.i - b.i))
    .slice(0, maxSections)
  for (const { i } of ranked) keep.add(i)

  const kept = [...keep].sort((a, b) => a - b).map(i => sections[i])
  const text = kept.map(s => s.raw.trim()).filter(Boolean).join('\n\n')
  const selectedHeadings = kept.filter(s => s.level > 0).map(s => s.heading)
  return { text, mode: 'selected', selectedHeadings }
}

// ── MEMORY.md task-scoped retrieval (Stage 2) ─────────────────────

export interface MemorySelectOptions {
  maxEntries?: number
  minScore?: number
}

const MEMORY_MAX_ENTRIES = 6

// A single retrievable memory item plus its source order, so we can rank by
// relevance but render in original order.
interface MemoryEntry {
  order: number
  text: string
  section: MarkdownSection
}

// MEMORY.md is durable facts written as top-level bullets AND/OR short `##` sections.
// We treat BOTH shapes as entries: each bullet line under the preamble/section body
// becomes an entry (scored on its own text), and each heading+body section becomes
// an entry (scored on heading+body). This way retrieval works whether memory was
// jotted as a flat bullet list or organised into small topic sections.
function collectMemoryEntries(memoryMd: string): MemoryEntry[] {
  const sections = parseMarkdownSections(memoryMd)
  const entries: MemoryEntry[] = []
  let order = 0
  for (const section of sections) {
    const bulletLines = section.raw
      .split('\n')
      .map(l => l.trim())
      .filter(l => /^[-*]\s+/.test(l))
    if (section.level > 0) {
      // A titled section is itself one entry (heading conveys the topic).
      entries.push({ order: order++, text: `${section.heading}: ${section.body}`.trim(), section })
    }
    for (const b of bulletLines) {
      const clean = b.replace(/^[-*]\s+/, '').trim()
      if (clean) {
        entries.push({
          order: order++,
          text: clean,
          section: { heading: '', level: 0, body: clean, raw: clean },
        })
      }
    }
  }
  return entries
}

// Pulls the MEMORY.md entries relevant to a task (Stage 2). Scores each entry with
// the same lexical overlap used for AGENTS.md, keeps the top-`maxEntries` scoring ≥
// minScore, and renders them as a compact bullet list in ORIGINAL order (stable,
// readable, and de-emphasises the ranking so the model does not over-weight order).
// Auto-injected by the harness — never model-fetched. No matches → empty.
export function selectMemoryEntries(
  memoryMd: string,
  query: RelevanceQuery,
  opts?: MemorySelectOptions,
): { text: string; entries: string[] } {
  const maxEntries = opts?.maxEntries ?? MEMORY_MAX_ENTRIES
  const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE
  if (memoryMd.trim() === '') return { text: '', entries: [] }

  const entries = collectMemoryEntries(memoryMd)
  const scored = entries
    .map(e => ({ e, score: scoreSectionRelevance(e.section, query) }))
    .filter(({ score }) => score >= minScore)
    .sort((a, b) => (b.score - a.score) || (a.e.order - b.e.order))
    .slice(0, maxEntries)
    .sort((a, b) => a.e.order - b.e.order)

  const picked = scored.map(({ e }) => e.text)
  if (picked.length === 0) return { text: '', entries: [] }
  return { text: picked.map(t => `- ${t}`).join('\n'), entries: picked }
}

// ── Recall pointer (offer, never require) ─────────────────────────

// One terse line telling the model the FULL AGENTS.md/MEMORY.md exist on disk and it
// MAY read_file/grep them for more than what was injected. Per the design this is an
// OFFER — the harness already auto-injected the relevant slice, so correctness never
// depends on the model acting on this. Includes only the clause for a present file;
// returns '' when neither is present (nothing to point at).
export function renderRecallPointer(opts: { agentsPresent: boolean; memoryPresent: boolean }): string {
  const files: string[] = []
  if (opts.agentsPresent) files.push('AGENTS.md')
  if (opts.memoryPresent) files.push('MEMORY.md')
  if (files.length === 0) return ''
  const exist = files.length > 1 ? 'exist' : 'exists'
  const them = files.length > 1 ? 'them' : 'it'
  return `Note: the full ${files.join(' and ')} ${exist} on disk — only the relevant part was injected above; use read_file or grep to consult ${them} if you need more.`
}

// ── Memory ⇄ compaction persistence (Stage 1) ─────────────────────

// Normalises an item for duplicate detection: lowercase, strip a leading bullet
// marker, strip leading/trailing punctuation, collapse internal whitespace. So
// "- Uses Postgres." and "uses postgres" are recognised as the same fact.
function normalizeItem(s: string): string {
  return s
    .replace(/^[\s>]*[-*+]\s+/, '')
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .replace(/\s+/g, ' ')
}

// Renders durable items as markdown bullets under a dated subheading. The date is
// INJECTABLE (defaults to now) so tests are deterministic — the dated heading is the
// only non-pure surface in this module, and confining Date to this one parameter
// keeps every other function reproducible. Blank items are skipped/trimmed.
export function formatMemoryAppend(items: string[], date: Date = new Date()): string {
  const clean = items.map(i => i.trim()).filter(Boolean)
  if (clean.length === 0) return ''
  const day = date.toISOString().slice(0, 10)
  const bullets = clean.map(i => `- ${i}`).join('\n')
  return `## Session memory (${day})\n${bullets}\n`
}

// Splits `items` into those NOT already present in `existing` vs those that are,
// using normalizeItem so the comparison is case/whitespace/bullet-insensitive. This
// is what stops the compaction→MEMORY.md flow from re-appending the same durable
// fact on every compaction pass.
export function dedupeAgainst(existing: string, items: string[]): { fresh: string[]; duplicate: string[] } {
  const seen = new Set(
    existing
      .split('\n')
      .map(normalizeItem)
      .filter(Boolean),
  )
  const fresh: string[] = []
  const duplicate: string[] = []
  // Track within-batch dupes too, so a repeated item in the SAME call is written once.
  const batchSeen = new Set<string>()
  for (const item of items) {
    if (item.trim() === '') continue
    const key = normalizeItem(item)
    if (!key) continue
    if (seen.has(key) || batchSeen.has(key)) {
      duplicate.push(item)
    } else {
      fresh.push(item)
      batchSeen.add(key)
    }
  }
  return { fresh, duplicate }
}

// Persists durable ledger items to MEMORY.md (Stage 1): read existing (empty string
// if the file is missing — never an error, most projects start without one), dedupe
// against it, append ONLY fresh items via formatMemoryAppend, write back. The io
// hooks are injectable and MUST be used when provided so tests never touch the real
// filesystem; when absent they default to node:fs/promises. Returns which items were
// written vs skipped so the caller can drop the written ones from the live window.
export async function persistToMemory(
  memoryPath: string,
  items: string[],
  io?: { readFile?: (p: string) => Promise<string>; writeFile?: (p: string, c: string) => Promise<void> },
  date?: Date,
): Promise<{ written: string[]; skipped: string[] }> {
  const readFile = io?.readFile ?? ((p: string) => fsReadFile(p, 'utf-8'))
  const writeFile = io?.writeFile ?? ((p: string, c: string) => fsWriteFile(p, c, 'utf-8'))

  let existing = ''
  try {
    existing = await readFile(memoryPath)
  } catch {
    existing = '' // missing file → treat as empty, not an error
  }

  const { fresh, duplicate } = dedupeAgainst(existing, items)
  if (fresh.length === 0) return { written: [], skipped: duplicate }

  const appended = formatMemoryAppend(fresh, date)
  // Separate the new block from prior content with a blank line, without piling up
  // blank lines when the file was empty.
  const base = existing.replace(/\s+$/, '')
  const next = base === '' ? appended : `${base}\n\n${appended}`
  await writeFile(memoryPath, next)
  return { written: fresh, skipped: duplicate }
}
