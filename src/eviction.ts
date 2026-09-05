// STRUCTURED CONTEXT EVICTION (docs/subagents-plan.md, config.agents / ARGO_AGENTS).
// Replaces LLM-summarization compaction (compaction.ts) as the default context-management
// mechanism, following CWL ("Beyond Compaction: Structured Context Eviction for
// Long-Horizon Agents", arXiv:2606.11213): a deterministic, no-LLM policy that types every
// tool call as an episode (exploratory | action) and evicts the oldest, already-durably-
// persisted ones first when the live window gets too large. Nothing evicted is actually
// gone — the full original survives in the ledger's episode record (ledger.ts) and can be
// pulled back via expand(). compaction.ts is kept only as the rare fallback for a slice
// that's still genuinely load-bearing after eviction alone (see agent.ts's gate on
// config.agents).
//
// v1 SIMPLIFICATION, noted explicitly: CWL's paper describes FOUR graduated eviction
// levels (reasoning trace -> bulk output -> intermediate artifact -> full removal). This
// implementation collapses straight to a single "stub" level — the same restorable-stub
// shape agent.ts's existing KEEP_RECENT_TOOL_RESULTS collapse already uses — because the
// full original is losslessly recoverable from the ledger either way (expand()); the
// graduated levels are a refinement to try if eviction proves too coarse in practice, not
// a correctness requirement.

import type { Message } from 'ollama'
import type { EpisodeKind } from './types.js'
import type { TaskGraph } from './tasks.js'
import { renderTaskGraph } from './tasks.js'

// Mapped onto Argo's actual tools (docs/subagents-plan.md). `bash` is classified as an
// action for ALL calls, not just mutating ones — reliably distinguishing a read-only
// `bash` invocation from a mutating one would require parsing the command string, which
// is not worth the false-negative risk (treating a mutation as exploratory would let it
// be evicted as if its effect weren't durably persisted, when it might not be).
const EXPLORATORY_TOOLS = new Set(['read_file', 'web_search', 'fetch_url', 'view_image'])
const ACTION_TOOLS = new Set(['write_file', 'edit_file', 'bash'])

export function classifyTool(name: string): EpisodeKind {
  if (EXPLORATORY_TOOLS.has(name)) return 'exploratory'
  return ACTION_TOOLS.has(name) ? 'action' : 'action' // unknown tools default to action (safer: never evicted early)
}

export interface EpisodeMeta {
  episodeId: string
  kind: EpisodeKind
  tool: string
  messageIndex: number // index into the message array this episode's tool-result occupies
  dependsOn: string[]
}

// Harness-inferred dependency heuristic — a DELIBERATE deviation from CWL's paper, which
// has the model declare links via a tool call. Correctness must not depend on a local
// model remembering a bookkeeping step (the same principle behind every other
// harness-owned mechanism in this project). A new action depends on every exploratory
// episode recorded since the last action, or since frame start. An explicit override
// exists on the `ledger` tool's `link` action for a model that wants to be precise, but
// it's never required (see tools/index.ts).
export function inferDependencies(priorEpisodes: EpisodeMeta[], newKind: EpisodeKind): string[] {
  if (newKind !== 'action') return []
  const deps: string[] = []
  for (let i = priorEpisodes.length - 1; i >= 0; i--) {
    const ep = priorEpisodes[i]
    if (ep.kind === 'action') break
    deps.unshift(ep.episodeId)
  }
  return deps
}

// The pinned anchor: objective (immutable, Boss-authored) + the current execution plan
// (mutable, Planner-authored). Always present, recited at the tail (same mechanism
// agent.ts already uses for the task ledger), NEVER subject to eviction — small and
// structured by construction. Locking the objective here is a direct structural fix for
// the original failure that motivated this project: a run quietly solving a different,
// more interesting problem than the one asked.
export function renderPinnedAnchor(objective: string | null, plan: TaskGraph | null): string {
  if (!objective && !plan) return ''
  const objLine = objective ? `[OBJECTIVE — immutable, set once by the Boss; never redefine it]\n${objective}` : ''
  const planBlock = plan && plan.steps.length > 0 ? renderTaskGraph(plan) : ''
  return [objLine, planBlock].filter(Boolean).join('\n\n')
}

