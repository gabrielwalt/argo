// TRACE LOGGER: a NEW, ADDITIVE Markdown-based log format for Argo agent frames. Runs
// ALONGSIDE the existing JSONL SessionLogger (logger.ts) — never replaces it,
// never reads its state, and a failure here must never affect the existing
// logging path (every public method below is fire-and-forget: internal errors are
// swallowed into the write queue, not thrown back into agent.ts's hot path). The
// `sessionId`/`frameId`/`jsonlFilename` constructor params and each turn/response's
// `jsonl_seq` cross-reference are pure pointers INTO that JSONL log — never read
// back FROM it, keeping the "never reads its state" guarantee above intact.
//
// One Markdown file per agent frame (one per SessionLogger-equivalent run), written
// incrementally turn-by-turn into LOGS_DIR's `traces/` subfolder (AL_DIR, below) —
// alongside but never mixed into the existing logger's `.jsonl` files, named
// `{TIMESTAMP}_{ITERATION}_{AGENTNAME}.md` — deliberately NOT the same sequence
// counter as logger.ts's `logFileSeq` (that would couple two independently-evolving
// files' numbering to each other for no reason); this file keeps its own counter,
// `alLogSeq`, reset only by tests via resetAlLogSeq().
//
// The output is heading-based Markdown: content is escaped (escapeMd) only where it
// would otherwise be misread as document structure (a line starting with `#` reading
// as a heading, or a line that is exactly `---` reading as a horizontal rule/fold
// boundary) — this is a HUMAN-READABLE TRACE FORMAT first, meant to render/fold
// nicely in an editor, not a machine-parsed one, matching the brief's own example.

import fs from 'fs/promises'
import path from 'path'
import type { AgentEvent, ModelOptions } from './types.js'
import { LOGS_DIR } from './logger.js'

// Markdown traces live in their own subfolder, separate from the JSONL/meta files
// logger.ts writes directly into LOGS_DIR — keeps the top-level logs directory
// listing (listLogs()/listSessions(), which glob LOGS_DIR for `.jsonl`) from ever
// having to account for `.md` trace files, and gives this format room to grow its
// own directory structure independently. append() below creates this on demand via
// `fs.mkdir(path.dirname(this.filepath), { recursive: true })`.
const AL_DIR = path.join(LOGS_DIR, 'traces')

// Shared-shape sequence counter, kept separate from logger.ts's logFileSeq (see file
// doc comment above) — but same pattern (module-level counter + reset hook) so tests
// can isolate runs from each other the same way logger.test.ts already does for
// SessionLogger.
let alLogSeq = 0
export function resetAlLogSeq() { alLogSeq = 0 }

// --- Markdown escaping -------------------------------------------------------------
// Applied to EVERY piece of user/model/tool-provided content written into the file
// (queries, messages, tool arguments/results, event text) — nothing free-form is
// interpolated unescaped, since model/tool content routinely contains a line
// starting with `#` (which would otherwise read as a heading) or a bare `---` line
// (which would otherwise read as a horizontal rule / fold boundary, indistinguishable
// from the turn separators this format itself uses). Only those two structural
// hazards are escaped — deliberately NOT a full Markdown-special-character escape
// (no touching `*`, `_`, backticks, etc.) since this is a human-readable trace, not
// content meant to render as rich Markdown; over-escaping would just make it harder
// to read.
export function escapeMd(input: unknown): string {
  const s = typeof input === 'string' ? input : String(input ?? '')
  return s
    .split('\n')
    .map(line => {
      // A line starting with one or more `#` followed by a space (or end of line) is
      // heading syntax — escape just the leading `#` so it renders as literal text.
      if (/^#+(?:\s|$)/.test(line)) return `\\${line}`
      // A line that IS (after trim) exactly `---` (or `***`/`___`, the other two HR
      // spellings) is a horizontal rule / our own turn-separator syntax — escape its
      // first character only, enough to break the HR/heading-underline parse.
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) return `\\${line}`
      return line
    })
    .join('\n')
}

