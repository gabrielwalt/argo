// WORKSPACE IDENTITY (fixes the stale-session bug: a worker resumed the last
// session recorded under a workspace NAME even after the folder behind that name
// was emptied and reattached — the folder had no relationship left to the session
// whose history/objective it was showing). Session resumption at container start
// (src/server.ts's startServer) needs a way to tell "the same folder, restarted"
// apart from "a folder that used to have this name but is now someone else's
// content" — that is CONTENT identity, not the workspace name LOGS_DIR is keyed by.
//
// Pure module except for the tiny injectable fs surface below (an optional `io`
// object, each field defaulted to the real node:fs/promises call) — so the decision
// logic here is unit-testable with no real disk, no network, no Ollama.

import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir as fsMkdir, readdir as fsReaddir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// .argo/ already holds harness bookkeeping (src/ledger.ts's per-frame ledger files
// under frames/, plus sessions.json) and is already added to the workspace
// .gitignore (ensureGitignored) — the natural home for one more small bookkeeping
// file, not a project deliverable.
const WORKSPACE_ID_REL = path.join('.argo', 'workspace-id')

export interface WorkspaceIdentityIO {
  readFile?: (p: string) => Promise<string>
  writeFile?: (p: string, c: string) => Promise<void>
  mkdir?: (p: string) => Promise<void>
  readdir?: (p: string) => Promise<string[]>
}

function ioReadFile(io?: WorkspaceIdentityIO): (p: string) => Promise<string> {
  return io?.readFile ?? ((p: string) => fsReadFile(p, 'utf-8'))
}
function ioWriteFile(io?: WorkspaceIdentityIO): (p: string, c: string) => Promise<void> {
  return io?.writeFile ?? ((p: string, c: string) => fsWriteFile(p, c, 'utf-8'))
}
function ioMkdir(io?: WorkspaceIdentityIO): (p: string) => Promise<void> {
  return io?.mkdir ?? (async (p: string) => { await fsMkdir(p, { recursive: true }) })
}
function ioReaddir(io?: WorkspaceIdentityIO): (p: string) => Promise<string[]> {
  return io?.readdir ?? ((p: string) => fsReaddir(p))
}

/** Reads the workspace's content identity, or null if it has none yet (fresh
 * workspace, or the file is unreadable for any reason — never throws). */
export async function readWorkspaceId(root: string, io?: WorkspaceIdentityIO): Promise<string | null> {
  try {
    const raw = await ioReadFile(io)(path.join(root, WORKSPACE_ID_REL))
    const id = raw.trim()
    return id === '' ? null : id
  } catch {
    return null
  }
}

/** Returns the workspace's existing content identity, or mints and persists a new
 * one. MUST fail open: a read-only workspace, or any write failure, returns null
 * rather than throwing — losing the ability to distinguish sessions by content is
 * far better than failing to start the worker over a bookkeeping file. */
export async function ensureWorkspaceId(root: string, io?: WorkspaceIdentityIO): Promise<string | null> {
  const existing = await readWorkspaceId(root, io)
  if (existing) return existing
  try {
    const id = randomUUID()
    await ioMkdir(io)(path.join(root, '.argo'))
    await ioWriteFile(io)(path.join(root, WORKSPACE_ID_REL), id)
    return id
  } catch {
    return null
  }
}

/** True when the workspace root has any non-dotfile entry. Dotfiles/dotdirs (.git,
 * .argo, .gitignore) are harness/VCS bookkeeping, not user content — and are
 * exactly what a workspace can retain even after the user believes they "deleted
 * everything" (e.g. `rm -rf *` skips dotfiles), so counting them would defeat the
 * check this exists for. Returns false (treated as empty) if the directory cannot
 * be read at all — fail toward the safer "don't trust a legacy pointer" branch. */
export async function workspaceHasContent(root: string, io?: WorkspaceIdentityIO): Promise<boolean> {
  try {
    const entries = await ioReaddir(io)(root)
    return entries.some(name => !name.startsWith('.'))
  } catch {
    return false
  }
}

// ── Session pointer ──────────────────────────────────────────────
// The current-session pointer used to be a small standalone text file
// (SESSION_ID_FILE, logs/current-session.txt) living OUTSIDE the workspace this
// module establishes identity for — which was the actual root cause of the
// stale-session bug this module exists to fix: a pointer stored elsewhere can
// never be told apart from a stale one just by looking at the folder it claims to
// describe. It now lives on the ledger's own registry instead
// (.argo/sessions.json's currentSessionId field, ledger.ts's setCurrentSession/
// getCurrentSession) — INSIDE the workspace, so it travels with the workspace's
// own content by construction and the workspaceId-mismatch case below can no
// longer actually occur for a ledger-sourced pointer. decideSessionResume is kept
// pointer-format-agnostic (a plain {sessionId, workspaceId} value, not tied to any
// one file's parsing) specifically so it still protects against the ledger's own
// equivalent of the original bug: a `rm -rf *` leaves dotfiles (.git, .argo, and
// so the whole ledger) behind, so a previously recorded sessionId can survive
// even though the user emptied the folder's real content — see
// workspaceHasContent's own fallback branch below for that case.
export interface SessionPointer {
  sessionId: string
  workspaceId: string | null
}

export type SessionResumeReason =
  | 'workspace-id-match'
  | 'workspace-id-mismatch'
  | 'legacy-pointer-nonempty-workspace'
  | 'legacy-pointer-empty-workspace'
  | 'no-pointer'

export interface SessionResumeDecision {
  resume: boolean
  reason: SessionResumeReason
}

// The core decision, pure and total. A recorded workspaceId (new-format pointer)
// is a strong signal — matched exactly or rejected, no heuristics. A legacy
// pointer (workspaceId === null) recorded no identity at all, so it can never be
// PROVEN to belong to the current folder — this is the case every session written
// before this change is in, including the one from the reported bug. Falling back
// to "does the workspace still have content" is what makes the very first run
// after deployment do the right thing in both directions: an untouched pre-existing
// project (the common case, everywhere) still has its files and keeps resuming
// exactly as before; a folder the user emptied and reattached (the reported bug)
// has none and gets a fresh session instead of replaying a stranger's objective.
export function decideSessionResume(
  pointer: SessionPointer | null,
  currentWorkspaceId: string | null,
  hasContent: boolean,
): SessionResumeDecision {
  if (!pointer) return { resume: false, reason: 'no-pointer' }
  if (pointer.workspaceId !== null) {
    return pointer.workspaceId === currentWorkspaceId
      ? { resume: true, reason: 'workspace-id-match' }
      : { resume: false, reason: 'workspace-id-mismatch' }
  }
  return hasContent
    ? { resume: true, reason: 'legacy-pointer-nonempty-workspace' }
    : { resume: false, reason: 'legacy-pointer-empty-workspace' }
}
