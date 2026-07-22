import type { Message } from 'ollama'
import type { Ollama } from 'ollama'
import type { ModelOptions } from './types.js'

// ── Structured compaction state ───────────────────────────────────
//
// A single free-form summary string, re-summarized on every compaction pass,
// has no way to distinguish "the agent verified this by running a test" from
// "the agent guessed this and never checked" — and once summarized, a later
// compaction pass re-summarizes the summary as if it were undifferentiated
// raw material, discarding whatever epistemic care went into the first pass.
// CompactionState keeps these categories separate and persists across
// compactions as structured data; each compaction *updates* it (new entries
// folded in, superseded ones moved to invalidated) rather than re-deriving it
// from scratch out of its own previous prose.
export interface CompactionState {
  projectCapsule: string
  userRequirements: string[]
  verifiedFacts: string[]
  decisionsMade: string[]
  changesMade: string[]
  testsAndVerification: string[]
  openQuestions: string[]
  hypotheses: string[]
  failedAttempts: string[]
  invalidatedConclusions: string[]
}

export function emptyCompactionState(): CompactionState {
  return {
    projectCapsule: '',
    userRequirements: [],
    verifiedFacts: [],
    decisionsMade: [],
    changesMade: [],
    testsAndVerification: [],
    openQuestions: [],
    hypotheses: [],
    failedAttempts: [],
    invalidatedConclusions: [],
  }
}

// Deliberately accepts an empty array here — `[]` is how the model clears a
// category on purpose (e.g. every open hypothesis got resolved), and must be
// distinguished from a missing/wrong-typed field, which is the actual
// malformed-response case `pick()` below falls back to the old value for.
function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every(x => typeof x === 'string')
}

// Defensive parse — an LLM asked for JSON can still return a malformed or
// partial shape. Anything missing/wrong-typed falls back to the existing
// value rather than throwing, so a bad model response degrades to "nothing
// new folded in" instead of crashing the run or silently losing state.
export function coerceCompactionState(raw: unknown, fallback: CompactionState): CompactionState {
  if (!raw || typeof raw !== 'object') return fallback
  const r = raw as Record<string, unknown>
  const pick = (key: keyof CompactionState): string[] =>
    isStringArray(r[key]) ? (r[key] as string[]) : (fallback[key] as string[])
  return {
    projectCapsule: typeof r.projectCapsule === 'string' ? r.projectCapsule : fallback.projectCapsule,
    userRequirements: pick('userRequirements'),
    verifiedFacts: pick('verifiedFacts'),
    decisionsMade: pick('decisionsMade'),
    changesMade: pick('changesMade'),
    testsAndVerification: pick('testsAndVerification'),
    openQuestions: pick('openQuestions'),
    hypotheses: pick('hypotheses'),
    failedAttempts: pick('failedAttempts'),
    invalidatedConclusions: pick('invalidatedConclusions'),
  }
}

