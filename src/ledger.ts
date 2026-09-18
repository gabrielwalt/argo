// THE LEDGER. Per-frame, append-only JSONL files under /workspace/.argo/frames/ —
// one file per call frame (dispatcher/planner/implementer instance), holding the
// exact messages (system/user/assistant/tool) that frame itself saw in its live
// context, PLUS UI-only metadata (thinking, tool args, token counts, ...) that is
// never handed back to the model. A frame's identity comes from WHICH FILE its
// entries live in — there is no frameId/taskId/agent/ts field on the entry itself
// any more (see types.ts's LedgerMessage). The file itself is append-only, so
// "chronological order" always means append order — but a message that is later
// EVICTED (or collapsed) from the live in-memory history (agent.ts's
// manageContext) gets a SECOND entry appended sharing its original `id`, marked
// `evicted: true`, whose
// content is the short recovery stub rather than the original. readFrame (below)
// is the deduplicated, last-write-wins-per-id view built from that raw log — what
// every consumer other than `expand` actually wants; `expand` alone reads the raw
// log to recover the ORIGINAL, pre-eviction entry.
//
// /workspace/.argo/sessions.json is the registry: session -> runs -> ordered list
// of frames spawned during that run (frameId/role/parentFrameId). This is the only
// place that records which role a frame is and where it sits in the delegation
// tree — the frame's own ledger file carries none of that.
//
// Deliberately NOT a database (this project's own memory research already settled
// grep-able files over a database for a near-identical case; nothing here needs
// real query performance).
//
// Pure I/O module: no LLM calls here. The model-invoked half of this API is exposed
// as the `ledger` tool (src/tools/index.ts: `messages` / `expand`), scoped to the
// CALLING FRAME's own file only — cross-agent visibility has been removed entirely,
// each frame sees only itself. The harness-automatic half (recordMessage) is called
// directly from agent.ts's pushCtx call sites — never a tool call, so it can never
// be forgotten by the model.

import { promises as fs } from 'fs'
import path from 'path'
import type { LedgerMessage, Role, SessionRegistry } from './types.js'

function argoDir(root: string): string {
  return path.join(root, '.argo')
}
function framesDir(root: string): string {
  return path.join(argoDir(root), 'frames')
}
function frameFile(root: string, frameId: string): string {
  return path.join(framesDir(root), `${frameId}.jsonl`)
}
function registryFile(root: string): string {
  return path.join(argoDir(root), 'sessions.json')
}

// Ensures /workspace/.gitignore excludes .argo/ — harness bookkeeping (the ledger,
// per-frame logs), never a tracked deliverable. Idempotent, mirrors how
// autoCommit() (agent.ts) idempotently ensures `git init` has run. Appends rather
// than overwrites, and never assumes the user's repo already has a .gitignore.
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
    if (!content.split('\n').some(l => l.trim() === '.argo/' || l.trim() === '.argo')) {
      const sep = content && !content.endsWith('\n') ? '\n' : ''
      await fs.writeFile(gi, `${content}${sep}.argo/\n`)
    }
  } catch (err) {
    console.error('[ledger] ensureGitignored failed (continuing):', err)
  }
  // Stale-file cleanup: an older pre-ledger build of this harness wrote a single
  // .argo/state.json bookkeeping file that has no successor (session tracking now
  // lives entirely in sessions.json + the per-frame files above) — remove it on
  // every dispatch start so a workspace that was ever run under that build doesn't
  // keep carrying dead bookkeeping forward indefinitely. Fails open, same stance
  // as the .gitignore step above: never lets a stale-file cleanup failure abort a
  // real run. Deliberately does NOT touch the old JSONL/history-*.json files under
  // logs/ — those are a different directory and, unlike state.json, are user-
  // visible run history rather than pure internal bookkeeping.
  try {
    await fs.unlink(path.join(argoDir(root), 'state.json'))
  } catch {
    // Never existed, or already gone — nothing to do.
  }
}

