import type { Ollama } from 'ollama'
import type { ModelOptions } from './types.js'
import { type Critique, parseCritique } from './critic.js'

// GROUNDING & SELF-CONSISTENCY guard (Phase 4). A pre-done check for WRITING /
// RESEARCH tasks — the class where the coding critic (test/spec oracle) does not
// apply. It targets the two failure modes observed on a real document-construction
// eval (a French print booklet built from web sources), measured across 4 runs:
//   1) FABRICATION of under-sourced specifics — when a detail is thinly documented
//      the model invents a confident specific (a school, a venue, a date) that is
//      different across runs (a tell that it is guessing, not reporting). The root
//      condition: Argo collapses tool results to stay context-lean, so the fetched
//      source text has scrolled out of the live window by the time the model writes
//      the prose, and it fills the gap from memory.
//   2) INTERNAL INCONSISTENCY — the same constant restated with different values in
//      different sections (e.g. a furnace temperature given as 1150 °C in a heading
//      and 2100 °C in the body of the SAME document).
//
// CRUCIAL DESIGN POINT (learned from a smoke test): the critic must see the ACTUAL
// fetched SOURCE TEXT, not just the source URLs. Given only URLs it guessed at
// support and produced false positives (flagging the CORRECT "1987" as fabricated),
// and the compliant actor then STRIPPED correct, well-sourced specifics — trading
// fabrication for vagueness, a net quality loss. So the checkpoint feeds the critic
// bounded excerpts of what the agent actually fetched (recoverable from the full
// history, which Argo keeps even after live-window collapse), and the prompt is
// explicit: KEEP supported specifics, flag ONLY specifics absent from every excerpt
// (and not general knowledge) or genuine internal contradictions.
//
// Self-contained (deterministic pre-scan + prompt + call + parse), reuses the critic
// model (qwen3.6 self-review) and critic.ts's robust JSON parse. Fails OPEN.

export interface SourceExcerpt {
  url: string
  text: string
}

export interface GroundingInput {
  objective: string
  // Visible text of the produced document(s), already stripped + truncated.
  docText: string
  // Bounded excerpts of the pages the agent actually fetched (url + text).
  sourceExcerpts: SourceExcerpt[]
  // Deterministic internal-conflict findings (see findNumericConflicts).
  numericConflicts: string[]
}

const DOC_EXTS = ['.html', '.htm', '.xhtml', '.md', '.markdown', '.txt', '.rst']

// A "document artifact" is a prose/markup file under the git-tracked workspace —
// the deliverable of a writing task. Code files are judged by tests, not by this.
export function isDocPath(p: string): boolean {
  if (!p) return false
  const s = p.toLowerCase()
  if (!s.startsWith('/workspace')) return false
  return DOC_EXTS.some(e => s.endsWith(e))
}

