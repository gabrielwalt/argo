export type ToolName = 'bash' | 'web_search' | 'read_file' | 'write_file' | 'edit_file' | 'fetch_url' | 'browser_fetch' | 'update_plan' | 'ledger'

export interface ToolResult {
  output: string
  error?: string
}

export interface ModelOptions {
  temperature?: number
  top_p?: number
  top_k?: number
  num_ctx?: number
}

export type AgentEvent =
  | { type: 'start'; model: string; query: string; options: ModelOptions }
  | { type: 'iteration'; current: number; max: number }
  | { type: 'ollama_request'; iteration: number; message_count: number; model: string }
  | { type: 'thought'; content: string }
  | { type: 'tool_call'; tool: ToolName; args: Record<string, unknown> }
  // rejected: true marks a HARNESS-level block (plan/act gate, role restriction, loop
  // steer) — deliberately still shaped exactly like a real tool_result (see
  // Agent.rejectToolCall) so the MODEL can't tell the difference and reacts the same
  // way it would to a genuine failure. This field is for CODE (tests, analytics) that
  // needs to tell "the tool actually ran" apart from "the harness declined to run it."
  | { type: 'tool_result'; tool: ToolName; output: string; error?: string; duration_ms: number; rejected?: boolean }
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'token_usage'; prompt_tokens: number; generated_tokens: number; num_ctx: number; eval_duration_ms?: number; total_duration_ms?: number }
  | { type: 'done'; content: string }
  | { type: 'git_commit'; hash: string; message: string }
  | { type: 'compact_start'; messageCount: number; contextUsagePct: number; manual?: boolean }
  | { type: 'compact_progress'; step: string; elapsedMs: number; timeoutMs: number }
  | {
      type: 'compact'
      summary: string
      // summarizeActiveMiddle's own output — unlike `summary` (the structured,
      // validated CompactionState), this is a single unvalidated LLM pass, and on
      // a run with repeated same-run compactions it re-summarizes its own prior
      // output each time. Previously this was folded straight into history with
      // no record anywhere of what it actually said — logged here so a run's
      // active-state summary is auditable, not just trusted.
      activeWorkingStateSummary?: string
      messagesBefore: number
      messagesAfter: number
      contextUsagePct: number
      rangeDescription: string
      validated: boolean
      manual?: boolean
    }
  | { type: 'plan'; objective: string; steps: string[]; revision: number }
  | {
      // ACTOR-CRITIC (Phase 4, step 2): a qwen3.6 self-critique verdict emitted
      // at one of a few in-loop checkpoints, so runs are auditable. Only emitted
      // when config.critic is on; the baseline never produces this event.
      // 'grounding' (config.grounding) and 'layout' (config.layout) reuse this SAME
      // event shape for their own pre-done checkpoints — gamed_oracle is always
      // false for both; see grounding.ts / layout.ts.
      type: 'critic'
      checkpoint: 'post-plan' | 'on-stall' | 'pre-done' | 'grounding' | 'layout'
      verdict: 'ok' | 'revise'
      gamed_oracle: boolean
      issues: string[]
      guidance: string
    }
  | {
      // HARNESS TASK LEDGER (Stage 3, config.tasks): emitted when the ledger is built
      // from a plan, re-planned (reconcile), or advanced to the next task — so runs are
      // auditable and the eval can measure sequencing. Only emitted when config.tasks is on.
      type: 'tasks'
      action: 'planned' | 'replanned' | 'advanced'
      revision: number
      done: number
      total: number
      current: string | null   // active task title, or null when all tasks are done
    }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }
  // ── Multi-agent architecture (config.agents) — harness-level narrative events,
  // always emitted UNTAGGED (no __frameId) since they describe the whole task, not
  // one role's turn. Every event a spawned frame produces (thought/tool_call/plan/
  // done/...) is instead TAGGED with FrameTag (below) by dispatch.ts's spawnFrame —
  // reusing the existing event shapes rather than adding a parallel set for them.
  | { type: 'objective'; text: string }
  | {
      type: 'task_graph'
      objective: string
      steps: Array<{ id: string; role: Role; prompt: string; dependsOn: string[]; frameGroup?: string }>
      revision: number
    }
  | { type: 'boss_verdict'; action: 'inject' | 'restart' | 'escalate'; message: string; targetFrameId: string | null }
  | { type: 'replan'; reason: string }

// Tags a spawned frame's own events (thought/tool_call/tool_result/plan/done/...) with
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

// ── Multi-agent architecture (docs/subagents-plan.md, config.agents / ARGO_AGENTS) ──
// A call frame is one role invocation, implemented as one scoped Agent instance
// (see src/frames.ts). The Orchestrator itself is harness code (src/dispatch.ts),
// never an LLM call.

export type Role = 'planner' | 'implementer' | 'tester' | 'boss'

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

// The Boss's / Tester's verdict shape (extends the existing Critique contract with
// `action` — see critic.ts). Kept here so ledger/frames/dispatch can reference it
// without importing critic.ts's prompt-building internals.
export type BossAction = 'none' | 'inject' | 'restart' | 'escalate'
export type TesterAction = 'release' | 'redo'
