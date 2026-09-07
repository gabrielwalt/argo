// AL-LOGGER: a NEW, ADDITIVE XML-based log format for Argo agent frames. Runs
// ALONGSIDE the existing JSONL SessionLogger (logger.ts) — never replaces it,
// never reads its state, and a failure here must never affect the existing
// logging path (every public method below is fire-and-forget: internal errors are
// swallowed into the write queue, not thrown back into agent.ts's hot path). The
// `sessionId`/`frameId`/`jsonlFilename` constructor params and each turn/response's
// `jsonl_seq` attribute are pure cross-references INTO that JSONL log — never read
// back FROM it, keeping the "never reads its state" guarantee above intact.
//
// One XML file per agent frame (one per SessionLogger-equivalent run), written
// incrementally turn-by-turn into LOGS_DIR's `al/` subfolder (AL_DIR, below) —
// alongside but never mixed into the existing logger's `.jsonl` files, named
// `{TIMESTAMP}_{ITERATION}_{AGENTNAME}.xml` — deliberately NOT the same sequence
// counter as logger.ts's `logFileSeq` (that would couple two independently-evolving
// files' numbering to each other for no reason); this file keeps its own counter,
// `alLogSeq`, reset only by tests via resetAlLogSeq().
//
// The tags are "pseudo-XML": content is escaped (escapeXml) so the file is valid
// XML text, but nothing here is validated against a schema or even guaranteed
// well-formed if a caller passes multiple root elements — this is a HUMAN-READABLE
// TRACE FORMAT first, not a machine-parsed one, matching the brief's own example.

import fs from 'fs/promises'
import path from 'path'
import type { AgentEvent, ModelOptions } from './types.js'
import { LOGS_DIR } from './logger.js'

// XML traces live in their own subfolder, separate from the JSONL/meta files
// logger.ts writes directly into LOGS_DIR — keeps the top-level logs directory
// listing (listLogs()/listSessions(), which glob LOGS_DIR for `.jsonl`) from ever
// having to account for `.xml` files, and gives the al-logger format room to grow
// its own directory structure independently. append() below creates this on
// demand via `fs.mkdir(path.dirname(this.filepath), { recursive: true })`.
const AL_DIR = path.join(LOGS_DIR, 'al')

// Shared-shape sequence counter, kept separate from logger.ts's logFileSeq (see file
// doc comment above) — but same pattern (module-level counter + reset hook) so tests
// can isolate runs from each other the same way logger.test.ts already does for
// SessionLogger.
let alLogSeq = 0
export function resetAlLogSeq() { alLogSeq = 0 }

