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

import type { Role, ToolName, FrameSpawnRequest, FramePolicy } from './types.js'
import { getConclusion } from './ledger.js'

export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  // Deliberately NO update_plan (removed 2026-09-04). The Planner's deliverable is the
  // task graph it returns as its FRAME'S FINAL ANSWER (a no-tool-call turn — see
  // dispatch.ts's parseTaskGraph), not a harness plan ledger: dispatch.ts owns the
  // graph, ledger.setPlan persists it, and nothing ever read a Planner's own
  // this.currentPlan. Holding the tool was actively harmful, not merely redundant —
  // combined with harness task sequencing (which spawnFrame never disabled, see
  // types.ts FramePolicy) an update_plan call built a task ledger whose per-task verify
  // gate then refused to let the frame conclude, so the graph was never delivered. The
  // 6 Planner frames that never called it concluded in two messages.
  planner: ['read_file', 'web_search', 'fetch_url', 'ledger'],
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

// PER-ROLE MECHANISM POLICY (2026-09-04). See types.ts's FramePolicy for why this is a
// declared object rather than a few setter calls at the spawn site. Justification per
// cell, since "why is this false" is the whole point:
//
//   tasks (harness task sequencing) — ON only for the Implementer. It is the one role
//     that does multi-step work, holds update_plan, and produces the file mutations the
//     per-task verify gate exists to check. For every other role the mechanism cannot
//     help and can only trap: the deliverable of a Planner/Tester/Boss frame IS its
//     no-tool-call final answer (a task graph, a RELEASE/REDO verdict, a NONE/INJECT/
//     RESTART/ESCALATE verdict), and task sequencing reinterprets that exact signal as
//     "current task might be done — run its verify, then ask for a summary", which
//     costs iterations at best and blocks the verdict at worst.
//   memory — ON only for the Implementer: MEMORY.md persistence at compaction (memory.ts
//     persistToMemory) is a WRITE to the workspace, and the read-only roles must not
//     write. Turning it off does not blind them: agent.ts falls back to the baseline
//     whole-file AGENTS.md + MEMORY.md injection, which for a short-budget role is
//     strictly more context than task-scoped retrieval.
//   loop — ON for every role. The failure it prevents (a small local model repeating an
//     identical call forever with nothing changed since) is role-independent, and its
//     escalation flag is what dispatch.ts's `hadTrouble()` standup trigger reads.
//   grounding / layout — ON only for the Implementer: both are PRE-DONE gates on an
//     ARTIFACT the frame produced (a document, an HTML page). A role that never writes
//     files can only ever be delayed by them, and a gate on a verdict-shaped final
//     answer is the same trap shape as `tasks` above. (layout is off in config by
//     default anyway; stated explicitly so a future default flip cannot re-open this.)
export const ROLE_POLICY: Record<Role, FramePolicy> = {
  planner:     { tasks: false, memory: false, loop: true, grounding: false, layout: false },
  implementer: { tasks: true,  memory: true,  loop: true, grounding: true,  layout: true  },
  tester:      { tasks: false, memory: false, loop: true, grounding: false, layout: false },
  boss:        { tasks: false, memory: false, loop: true, grounding: false, layout: false },
}

