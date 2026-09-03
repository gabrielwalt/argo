// CALL FRAMES (docs/subagents-plan.md, config.agents / ARGO_AGENTS). A call frame is one
// role invocation. Implemented as one scoped `Agent` instance (agent.ts) rather than a
// second execution engine: every role reuses the exact same battle-tested ReAct loop
// (compaction/eviction, loop-recovery, retries, tool execution) with a different system
// prompt and a restricted tool set — "mode as permission state," not "mode as a separate
// program." dispatch.ts constructs these; this module only holds the per-role
// configuration and the context-construction algorithm.
//
// v1 SIMPLIFICATION, noted explicitly: the pinned anchor (objective + plan) is folded
// into the frame's initial assignment message rather than threaded into the reused
// Agent's own per-turn recitation machinery (which is keyed to that Agent instance's OWN
// this.currentPlan/task ledger, set via its own update_plan calls) — so a long-running
// frame's recitation of the LEDGER-level plan may fade the same way any other context
// does without eviction re-surfacing it. Re-threading ledger state into per-turn
// recitation is a real refinement, not a correctness requirement for v1.

import type { Role, ToolName, FrameSpawnRequest } from './types.js'
import { getConclusion } from './ledger.js'

export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  planner: ['read_file', 'web_search', 'fetch_url', 'ledger', 'update_plan'],
  implementer: ['read_file', 'write_file', 'edit_file', 'bash', 'fetch_url', 'web_search', 'browser_fetch', 'ledger', 'update_plan'],
  // Deliberately no write_file/edit_file — Tester directs fixes, never makes them.
  tester: ['read_file', 'bash', 'ledger'],
  // Deliberately no write_file/edit_file — the Boss verifies, it never fixes.
  boss: ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger'],
}

// Per-role iteration budgets. Implementer keeps the most headroom (real work happens
// there); Planner/Tester/Boss are short bounded loops, not open-ended. Planner raised
// 15->20 (2026-09-03, overnight large-task eval): on a genuinely large objective
// against a real 11-file codebase (bigproj's tasklab, `docs/overnight-log.md` Finding
// 4), 15 wasn't enough room to read the codebase AND produce a task graph — it hit
// its cap with NO plan at all, falling open to a single-step graph that (correctly,
// but by accident) routed the whole objective to one large Implementer frame instead
// of real decomposition. This is exactly the scenario the Planner exists for; 20
// gives it a real chance to converge instead of reliably timing out on it.
export const ROLE_MAX_ITERATIONS: Record<Role, number> = {
  planner: 20,
  implementer: 60,
  tester: 20,
  boss: 15,
}

// Display names — the Argonauts, matched to each role's actual function rather than
// picked for flavor alone: Jason is the leader accountable for the whole quest (sets
// what "done" means, has final say); Tiphys is the Argo's helmsman, famed for charting
// the course; Argus is the shipwright who built the Argo; Lynceus keeps his mythic
// reputation for extraordinarily sharp eyesight — the one who catches what everyone
// else misses. "Argo" itself (the ship) is the harness/dispatch loop, not a role — it
// carries and dispatches the crew, it doesn't have its own turn. Internal code
// identifiers (Role's own string values) are deliberately left as plain functional
// names (planner/implementer/tester/boss) — this mapping is a display layer only, kept
// alongside the plain role so it's never ambiguous which is which.
export const ROLE_NAME: Record<Role, string> = {
  boss: 'Jason',
  planner: 'Tiphys',
  implementer: 'Argus',
  tester: 'Lynceus',
}

