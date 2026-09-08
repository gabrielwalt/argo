export type ToolName = 'bash' | 'web_search' | 'read_file' | 'write_file' | 'edit_file' | 'fetch_url' | 'browser_fetch' | 'ledger' | 'conclude'

export interface ToolResult {
  output: string
  error?: string
}

export interface ModelOptions {
  temperature?: number
  top_p?: number
  top_k?: number
  num_ctx?: number
  num_predict?: number
}

export type AgentEvent =
  | { type: 'start'; model: string; query: string; options: ModelOptions }
  | { type: 'iteration'; current: number; max: number }
  | { type: 'ollama_request'; iteration: number; message_count: number; model: string }
  // content: the model's own visible text alongside/instead of a tool call (Ollama's
  // message.content). thinking: its separate raw chain-of-thought (message.thinking,
  // reasoning models only) — the actual internal reasoning, distinct from content.
  // Either may be present without the other (e.g. a turn that spends its whole
  // token budget on thinking and never reaches content) — never both absent, since
  // the emit site only fires when at least one is non-empty.
  | { type: 'thought'; content?: string; thinking?: string }
  | { type: 'system_prompt'; content: string }
  | { type: 'tool_call'; tool: ToolName; args: Record<string, unknown> }
  // rejected: true marks a HARNESS-level block (role restriction, loop steer/replay) —
  // deliberately still shaped exactly like a real tool_result (see
  // Agent.rejectToolCall) so the MODEL can't tell the difference and reacts the same
  // way it would to a genuine failure. This field is for CODE (tests, analytics) that
  // needs to tell "the tool actually ran" apart from "the harness declined to run it."
  // replayed: true (2026-09, H20 loop-guard redesign) narrows that further for the
  // ONE rejected case that isn't really a failure at all: the loop ladder's L0 rung
  // serving back the CACHED result of an identical call already run, labeled as a
  // repeat, instead of a bare block (see Agent.replayToolCall / loop.ts's
  // evaluateCall). Always accompanied by rejected: true; never set on its own.
  | { type: 'tool_result'; tool: ToolName; output: string; error?: string; duration_ms: number; rejected?: boolean; replayed?: boolean }
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'token_usage'; prompt_tokens: number; generated_tokens: number; num_ctx: number; eval_duration_ms?: number; total_duration_ms?: number }
  | { type: 'done'; content: string }
  | { type: 'git_commit'; hash: string; message: string }
  | {
      // Structured-context EVICTION event (src/eviction.ts) — deterministic, harness-
      // owned context management. No LLM-summarization compaction path exists any
      // more; this is the only way a frame's context ever shrinks mid-run.
      type: 'compact'
      summary: string
      messagesBefore: number
      messagesAfter: number
      contextUsagePct: number
      rangeDescription: string
      validated: boolean
      manual?: boolean
    }
  | { type: 'error'; message: string }
  // `level` is the LOOP-RECOVERY LADDER rung (loop.ts's LoopAction.level) when this
  // warning came from that ladder — L0 steer / L1 compaction / L2 stop-and-reframe.
  // Previously agent.ts emitted only `action.message` and threw `action.level` away, so
  // every consumer (the eval's metrics counters, the UI) had to recover the rung by
  // regex over prose; two counters were silently broken for months for exactly that
  // reason. Optional because most warnings have no ladder rung at all (stall re-ground,
  // task-advance, summary ask, near-duplicate streak nudge) — absent means "not a
  // ladder event", never "L0".
  | { type: 'warning'; message: string; level?: 'L0' | 'L1' | 'L2' }
  // ── Multi-agent architecture — harness-level narrative events, always emitted
  // UNTAGGED (no __frameId) since they describe the whole task, not one role's turn.
  // Every event a spawned frame produces (thought/tool_call/done/...) is instead
  // TAGGED with FrameTag (below) by dispatch.ts's spawnFrame — reusing the existing
  // event shapes rather than adding a parallel set for them.
  | { type: 'objective'; text: string }

// Tags a spawned frame's own events (thought/tool_call/tool_result/done/...) with
// which role produced them and where that frame sits in the delegation tree. An event
// with no tags is the top-level dispatch narrative; a tagged event belongs inside
// that frame's own card instead.
export interface FrameTag {
  __frameId?: string
  __role?: Role
  __parentFrameId?: string | null
}

