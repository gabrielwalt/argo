// THE LEDGER (docs/subagents-plan.md, config.agents / ARGO_AGENTS). The audit trail of
// the call-frame stack: spawning a frame is a `delegation` entry, a frame finishing is a
// `conclusion` entry, and every tool call inside a frame is an `episode` entry (the CWL
// eviction graph — see eviction.ts). Append-only JSONL at /workspace/.argo/ledger.jsonl —
// deliberately NOT a database (this project's own memory research already settled
// grep-able files over a database for a near-identical case; nothing here needs real
// query performance). A small separate state.json under the same directory holds the two
// PINNED values that aren't append-only events: the immutable `objective` and the
// current, mutable execution `plan` — read every iteration, so they don't belong in a
// growing log.
//
// Pure I/O module: no LLM calls here. The model-invoked half of this API is exposed as
// the `ledger` tool (src/tools/index.ts); the harness-automatic half (recordDelegation,
// recordConclusion, recordEpisode, ...) is called directly from dispatch.ts/frames.ts —
// never a tool call, so it can never be forgotten by the model.

import { promises as fs } from 'fs'
import path from 'path'
import type {
  LedgerEntry,
  LedgerDelegationEntry,
  LedgerConclusionEntry,
  LedgerInjectionEntry,
  LedgerEpisodeEntry,
} from './types.js'
import type { TaskGraph } from './tasks.js'

function argoDir(root: string): string {
  return path.join(root, '.argo')
}
function ledgerFile(root: string): string {
  return path.join(argoDir(root), 'ledger.jsonl')
}
function stateFile(root: string): string {
  return path.join(argoDir(root), 'state.json')
}

interface PinnedState {
  objective: string | null
  objectiveSetAt: number | null
  plan: TaskGraph | null
}

const EMPTY_STATE: PinnedState = { objective: null, objectiveSetAt: null, plan: null }