const ROLE_SYSTEM_SUFFIX: Record<Role, string> = {
  planner:
    'You are Tiphys, the PLANNER inside Argo\'s multi-agent harness — the helmsman who charts the course. ' +
    'Turn the given (immutable) objective into a task graph: ' +
    'an ordered list of steps, each naming which role should execute it (implementer or tester), its own concrete ' +
    'prompt, and any dependsOn relationships on earlier steps. You may read files and search the web, but you never ' +
    'write or edit anything — you reason about the plan, you don\'t produce artifacts. If several steps would ' +
    'otherwise duplicate the same investigation, schedule a dedicated early step to produce that shared context ' +
    'instead of investigating it yourself. If the task is too large to fully predict, plan only the part you can, ' +
    'say so explicitly, and expect to be resumed later with what happened so far. You never redefine the objective ' +
    'itself — only the Boss does that, and only as a deliberate, rare act. ' +
    'Isolating a step into its own frame costs a fresh context and its own overhead — only worth paying when that ' +
    'step\'s own work would otherwise run about 20-40+ iterations, or when it must not share context/mutations with ' +
    'unrelated work. Small or tightly-related steps (quick edits, steps that touch the same files or the same piece ' +
    'of logic) belong in the SAME frame: give them the same frameGroup so they run sequentially in one Implementer ' +
    'frame instead of each paying for isolation it doesn\'t need. Mark a step skipTest:true when it is small and ' +
    'unambiguous enough that Lynceus\'s separate verification pass would not be worth its extra iterations — Jason\'s ' +
    'own periodic and final checks remain the safety net either way, so skipTest is about avoiding redundant checking, ' +
    'not about lowering the bar.',
  implementer:
    'You are Argus, the IMPLEMENTER inside Argo\'s multi-agent harness — the shipwright who builds — working one ' +
    'well-scoped task handed to you. If you ' +
    'cannot complete it within reasonable effort, say so explicitly in your final answer: state what you tried, what ' +
    'failed, and why you don\'t think it will succeed as scoped — do not grind indefinitely on the same approach.',
  tester:
    'You are Lynceus, the TESTER inside Argo\'s multi-agent harness — keen-eyed enough to see what others miss. ' +
    'You verify another agent\'s claimed work — you never fix ' +
    'anything yourself, only read files and run checks. Check the SPECIFIC claim: if it claims full success, verify ' +
    'it fully; if partial, check both the claimed-successful and claimed-failed parts, and whether real effort was ' +
    'put into the failed parts. End your answer with either RELEASE (accept the conclusion, success or failure) or ' +
    'REDO: <specific follow-up> (resume the implementer with a targeted instruction, not a vague "try again").',
  boss:
    'You are Jason, the BOSS inside Argo\'s multi-agent harness — leader of this quest, accountable for the whole ' +
    'voyage, not per-frame review (Lynceus already does that). Verify independently (read files, run checks, search the web) rather than trusting ' +
    'self-reports; asking a running agent a direct question is a last resort, only when independent verification ' +
    'can\'t resolve it. Verify each specific claim ONCE — one clean check that confirms or refutes it — then ' +
    'conclude immediately with your verdict for THIS checkpoint. Do not re-run a check you already got a clear ' +
    'answer from "to be sure": every checkpoint has its own small iteration budget specifically so you have room ' +
    'to verify, not to loop, and repeating a confirmed check just spends that budget without changing the answer. ' +
    'Different checkpoints expect different one-line endings — the specific CHECKPOINT assignment ' +
    'below always tells you which convention to end with; follow that one, not a checkpoint you handled earlier in ' +
    'this same conversation. At standup/final checkpoints, end with exactly one of: NONE (healthy, continue), ' +
    'INJECT: <message> (a targeted correction, the frame continues), RESTART: <context for the retry> (end this ' +
    'frame, start a fresh one on the same task informed by what went wrong), or ESCALATE: <diagnosis> (return to the ' +
    'Planner for a real replan).',
}

export function systemPromptFor(role: Role): string {
  return ROLE_SYSTEM_SUFFIX[role]
}

const SUMMARY_CHAR_CAP = 2000
const DEP_SUMMARY_CHAR_CAP = 500

// Caps a frame's own final-answer text before it's stored as a ledger conclusion's
// `summary` — keeps dependency hand-offs small by construction (buildAssignment below
// only ever forwards THIS capped text, never a dependency's raw episode graph).
export function capSummary(s: string): string {
  return s.length > SUMMARY_CHAR_CAP ? `${s.slice(0, SUMMARY_CHAR_CAP)}…` : s
}