export interface GitCommit {
  hash: string
  message: string
  date: string
  author: string
}

// ── Multi-agent architecture ──
// A call frame is one role invocation, implemented as one scoped Agent instance
// (see src/frames.ts). The Orchestrator itself is harness code (src/dispatch.ts),
// never an LLM call.

export type Role = 'planner' | 'implementer' | 'dispatcher'

export type FrameStatus = 'success' | 'partial' | 'failed' | 'gave_up' | 'killed' | 'restarted'

export interface FrameSpawnRequest {
  role: Role
  parentFrameId: string | null   // null only for the Planner's first spawn
  assignment: string             // this frame's specific goal/prompt
  dependsOn?: string[]           // frameIds whose distilled conclusion feeds this one
  maxIterations?: number         // per-role default (frames.ts) if omitted
  // If set, reuse THIS frameId instead of minting a new one, and preload the new
  // Agent's history from that frameId's existing ledger file (dispatch.ts's
  // spawnFrame) before its chat() call — the mechanism behind the Dispatcher's
  // one-persistent-frame-per-session context model (see dispatch.ts's
  // dispatcherFrameId). The frame is assumed to already be registered in the
  // session registry from a previous run, so spawnFrame skips registerFrame for it.
  persistentFrameId?: string
}

export interface FrameResult {
  frameId: string
  status: FrameStatus
  summary: string                // hard-capped (see frames.ts SUMMARY_CHAR_CAP)
  filesTouched: string[]         // diff-derived, not self-reported
  filesWritten: string[]
  confidence?: number
  issues?: string[]
}

// ── The ledger — PER-FRAME FILES ──
// One append-only JSONL file per frame under /workspace/.argo/frames/ (src/ledger.ts),
// registered in /workspace/.argo/sessions.json. Frame identity comes from WHICH FILE
// an entry lives in — there is no frameId/taskId/agent field on the entry itself any
// more. Chronological order is append order (no `ts` field needed either). This is
// deliberately the SAME shape as a chat message — no separate delegation/conclusion/
// standup/injection/episode bookkeeping — so the ledger stays simple enough for the
// model itself to read back via the `ledger` tool (tools/index.ts), which strips
// even further down to {id, role, content} before returning it to the model.
export interface LedgerMessage {
  // Core fields (what agents see via the ledger tool):
  id: string                    // unique message ID for expand recovery
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string

  // UI metadata (stored in the file, NOT returned to agents):
  thinking?: string             // model's chain-of-thought (separate from content)
  toolName?: string             // tool name (on tool_call and tool_result entries)
  toolArgs?: Record<string, unknown>  // structured tool arguments
  durationMs?: number           // tool execution time in ms
  error?: boolean               // true if tool result was an error
  promptTokens?: number         // tokens in the prompt this turn
  generatedTokens?: number      // tokens generated this turn
  totalDurationMs?: number      // total Ollama response time in ms
  model?: string                // model name — set on the first message of a frame
  modelOptions?: ModelOptions   // sampling options — set on the first message of a frame
  // True ONLY on a follow-up "eviction marker" entry appended AFTER a message's
  // original entry (ledger.ts's recordMessage, called from agent.ts's
  // compactHistory once eviction stubs a message in the live in-memory history) —
  // never on the original entry itself, and never on a `messages`/`expand` result
  // (see ledger.ts's readFrame/expand for how the two entries that can share one
  // `id` are told apart). Its own `content` IS the stub text
  // (`[evicted — N chars; msg_id "..." to recover]`), not the original.
  evicted?: boolean
}

// ── Session registry (src/ledger.ts) ──
// /workspace/.argo/sessions.json — maps a session to its runs, and each run to the
// ORDERED list of frames spawned during it (dispatch.ts's spawnFrame registers each
// one via ledger.registerFrame as it's created). This is the only place frame
// parentage/role is recorded now — the frame's own ledger file carries no such
// metadata, since the file IS the frame's scope.
export interface SessionRegistry {
  currentSessionId?: string   // the active session — replaces current-session.txt
  sessions: Array<{
    id: string              // session ID
    runs: Array<{
      startedAt: string     // ISO timestamp
      frames: Array<{
        frameId: string     // e.g. "dispatcher-abc"
        role: Role          // dispatcher/planner/implementer
        parentFrameId: string | null
      }>
    }>
  }>
}