// Renders the structured state into the text block injected into history.
// This is what the model actually reads — the CompactionState object itself
// never reaches the model directly.
export function renderCompactionState(state: CompactionState): string {
  const section = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map(i => `- ${i}`).join('\n')}\n` : ''

  const capsule = state.projectCapsule ? `PROJECT CAPSULE\n${state.projectCapsule}\n\n` : ''

  const prior = [
    section('USER REQUIREMENTS', state.userRequirements),
    section('VERIFIED FACTS', state.verifiedFacts),
    section('DECISIONS MADE', state.decisionsMade),
    section('CHANGES MADE', state.changesMade),
    section('TESTS / VERIFICATION', state.testsAndVerification),
    section('OPEN QUESTIONS', state.openQuestions),
    section('HYPOTHESES / UNVERIFIED CLAIMS', state.hypotheses),
    section('FAILED ATTEMPTS', state.failedAttempts),
    section('INVALIDATED OR SUPERSEDED CONCLUSIONS', state.invalidatedConclusions),
  ].filter(Boolean).join('\n')

  return `${capsule}PRIOR WORK STATE\n\n${prior || '(nothing recorded yet)'}`
}

// ── Serialising raw messages to a work log for the LLM calls ──────

// Collapse verbose, low-value tool output (test runner logs are the classic
// case) to its actual conclusion once it's headed into compaction — the
// full raw output already exists forever in the untouched JSONL/MD log; the
// compacted context only needs the conclusion. Anything not matching a known
// pattern still gets the existing hard cap, just without the special-case win.
const SUMMARY_LINE_PATTERNS = [
  /(\d+)\s+passing/i,
  /(\d+)\s+passed,?\s*(\d+)\s+failed/i,
  /tests?:\s*\d+\s*(passed|failed)/i,
  /✓.*\d+.*pass/i,
]

function collapseVerboseOutput(text: string, cap = 300): string {
  for (const re of SUMMARY_LINE_PATTERNS) {
    const m = text.match(re)
    if (m) {
      const line = text.split('\n').find(l => re.test(l))
      if (line) return line.trim().slice(0, cap)
    }
  }
  return text.slice(0, cap)
}

export function messagesToText(messages: Message[]): string {
  const lines: string[] = []
  for (const msg of messages) {
    if (msg.role === 'user' && msg.content) {
      // User content is the actual source of userRequirements — unlike tool
      // output, there's no verbose/low-signal preamble to skip, so it must go
      // in whole. A 300-char cap here once silently dropped a detailed
      // multi-step prompt down to its first sentence and a half before
      // compaction ever saw it, permanently losing requirements from
      // persisted state (confirmed via a real session: userRequirements only
      // captured the pre-cutoff fragment, and compaction's own openQuestions
      // flagged the truncation as if it were something the user did).
      lines.push(`User: ${msg.content}`)
    } else if (msg.role === 'assistant') {
      const tc = (msg as { tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }> }).tool_calls
      if (tc?.length) {
        for (const call of tc) {
          lines.push(`Called ${call.function.name}(${JSON.stringify(call.function.arguments).slice(0, 120)})`)
        }
      } else if (msg.content) {
        lines.push(`Agent: ${msg.content}`)
      }
    } else if (msg.role === 'tool' && msg.content) {
      lines.push(`Result: ${collapseVerboseOutput(msg.content)}`)
    }
  }
  return lines.join('\n')
}

// ── Deterministic message split (no LLM involved) ──────────────────
//
// This is the part that actually guarantees the active prompt survives — it
// does not depend on what any model decides to write. `currentRunStart` is
// the index of the user message that began the run currently executing.

export interface HistorySplit {
  /** Everything before the antecedent turn — the actual compaction candidate. */
  prior: Message[]
  /** The single user+assistant(+tool) exchange immediately before this run, kept verbatim for referential context ("fix that", "the second option"). */
  antecedent: Message[]
  /** The message that started the current run — always kept verbatim, always. */
  currentPrompt: Message
  /** Iterations of the current run since the prompt, older than the recent tail — candidate for lighter, separate "active working state" compression. */
  activeMiddle: Message[]
  /** The most recent messages of the current run, kept verbatim. */
  activeTail: Message[]
}

const KEEP_ACTIVE_TAIL = 8
// How far back to look for the previous user message when locating the
// antecedent turn. Bounded on purpose: an unbounded walk-back would pull an
// entire long-running *previous* turn (many tool-call iterations) into the
// "always verbatim" bucket if that turn itself had many iterations, defeating
// the whole point of bounding post-compaction size. Referential phrases like
// "fix that" almost always resolve against the previous turn's final reply,
// not its intermediate tool mechanics, so a small window is enough.
const MAX_ANTECEDENT_SEARCH = 6

export function splitForCompaction(history: Message[], currentRunStart: number): HistorySplit {
  const clampedStart = Math.max(0, Math.min(currentRunStart, history.length - 1))
  const currentPrompt = history[clampedStart]
  const activeRun = history.slice(clampedStart + 1)

  // The antecedent is whatever one exchange sits directly before this run —
  // found by walking back from clampedStart to the previous user message,
  // within a bounded window, so "fix that" still has its antecedent even if
  // the previous turn itself was short.
  const searchFloor = Math.max(0, clampedStart - MAX_ANTECEDENT_SEARCH)
  let antecedentStart = clampedStart
  if (antecedentStart > 0) {
    antecedentStart -= 1
    while (antecedentStart > searchFloor && history[antecedentStart].role !== 'user') antecedentStart -= 1
    if (history[antecedentStart].role !== 'user') antecedentStart = clampedStart // nothing found in range — no antecedent
  }
  const antecedent = clampedStart > 0 ? history.slice(antecedentStart, clampedStart) : []
  const prior = history.slice(0, antecedentStart)

  const activeMiddle = activeRun.length > KEEP_ACTIVE_TAIL ? activeRun.slice(0, activeRun.length - KEEP_ACTIVE_TAIL) : []
  const activeTail = activeRun.length > KEEP_ACTIVE_TAIL ? activeRun.slice(-KEEP_ACTIVE_TAIL) : activeRun

  return { prior, antecedent, currentPrompt, activeMiddle, activeTail }
}

// ── LLM calls: fold new material into state, then validate ────────

const UPDATE_INSTRUCTIONS = `You maintain structured working memory for a coding agent across a long session. You will be given the EXISTING structured state (already vetted — do not re-derive it, only update it) and NEW raw work log to fold in.