async function readState(root: string): Promise<PinnedState> {
  try {
    const raw = await fs.readFile(stateFile(root), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<PinnedState>
    return {
      objective: typeof parsed.objective === 'string' ? parsed.objective : null,
      objectiveSetAt: typeof parsed.objectiveSetAt === 'number' ? parsed.objectiveSetAt : null,
      plan: parsed.plan ?? null,
    }
  } catch {
    return { ...EMPTY_STATE }
  }
}

async function writeState(root: string, state: PinnedState): Promise<void> {
  await fs.mkdir(argoDir(root), { recursive: true })
  const tmp = `${stateFile(root)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2))
  await fs.rename(tmp, stateFile(root))
}

// Ensures /workspace/.gitignore excludes .argo/ — harness bookkeeping (delegation
// trails, drafts), never a tracked deliverable. Idempotent, mirrors how autoCommit()
// (agent.ts) idempotently ensures `git init` has run. Appends rather than overwrites,
// and never assumes the user's repo already has a .gitignore.
export async function ensureGitignored(root: string): Promise<void> {
  // Fails open, fully — a housekeeping nicety (keep .argo/ out of the user's git
  // history), never something that should be able to abort a run. Root can be wrong
  // (e.g. WORKSPACE_PATH unset) or unwritable for reasons unrelated to the dispatch
  // loop's own correctness.
  try {
    const gi = path.join(root, '.gitignore')
    let content = ''
    try {
      content = await fs.readFile(gi, 'utf-8')
    } catch {
      // No .gitignore yet — fine, we'll create one.
    }
    if (content.split('\n').some(l => l.trim() === '.argo/' || l.trim() === '.argo')) return
    const sep = content && !content.endsWith('\n') ? '\n' : ''
    await fs.writeFile(gi, `${content}${sep}.argo/\n`)
  } catch (err) {
    console.error('[ledger] ensureGitignored failed (continuing):', err)
  }
}

let idCounter = 0
// Monotonic-enough ids for a single process/run — collisions would need the same
// millisecond AND the same in-process counter value, which a single Node process
// driving one strictly-sequential dispatch loop (see docs/subagents-plan.md's hard
// no-parallelism rule) cannot produce.
export function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

async function append(root: string, entry: LedgerEntry): Promise<void> {
  await fs.mkdir(argoDir(root), { recursive: true })
  await fs.appendFile(ledgerFile(root), `${JSON.stringify(entry)}\n`)
}

async function readAll(root: string): Promise<LedgerEntry[]> {
  let raw: string
  try {
    raw = await fs.readFile(ledgerFile(root), 'utf-8')
  } catch {
    return []
  }
  const out: LedgerEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LedgerEntry)
    } catch {
      // A malformed line (e.g. a partial write from a crash mid-append) is skipped,
      // never fatal — the ledger is an audit trail, not a transactional store.
    }
  }
  return out
}

function hasFrameId(e: LedgerEntry): e is LedgerEntry & { frameId: string } {
  return 'frameId' in e && typeof (e as { frameId?: unknown }).frameId === 'string'
}
function hasTargetFrameId(e: LedgerEntry): e is LedgerInjectionEntry {
  return e.kind === 'injection'
}

// ── Harness-automatic writers — never a model tool call, cannot be forgotten ──

export async function recordDelegation(root: string, e: Omit<LedgerDelegationEntry, 'kind' | 'ts'>): Promise<void> {
  await append(root, { kind: 'delegation', ts: Date.now(), ...e })
}

export async function recordConclusion(root: string, e: Omit<LedgerConclusionEntry, 'kind' | 'ts'>): Promise<void> {
  await append(root, { kind: 'conclusion', ts: Date.now(), ...e })
}

export async function recordInjection(root: string, e: Omit<LedgerInjectionEntry, 'kind' | 'ts'>): Promise<void> {
  await append(root, { kind: 'injection', ts: Date.now(), ...e })
}

export async function recordEpisode(root: string, e: Omit<LedgerEpisodeEntry, 'kind' | 'ts'>): Promise<void> {
  await append(root, { kind: 'episode', ts: Date.now(), ...e })
}

// JSONL is append-only, so an eviction is recorded as a NEW record for the same
// episodeId carrying evictedAt — never a rewrite of the original line. Readers that
// want "is this episode currently evicted" should look at the LATEST record for a
// given episodeId (see getEpisode below), same pattern as the task ledger's
// re-plan-preserves-history convention.
export async function markEpisodeEvicted(root: string, episodeId: string): Promise<void> {
  const entries = await readAll(root)
  const versions = entries.filter((e): e is LedgerEpisodeEntry => e.kind === 'episode' && e.episodeId === episodeId)
  const latest = versions[versions.length - 1]
  if (!latest) return
  await append(root, { ...latest, evictedAt: Date.now() })
}

async function getEpisode(root: string, episodeId: string): Promise<LedgerEpisodeEntry | null> {
  const entries = await readAll(root)
  const versions = entries.filter((e): e is LedgerEpisodeEntry => e.kind === 'episode' && e.episodeId === episodeId)
  return versions.length ? versions[versions.length - 1] : null
}

// ── Model-invoked API (the `ledger` tool multiplexes onto these — see tools/index.ts) ──

export async function getObjective(root: string): Promise<string | null> {
  return (await readState(root)).objective
}

// Immutable once set — a second call is a no-op returning {ok:false} UNLESS force is
// true, which is the distinct, loud, ledger-logged act a real revision requires (the
// caller is responsible for also recording WHY via recordInjection/a conclusion, this
// function only guards the write itself).
export async function setObjective(
  root: string,
  objective: string,
  force = false,
): Promise<{ ok: boolean; reason?: string }> {
  const state = await readState(root)
  if (state.objective && !force) {
    return { ok: false, reason: 'objective already set — immutable; pass force to deliberately revise it' }
  }
  await writeState(root, { ...state, objective, objectiveSetAt: Date.now() })
  return { ok: true }
}

// setPlan REMOVED (this task, dead-code pass): zero call sites project-wide (only
// comment mentions) — the current iterative Planner (dispatch.ts) never writes a
// TaskGraph any more, only reads through the ledger tool's get_plan action
// (tools/index.ts), so getPlan now permanently returns null. getPlan itself is kept
// because that live call site exists; the type it returns (TaskGraph, tasks.ts) is
// otherwise unused machinery this scoop cannot fully remove — see DEAD-CODE.md.
export async function getPlan(root: string): Promise<TaskGraph | null> {
  return (await readState(root)).plan
}

export async function getConclusion(root: string, frameId: string): Promise<LedgerConclusionEntry | null> {
  const entries = await readAll(root)
  const matches = entries.filter((e): e is LedgerConclusionEntry => e.kind === 'conclusion' && e.frameId === frameId)
  return matches.length ? matches[matches.length - 1] : null
}

// A specific frame's FULL story — delegation, standups, injections, kill/restart
// reason if any, and its conclusion. What the Planner uses to understand a failure
// in detail before proposing a fix (getConclusion's one-line summary is what a normal
// dependency hand-off gets instead — see frames.ts buildStartingContext).
export async function getFrameTrail(root: string, frameId: string): Promise<LedgerEntry[]> {
  const entries = await readAll(root)
  return entries.filter(e => (hasFrameId(e) && e.frameId === frameId) || (hasTargetFrameId(e) && e.targetFrameId === frameId))
}

// Sliding window over the ledger — what the Boss reads for a standup. `scope`
// filters standup entries to just one granularity when present; every other entry
// kind is unaffected by the filter (the Boss still wants delegations/conclusions in
// its recent-activity view regardless of which standup scope it's checking).
export async function getRecent(root: string, n: number, scope?: 'frame' | 'task'): Promise<LedgerEntry[]> {
  const entries = await readAll(root)
  const filtered = scope ? entries.filter(e => e.kind !== 'standup' || e.scope === scope) : entries
  return filtered.slice(-Math.max(0, n))
}

// Re-inject a specific evicted episode's full original content on demand — LCM's
// "lossless pointer to every original" (docs/subagents-plan.md), made concrete.
// Returns null if the episode was never recorded (not "not found vs. never evicted" —
// callers that only care about content don't need to distinguish those).
export async function expand(root: string, episodeId: string): Promise<string | null> {
  const ep = await getEpisode(root, episodeId)
  return ep?.fullContent ?? null
}

// Count of ACTION episodes across the whole task since a given timestamp — the
// pacing signal for task-scope Boss standups (paced by real work, not raw steps;
// see docs/subagents-plan.md "The Boss"). Exploratory episodes don't count.
export async function countActionEpisodesSince(root: string, sinceTs: number): Promise<number> {
  const entries = await readAll(root)
  return entries.filter(
    (e): e is LedgerEpisodeEntry => e.kind === 'episode' && e.episodeKind === 'action' && e.ts > sinceTs,
  ).length
}