// Returned as a fresh object so a caller can never mutate the table above.
export function policyFor(role: Role): FramePolicy {
  return { ...ROLE_POLICY[role] }
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
// convention at the end of their final answer (see ROLE_SYSTEM_SUFFIX above).
//
// FOUR parse sites live in this pipeline — parseTesterVerdict, parseTaskStartVerdict,
// parseBossVerdict (here) and parseTaskGraph (dispatch.ts) — and until 2026-09-04 they
// each "failed open to a safe default" in their own way, with no way for a caller to
// tell "the model said this" from "nothing was parseable". Two of those defaults were
// not safe at all: an unparseable TESTER reply became RELEASE, i.e. work accepted with
// no review (measured: 85 Tester frames, ZERO REDOs ever issued, 2 of them stalled
// blank at their cap and still read as approval), and an unparseable PLANNER reply
// became a one-step graph, i.e. decomposition silently discarded.
//
// The convention now: every parse site returns an explicit `parsed` flag, so
// "unparseable" is a fact the caller can act on rather than something laundered into a
// positive verdict. Fail-open remains the default for a CLEAN, parseable-but-markerless
// reply where the benign reading is genuinely the likely one (Boss "nothing wrong");
// it is NOT the default where the pessimistic reading is (Tester approval, Planner
// decomposition), and it is never the default when the frame's own run ended in a cap
// hit or an error — dispatch.ts consults Agent.getLastRunOutcome() for that.
export interface TesterVerdict {
  // 'escalate' = no verdict could be read at all. Deliberately NOT collapsed into
  // 'release': a Tester that never said RELEASE has not approved anything.
  action: 'release' | 'redo' | 'escalate'
  followUp: string // only meaningful when action === 'redo'
  parsed: boolean  // false ⇔ action === 'escalate'
}

export function parseTesterVerdict(finalAnswer: string): TesterVerdict {
  const redo = /REDO\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (redo) return { action: 'redo', followUp: redo[1].trim(), parsed: true }
  // RELEASE must be stated, not assumed. Word-boundary matched (not a substring) so
  // "released"/"releasing" in prose cannot be mistaken for the verdict marker; the
  // colon is optional because the prompt asks the model to end with the bare word.
  if (/\bRELEASE\b/i.test(finalAnswer)) return { action: 'release', followUp: '', parsed: true }
  return { action: 'escalate', followUp: '', parsed: false }
}

// The nudge dispatch.ts sends when a Tester frame produced no readable verdict and
// there is still a round left — a targeted reformat request (the diagnosis is exact:
// the review may well have happened, the marker line is missing), mirroring
// TASK_START_MARKER_RETRY_NUDGE rather than a blind "try again".
export const TESTER_VERDICT_NUDGE =
  'Your last answer did not end with a verdict line, so it cannot be acted on. Reply again and end your ' +
  'answer with exactly one of: RELEASE (you accept the conclusion, success or failure) or ' +
  'REDO: <specific follow-up instruction> — nothing else after it.'

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
  parsed: boolean // false ⇔ no marker line was found (text is then '')
}

export function parseTaskStartVerdict(finalAnswer: string): TaskStartVerdict {
  const answer = /ANSWER\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (answer) return { mode: 'answer', text: answer[1].trim(), parsed: true }
  const trivial = /TRIVIAL\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (trivial) return { mode: 'trivial', text: trivial[1].trim(), parsed: true }
  const simple = /SIMPLE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (simple) return { mode: 'simple', text: simple[1].trim(), parsed: true }
  const objective = /OBJECTIVE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (objective) return { mode: 'objective', text: objective[1].trim(), parsed: true }
  // No marker found at all — do NOT fall back to the raw final answer text. A real
  // failure observed in eval: the Boss did the fix itself via bash instead of just
  // classifying, then reported that as free-form prose with no ANSWER/TRIVIAL/
  // SIMPLE/OBJECTIVE line; the raw prose ("All 7 tests pass. The three functions are
  // now implemented: ...") became the "objective" fed to the Planner, which had no
  // idea what to plan for a COMPLETION REPORT and hallucinated an entire unrelated
  // project structure trying to find something to do. Returning empty text here
  // signals "unparseable" so the caller (dispatch.ts's runBossTaskStart) falls back
  // to the ORIGINAL user message instead — always a valid objective by construction,
  // unlike the Boss's free-form answer. `parsed: false` says the same thing explicitly;
  // note this site was ALREADY not failing open (the fallback objective is the user's
  // own words, not the model's prose), so only the flag is new here.
  return { mode: 'objective', text: '', parsed: false }
}

export interface BossVerdict {
  action: 'none' | 'inject' | 'restart' | 'escalate'
  message: string
  // false ⇔ no NONE/INJECT/RESTART/ESCALATE marker was found. Unlike the Tester's,
  // this default STAYS benign ('none' = reviewed, nothing wrong) for a run that ended
  // cleanly: the Boss is a periodic health check whose overwhelmingly common outcome
  // is "carry on", and escalating every markerless-but-complete review would replan on
  // formatting. dispatch.ts's runBoss escalates when !parsed AND the frame's own run
  // did not end cleanly (cap hit / error) — the case where nothing was reviewed at all.
  parsed: boolean
}

export function parseBossVerdict(finalAnswer: string): BossVerdict {
  const inject = /INJECT\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (inject) return { action: 'inject', message: inject[1].trim(), parsed: true }
  const restart = /RESTART\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (restart) return { action: 'restart', message: restart[1].trim(), parsed: true }
  const escalate = /ESCALATE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (escalate) return { action: 'escalate', message: escalate[1].trim(), parsed: true }
  if (/\bNONE\b/.test(finalAnswer)) return { action: 'none', message: '', parsed: true }
  return { action: 'none', message: '', parsed: false }
}