// Renders the model options line's trailing option string — same fields/order
// logger.ts's own meta/options rendering used, so the two logs describe the same
// run identically, just as a flat space-joined string here instead of a table cell.
function formatOptions(options: ModelOptions): string {
  const parts = [
    options.temperature != null ? `temp=${options.temperature}` : null,
    options.top_p != null ? `top_p=${options.top_p}` : null,
    options.top_k != null ? `top_k=${options.top_k}` : null,
    options.num_ctx != null ? `ctx=${options.num_ctx}` : null,
  ].filter((p): p is string => p !== null)
  return parts.join(' ')
}

export interface AlToolDef {
  type: string
  function: { name: string; description: string; parameters: object }
}

// Renders the `## Tools (N)` block once, for the header — never repeated per-turn
// (the brief: "Tools logged once"). Each tool gets its own `###` sub-heading so the
// block folds per-tool in an editor.
function formatTools(tools: AlToolDef[]): string {
  const lines: string[] = []
  lines.push(`## Tools (${tools.length})`)
  lines.push('')
  for (const t of tools) {
    lines.push(`### ${escapeMd(t.function.name)}`)
    lines.push(`- **Description**: ${escapeMd(t.function.description)}`)
    lines.push(`- **Parameters**: \`${escapeMd(JSON.stringify(t.function.parameters))}\``)
    lines.push('')
  }
  return lines.join('\n')
}

export interface AlMessage {
  role: string
  content: string
}

export interface AlCollapsedMessage {
  index: number
  originalChars: number
  sentChars: number
  role: string
}

export interface AlToolCall {
  name: string
  args: object
}

export interface AlResponse {
  thinking?: string
  content?: string
  toolCalls?: AlToolCall[]
  durationMs?: number
  role?: string
  done?: boolean
  doneReason?: string
  promptEvalCount?: number
  evalCount?: number
}

// Renders a block of blockquoted content — content is escaped, then EVERY line
// (including blank ones, which become a bare `>`) is prefixed with `> ` so the
// whole block reads as one blockquote in a Markdown renderer/editor fold, matching
// the brief's `> line1\n> line2` convention. Empty content still yields a single
// `> ` line so the block is never entirely absent from the file.
function blockquote(content: string): string {
  const escaped = escapeMd(content)
  const lines = escaped.split('\n')
  return lines.map(l => (l.length > 0 ? `> ${l}` : '>')).join('\n')
}

// --- The logger --------------------------------------------------------------------

export class TraceLogger {
  private filepath: string
  private writeQueue: Promise<void> = Promise.resolve()
  private turnNumber = 0
  // How many history messages had already been logged as "new" by the START of the
  // most recently opened turn — beginTurn() slices from here to build `newMessages`
  // itself; kept here only so close()/tests can inspect it if ever needed.
  private lastMessageCount = 0
  // True from beginTurn() until the matching turn is closed by the NEXT beginTurn()
  // (or by close()) — used only to make sure a turn's section is always properly
  // separated exactly once, even if logResponse/logToolExecution/logContext are
  // never called for it (e.g. the run aborts mid-turn).
  private inTurn = false
  private headerWritten = false
  // Latest JSONL `__seq` forwarded via logEvent() (agent.ts's emitAndLog calls this
  // for every event, seq included) — read by beginTurn()/logResponse() so each
  // turn/response heading can carry the exact JSONL line it corresponds to, without
  // every call site needing to thread the seq through explicitly. Starts at 0 (no
  // JSONL event logged yet); a turn opened before any event exists (never happens in
  // practice — 'message'/'start' are logged before the first beginTurn) would simply
  // carry seq=0.
  private lastSeq = 0

  constructor(
    query: string,
    model: string,
    options: ModelOptions,
    role: string,
    tools: AlToolDef[],
    sessionId?: string,
    frameId?: string,
    jsonlFilename?: string,
  ) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const seq = String(++alLogSeq).padStart(4, '0')
    this.filepath = path.join(AL_DIR, `${ts}_${seq}_${role}.md`)