let idCounter = 0
// Monotonic-enough ids for a single process/run — collisions would need the same
// millisecond AND the same in-process counter value, which a single Node process
// driving one strictly-sequential dispatch loop (see dispatch.ts's own "no two LLM
// calls ever run concurrently" hard rule) cannot produce.
export function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter}`
}

// ── Per-frame ledger files ──

// Append one message to a frame's own ledger file. Fire-and-forget from the
// caller's perspective (agent.ts never awaits this into the hot path) but this
// function itself does the real write and can throw — callers decide how to
// handle a failure (agent.ts/dispatch.ts both just log and continue).
export async function recordMessage(root: string, frameId: string, msg: LedgerMessage): Promise<void> {
  await fs.mkdir(framesDir(root), { recursive: true })
  await fs.appendFile(frameFile(root, frameId), `${JSON.stringify(msg)}\n`)
}

// Read every RAW entry recorded for one frame, in append (chronological) order —
// including both an evicted message's ORIGINAL entry and its later eviction-marker
// entry (types.ts's LedgerMessage.evicted) as two separate array elements sharing
// one `id`. Missing file (a frame that never recorded anything, or an unknown
// frameId) returns an empty array rather than throwing — same fail-open stance as
// the old single-file readAll(). Internal — callers almost always want the
// deduplicated view (readFrame, below) or the ORIGINAL specifically (expand,
// below); this is exposed only for those two to share the actual file-reading
// logic, never called directly outside this module.
async function readFrameRaw(root: string, frameId: string): Promise<LedgerMessage[]> {
  let raw: string
  try {
    raw = await fs.readFile(frameFile(root, frameId), 'utf-8')
  } catch {
    return []
  }
  const out: LedgerMessage[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as LedgerMessage)
    } catch {
      // A malformed line (e.g. a partial write from a crash mid-append) is skipped,
      // never fatal — the ledger is an audit trail, not a transactional store.
    }
  }
  return out
}

// Read one frame's messages as they should be REPLAYED — the eviction-aware view.
// Most entries have exactly one line in the file and pass through unchanged. A
// message that was later collapsed or evicted (agent.ts's manageContext, once it
// stubs a message out of the live in-memory history) has TWO lines sharing the
// same `id`: the original (full content) followed by an eviction-marker entry
// (`evicted: true`, content is the short recovery stub) appended once that pass
// actually runs — see that call site's own comment. Deduplicating by id, LAST entry wins, is exactly
// what makes the stub replace the original here: an evicted message's marker entry
// was appended strictly after its original, so it is later in append order and
// wins the dedup. A message that was NEVER evicted has only the one entry, which
// trivially "wins" against nothing.
//
// This is what the `ledger` tool's `messages` action (tools/index.ts) shows a model
// browsing its own history, and what dispatch.ts's persistent-frame reload
// (spawnFrame's Agent.loadHistory preload) loads back — both want the CURRENT,
// already-compact view, not a growing duplicate-laden raw log.
export async function readFrame(root: string, frameId: string): Promise<LedgerMessage[]> {
  const entries = await readFrameRaw(root, frameId)
  const byId = new Map<string, LedgerMessage>()
  const order: string[] = []
  for (const e of entries) {
    if (!byId.has(e.id)) order.push(e.id)
    byId.set(e.id, e) // last write for this id wins — see this function's own comment
  }
  return order.map(id => byId.get(id)!)
}

// Re-inject a specific evicted/collapsed message's full ORIGINAL content on
// demand — the ledger's lossless pointer to every original, made concrete. Reads
// the RAW (non-deduplicated) log and takes the FIRST entry for that id that is not
// itself an eviction marker — the original is always written before any later
// marker for the same id (readFrameRaw's own append-order guarantee), so "first
// non-evicted entry" is exactly "the original," never a stub. (A collapsed-but-
// never-evicted message was only ever written once — its lone entry is trivially
// both the first and the original.)
//
// When `frameId` is given (the normal case — the `ledger` tool always passes the
// calling frame's own id, since cross-agent visibility no longer exists), only
// that frame's file is searched. Without it, every frame file under
// .argo/frames/ is searched — used by callers that don't have a specific frame in
// scope (tests, tooling). Returns null if the id was never recorded anywhere in
// scope.
export async function expand(root: string, messageId: string, frameId?: string): Promise<string | null> {
  if (frameId) {
    const entries = await readFrameRaw(root, frameId)
    const original = entries.find(e => e.id === messageId && !e.evicted)
    return original ? original.content : null
  }
  let files: string[]
  try {
    files = await fs.readdir(framesDir(root))
  } catch {
    return null
  }
  for (const file of files) {
    if (!file.endsWith('.jsonl')) continue
    const entries = await readFrameRaw(root, file.slice(0, -'.jsonl'.length))
    const original = entries.find(e => e.id === messageId && !e.evicted)
    if (original) return original.content
  }
  return null
}

// ── Registry (sessions.json) ──

async function readRegistry(root: string): Promise<SessionRegistry> {
  try {
    const raw = await fs.readFile(registryFile(root), 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed && Array.isArray(parsed.sessions)) return parsed as SessionRegistry
    return { sessions: [] }
  } catch {
    return { sessions: [] }
  }
}

async function writeRegistry(root: string, registry: SessionRegistry): Promise<void> {
  await fs.mkdir(argoDir(root), { recursive: true })
  await fs.writeFile(registryFile(root), JSON.stringify(registry, null, 2))
}

// Public read accessor — the whole-file read-modify-write registerFrame does
// internally, exposed for callers (tests, tooling, a future UI) that just need to
// inspect current state without registering anything.
export async function getRegistry(root: string): Promise<SessionRegistry> {
  return readRegistry(root)
}

// Registers one spawned frame under session `sessionId`'s run `runIndex` — called
// once per frame spawn (dispatch.ts's spawnFrame), right alongside minting its
// frameId. Creates the session and/or run entry on first use. `runIndex` is
// 0-based and stable for the lifetime of one runDispatchLoop call; a run that
// doesn't exist yet at that index is created (and any gap filled with empty runs)
// rather than assumed to already be there, so callers never need a separate
// "start a run" step.
export async function registerFrame(
  root: string,
  sessionId: string,
  runIndex: number,
  frame: { frameId: string; role: Role; parentFrameId: string | null; implementerIndex?: number },
): Promise<void> {
  const registry = await readRegistry(root)
  let session = registry.sessions.find(s => s.id === sessionId)
  if (!session) {
    session = { id: sessionId, runs: [] }
    registry.sessions.push(session)
  }
  while (session.runs.length <= runIndex) {
    session.runs.push({ startedAt: new Date().toISOString(), frames: [] })
  }
  session.runs[runIndex].frames.push({
    frameId: frame.frameId, role: frame.role, parentFrameId: frame.parentFrameId,
    implementerIndex: frame.implementerIndex,
  })
  await writeRegistry(root, registry)
}

// ── Current session pointer ──
// Replaces server.ts's old current-session.txt file — "which session is active"
// now lives as a field on the SAME registry file frames are already recorded in,
// rather than a second small bookkeeping file. Whole-file read-modify-write, same
// pattern as registerFrame above.

export async function setCurrentSession(root: string, sessionId: string): Promise<void> {
  const reg = await readRegistry(root)
  reg.currentSessionId = sessionId
  await writeRegistry(root, reg)
}

export async function getCurrentSession(root: string): Promise<string | null> {
  const reg = await readRegistry(root)
  return reg.currentSessionId ?? null
}

// Removes one session's entry from the registry AND every frame file that
// session's runs ever registered — server.ts's DELETE /logs/:sessionId. Returns
// the frameIds that were removed (so the caller, or a future UI, can confirm what
// was actually deleted) — an unknown sessionId is a no-op, returning [].
export async function deleteSession(root: string, sessionId: string): Promise<string[]> {
  const registry = await readRegistry(root)
  const session = registry.sessions.find(s => s.id === sessionId)
  if (!session) return []
  const frameIds = session.runs.flatMap(r => r.frames.map(f => f.frameId))
  await Promise.all(frameIds.map(frameId => fs.unlink(frameFile(root, frameId)).catch(() => {})))
  registry.sessions = registry.sessions.filter(s => s.id !== sessionId)
  await writeRegistry(root, registry)
  return frameIds
}

// Clears every frame file and resets the registry to empty — server.ts's DELETE
// /logs (the "delete everything and start over" action). Deliberately drops
// currentSessionId too — the caller (server.ts) always mints and sets a fresh one
// immediately after calling this.
export async function resetAllSessions(root: string): Promise<void> {
  await fs.rm(framesDir(root), { recursive: true, force: true }).catch(() => {})
  await writeRegistry(root, { sessions: [] })
}