// --- XML escaping -----------------------------------------------------------------
// Applied to EVERY piece of user/model/tool-provided content written into the file
// (queries, messages, tool arguments/results, event text) — nothing free-form is
// ever interpolated unescaped, since tool output and model content routinely
// contains `<`, `&`, or literal `"`/`'` that would otherwise break the pseudo-XML
// structure for a human or a future lenient parser.
export function escapeXml(input: unknown): string {
  const s = typeof input === 'string' ? input : String(input ?? '')
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Renders the `<al-model>` line's trailing option string — same fields/order
// logger.ts's own meta/options rendering used, so the two logs describe the same
// run identically, but flattened to a single space-joined string here instead of
// a table cell.
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

// Renders the `<al-tools>` block once, for the header — never repeated per-turn
// (the brief: "Tools logged once"). 2-space base indent, matching the rest of the
// file's indentation convention.
function formatTools(tools: AlToolDef[]): string {
  const lines: string[] = []
  lines.push(`<al-tools number="${tools.length}">`)
  for (const t of tools) {
    lines.push('  <al-tool>')
    lines.push(`    <al-tool-name>${escapeXml(t.function.name)}</al-tool-name>`)
    lines.push(`    <al-tool-description>${escapeXml(t.function.description)}</al-tool-description>`)
    lines.push(`    <al-tool-parameters>${escapeXml(JSON.stringify(t.function.parameters))}</al-tool-parameters>`)
    lines.push('  </al-tool>')
  }
  lines.push('</al-tools>')
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

// --- The logger --------------------------------------------------------------------

export class AlLogger {
  private filepath: string
  private writeQueue: Promise<void> = Promise.resolve()
  private turnNumber = 0
  // How many history messages had already been logged as "new" by the START of the
  // most recently opened turn — beginTurn() slices from here to build `newMessages`
  // itself; kept here only so close()/tests can inspect it if ever needed.
  private lastMessageCount = 0
  // True from beginTurn() until the matching turn is closed by the NEXT beginTurn()
  // (or by close()) — used only to make sure a turn's <al-turn> element is always
  // properly closed exactly once, even if logResponse/logToolExecution/logContext are
  // never called for it (e.g. the run aborts mid-turn).
  private inTurn = false
  private headerWritten = false
  // Latest JSONL `__seq` forwarded via logEvent() (agent.ts's emitAndLog calls this
  // for every event, seq included) — read by beginTurn()/logResponse() so each
  // <al-turn>/<al-response> can carry the exact JSONL line it corresponds to,
  // without every call site needing to thread the seq through explicitly. Starts
  // at 0 (no JSONL event logged yet); a turn opened before any event exists (never
  // happens in practice — 'message'/'start' are logged before the first beginTurn)
  // would simply carry jsonl_seq="0".
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
    this.filepath = path.join(AL_DIR, `${ts}_${seq}_${role}.xml`)

    const optsStr = formatOptions(options)
    const runAttrs = [
      sessionId ? ` session_id="${escapeXml(sessionId)}"` : '',
      frameId ? ` frame_id="${escapeXml(frameId)}"` : '',
      jsonlFilename ? ` jsonl_file="${escapeXml(jsonlFilename)}"` : '',
    ].join('')
    this.append(
      `<al-run${runAttrs}>\n`
      + `<al-query>${escapeXml(query)}</al-query>\n`
      + `<al-model>${escapeXml(model)}${optsStr ? ` ${optsStr}` : ''}</al-model>\n`
      + `<al-iteration>${seq} ${escapeXml(role)}</al-iteration>\n`
      + formatTools(tools) + '\n\n',
    )
    this.headerWritten = true
  }

  /**
   * Called right before a new Ollama request is issued for this turn. Opens a new
   * `<al-turn>` element (closing the previous one first, if still open) and writes
   * the `<al-call>` block: any context-editing modifications (collapsed tool
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
    lines.push(`<al-turn number="${String(this.turnNumber).padStart(4, '0')}" jsonl_seq="${this.lastSeq}">`)
    lines.push('  <al-call>')
    if (collapsed && collapsed.length > 0) {
      lines.push('    <al-context-modifications>')
      lines.push(`      <al-collapsed count="${collapsed.length}" reason="older tool results beyond recent 5">`)
      for (const c of collapsed) {
        lines.push(`        <al-collapsed-message index="${c.index}" original_chars="${c.originalChars}" sent_chars="${c.sentChars}" role="${escapeXml(c.role)}"/>`)
      }
      lines.push('      </al-collapsed>')
      lines.push('    </al-context-modifications>')
    }
    lines.push(`    <al-messages total="${totalMessages}" new="${newMessages.length}">`)
    for (const m of newMessages) {
      lines.push(`      <al-message role="${escapeXml(m.role)}">${escapeXml(m.content)}</al-message>`)
    }
    lines.push('    </al-messages>')
    lines.push('  </al-call>')
    lines.push('')

    this.append(lines.join('\n') + '\n')
  }

  /** Called when the Ollama response for the current turn arrives. */
  logResponse(response: AlResponse) {
    const lines: string[] = []
    lines.push(`  <al-response jsonl_seq="${this.lastSeq}">`)
    lines.push(`    <al-thinking>${escapeXml(response.thinking ?? '')}</al-thinking>`)
    lines.push(`    <al-content>${escapeXml(response.content ?? '')}</al-content>`)
    if (response.toolCalls && response.toolCalls.length > 0) {
      lines.push('    <al-tool-calls>')
      for (const tc of response.toolCalls) {
        lines.push('      <al-tool-call>')
        lines.push(`        <al-tool-call-name>${escapeXml(tc.name)}</al-tool-call-name>`)
        lines.push(`        <al-tool-call-arguments>${escapeXml(JSON.stringify(tc.args))}</al-tool-call-arguments>`)
        lines.push('      </al-tool-call>')
      }
      lines.push('    </al-tool-calls>')
    } else {
      lines.push('    <al-tool-calls/>')
    }
    const attrs = [
      response.durationMs != null ? `duration_ms="${response.durationMs}"` : null,
      `role="${escapeXml(response.role ?? 'assistant')}"`,
      `done="${response.done ?? true}"`,
      response.doneReason != null ? `done_reason="${escapeXml(response.doneReason)}"` : null,
      response.promptEvalCount != null ? `prompt_eval_count="${response.promptEvalCount}"` : null,
      response.evalCount != null ? `eval_count="${response.evalCount}"` : null,
    ].filter((a): a is string => a !== null)
    lines.push(`    <al-details ${attrs.join(' ')}/>`)
    lines.push('  </al-response>')
    lines.push('')

    this.append(lines.join('\n') + '\n')
  }

  /** Called after each tool execution this turn. Accumulates into an open
   *  `<al-tool-executions>` block — one call per tool run, so multiple tool calls
   *  in the same turn each get their own `<al-tool-execution>` appended in order. */
  logToolExecution(name: string, args: object, result: string, error: string | undefined, durationMs: number) {
    const lines: string[] = []
    lines.push('  <al-tool-executions>')
    lines.push('    <al-tool-execution>')
    lines.push(`      <al-tool-name>${escapeXml(name)}</al-tool-name>`)
    lines.push(`      <al-tool-arguments>${escapeXml(JSON.stringify(args))}</al-tool-arguments>`)
    const body = error ? `Error: ${error}\n${result}` : result
    lines.push(`      <al-tool-result duration_ms="${durationMs}">${escapeXml(body)}</al-tool-result>`)
    lines.push('    </al-tool-execution>')
    lines.push('  </al-tool-executions>')
    lines.push('')

    this.append(lines.join('\n') + '\n')
  }

  /** Called once token usage is known for the turn. */
  logContext(promptTokens: number, numCtx: number) {
    const pct = numCtx > 0 ? `${Math.round((promptTokens / numCtx) * 100)}%` : '0%'
    this.append(`  <al-context tokens="${promptTokens}" percent="${pct}" num_ctx="${numCtx}"/>\n`)
  }

  /**
   * Called for harness-level events between turns (eviction/compaction, warnings,
   * progress checks) — rendered as a standalone `<al-events><al-event .../></al-events>`
   * block, OUTSIDE any `<al-turn>` (matching the brief's example placement). Not every
   * AgentEvent variant produces output here — only the ones the brief calls out
   * (eviction/compact, warning, progress_check-shaped warnings); anything else is a
   * silent no-op so this can safely be wired to every emitAndLog call site without
   * needing a parallel filter at each call site.
   */
  logEvent(event: AgentEvent, seq?: number) {
    // Track the latest JSONL seq regardless of whether this event renders
    // anything here — beginTurn()/logResponse() read lastSeq lazily, so even an
    // event this logger has no rendering for (renderEvent() returns null for it)
    // must still advance the cross-reference forward to the next turn/response.
    if (seq != null) this.lastSeq = seq
    const body = this.renderEvent(event)
    if (body === null) return
    this.append(`<al-events>\n${body}\n</al-events>\n\n`)
  }

  private renderEvent(event: AgentEvent): string | null {
    switch (event.type) {
      case 'compact': {
        const lines: string[] = []
        const trigger = `context at ${Math.round(event.contextUsagePct * 100)}%`
        lines.push(`  <al-event type="eviction" trigger="${escapeXml(trigger)}">`)
        lines.push(`    <al-eviction-budget messages_before="${event.messagesBefore}" messages_after="${event.messagesAfter}"/>`)
        lines.push(`    <al-eviction-summary>${escapeXml(event.summary)}</al-eviction-summary>`)
        lines.push('  </al-event>')
        return lines.join('\n')
      }
      case 'warning': {
        const t = event.level ? 'progress_check' : 'warning'
        const lvl = event.level ? ` level="${escapeXml(event.level)}"` : ''
        return `  <al-event type="${t}"${lvl}>${escapeXml(event.message)}</al-event>`
      }
      case 'error':
        return `  <al-event type="error">${escapeXml(event.message)}</al-event>`
      default:
        return null
    }
  }

  /** Close the file. Idempotent-ish: safe to call once at the end of a run. */
  async close() {
    this.closeTurnIfOpen()
    this.append('</al-run>\n')
    await this.writeQueue
  }

  private closeTurnIfOpen() {
    if (!this.inTurn) return
    this.inTurn = false
    this.append('</al-turn>\n\n')
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