Rules — these are the whole point of this exercise:
- Only "VERIFIED FACTS" may contain things directly confirmed by a tool result (a command that ran, a file that was read, a test that passed/failed). If something was only reasoned about, guessed, or asserted without running anything, it belongs in "HYPOTHESES", never in "VERIFIED FACTS".
- If new evidence contradicts an existing entry, move the old one to "INVALIDATED OR SUPERSEDED CONCLUSIONS" (keep it, labeled as superseded — do not silently delete it) and add the corrected version to the right category.
- Copy exact paths, URLs, identifiers, commands, and error messages verbatim from the work log. Never paraphrase or reconstruct a literal.
- Preserve every USER REQUIREMENT and prohibition ("do not modify X", "only do Y") exactly — these must never be dropped, softened, or merged away.
- Do not invent facts, causes, or explanations not present in the work log, even if they sound plausible.
- projectCapsule: a short, stable description of what the project is, its architecture, and important conventions — update it only if genuinely new stable information appeared, otherwise keep it as given. Keep it under roughly 1500 characters.

Reply with ONLY a JSON object with exactly these fields (all arrays of short strings, each self-contained since they'll be read out of order):
{"projectCapsule": string, "userRequirements": string[], "verifiedFacts": string[], "decisionsMade": string[], "changesMade": string[], "testsAndVerification": string[], "openQuestions": string[], "hypotheses": string[], "failedAttempts": string[], "invalidatedConclusions": string[]}`

export async function updateCompactionState(
  ollama: Ollama,
  model: string,
  options: ModelOptions,
  existing: CompactionState,
  newRawMessages: Message[],
): Promise<CompactionState> {
  const workLog = messagesToText(newRawMessages)
  if (!workLog.trim()) return existing

  const resp = await ollama.chat({
    model,
    format: 'json',
    stream: false,
    messages: [{
      role: 'user',
      content: `${UPDATE_INSTRUCTIONS}\n\nEXISTING STATE:\n${JSON.stringify(existing)}\n\nNEW WORK LOG TO FOLD IN:\n${workLog}`,
    }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: options as any,
  })

  try {
    return coerceCompactionState(JSON.parse(resp.message.content), existing)
  } catch {
    return existing
  }
}

const VALIDATE_INSTRUCTIONS = `You are checking a just-updated structured summary of a coding agent's work log for factual errors introduced during summarization. Compare the DRAFT STATE against the SOURCE WORK LOG it was derived from.

Look specifically for:
- Claims in verifiedFacts, decisionsMade, or changesMade that are not actually supported by a tool result in the source log.
- Anything in hypotheses that should be labeled as verified (or vice versa).
- Contradictions between entries.
- User requirements or prohibitions present in the source but missing from userRequirements.
- A failed attempt or command described as successful, or a success described as failed.
- A superseded/invalidated conclusion still appearing as if it were current in another category.

If you find no issues, return the draft state unchanged. If you find issues, return a corrected version — move unsupported claims to hypotheses (or drop them if truly unfounded), fix mislabeled entries, restore missing requirements. Never add information that isn't in the source log.

Reply with ONLY the corrected JSON object, same shape as the draft.`

export async function validateCompactionState(
  ollama: Ollama,
  model: string,
  options: ModelOptions,
  sourceWorkLog: string,
  draft: CompactionState,
): Promise<{ state: CompactionState; changed: boolean }> {
  const resp = await ollama.chat({
    model,
    format: 'json',
    stream: false,
    messages: [{
      role: 'user',
      content: `${VALIDATE_INSTRUCTIONS}\n\nSOURCE WORK LOG:\n${sourceWorkLog}\n\nDRAFT STATE:\n${JSON.stringify(draft)}`,
    }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: options as any,
  })
  const corrected = coerceCompactionState(JSON.parse(resp.message.content), draft)
  return { state: corrected, changed: JSON.stringify(corrected) !== JSON.stringify(draft) }
}

// Lighter-weight than the full state machinery above — the active run's own
// middle iterations aren't cross-session persistent state, just a running
// account of the current task, so one plain (but still provenance-aware) pass
// is enough; no separate validation call for this one.
export async function summarizeActiveMiddle(
  ollama: Ollama,
  model: string,
  options: ModelOptions,
  activeMiddle: Message[],
): Promise<string> {
  const workLog = messagesToText(activeMiddle)
  if (!workLog.trim()) return ''
  const resp = await ollama.chat({
    model,
    stream: false,
    messages: [{
      role: 'user',
      content: `Summarize the in-progress work below on the CURRENT task (not finished, not yet reported to the user). Rules:
- Copy exact paths, URLs, commands, and error messages verbatim
- State plainly what has been tried, what worked, what failed — never blur the two
- Label anything not directly confirmed by a tool result as a hypothesis, not a fact
- Note what remains to be done
- Be dense; every sentence must carry unique information

Work log:
${workLog}`,
    }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: options as any,
  })
  return resp.message.content.trim()
}