// Chars-per-token estimate used to translate a token budget into the char counts we can
// actually measure cheaply on every turn. Conservative for code-heavy content (which
// tends to run closer to ~3-4 chars/token than prose's ~4-5), so this errs toward
// evicting slightly MORE than a precise tokenizer would require rather than less — the
// failure mode we're fixing (root cause above: a char budget that can be satisfied while
// token usage stays near-full) only gets worse if the estimate under-counts tokens.
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

// Deterministic, no-LLM eviction: strips the OLDEST action episodes first (their effect
// is already durably persisted — a file on disk, a ledger conclusion — so the raw record
// isn't needed live), then exploratory episodes nothing still-live depends on. Never
// evicts an exploratory episode while an action still in context depends on it. If that
// alone isn't enough to reach budget, falls back to truncating long assistant messages
// (oldest first) — the second pass below — since early-iteration reasoning is generally
// the lowest-value content left once episodes are exhausted. Runs every turn — cheap
// enough that "every turn" is the right cadence, unlike LLM compaction. Returns the
// trimmed messages, which episodeIds were evicted this pass (the caller is responsible
// for calling ledger.markEpisodeEvicted for each), and before/after token estimates for
// logging.
export function evict(
  messages: Message[],
  episodes: EpisodeMeta[],
  budget: EvictionBudget = DEFAULT_EVICTION_BUDGET,
): { messages: Message[]; evictedEpisodeIds: string[]; tokenEstimateBefore: number; tokenEstimateAfter: number } {
  const tokensBefore = estimateTokens(messages)
  if (tokensBefore <= budget.maxTokens) {
    return { messages, evictedEpisodeIds: [], tokenEstimateBefore: tokensBefore, tokenEstimateAfter: tokensBefore }
  }

  const dependedOn = new Set<string>()
  for (const ep of episodes) for (const d of ep.dependsOn) dependedOn.add(d)

  // Oldest action episodes first, then exploratory episodes nothing depends on.
  // episodes is assumed oldest-first (the order they were recorded in).
  const candidates = episodes
    .filter(ep => ep.kind === 'action')
    .concat(episodes.filter(ep => ep.kind === 'exploratory' && !dependedOn.has(ep.episodeId)))

  const evictedEpisodeIds: string[] = []
  const trimmed = messages.map(m => ({ ...m }))
  let remaining = tokensBefore

  for (const ep of candidates) {
    if (remaining <= budget.maxTokens) break
    const msg = trimmed[ep.messageIndex]
    if (!msg || typeof msg.content !== 'string' || msg.content.startsWith('[evicted')) continue
    const before = msg.content.length
    const stub = `[evicted — episode ${ep.episodeId}, ${before} chars, tool ${ep.tool}; call ledger with action "expand" and this episodeId to recover it]`
    msg.content = stub
    remaining -= (before - stub.length) / CHARS_PER_TOKEN
    evictedEpisodeIds.push(ep.episodeId)
  }

  // Second pass, "good enough" safety valve: episode eviction only ever touches
  // tool-result content, so a slice dominated by assistant thinking/content, user
  // messages, or tool-call argument JSON can still be over budget with zero episodes
  // left to evict (the second real-run trace in the problem statement: 99% context,
  // only 1 episode left). Truncate the longest-standing assistant messages, oldest
  // first, until back under budget or nothing left worth truncating. Not
  // token-precise — it doesn't need to be; getting from ~94% to ~70% beats staying
  // at 96% with a technically-satisfied char budget.
  if (remaining > budget.maxTokens) {
    const TRUNCATE_THRESHOLD = 500 // chars — don't bother with already-short messages
    const TRUNCATE_TO = 200 // keep first N chars + a marker
    for (let i = 0; i < trimmed.length && remaining > budget.maxTokens; i++) {
      const msg = trimmed[i]
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.length > TRUNCATE_THRESHOLD) {
        const before = msg.content.length
        msg.content = msg.content.slice(0, TRUNCATE_TO) + `\n[...truncated from ${before} chars — early-iteration reasoning]`
        remaining -= (before - msg.content.length) / CHARS_PER_TOKEN
      }
    }
  }

  return { messages: trimmed, evictedEpisodeIds, tokenEstimateBefore: tokensBefore, tokenEstimateAfter: remaining }
}