// Normalizes raw HTML/markup to plain, entity-decoded text with unicode spaces
// (NBSP, narrow no-break, thin space) flattened to a regular space — so numbers
// like "1&nbsp;200" and "1 200" and "1200" all compare equal downstream.
export function normalizeText(s: string): string {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#0*160;|&#8239;|&#x202f;/gi, ' ')
    .replace(/&deg;|&#0*176;|&#xb0;/gi, '\u00b0')
    .replace(/[\u00a0\u202f\u2009\u2007\u2008]/g, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseNum(raw: string): number {
  const cleaned = raw.replace(/\s/g, '')
  // European thousands dot like "1.200" -> 1200 (temperatures are integers here).
  const m = /^(\d+)\.(\d{3})$/.exec(cleaned)
  if (m) return Number(m[1] + m[2])
  return Number(cleaned.replace(/,(?=\d{3}(\D|$))/g, ''))
}

// Extracts temperatures mentioned in the text, normalized to Celsius. Restricted to
// a plausible furnace/kiln range so stray numbers can't masquerade as temperatures.
// Temperature is the single highest-precision internal-consistency signal for this
// class of document (a physical constant that must be one value); it is the concrete
// drift seen in the eval. The check is intentionally narrow to keep false positives
// near zero — the LLM pass below catches the softer contradictions.
export function extractTemperaturesC(text: string): number[] {
  const t = normalizeText(text)
  const vals: number[] = []
  const push = (numRaw: string, unit: string) => {
    const n = parseNum(numRaw)
    if (!isFinite(n) || n <= 0) return
    const c = /f/i.test(unit) ? Math.round((n - 32) * 5 / 9) : n
    if (c >= 100 && c <= 5000) vals.push(c)
  }
  let m: RegExpExecArray | null
  const reDeg = /(\d[\d .]*\d|\d)\s*\u00b0\s*([cf])\b/gi
  while ((m = reDeg.exec(t)) !== null) push(m[1], m[2])
  const reWord = /(\d[\d .]*\d|\d)\s*degr[ée]s?\s+(celsius|fahrenheit)/gi
  while ((m = reWord.exec(t)) !== null) push(m[1], m[2][0])
  return vals
}

// Greedy 1-D clustering: values within `tol` of the running cluster join it; a
// larger gap starts a new cluster. >1 cluster ⇒ the values genuinely disagree.
export function clusterValues(vals: number[], tol: number): number[][] {
  const sorted = [...vals].sort((a, b) => a - b)
  const clusters: number[][] = []
  for (const v of sorted) {
    const last = clusters[clusters.length - 1]
    if (last && v - last[last.length - 1] <= tol) last.push(v)
    else clusters.push([v])
  }
  return clusters
}

// Deterministic internal-consistency findings, as human-readable strings fed to the
// critic as CONFIRMED evidence (and to the steer). Empty array = nothing found.
export function findNumericConflicts(text: string): string[] {
  const conflicts: string[] = []
  const temps = extractTemperaturesC(text)
  if (temps.length >= 2) {
    const clusters = clusterValues(temps, 75)
    if (clusters.length >= 2) {
      const reps = clusters.map(c => Math.round(c.reduce((a, b) => a + b, 0) / c.length))
      conflicts.push(
        `the document states a temperature as multiple conflicting values (~${reps.map(r => `${r}\u00b0C`).join(' vs ')}); pick ONE and use it in every section`,
      )
    }
  }
  return conflicts
}

// The fact-checking editor prompt. Scoped to grounding + consistency only (NOT
// prose/layout/completeness), and locked to the same JSON contract the coding critic
// uses so parseCritique/coerceCritique are reused unchanged. The emphasis on KEEPING
// supported specifics is deliberate — an earlier URL-only version caused the actor to
// strip correct facts.
export const GROUNDING_SYSTEM_PROMPT = `You are a strict FACT-CHECKING EDITOR reviewing a document that another AI agent just wrote from web research, right before it declares the task finished. Your ONLY job is to catch two failure modes and return a JSON verdict the harness feeds back to steer a revision. Be precise and terse — every word is injected into the agent's context.

You are given (1) the DOCUMENT, (2) SOURCE EXCERPTS = bounded text of the pages the agent ACTUALLY fetched, and (3) CONFIRMED numeric conflicts from a deterministic pre-scan.

FAILURE MODES:
1) UNSUPPORTED SPECIFIC (fabrication). A specific in the DOCUMENT that does NOT appear in any SOURCE EXCERPT and is not obvious general knowledge — i.e. the agent likely invented it. Small local models fill gaps with confident, plausible specifics that were never in the sources. This includes: proper nouns, personal names, dates/years, prices; a SCHOOL / degree / award / job title; a GEOGRAPHIC or INSTITUTIONAL detail (a city an affiliation is placed in, an origin region or country, a street/venue name); a specific NUMBER (temperature, duration, age/century); and NARRATIVE CONFLATIONS — attributing one entity's trait, place, or product to another (e.g. giving an artist the wrong medium, wrong city, or wrong founding story). Known traps seen before: an invented workshop building (e.g. an "ice house"), a wrong craft-origin region, a "sea glass" conflation, and wrong founder names — check these specifically when the topic matches.
2) INTERNAL INCONSISTENCY. The same fact — especially a number/constant — stated with different values in different places. The CONFIRMED conflicts are pre-verified; require reconciliation to ONE value.

CRITICAL RULES — your goal is ACCURACY, NOT vagueness:
- A specific that DOES appear in a SOURCE EXCERPT is SUPPORTED — do NOT flag it, and do NOT ask the agent to remove or generalize it. Keeping well-sourced specifics is good.
- Flag a specific as unsupported ONLY when it is absent from every excerpt AND not general knowledge. When in doubt about a plausibly-sourced detail, do NOT flag it (the excerpts are truncated, so a fact may be real even if you don't see it).
- Never request removing accurate content or making the document vaguer than the sources support. You are removing FABRICATIONS, not specificity.
- You are NOT judging prose style, tone, layout, length, or completeness.

OUTPUT CONTRACT — respond with EXACTLY one JSON object and nothing else (no prose, markdown, code fences, or <think>):
{"verdict":"ok"|"revise","gamed_oracle":false,"issues":[string,...],"guidance":string}
- verdict "revise" ONLY if there is a clearly unsupported/fabricated specific OR a confirmed internal inconsistency; otherwise "ok".
- gamed_oracle is always false here.
- issues: short, specific findings — QUOTE the exact unsupported specific (and note it is absent from the sources), or the conflicting values. Do NOT list supported specifics.
- guidance: ONE actionable paragraph — for each unsupported specific, tell the agent to either replace it with a fact FROM the excerpts or generalize just that phrase; for a numeric conflict, which single value to standardize on. Tell it to KEEP everything that is supported. Empty string only when verdict is "ok".`

export function buildGroundingUserPrompt(input: GroundingInput): string {
  const excerpts = input.sourceExcerpts.length
    ? input.sourceExcerpts.map((s, i) => `--- SOURCE ${i + 1}: ${s.url} ---\n${s.text}`).join('\n\n')
    : '(no source excerpts captured — be conservative: flag only clear internal contradictions and specifics that are obviously invented)'
  const conflicts = input.numericConflicts.length ? input.numericConflicts.map(c => `- ${c}`).join('\n') : '(none found)'
  return `CHECKPOINT: pre-done (WRITING / RESEARCH task)

OBJECTIVE:
${input.objective}

CONFIRMED internal numeric conflicts (deterministic pre-scan — treat as verified):
${conflicts}

SOURCE EXCERPTS (text the agent actually fetched — the ground truth for what is supported):
${excerpts}

THE DOCUMENT THE AGENT PRODUCED (visible text, truncated):
${input.docText || '(empty)'}

Check each specific in the DOCUMENT against the SOURCE EXCERPTS. Flag only clearly unsupported/fabricated specifics and confirmed inconsistencies; keep everything that is supported. Return your JSON verdict now.`
}

// Issues the grounding critic chat call: its own system prompt, format:"json",
// temperature pinned low for a stable verdict. Reuses the caller's Ollama client
// and critic.ts's robust parse. Returns null on unparseable output so the caller
// can fail OPEN (no block).
export async function runGroundingCritic(
  ollama: Ollama,
  model: string,
  options: ModelOptions,
  input: GroundingInput,
): Promise<Critique | null> {
  const resp = await ollama.chat({
    model,
    format: 'json',
    stream: false,
    messages: [
      { role: 'system', content: GROUNDING_SYSTEM_PROMPT },
      { role: 'user', content: buildGroundingUserPrompt(input) },
    ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: { ...options, temperature: 0.2 } as any,
  })
  return parseCritique(resp.message?.content ?? '')
}
