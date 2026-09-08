// STRUCTURED CONTEXT EVICTION. The ONLY context-management mechanism in this
// codebase: a deterministic, no-LLM policy that evicts the OLDEST tool-result
// messages first when the live window gets too large. Nothing evicted is actually
// gone — the full original survives in the ledger (ledger.ts) under its message
// id and can be pulled back via ledger's expand().
//
// v2 SIMPLIFICATION: the earlier CWL-derived dependency-graph/episode-kind
// machinery (exploratory vs. action, harness-inferred dependsOn) has been removed
// entirely — it added significant bookkeeping for a benefit that never justified
// it once the ledger became a flat message list. Eviction is now simply "oldest
// tool messages first," which is easy for anyone (or any model) to reason about.

import type { Message } from 'ollama'

// Chars-per-token estimate used to translate a token budget into the char counts we
// can actually measure cheaply on every turn. Conservative for code-heavy content
// (which tends to run closer to ~3-4 chars/token than prose's ~4-5), so this errs
// toward evicting slightly MORE than a precise tokenizer would require rather than
// less — the failure mode we're fixing (root cause: a char budget that can be
// satisfied while token usage stays near-full) only gets worse if the estimate
// under-counts tokens.
const CHARS_PER_TOKEN = 3.5

function estimateTokens(msgs: Message[]): number {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) / CHARS_PER_TOKEN
}

export interface EvictionBudget {
  // Target token budget for the "working history" part of context (excludes the pinned
  // anchor and system prompt, which are never evicted), estimated as chars/CHARS_PER_TOKEN
  // rather than measured with a real tokenizer — cheap to compute on every turn, same
  // tradeoff agent.ts's own TOOL_RESULT_COLLAPSE_OVER already makes. The caller (agent.ts)
  // derives this from the run's actual num_ctx (e.g. numCtx * 0.7) so the budget tracks
  // the same unit the trigger fires on, instead of an unrelated flat char count.
  maxTokens: number
}

export const DEFAULT_EVICTION_BUDGET: EvictionBudget = { maxTokens: Math.floor(65_536 * 0.7) }

// A message's ledger id, when known — used to label a stub with its recovery
// pointer (ledger.expand). Passed in parallel to `messages` (same index), since
// Message itself (the ollama package's own type) carries no id field of its own.
export type MessageIds = Array<string | undefined>

// Deterministic, no-LLM eviction: strips the OLDEST tool-result messages first
// (their effect is already durably persisted in the ledger, so the raw record
// isn't needed live). If that alone isn't enough to reach budget, falls back to
// truncating long assistant messages (oldest first) — the second pass below —
// since early-iteration reasoning is generally the lowest-value content left once
// tool results are exhausted. Runs every turn — cheap enough that "every turn" is
// the right cadence, unlike LLM compaction. Returns the trimmed messages, which
// message ids were evicted this pass, and before/after token estimates for
// logging.
export function evict(
  messages: Message[],
  messageIds: MessageIds = [],
  budget: EvictionBudget = DEFAULT_EVICTION_BUDGET,
): { messages: Message[]; evictedMessageIds: string[]; tokenEstimateBefore: number; tokenEstimateAfter: number } {
  const tokensBefore = estimateTokens(messages)
  if (tokensBefore <= budget.maxTokens) {
    return { messages, evictedMessageIds: [], tokenEstimateBefore: tokensBefore, tokenEstimateAfter: tokensBefore }
  }

  const evictedMessageIds: string[] = []
  const trimmed = messages.map(m => ({ ...m }))
  let remaining = tokensBefore

  // Oldest tool messages first — messages is assumed oldest-first (this.history's
  // own order).
  for (let i = 0; i < trimmed.length; i++) {
    if (remaining <= budget.maxTokens) break
    const msg = trimmed[i]
    if (msg.role !== 'tool' || typeof msg.content !== 'string' || msg.content.startsWith('[evicted')) continue
    const before = msg.content.length
    const id = messageIds[i]
    // "msg_id" here MUST match the `ledger` tool's actual expand parameter
    // name (tools/index.ts's `args.msg_id`) — this prose is the only place a
    // model learns what to pass, and a mismatched key would silently fail the
    // recovery this stub exists to offer.
    const recovery = id ? `; msg_id "${id}" to recover` : ''
    const stub = `[evicted — ${before} chars${recovery}]`
    msg.content = stub
    remaining -= (before - stub.length) / CHARS_PER_TOKEN
    if (id) evictedMessageIds.push(id)
  }

  // Second pass, "good enough" safety valve: tool-message eviction only ever
  // touches tool-result content, so a slice dominated by assistant thinking/
  // content, user messages, or tool-call argument JSON can still be over budget
  // with zero tool messages left to evict. Truncate the longest-standing assistant
  // messages, oldest first, until back under budget or nothing left worth
  // truncating. Not token-precise — it doesn't need to be; getting from ~94% to
  // ~70% beats staying at 96% with a technically-satisfied char budget.
  if (remaining > budget.maxTokens) {
    const TRUNCATE_THRESHOLD = 500 // chars — don't bother with already-short messages
    const TRUNCATE_TO = 200 // keep first N chars + a marker
    for (let i = 0; i < trimmed.length && remaining > budget.maxTokens; i++) {
      const msg = trimmed[i]
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > TRUNCATE_THRESHOLD) {
        const before = msg.content.length
        msg.content = msg.content.slice(0, TRUNCATE_TO) + `\n[...truncated from ${before} chars]`
        remaining -= (before - msg.content.length) / CHARS_PER_TOKEN
      }
    }
  }

  return { messages: trimmed, evictedMessageIds, tokenEstimateBefore: tokensBefore, tokenEstimateAfter: remaining }
}
