export type ToolName = 'bash' | 'web_search' | 'read_file' | 'write_file' | 'edit_file' | 'fetch_url' | 'browser_fetch' | 'update_plan'

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
  | { type: 'tool_result'; tool: ToolName; output: string; error?: string; duration_ms: number }
  | { type: 'message'; role: 'user' | 'assistant'; content: string }
  | { type: 'token_usage'; prompt_tokens: number; generated_tokens: number; num_ctx: number }
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
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string }

export interface GitCommit {
  hash: string
  message: string
  date: string
  author: string
}
