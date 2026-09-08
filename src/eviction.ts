// TOKEN ESTIMATION for context management (agent.ts's manageContext). Context
// management itself — deciding what to keep verbatim, what to collapse, what to
// evict — lives entirely in agent.ts now (a single unified pass instead of two
// separate mechanisms with different triggers); this file is left as the one
// shared, cheap-to-compute token estimate both agent.ts and its tests build on.
//
// v3 SIMPLIFICATION: the old evict() (oldest-tool-messages-first, with a
// second-pass assistant-truncation fallback) and agent.ts's separate
// collapseOldToolResults() have both been replaced by agent.ts's manageContext(),
// which walks messages newest-to-oldest ONCE, decides a verbatim/collapse/evict
// split against a single set of percentage-of-num_ctx budgets, and writes the
// same ledger markers the old two mechanisms did. See agent.ts's own header
// comment on manageContext for the full algorithm.

import type { Message } from 'ollama'

// Chars-per-token estimate used to translate a token budget into the char counts we
// can actually measure cheaply on every turn. Conservative for code-heavy content
// (which tends to run closer to ~3-4 chars/token than prose's ~4-5), so this errs
// toward evicting slightly MORE than a precise tokenizer would require rather than
// less — the failure mode we're fixing (root cause: a char budget that can be
// satisfied while token usage stays near-full) only gets worse if the estimate
// under-counts tokens.
export const CHARS_PER_TOKEN = 3.5

export function estimateTokens(msgs: Message[]): number {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0) / CHARS_PER_TOKEN
}

export function estimateTokensForText(content: string): number {
  return content.length / CHARS_PER_TOKEN
}
