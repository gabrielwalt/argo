// SCHEMA-CONSTRAINED CONTROL PLANE (config.schemaControlPlane, ARGO_SCHEMA_CONTROL_PLANE).
// docs/research/09-small-model-scaffolding.md §1 ("Schema-constrained decoding for
// control-plane outputs") and §7 ("Thinking budget per turn"); HYPOTHESIS-LEDGER.md, "Other
// platform facts settled by probe" (2026-09-03).
//
// Ollama's `format` field on /api/chat accepts a full JSON Schema, not only the string
// "json" — and, the one fact this whole idea was gated on, it has been VERIFIED to compose
// with `tools` in a single request (no error, `tool_calls: 0`, content conforming exactly
// to the requested schema). So a schema-constrained call can sit ALONGSIDE the existing
// tool-calling frames without touching how they run.
//
// This module is the EXTRACTION step, not a replacement for the frames themselves. A
// Boss/Planner/Tester frame runs exactly as it does today — its own ReAct loop, its own
// tools, its own free-text final answer — and the harness's existing regex parsers
// (frames.ts's parseTesterVerdict/parseTaskStartVerdict/parseBossVerdict) remain the
// cheap first attempt, tried first, at zero extra cost. Only
// when that cheap parse fails does dispatch.ts hand this module the frame's own final
// answer, and this module makes exactly one bounded, schema-constrained, NO-TOOLS call
// that RESTATES the decision the frame already reached in the shape the harness needs —
// it never reasons about what the decision *should* be. `think: false` is set on every
// call here for the same reason: this is always a pure reformat of an already-made
// decision, never a diagnosis turn, so Ollama takes the `forceImmediate` path and skips
// the structured-outputs double request entirely (routes.go, cited in the research doc) —
// without that, a schema call on a large prompt would be "the single most expensive
// mistake available here" (§1, "Cost").
//
// NEVER FAILS OPEN. Every parse function below returns null on ANY structural doubt —
// wrong enum, empty/missing required field, a REDO/INJECT/RESTART/ESCALATE with nothing
// to act on, or the model's own explicit "nothing was decided" sentinel (see the
// *_EXTRACTION_PROMPT strings) — rather than coercing to a default.
// Unlike layout.ts's OK_VERDICT fallback, there is no safe default for "the Planner's
// graph" or "the Tester's verdict": inventing one here would recreate the exact defect
// BATCH 2 (H13) just removed — a fail-open default indistinguishable from a real decision
// (measured: 84 of 85 executed graphs were a silently-invented one-step plan). The callers
// in dispatch.ts/frames.ts are responsible for falling through to their OWN existing
// hard-stop (PlanningFailed) or conservative default (the Boss's benign 'none') on a null
// — this module only ever hands back "recovered" or "nothing recovered," never a guess.
//
// Self-contained, mirroring critic.ts / grounding.ts / layout.ts: its own system prompts,
// a pure request-shape builder, pure parse/validate functions, and its own network call —
// nothing here depends on an Agent instance or its private Ollama client.

import { config } from './config.js'

// ---------------------------------------------------------------------------------------
// Ollama host

// The SAME client target the rest of the harness talks to — agent.ts constructs its own
// Ollama client identically: `new Ollama({ host: config.ollamaHost })`. Deliberately NOT
// layout.ts's process.env-direct read: that module's rationale (a screenshot subprocess
// reaching Ollama from wherever the harness process itself runs, launched via `docker
// exec` in worker mode) does not apply here — this module runs in-process, in the exact
// same process as agent.ts's own client, so config.ollamaHost is already correct for it.
function ollamaHost(): string {
  return config.ollamaHost
}

// ---------------------------------------------------------------------------------------
// JSON Schemas — deliberately small (§1, "Smallest sufficient implementation": "no
// `description` prose in the schema" and "fewer required fields" is the prescribed
// response if quality regresses under constraint, per the *Let Me Speak Freely?* /
// dottxt.co exchange cited there). Enums + `required` + `additionalProperties: false` are
// the entire mechanism; there is nothing else to add without risking the "reasoning under
// format restrictions" penalty that evidence describes.

type JsonSchema = Record<string, unknown>

