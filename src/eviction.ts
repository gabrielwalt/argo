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

export interface EvictionBudget {
  // Rough character budget for the "working history" part of context (excludes the
  // pinned anchor and system prompt, which are never evicted). Deliberately a char
  // count, not a token count — cheap to compute on every turn, same tradeoff
  // agent.ts's own TOOL_RESULT_COLLAPSE_OVER already makes.
  maxLiveChars: number
}

export const DEFAULT_EVICTION_BUDGET: EvictionBudget = { maxLiveChars: 60_000 }

// Deterministic, no-LLM eviction: strips the OLDEST action episodes first (their effect
// is already durably persisted — a file on disk, a ledger conclusion — so the raw record
// isn't needed live), then exploratory episodes nothing still-live depends on. Never
// evicts an exploratory episode while an action still in context depends on it. Runs
// every turn — cheap enough that "every turn" is the right cadence, unlike LLM
// compaction. Returns the trimmed messages plus which episodeIds were evicted this pass
// (the caller is responsible for calling ledger.markEpisodeEvicted for each).
export function evict(
  messages: Message[],
  episodes: EpisodeMeta[],
  budget: EvictionBudget = DEFAULT_EVICTION_BUDGET,
): { messages: Message[]; evictedEpisodeIds: string[] } {
  const totalChars = messages.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0)
  if (totalChars <= budget.maxLiveChars) return { messages, evictedEpisodeIds: [] }

  const dependedOn = new Set<string>()
  for (const ep of episodes) for (const d of ep.dependsOn) dependedOn.add(d)

  // Oldest action episodes first, then exploratory episodes nothing depends on.
  // episodes is assumed oldest-first (the order they were recorded in).
  const candidates = episodes
    .filter(ep => ep.kind === 'action')
    .concat(episodes.filter(ep => ep.kind === 'exploratory' && !dependedOn.has(ep.episodeId)))

  const evictedEpisodeIds: string[] = []
  const trimmed = messages.map(m => ({ ...m }))
  let remaining = totalChars

  for (const ep of candidates) {
    if (remaining <= budget.maxLiveChars) break
    const msg = trimmed[ep.messageIndex]
    if (!msg || typeof msg.content !== 'string' || msg.content.startsWith('[evicted')) continue
    const before = msg.content.length
    const stub = `[evicted — episode ${ep.episodeId}, ${before} chars, tool ${ep.tool}; call ledger with action "expand" and this episodeId to recover it]`
    msg.content = stub
    remaining -= before - stub.length
    evictedEpisodeIds.push(ep.episodeId)
  }

  return { messages: trimmed, evictedEpisodeIds }
}