// The concrete mechanism for "only relevant content is shared" (docs/subagents-plan.md):
// a dependency contributes its capped conclusion summary + file pointers, NEVER its raw
// episode graph or transcript. If a frame needs more, it calls `ledger` with action
// "getFrameTrail" itself — explicit, on-demand, never automatic.
export async function buildAssignment(root: string, req: FrameSpawnRequest): Promise<string> {
  const deps = await Promise.all(
    (req.dependsOn ?? []).map(async id => {
      const c = await getConclusion(root, id)
      if (!c) return `PRIOR WORK (frame ${id}): no conclusion recorded.`
      const summary = c.summary.length > DEP_SUMMARY_CHAR_CAP ? `${c.summary.slice(0, DEP_SUMMARY_CHAR_CAP)}…` : c.summary
      return `PRIOR WORK (frame ${id}, ${c.status}): ${summary}\nFiles: ${c.filesWritten.join(', ') || 'none'}`
    }),
  )
  return [...deps, req.assignment].filter(Boolean).join('\n\n')
}

// ── Tester / Boss verdict parsing ──────────────────────────────────────────────────
// Tester and Boss are real Agent-based frames (their own ReAct loop, real tools),
// not single-shot JSON-mode critic calls — so their verdict comes from a simple text
// convention at the end of their final answer (see ROLE_SYSTEM_SUFFIX above), parsed
// with regexes that fail open to a safe default rather than blocking on an
// unparseable reply (same "fail open" principle as every other checkpoint in this
// project — critic.ts, grounding.ts, layout.ts).

export interface TesterVerdict {
  action: 'release' | 'redo'
  followUp: string // only meaningful when action === 'redo'
}

export function parseTesterVerdict(finalAnswer: string): TesterVerdict {
  const redo = /REDO\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (redo) return { action: 'redo', followUp: redo[1].trim() }
  return { action: 'release', followUp: '' }
}

// Task-start checkpoint, a FOUR-way fork rather than always producing an objective +
// full plan (docs/subagents-plan.md, "skippable phases" + the Magentic-One-grounded
// redesign of 2026-09-03): a pure Q&A needs no frame at all; a truly tiny change (~1-2
// iterations) is the ONE case the Boss may attempt directly, tightly capped; a
// single-file change that isn't trivial to DIAGNOSE (but is still just one piece of
// work) goes straight to one Implementer + Tester with no Planner ceremony; and only
// work anticipated to need MULTIPLE distinct pieces gets the full Planner pipeline.
// Fails open to 'objective' (the safest, most-capable path) on anything unparseable.
export interface TaskStartVerdict {
  mode: 'answer' | 'trivial' | 'simple' | 'objective'
  text: string // the final answer (mode 'answer') or the objective statement (otherwise)
}

export function parseTaskStartVerdict(finalAnswer: string): TaskStartVerdict {
  const answer = /ANSWER\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (answer) return { mode: 'answer', text: answer[1].trim() }
  const trivial = /TRIVIAL\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (trivial) return { mode: 'trivial', text: trivial[1].trim() }
  const simple = /SIMPLE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (simple) return { mode: 'simple', text: simple[1].trim() }
  const objective = /OBJECTIVE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (objective) return { mode: 'objective', text: objective[1].trim() }
  // No marker found at all — do NOT fall back to the raw final answer text. A real
  // failure observed in eval: the Boss did the fix itself via bash instead of just
  // classifying, then reported that as free-form prose with no ANSWER/TRIVIAL/
  // SIMPLE/OBJECTIVE line; the raw prose ("All 7 tests pass. The three functions are
  // now implemented: ...") became the "objective" fed to the Planner, which had no
  // idea what to plan for a COMPLETION REPORT and hallucinated an entire unrelated
  // project structure trying to find something to do. Returning empty text here
  // signals "unparseable" so the caller (dispatch.ts's runBossTaskStart) falls back
  // to the ORIGINAL user message instead — always a valid objective by construction,
  // unlike the Boss's free-form answer.
  return { mode: 'objective', text: '' }
}

export interface BossVerdict {
  action: 'none' | 'inject' | 'restart' | 'escalate'
  message: string
}

export function parseBossVerdict(finalAnswer: string): BossVerdict {
  const inject = /INJECT\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (inject) return { action: 'inject', message: inject[1].trim() }
  const restart = /RESTART\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (restart) return { action: 'restart', message: restart[1].trim() }
  const escalate = /ESCALATE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (escalate) return { action: 'escalate', message: escalate[1].trim() }
  return { action: 'none', message: '' }
}