// TASK_GRAPH_STEP_SCHEMA/TASK_GRAPH_SCHEMA (the Planner's JSON task-graph shape) and
// their extraction plumbing (ExtractedTaskStep/ExtractedTaskGraph, extractTaskGraph,
// parseExtractedTaskGraph, the 'task_graph' ExtractionKind) were REMOVED (2026-09,
// "iterative planner" — see dispatch.ts's module header). The Planner no longer
// produces a JSON graph at all: it returns a rough plan as plain text, then is
// resumed repeatedly to detail one task at a time via a simple TASK:/TEST:/DONE text
// convention (dispatch.ts's parseNextTask) — there is nothing graph-shaped left to
// restate here. task_start/tester_verdict/boss_verdict extraction (below) are
// unaffected; they concern separate checkpoints untouched by this change.

export const TASK_START_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    mode: { type: 'string', enum: ['answer', 'trivial', 'simple', 'objective'] },
    text: { type: 'string', minLength: 1 },
  },
  required: ['mode', 'text'],
  additionalProperties: false,
}

export const TESTER_VERDICT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['release', 'redo'] },
    reason: { type: 'string' },
  },
  required: ['verdict'],
  additionalProperties: false,
}

export const BOSS_VERDICT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['none', 'inject', 'restart', 'escalate'] },
    reason: { type: 'string' },
  },
  required: ['verdict'],
  additionalProperties: false,
}

// ---------------------------------------------------------------------------------------
// Extracted shapes. Deliberately separate from frames.ts's *Verdict types (which carry a
// `parsed` flag this module has no business producing — extraction either succeeds
// structurally or returns null, there is no partial state to report). The dispatch.ts/
// frames.ts call sites do the mapping into those shapes.

export interface ExtractedTaskStart {
  mode: 'answer' | 'trivial' | 'simple' | 'objective'
  text: string
}
export interface ExtractedTesterVerdict {
  verdict: 'release' | 'redo'
  reason?: string
}
export interface ExtractedBossVerdict {
  verdict: 'none' | 'inject' | 'restart' | 'escalate'
  reason?: string
}

export type ExtractionKind = 'task_start' | 'tester_verdict' | 'boss_verdict'

// ---------------------------------------------------------------------------------------
// System prompts. Each one is explicit that the model RESTATES an existing decision — it
// must never plan, verify, or classify afresh — and each names the exact escape-hatch
// sentinel to use when the input genuinely contains no decision to restate (see
// looksLikeNoDecision below for the pre-check that tries to avoid even reaching this
// point, and the parse functions for where the sentinel is caught).

export const NO_DECISION_SENTINEL = 'NO_DECISION_IN_INPUT'
export const NO_VERDICT_SENTINEL = 'NO_VERDICT_IN_INPUT'

const TASK_START_EXTRACTION_PROMPT =
  'You restate an ALREADY-MADE classification as JSON — you do not classify anything yourself. You are given ' +
  "the BOSS's own final answer to a task-start checkpoint, which already ends (or was meant to end) with one " +
  'of four markers: ANSWER:, TRIVIAL:, SIMPLE:, or OBJECTIVE:, each followed by text. Find which of the four ' +
  'it already committed to — from the marker if present, or from what the prose clearly states if the marker ' +
  'itself was dropped or garbled — and restate it as {mode, text}: mode is exactly one of answer/trivial/' +
  'simple/objective (lowercase), and text is the same content that followed (or was clearly intended to ' +
  'follow) that marker, verbatim where possible. Never pick a mode the text does not support, and never write ' +
  'your own answer, fix, or classification. If the text genuinely commits to none of the four, respond with ' +
  `exactly: {"mode":"objective","text":"${NO_DECISION_SENTINEL}"}`

const TESTER_VERDICT_EXTRACTION_PROMPT =
  'You restate an ALREADY-MADE verification verdict as JSON — you do not verify anything yourself. You are ' +
  "given the TESTER's own final answer, which already ends (or was meant to end) with RELEASE or " +
  'REDO: <specific follow-up>. Restate the verdict it already reached: verdict is exactly "release" or "redo" ' +
  '(lowercase); when it is redo, reason must be the SAME specific follow-up instruction the text already gives ' +
  '(verbatim where possible) — never write your own follow-up, and never invent one if the text does not ' +
  'actually specify what should happen next. If the text genuinely states no verdict at all — no acceptance ' +
  `and no specific request for a fix — respond with exactly: {"verdict":"redo","reason":"${NO_VERDICT_SENTINEL}"}`

