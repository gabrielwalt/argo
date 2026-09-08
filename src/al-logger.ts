// TRACE LOGGER: a Markdown-based log format for Argo agent frames — the harness's
// narrative trace, complementary to the ledger (ledger.ts), which is the durable
// per-frame message record. A failure here must never affect the real run (every
// public method below is fire-and-forget: internal errors are swallowed into the
// write queue, not thrown back into agent.ts's hot path).
//
// One Markdown file per agent frame (one per chat() run), written incrementally
// turn-by-turn directly into LOGS_DIR (AL_DIR, below) — alongside the (now mostly
// empty, writer-removed) `.jsonl` files and other log artifacts, named
// `{TIMESTAMP}_{ITERATION}_{AGENTNAME}.md`. This file keeps its own sequence
// counter, `alLogSeq`, reset only by tests via resetAlLogSeq().
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

// Markdown traces live directly in LOGS_DIR (no `traces/` subfolder) — same
// directory as everything else logger.ts manages. append() below creates this on
// demand via `fs.mkdir(path.dirname(this.filepath), { recursive: true })`, though
// LOGS_DIR itself is expected to already exist by the time any run gets here.
const AL_DIR = LOGS_DIR

// Module-level counter + reset hook so tests can isolate runs from each other.
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

// --- Per-tool-call readable formatting ----------------------------------------------
// Replaces the old flat `N. \`toolName(JSON.stringify(args))\`` one-liner — that
// format made every call, regardless of shape, equally opaque (a bash command's
// spaces and quoting mangled by JSON escaping, a conclude message unreadable
// buried in a value string). Each tool below instead gets a `#### Call <name>`
// heading plus the one or two pieces of its arguments that actually matter to a
// human reading the trace; a tool with no bespoke case still gets a heading and its
// full args as a fenced JSON block (the fallback branch), never a silent no-op.
function formatToolCall(tc: AlToolCall): string[] {
  const args = tc.args as Record<string, unknown>
  switch (tc.name) {
    case 'bash': {
      const lines = [`#### Call bash`, '```', escapeMd(String(args.command ?? '')), '```']
      if (args.cwd) lines.push(`cwd: \`${escapeMd(String(args.cwd))}\``)
      return lines
    }
    case 'read_file': {
      // Shadows nothing named `path` at module scope by using a distinct name —
      // this file's own top-level `import path from 'path'` (the Node module) is
      // never referenced inside this function, but a same-named local const would
      // still needlessly invite confusion for a future reader/editor.
      const filePath = typeof args.path === 'string' ? args.path : (Array.isArray(args.paths) ? args.paths.join(', ') : '')
      if (typeof args.pattern === 'string' && args.pattern) {
        return [`#### Call read_file (search)`, `\`${escapeMd(filePath)}\` — pattern: \`${escapeMd(args.pattern)}\``]
      }
      const offsetNum = typeof args.offset === 'number' ? args.offset : 1
      const limitNum = typeof args.limit === 'number' ? args.limit : null
      const range = args.offset != null || args.limit != null
        ? ` (lines ${offsetNum}-${limitNum != null ? offsetNum + limitNum - 1 : '?'})`
        : ''
      return [`#### Call read_file`, `\`${escapeMd(filePath)}\`${range}`]
    }
    case 'write_file': {
      const content = typeof args.content === 'string' ? args.content : ''
      return [`#### Call write_file`, `\`${escapeMd(String(args.path ?? ''))}\` (${content.length} chars)`]
    }
    case 'edit_file':
      return [`#### Call edit_file`, `\`${escapeMd(String(args.path ?? ''))}\``]
    case 'conclude': {
      // Plain (not blockquoted) message text, matching the brief's example exactly
      // — conclude's message is this frame's own final answer/assignment/summary,
      // read as the primary content of this call rather than as quoted material
      // the way a tool RESULT or a history message is.
      const lines = [`#### Call conclude`, `**status**: \`${escapeMd(String(args.status ?? ''))}\``, '']
      if (typeof args.message === 'string' && args.message) lines.push(escapeMd(args.message))
      return lines
    }
    case 'web_search':
      return [`#### Call web_search`, `\`${escapeMd(String(args.query ?? ''))}\``]
    case 'fetch_url':
    case 'browser_fetch':
      return [`#### Call ${tc.name}`, `\`${escapeMd(String(args.url ?? ''))}\``]
    case 'ledger': {
      const action = String(args.action ?? '')
      const extra = args.n != null
        ? ` (n=${String(args.n)})`
        : args.frame_id ? ` (frame_id=${escapeMd(String(args.frame_id))})`
        : args.episode_id ? ` (episode_id=${escapeMd(String(args.episode_id))})`
        : ''
      return [`#### Call ledger`, `**action**: \`${escapeMd(action)}\`${extra}`]
    }
    default:
      return [`#### Call ${escapeMd(tc.name)}`, '```json', escapeMd(JSON.stringify(tc.args)), '```']
  }
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
  // separated exactly once, even if logResponse/logContext are
  // never called for it (e.g. the run aborts mid-turn).
  private inTurn = false
  private headerWritten = false
  // Latest per-run `__seq` forwarded via logEvent() (agent.ts's emitAndLog calls
  // this for every event, seq included) — read by beginTurn()/logResponse() so
  // each turn/response heading can carry the exact seq it corresponds to, without
  // every call site needing to thread the seq through explicitly. Starts at 0 (no
  // event logged yet); a turn opened before any event exists (never happens in
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
  ) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const seq = String(++alLogSeq).padStart(4, '0')
    this.filepath = path.join(AL_DIR, `${ts}_${seq}_${role}.md`)

    const optsStr = formatOptions(options)
    const truncatedQuery = query.length > 120 ? `${query.slice(0, 120)}…` : query

    const metaLines: string[] = []
    if (sessionId) metaLines.push(`- **Session**: ${escapeMd(sessionId)}`)
    if (frameId) metaLines.push(`- **Frame**: ${escapeMd(frameId)}`)

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
   * the `### Call` block: the messages newly added to history since the previous
   * turn (or ALL of them, on turn 1). Collapse and eviction now both modify
   * this.history IN PLACE (agent.ts's collapseOldToolResults/compactHistory), so
   * a shortened tool result just shows up as a shorter entry in `newMessages` —
   * there's no separate "context modifications" detail to log here any more.
   *
   * `totalMessages` is the full history length AS SENT to the model this turn
   * (matches the harness's own `ollama_request.message_count` event semantics —
   * i.e. including whatever this call is about to add, if the caller counts that
   * way; agent.ts passes messages.length from chatCall's already-built `messages`
   * array).
   * `newMessages` are exactly the messages this turn is presenting for the first
   * time — turn 1: everything; later turns: the tail added since the last beginTurn.
   */
  beginTurn(totalMessages: number, newMessages: AlMessage[]) {
    this.closeTurnIfOpen()
    this.turnNumber++
    this.inTurn = true
    this.lastMessageCount = totalMessages

    const lines: string[] = []
    lines.push(`## Turn ${this.turnNumber} [seq=${this.lastSeq}]`)
    lines.push('')
    lines.push(`### Call (${totalMessages} messages, ${newMessages.length} new)`)
    lines.push('')
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
    // Skip empty sections entirely — a "#### Thinking" or "#### Content" heading
    // over an "_(empty)_" placeholder was pure noise on every turn that had a tool
    // call but no reasoning/final text, which is most of them.
    if (response.thinking) {
      lines.push('#### Thinking')
      lines.push(blockquote(response.thinking))
      lines.push('')
    }
    if (response.content) {
      lines.push('#### Content')
      lines.push(blockquote(response.content))
      lines.push('')
    }
    // Per-tool-call readable formatting (formatToolCall, below) replaces the old
    // flat `toolName(JSON.stringify(args))` one-liner — a bash command, a file
    // path, a conclude status/message are each rendered as the kind of thing they
    // actually are, not as an opaque JSON blob.
    if (response.toolCalls && response.toolCalls.length > 0) {
      for (const tc of response.toolCalls) {
        lines.push(...formatToolCall(tc))
        lines.push('')
      }
    }
    // The `_role=assistant done=true done_reason=stop_` metadata line is dropped —
    // it was constant (role is always 'assistant', done is always true by the time
    // this fires) for the overwhelming majority of turns and added nothing a reader
    // needed; the few real done_reason values worth knowing (e.g. 'length') are
    // rare enough not to warrant a line on every single turn.

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
    // Track the latest per-run seq regardless of whether this event renders
    // anything here — beginTurn()/logResponse() read lastSeq lazily, so even an
    // event this logger has no rendering for (renderEvent() returns null for it)
    // must still advance the cross-reference forward to the next turn/response.
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
