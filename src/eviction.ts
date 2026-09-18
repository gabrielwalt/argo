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

// Chars-per-token DEFAULT/fallback estimate, used only until a real
// measurement is available to calibrate against (agent.ts's
// effectiveCharsPerToken/recalibrateCharsPerToken) — a flat constant is not
// reliable on its own. Confirmed live (2026-09-18, test-wind hex-grid run):
// this constant's own assumption ("conservative for code-heavy content")
// still understated real density badly enough that manageContext's 60%
// trigger, computed from this constant alone, never fired once in a 13-turn
// run where real usage (Ollama's own prompt_eval_count) crossed 90% — dense
// coordinate/math content ran closer to ~1.5-2.8 real chars/token, and this
// estimate is also structurally blind to the tool-schema definitions sent
// with every request (never part of the message list this function sees at
// all). See agent.ts's manageContext for the calibrated estimate that now
// actually drives eviction decisions; this constant remains the correct
// choice only as agent.ts's own starting point before any real data exists.
export const CHARS_PER_TOKEN = 3.5

export function sumContentChars(msgs: Message[]): number {
  return msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
}

export function estimateTokens(msgs: Message[], charsPerToken: number = CHARS_PER_TOKEN): number {
  return sumContentChars(msgs) / charsPerToken
}

export function estimateTokensForText(content: string, charsPerToken: number = CHARS_PER_TOKEN): number {
  return content.length / charsPerToken
}