const BOSS_VERDICT_EXTRACTION_PROMPT =
  'You restate an ALREADY-MADE review verdict as JSON — you do not review anything yourself. You are given the ' +
  "BOSS's own final answer at a standup or final checkpoint, which already ends (or was meant to end) with one " +
  'of: NONE, INJECT: <message>, RESTART: <context>, or ESCALATE: <diagnosis>. Restate the verdict it already ' +
  'reached: verdict is exactly one of none/inject/restart/escalate (lowercase); for inject/restart/escalate, ' +
  'reason must be the SAME message/context/diagnosis the text already gives (verbatim where possible) — never ' +
  'write your own, and never invent one if the text does not actually specify it. If the text genuinely states ' +
  `no verdict at all, respond with exactly: {"verdict":"escalate","reason":"${NO_VERDICT_SENTINEL}"}`

const SYSTEM_PROMPTS: Record<ExtractionKind, string> = {
  task_start: TASK_START_EXTRACTION_PROMPT,
  tester_verdict: TESTER_VERDICT_EXTRACTION_PROMPT,
  boss_verdict: BOSS_VERDICT_EXTRACTION_PROMPT,
}

const SCHEMAS: Record<ExtractionKind, JsonSchema> = {
  task_start: TASK_START_SCHEMA,
  tester_verdict: TESTER_VERDICT_SCHEMA,
  boss_verdict: BOSS_VERDICT_SCHEMA,
}

// Low, not zero: this is restatement, not open-ended composition, so it should be even
// more deterministic than critic.ts's/grounding.ts's 0.2 (which still exercises judgment).
export const EXTRACTION_TEMPERATURE = 0.1

export interface SchemaExtractionRequest {
  model: string
  think: false
  stream: false
  format: JsonSchema
  messages: [{ role: 'system'; content: string }, { role: 'user'; content: string }]
  options: { temperature: number }
}

// Pure request-shape builder (no network), mirroring layout.ts's buildLayoutRequest —
// deliberately NOT passing `tools`: HYPOTHESIS-LEDGER.md's probe found format+tools
// compose but the schema suppresses tool_calls on that turn, which is exactly right for a
// verdict-only turn and exactly why this must never be used on a turn where a tool call is
// still wanted (i.e. never inside a frame's own ReAct loop — only on this side call).
export function buildExtractionRequest(kind: ExtractionKind, model: string, proseAnswer: string): SchemaExtractionRequest {
  return {
    model,
    think: false,
    stream: false,
    format: SCHEMAS[kind],
    messages: [
      { role: 'system', content: SYSTEM_PROMPTS[kind] },
      { role: 'user', content: proseAnswer },
    ],
    options: { temperature: EXTRACTION_TEMPERATURE },
  }
}

// ---------------------------------------------------------------------------------------
// Pre-check: text that already reads like "nothing was decided" is refused before a
// network round-trip is spent trying to restate it — cheaper than the sentinel escape
// hatch above (which still costs a call) and catches the same failure the sentinel exists
// for as a backstop. Exported so it is directly testable without a model: this guard is
// deterministic by construction.
const NO_DECISION_PATTERN =
  /\b(giving up|give up|cannot complete|unable to complete|no (?:readable|valid) (?:plan|task graph)|insufficient information|need more (?:information|context) to (?:plan|proceed))\b/i

export function looksLikeNoDecision(text: string): boolean {
  return NO_DECISION_PATTERN.test(text)
}

// ---------------------------------------------------------------------------------------
// Robust parse: strips <think> blocks and code fences defensively (the schema is meant to
// make these impossible, but critic.ts's own comment — "qwen sometimes emits either
// despite format:\"json\"" — is exactly the caution this module inherits; JSON MODE not
// being enough is precisely why schema mode exists, but "stronger" is not "proven", so the
// same defence stays here) before taking the first balanced JSON object.

function stripThinkAndFences(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '')
  s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '')
  return s.trim()
}

// Mirrors critic.ts's extractFirstJsonObject exactly (kept local so this module stays
// self-contained, same as layout.ts keeping its own copy rather than importing critic.ts's).
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