    const optsStr = formatOptions(options)
    const truncatedQuery = query.length > 120 ? `${query.slice(0, 120)}…` : query

    const metaLines: string[] = []
    if (sessionId) metaLines.push(`- **Session**: ${escapeMd(sessionId)}`)
    if (frameId) metaLines.push(`- **Frame**: ${escapeMd(frameId)}`)
    if (jsonlFilename) metaLines.push(`- **JSONL**: ${escapeMd(jsonlFilename)}`)

    const lines: string[] = []
    lines.push(`# ${escapeMd(role.charAt(0).toUpperCase() + role.slice(1))} ${seq}`)
    lines.push(`- **Model**: ${escapeMd(model)}${optsStr ? ` ${optsStr}` : ''}`)
    lines.push(...metaLines)
    lines.push('')
    lines.push(formatTools(tools))
    lines.push('')

    this.append(lines.join('\n') + '\n')
    this.headerWritten = true
  }

  /**
   * Called right before a new Ollama request is issued for this turn. Opens a new
   * `## Turn N` section (closing the previous one first, if still open) and writes
   * the `### Call` block: any context-editing modifications (collapsed tool
   * results), then the messages newly added to history since the previous turn
   * (or ALL of them, on turn 1).
   *
   * `totalMessages` is the full history length AS SENT to the model this turn
   * (matches SessionLogger's `ollama_request.message_count` semantics — i.e.
   * including whatever this call is about to add, if the caller counts that way;
   * agent.ts passes messages.length from chatCall's already-built `messages` array).
   * `newMessages` are exactly the messages this turn is presenting for the first
   * time — turn 1: everything; later turns: the tail added since the last beginTurn.
   */
  beginTurn(totalMessages: number, newMessages: AlMessage[], collapsed?: AlCollapsedMessage[]) {
    this.closeTurnIfOpen()
    this.turnNumber++
    this.inTurn = true
    this.lastMessageCount = totalMessages

    const lines: string[] = []
    lines.push(`## Turn ${this.turnNumber} [seq=${this.lastSeq}]`)
    lines.push('')
    lines.push(`### Call (${totalMessages} messages, ${newMessages.length} new)`)
    lines.push('')
    if (collapsed && collapsed.length > 0) {
      lines.push('#### Context modifications')
      for (const c of collapsed) {
        lines.push(`- Collapsed message #${c.index} (${escapeMd(c.role)}, ${c.originalChars}→${c.sentChars} chars)`)
      }
      lines.push('')
    }
    lines.push('#### New messages')
    if (newMessages.length === 0) {
      lines.push('_(none)_')
    } else {
      for (const m of newMessages) {
        lines.push(`> **[${escapeMd(m.role)}]**`)
        lines.push(blockquote(m.content))
        lines.push('')
      }
    }
    lines.push('')

    this.append(lines.join('\n') + '\n')
  }

  /** Called when the Ollama response for the current turn arrives. */
  logResponse(response: AlResponse) {
    const durationStr = response.durationMs != null ? `${response.durationMs}ms, ` : ''
    const tokensStr = response.evalCount != null ? `${response.evalCount} tokens generated, ` : ''
    const promptStr = response.promptEvalCount != null
      ? `prompt=${response.promptEvalCount}`
      : ''

    const lines: string[] = []
    lines.push(`### Response (${durationStr}${tokensStr}${promptStr})`)
    lines.push('')
    lines.push('#### Thinking')
    lines.push(response.thinking ? blockquote(response.thinking) : '_(empty)_')
    lines.push('')
    lines.push('#### Content')
    lines.push(response.content ? blockquote(response.content) : '_(empty)_')
    lines.push('')
    lines.push('#### Tool calls')
    if (response.toolCalls && response.toolCalls.length > 0) {
      response.toolCalls.forEach((tc, i) => {
        lines.push(`${i + 1}. \`${escapeMd(tc.name)}(${escapeMd(JSON.stringify(tc.args))})\``)
      })
    } else {
      lines.push('_(none)_')
    }
    lines.push('')
    const detailParts = [
      `role=${response.role ?? 'assistant'}`,
      `done=${response.done ?? true}`,
      response.doneReason != null ? `done_reason=${response.doneReason}` : null,
    ].filter((p): p is string => p !== null)
    lines.push(`_${escapeMd(detailParts.join(' '))}_`)
    lines.push('')

    this.append(lines.join('\n') + '\n')
  }

  /** Called after each tool execution this turn. Accumulates into an open
   *  `### Tool Results` block — one entry per tool run, so multiple tool calls
   *  in the same turn each get their own fenced block appended in order. */
  logToolExecution(name: string, args: object, result: string, error: string | undefined, durationMs: number) {
    const body = error ? `Error: ${error}\n${result}` : result
    const lines: string[] = []
    lines.push('### Tool Results')
    lines.push('')
    lines.push(`**${escapeMd(name)}** (${durationMs}ms), args: \`${escapeMd(JSON.stringify(args))}\`:`)
    lines.push('```')
    lines.push(body)
    lines.push('```')
    lines.push('')

    this.append(lines.join('\n') + '\n')
  }

  /** Called once token usage is known for the turn. */
  logContext(promptTokens: number, numCtx: number) {
    const pct = numCtx > 0 ? `${Math.round((promptTokens / numCtx) * 100)}%` : '0%'
    this.append(`_Context: ${promptTokens}/${numCtx} tokens (${pct})_\n\n`)
  }

  /**
   * Called for harness-level events between turns (eviction/compaction, warnings,
   * progress checks) — rendered as a standalone `## Events` list item, OUTSIDE any
   * turn section (matching the brief's example placement). Not every AgentEvent
   * variant produces output here — only the ones the brief calls out (eviction/
   * compact, warning, progress_check-shaped warnings); anything else is a silent
   * no-op so this can safely be wired to every emitAndLog call site without needing
   * a parallel filter at each call site.
   */
  logEvent(event: AgentEvent, seq?: number) {
    // Track the latest JSONL seq regardless of whether this event renders anything
    // here — beginTurn()/logResponse() read lastSeq lazily, so even an event this
    // logger has no rendering for (renderEvent() returns null for it) must still
    // advance the cross-reference forward to the next turn/response.
    if (seq != null) this.lastSeq = seq
    const body = this.renderEvent(event)
    if (body === null) return
    this.append(`## Events\n\n${body}\n\n---\n\n`)
  }

  private renderEvent(event: AgentEvent): string | null {
    switch (event.type) {
      case 'compact': {
        const before = event.messagesBefore
        const after = event.messagesAfter
        const pct = Math.round(event.contextUsagePct * 100)
        return `- **[eviction]** Context at ${pct}% — evicted ${before - after} messages, ${escapeMd(event.summary)}`
      }
      case 'warning': {
        const t = event.level ? 'progress_check' : 'warning'
        const lvl = event.level ? ` level=${event.level}` : ''
        return `- **[${t}]**${lvl} ${escapeMd(event.message)}`
      }
      case 'error':
        return `- **[error]** ${escapeMd(event.message)}`
      default:
        return null
    }
  }

  /** Close the file. Idempotent-ish: safe to call once at the end of a run. */
  async close() {
    this.closeTurnIfOpen()
    await this.writeQueue
  }

  private closeTurnIfOpen() {
    if (!this.inTurn) return
    this.inTurn = false
    this.append('---\n\n')
  }

  private append(text: string) {
    this.writeQueue = this.writeQueue
      .then(() => fs.mkdir(path.dirname(this.filepath), { recursive: true }))
      .then(() => fs.appendFile(this.filepath, text, 'utf-8'))
      // Never let a write failure here propagate into agent.ts's hot path or leave
      // the queue permanently rejected (a rejected promise in the chain would make
      // every SUBSEQUENT .then() above short-circuit, silently dropping the rest of
      // the run's log forever) — this is a best-effort trace, not load-bearing state.
      .catch(() => {})
  }
}
