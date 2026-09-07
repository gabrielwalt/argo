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
  | { type: 'thought'; content: string }
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
  | { type: 'replan'; reason: string }

// Tags a spawned frame's own events (thought/tool_call/tool_result/done/...) with
// which role produced them and where that frame sits in the delegation tree. An event
// with no tags is the top-level dispatch narrative (rendered exactly like the baseline
// single-loop UI); a tagged event belongs inside that frame's own card instead.
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

export type Role = 'planner' | 'implementer' | 'boss'

export type FrameStatus = 'success' | 'partial' | 'failed' | 'gave_up' | 'killed' | 'restarted'

export interface FrameSpawnRequest {
  role: Role
  parentFrameId: string | null   // null only for the Planner's first spawn
  assignment: string             // this frame's specific goal/prompt
  dependsOn?: string[]           // frameIds whose distilled conclusion feeds this one
  maxIterations?: number         // per-role default (frames.ts) if omitted
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

// ── The ledger — five entry shapes, tree-structured (frameId + parentFrameId) ──
// Append-only JSONL at /workspace/.argo/ledger.jsonl (src/ledger.ts). Every entry
// carries `ts` (ms epoch) and `kind` as its discriminant.

export interface LedgerDelegationEntry {
  kind: 'delegation'
  ts: number
  frameId: string
  parentFrameId: string | null
  from: Role | 'harness'
  to: Role
  prompt: string
  contextGiven?: string[]
}

export interface LedgerConclusionEntry {
  kind: 'conclusion'
  ts: number
  frameId: string
  status: FrameStatus
  summary: string
  filesTouched: string[]
  filesWritten: string[]
  confidence?: number
  issues?: string[]
}

export interface LedgerStandupEntry {
  kind: 'standup'
  ts: number
  scope: 'frame' | 'task'
  frameId?: string
  covered: number            // action-episode count (task-scope) or step count (frame-scope)
  summary: string
  concern?: string
}

export interface LedgerInjectionEntry {
  kind: 'injection'
  ts: number
  targetFrameId: string
  message: string
  reason: string
  injectedBy: Role | 'harness' | 'loop-detector'
  expectsResponse?: boolean
}

export type EpisodeKind = 'exploratory' | 'action'

export interface LedgerEpisodeEntry {
  kind: 'episode'
  ts: number
  frameId: string
  episodeId: string
  episodeKind: EpisodeKind
  tool: string
  argsSummary: string
  dependsOn: string[]        // episodeIds this one drew on (harness-inferred by default)
  evictedAt?: number         // ms epoch when stripped from the live window; undefined = still live
  fullContent?: string       // the original message content, kept here so expand() is lossless
}

export type LedgerEntry =
  | LedgerDelegationEntry
  | LedgerConclusionEntry
  | LedgerStandupEntry
  | LedgerInjectionEntry
  | LedgerEpisodeEntry