function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const obj = extractFirstJsonObject(stripThinkAndFences(raw))
  if (!obj) return null
  try {
    const parsed = JSON.parse(obj)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------
// Parse + structural validation, one per kind. Each returns null on ANY doubt — see the
// module header. These are pure and unit-tested directly (no network).

export function parseExtractedTaskStart(raw: string): ExtractedTaskStart | null {
  const obj = parseJsonObject(raw)
  if (!obj) return null
  const mode = obj.mode
  const text = obj.text
  if (mode !== 'answer' && mode !== 'trivial' && mode !== 'simple' && mode !== 'objective') return null
  if (typeof text !== 'string' || text.trim().length === 0) return null
  const trimmed = text.trim()
  if (trimmed === NO_DECISION_SENTINEL) return null
  return { mode: mode as ExtractedTaskStart['mode'], text: trimmed }
}

export function parseExtractedTesterVerdict(raw: string): ExtractedTesterVerdict | null {
  const obj = parseJsonObject(raw)
  if (!obj) return null
  const verdict = obj.verdict
  if (verdict !== 'release' && verdict !== 'redo') return null
  const reasonRaw = obj.reason
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : undefined
  if (reason === NO_VERDICT_SENTINEL) return null
  // A redo with nothing to act on is not a followUp — never invent one at the call site by
  // falling back to a generic nudge; treat it the same as extraction having failed.
  if (verdict === 'redo' && !reason) return null
  const v = verdict as ExtractedTesterVerdict['verdict']
  return reason ? { verdict: v, reason } : { verdict: v }
}

export function parseExtractedBossVerdict(raw: string): ExtractedBossVerdict | null {
  const obj = parseJsonObject(raw)
  if (!obj) return null
  const verdict = obj.verdict
  if (verdict !== 'none' && verdict !== 'inject' && verdict !== 'restart' && verdict !== 'escalate') return null
  const reasonRaw = obj.reason
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : undefined
  if (reason === NO_VERDICT_SENTINEL) return null
  // inject/restart/escalate are all actions the harness acts on with `reason` as the
  // message/context/diagnosis it carries forward — an action with nothing to carry is
  // indistinguishable from a hallucinated one, so treat it as extraction failure.
  if (verdict !== 'none' && !reason) return null
  const v = verdict as ExtractedBossVerdict['verdict']
  return reason ? { verdict: v, reason } : { verdict: v }
}

// ---------------------------------------------------------------------------------------
// Network call + the four exported entry points. Bounded timeout since this is a single
// short, tool-free, think:false call — it should never be the slow part of a checkpoint.

const EXTRACTION_TIMEOUT_MS = 30_000

async function callExtraction(kind: ExtractionKind, model: string, proseAnswer: string): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), EXTRACTION_TIMEOUT_MS)
  try {
    const resp = await fetch(`${ollamaHost()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildExtractionRequest(kind, model, proseAnswer)),
      signal: controller.signal,
    })
    if (!resp.ok) return null
    const data = (await resp.json()) as { message?: { content?: string } }
    return data.message?.content ?? ''
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Each entry point pre-checks with looksLikeNoDecision (task_start only, of the three
// remaining kinds — a Tester/Boss verdict frame's prose is reviewing something else's
// work, not reporting its own progress, so "unable to complete" language in it describes
// the REVIEWED work, not the verdict itself, and must not short-circuit the verdict
// extraction), then calls the model, then validates structurally. Returns null on ANY
// failure — network, HTTP, parse, or structural — never a default.

export async function extractTaskStart(model: string, proseAnswer: string): Promise<ExtractedTaskStart | null> {
  if (!proseAnswer?.trim() || looksLikeNoDecision(proseAnswer)) return null
  const raw = await callExtraction('task_start', model, proseAnswer)
  if (raw === null) return null
  return parseExtractedTaskStart(raw)
}

export async function extractTesterVerdict(model: string, proseAnswer: string): Promise<ExtractedTesterVerdict | null> {
  if (!proseAnswer?.trim()) return null
  const raw = await callExtraction('tester_verdict', model, proseAnswer)
  if (raw === null) return null
  return parseExtractedTesterVerdict(raw)
}

export async function extractBossVerdict(model: string, proseAnswer: string): Promise<ExtractedBossVerdict | null> {
  if (!proseAnswer?.trim()) return null
  const raw = await callExtraction('boss_verdict', model, proseAnswer)
  if (raw === null) return null
  return parseExtractedBossVerdict(raw)
}
