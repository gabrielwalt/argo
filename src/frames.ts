// CALL FRAMES. A call frame is one role invocation. Implemented as one scoped `Agent`
// instance (agent.ts) rather than a second execution engine: every role reuses the exact
// same battle-tested ReAct loop (eviction-based context management, loop-recovery,
// retries, tool execution) with a different system prompt and a restricted tool set —
// "mode as permission state," not "mode as a separate program." dispatch.ts constructs
// these; this module only holds the per-role configuration and the context-construction
// algorithm.

import type { Role, ToolName, FrameSpawnRequest } from './types.js'

// `conclude` is in EVERY role's tool set below — it is how any frame ends its turn
// (agent.ts's chat() loop: a turn with no tool calls is a thinking turn, only calling
// `conclude` finishes). The Planner's plan (both its initial overall plan and each
// per-task assignment, read straight through as free text — see dispatch.ts's
// isPlannerDone/isPlannerGiveUp; there is no TASK:/TEST:/DONE line convention) and the
// Dispatcher's checkpoint markers are all delivered as `conclude`'s `answer` argument
// instead of a bare no-tool-call final message.
export const ROLE_TOOLS: Record<Role, ToolName[]> = {
  // Deliberately NO update_plan. The Planner's deliverable is its own FRAME'S FINAL
  // ANSWER on each call (delivered via `conclude`'s `answer` — see dispatch.ts's
  // buildInitialPlannerPrompt/buildNextTaskPrompt/isPlannerDone), not a harness plan
  // ledger. `bash` is back (2026 review, reversing the earlier removal) but for
  // INVESTIGATION only — the Planner still has no write_file/edit_file, and its own
  // ROLE_INSTRUCTIONS.planner still states the project is READ-ONLY for it, so the
  // prompt's framing (not the absence of the tool) is what keeps it from editing.
  // agent.ts's chatCall patches this role's `bash` tool DESCRIPTION to the read-only
  // variant (patchBashForReadOnly, below) so the schema itself never invites writes.
  planner: ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger', 'conclude'],
  // Deliberately NO update_plan. The harness owns the plan; the Implementer's job is
  // to execute it, not define or refine it.
  implementer: ['read_file', 'write_file', 'edit_file', 'bash', 'fetch_url', 'web_search', 'browser_fetch', 'ledger', 'conclude'],
  // Deliberately no write_file/edit_file — the Dispatcher is strictly read-only: it
  // classifies the request, it never implements anything. `bash` is back (2026
  // review) for investigation (grep/cat/ls/running tests to understand behaviour),
  // same rationale as the Planner above — its own prompt framing plus the
  // classification-only scope is the guard, not the absence of the tool; see
  // patchBashForReadOnly for how its tool description is kept honest about that.
  // TASK_START_TOOLS (below) is a SEPARATE, deliberately different tool set used
  // only for the task-start classification checkpoint; this change does not touch it.
  dispatcher: ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger', 'conclude'],
}

// The task-start checkpoint's tool set (dispatch.ts's runDispatcherTaskStart) —
// deliberately NOT ROLE_TOOLS.dispatcher (a separate array, even though the two are
// now identical in content: this checkpoint's set is allowed to diverge from the
// Dispatcher's general role tools independently, and history has shown it needs to —
// see below). Classification must stay STRICTLY read-only in EFFECT (2026-09-05):
// `bash` CAN write, and an earlier incident traced exactly that — in eval, the
// Dispatcher judged a 6-method feature TRIVIAL, rewrote the whole target file via
// `cat > file << EOF`, hallucinated surrounding code, and broke an unrelated
// constructor signature other files depended on; the same failure recurred in a real
// session (frame dispatcher-mtmm1gcc-1: refused write_file, then ran the same heredoc
// trick via bash on its very next turn and committed).
//
// `bash` is back (2026 review, reversing the earlier removal) because the
// alternative — no bash at all — left the checkpoint unable to grep/cat/ls/run tests
// to understand real behaviour, which is worse than the write risk above. The write
// risk itself is contained by the PROMPT, not the tool set: the checkpoint's prompt
// (ROLE_INSTRUCTIONS.dispatcher) states the project is READ-ONLY and its `bash` tool
// DESCRIPTION is patched by agent.ts's chatCall to the read-only variant
// (patchBashForReadOnly, below) so the schema itself never invites a write, unlike
// the read-write default every tool definition carries in tools/index.ts.
// `ledger` stays: the TOOL only exposes read actions (messages/expand — see
// tools/index.ts's ledger case); the harness's OWN ledger.recordMessage calls are
// direct module calls from agent.ts's pushCtx, never reachable through this tool,
// so including it does not reopen a write path. `read_file` covers investigation
// (it gained a `pattern` search
// param plus offset/limit line paging specifically so a role without bash can still
// find a symbol); `web_search`/`fetch_url` cover the checkpoint's own "ground it"
// instruction. `conclude` is how this checkpoint now delivers its ANSWER/SIMPLE/
// OBJECTIVE status — a turn with no tool calls no longer ends anything (agent.ts's
// chat() loop), so without it this checkpoint could investigate forever but never
// actually classify.
export const TASK_START_TOOLS: ToolName[] = ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger', 'conclude']

// READ-ONLY ROLE BASH DESCRIPTION PATCH. Dispatcher/Planner get `bash` back (above)
// for investigation, but tools/index.ts's own `bash` tool definition carries one
// description shared by every role, written for the Implementer's read-write use
// (it explicitly talks about writing to /workspace for "intentional project changes
// or deliverables"). That wording is actively wrong advice for a role whose own
// prompt says the project is READ-ONLY — a model reading the tool schema alone (not
// every word of its system prompt) could reasonably conclude bash-writes-to-
// /workspace is an endorsed path for it too. This is the same "the SCHEMA sent to
// Ollama, not just the prompt's prose, must reflect the restriction" argument
// withConcludeStatusEnum already makes for `conclude`'s status enum — just applied
// to a tool description string instead of a parameter's enum.
//
// Generic over the tool-definition shape for the same reason withConcludeStatusEnum
// is (avoids importing tools/index.ts's concrete type into this module beyond what
// it already depends on); returns the input array unchanged (same reference) when
// no `bash` tool is present in it at all (a role-filtered list that doesn't include
// it — true for the Implementer's own tool set is irrelevant here since this is only
// ever called for Dispatcher/Planner, but the guard is cheap and correct regardless).
interface BashLikeTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

export function patchBashForReadOnly<T extends BashLikeTool>(tools: readonly T[], description: string): T[] {
  return tools.map(t => {
    if (t.function.name !== 'bash') return t
    return { ...t, function: { ...t.function, description } } as T
  })
}

// Per-role iteration budgets. Implementer keeps the most headroom (real work happens
// there); Planner/Dispatcher are short bounded loops, not open-ended. Planner raised
// 15->20->40 (2026-09-03/04, overnight large-task eval + unattended driver session):
// on a genuinely large objective against a real 11-file codebase, 15-20 wasn't enough
// room to read the codebase AND produce a task graph — it hit its cap with NO plan at
// all. MEASURED on `commander-count-option` at k=3: 2 of 3 runs hit a 20-iteration cap
// with no conclusion at all; `commander` is 4180 lines with lib/command.js alone at
// 2790, and reading enough of it to decompose the objective does not fit in 20 turns
// when each read costs a turn.
//
// Two caveats recorded deliberately. (1) This project has already DISMISSED "more
// iterations help" once — 60->90 made a single-loop Implementer worse, by thrashing.
// That result does not obviously transfer: a frame killed mid-read while making steady
// progress is a different failure from a frame drifting with budget to spare. If 40
// merely moves the cap-hit later, the budget is not the constraint — raise it once,
// measure, and do not keep raising it.
// (2) ~20 iterations is meant to be an IDEAL CHUNK SIZE and a stand-up cadence, NOT a
// hard kill; every entry in this table is currently a hard kill (agent.ts makes the
// cap-hit string the frame's final answer). The correct fix is a soft cap with a
// stand-up, and this raise is an interim measurement, not that fix.
// Implementer raised 60->80->160 across this project's history. The escalating
// PROGRESS_CHECK_ITERATIONS/PROGRESS_CHECK_MESSAGES table below gives the Implementer
// escalating nudges before its hard cap, keeping a real margin after the strongest
// ("Finish immediately") nudge instead of the cap landing right on top of it.
export const ROLE_MAX_ITERATIONS: Record<Role, number> = {
  planner: 40,
  implementer: 160,
  dispatcher: 15,
}

// PER-ROLE PROGRESS-CHECK ESCALATION. Distinct from the generic fraction-of-
// maxIterations stall/progress mechanism already in agent.ts (the `stallCheckpoints`
// local in chat(), scaled 0.4/0.65/0.85 of a run's own budget) — that mechanism stays
// exactly as it is for every role NOT listed here (currently just Dispatcher).
// Planner/Implementer instead get FIXED, ABSOLUTE per-call iteration thresholds with
// role-specific wording, because the numbers involved don't fall out of the generic
// fractions and neither role is well served by the generic table's coarser rungs.
// agent.ts reads these keyed by the frame's role (Agent.setRole, called by
// dispatch.ts's spawnFrame alongside setAllowedTools/setMaxIterations/etc.) and,
// when a role has an entry here, replaces the generic mechanism for that one
// frame's checkpoints with these exact iteration numbers and exact message text —
// unconditionally: these are fixed checkpoints on a countdown to a hard cap, not a
// stall detector, so they fire every time regardless of how much real progress is
// happening. Iteration numbers here are per-CALL (i.e. per resumeFrame/chat() turn on
// the frame's Agent instance) — this falls out for free from how agent.ts's iteration
// loop already works: the `for (let i = 0; i < this.maxIterations; i++)` loop always
// starts i at 0 on every chat() call regardless of a resumed frame's cumulative
// `iterationBase` (that offset only shifts REPORTED iteration numbers and this table's
// own thresholds together, so the comparison still lands on the same LOCAL iteration
// count every call — see agent.ts's stallCheckpoints computation).
export const PROGRESS_CHECK_ITERATIONS: Partial<Record<Role, number[]>> = {
  planner: [20, 30],
  implementer: [100, 120, 140],
}

// Message text is VERBATIM per this task's brief — index-aligned with
// PROGRESS_CHECK_ITERATIONS[role] (message[i] fires at iteration[i]). Planner's own
// two rungs mirror the Implementer's escalating tone (gentle reminder, then firmer)
// at half the iteration count, since its hard cap (40) is half the Implementer's.
export const PROGRESS_CHECK_MESSAGES: Partial<Record<Role, string[]>> = {
  planner: [
    'IMPORTANT — 20 iterations used. Wrap up your analysis and call conclude with your result.',
    'IMPORTANT — 30 iterations used, approaching the hard limit. You MUST call conclude NOW with your best result.',
  ],
  implementer: [
    'IMPORTANT — 100 iterations used. Start wrapping up your work. Call conclude with a ' +
      'summary of what you accomplished, what didn\'t work, and what\'s left to do.',
    'IMPORTANT — 120 iterations used. You MUST wrap up now. Call conclude with what you accomplished and ' +
      'what remains.',
    'IMPORTANT — 140 iterations used, approaching the hard limit. Finish IMMEDIATELY. Call conclude with your ' +
      'final status — what was done, what failed, and what\'s left.',
  ],
}

// Plain display names — the role's function, not a character.
export const ROLE_NAME: Record<Role, string> = {
  dispatcher: 'Dispatcher',
  planner: 'Planner',
  implementer: 'Implementer',
}

// Valid `conclude` status keywords per role. When an agent calls conclude(status, message),
// agent.ts validates `status` against this set and returns an error (visible to the model)
// if invalid, repeating the expected keywords. This replaces all regex-based parsing of
// conclude text in dispatch.ts.
export const ROLE_CONCLUDE_STATUSES: Record<Role, string[]> = {
  // Dispatcher: ANSWER (knows the answer), SIMPLE (one implementer), OBJECTIVE
  // (needs a planner to decompose), SUMMARY (end-of-run conclusion).
  dispatcher: ['ANSWER', 'SIMPLE', 'OBJECTIVE', 'SUMMARY'],
  // Planner initial call: PLAN (the plan is the message).
  // Planner detail calls: IMPLEMENT (assignment for next sub-agent), SUCCESS (objective
  // fully met, final statement), FAIL (cannot complete, explain why).
  planner: ['PLAN', 'IMPLEMENT', 'SUCCESS', 'FAIL'],
  // Implementer: SUCCESS (did the work) or FAIL (couldn't do it).
  implementer: ['SUCCESS', 'FAIL'],
}

export function concludeStatusError(role: Role, invalidStatus: string): string {
  const valid = ROLE_CONCLUDE_STATUSES[role]
  return `Invalid conclude status "${invalidStatus}". For your role (${ROLE_NAME[role]}), ` +
    `the valid status keywords are: ${valid.join(', ')}. ` +
    `Call conclude again with status set to one of these keywords and your message in the message parameter.`
}

// DYNAMIC conclude.status ENUM. agent.ts's runtime check (chat()'s conclude handler,
// using ROLE_CONCLUDE_STATUSES/concludeStatusError above) has always REJECTED an
// invalid status with a corrective error — but until now the SCHEMA offered to
// Ollama for every role advertised only `{ type: 'string' }`, with the valid
// keywords mentioned solely in the tool description's prose. A model that never
// reads (or forgets) that prose has no structural signal for which keywords are
// legal; putting the same list ROLE_CONCLUDE_STATUSES already enforces into the
// schema's `enum` lets a tool-calling model see and validate against it directly,
// the same way the ledger tool's `action` parameter already gives its own enum.
//
// Generic over the tool-definition SHAPE (rather than importing tools/index.ts's
// concrete type, which would create a needless frames.ts -> tools/index.ts type
// dependency beyond what's already there) — T is inferred at the call site from
// whatever array agent.ts passes in, so this stays a pure, narrowly-scoped patch:
// find the tool named 'conclude', return every OTHER tool untouched (by reference —
// no wasted clone), and return a new object only for 'conclude' itself with its
// `status` property's `enum` set. Returns the input array unchanged (same
// reference) when role is null/undefined (defensive — every production caller
// always passes a real role now, since Agent.roleTag is never null) or when no
// 'conclude' tool is in the array at all (a role-filtered list that doesn't
// include it, though every current role does).
interface ConcludeLikeTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: string
      // Index signature (not a fixed {type,description,enum?} shape) deliberately —
      // this must structurally match every tool in tools/index.ts's toolDefinitions,
      // several of which put extra JSON-Schema keywords (minimum/maximum/items/
      // maxItems) on OTHER properties this function never touches. Widening to
      // `Record<string, unknown>` sidesteps having to enumerate every keyword this
      // helper doesn't care about, while `status` below (the only property actually
      // read/written) still gets a real, narrow type.
      properties: Record<string, unknown> & { status?: { type: string; description: string; enum?: string[] } }
      required: string[]
    }
  }
}

export function withConcludeStatusEnum<T extends ConcludeLikeTool>(tools: readonly T[], role?: Role | null): T[] {
  if (!role) return tools as T[]
  const statuses = ROLE_CONCLUDE_STATUSES[role]
  if (!statuses) return tools as T[]
  return tools.map(t => {
    if (t.function.name !== 'conclude') return t
    // The patched result is only ever a reshaped copy of a tool that already
    // satisfied ConcludeLikeTool (t itself), so it is safe to assert back to T here —
    // same pattern as the two early `as T[]` returns above, just per-element. TS
    // cannot verify a generic-shaped object literal against an arbitrary T on its
    // own, which is exactly why the assertion (not a plain return) is needed.
    return {
      ...t,
      function: {
        ...t.function,
        parameters: {
          ...t.function.parameters,
          properties: {
            ...t.function.parameters.properties,
            status: { ...t.function.parameters.properties.status, enum: statuses },
          },
        },
      },
    } as T
  })
}

// ROLE_IDENTITY / ROLE_INSTRUCTIONS — the two SYSTEM messages agent.ts's chat()
// wraps around a frame's [user] assignment (message 1 = identity, message 3 =
// instructions; see that file's chat() for the exact construction). Replaces the
// old single-block ROLE_SYSTEM_SUFFIX/systemPromptFor pair (which used to be
// prepended onto the first user message) now that every frame gets properly
// typed, separate system/user/system messages instead of one concatenated
// user-role block. Deliberately lean: no tool descriptions (Ollama's own `tools`
// parameter already shows the model its tools), no filesystem/environment/
// memory/git details — those lived in agent.ts's buildSystemPrompt (removed) and
// were never role-specific.
export const ROLE_IDENTITY: Record<Role, string> = {
  dispatcher:
    'You are Argo\'s DISPATCHER agent in a multi-agent coding harness, accountable for the entire run. ' +
    'You determine how each user request should be handled and, when the run is complete, synthesize ' +
    'the verified results into the final answer to the user.',
  planner:
    'You are Argo\'s PLANNER agent in a multi-agent coding harness. You turn objectives into coherent ' +
    'implementation units and produce a self-contained assignment for each.',
  implementer:
    'You are Argo\'s IMPLEMENTER agent in a multi-agent coding harness, responsible for completing one ' +
    'assigned implementation task.',
}

// ITERATIVE PLANNER, `conclude`-based — no TASK:/TEST:/DONE line convention. The
// Planner is called in two phases: ONCE for an overall plan (an ordered list of
// concrete sub-tasks, delivered as its `conclude` answer), then RESUMED repeatedly,
// each time producing exactly one fully self-contained Implementer assignment as its
// `conclude` answer, informed by the previous Implementer's own conclusion. There is
// no separate re-planning step — adaptation is just what happens naturally on the
// next detail call (see dispatch.ts's module header for the full flow, and
// isPlannerDone for how the harness detects "no further work needed").
export const ROLE_INSTRUCTIONS: Record<Role, string> = {
  dispatcher:
    'Classify the user request into exactly one of these statuses and provide the corresponding message:\n' +
    '- Status ANSWER; Message: The complete final answer — Use when the request can be answered directly ' +
    'without project changes or delegation. Investigate with the available read-only tools when needed ' +
    'before answering.\n' +
    '- Status SIMPLE; Message: A concrete, verifiable objective — Use for a well-scoped change that can be ' +
    'handled by a single Implementer agent. SIMPLE should be the default unless decomposition into ' +
    'independently verifiable implementation units materially improves execution or correctness.\n' +
    '- Status OBJECTIVE; Message: A concrete, verifiable objective — Use when deeper upfront analysis, ' +
    'several distinct implementation units, or genuine ambiguity about the approach makes planning useful. ' +
    'A Planner agent will determine the implementation strategy.\n\n' +
    'Ground your answer or objective whenever it depends on project-specific details, current facts, or ' +
    'anything you cannot establish confidently from the request alone. Inspect the relevant files or use ' +
    'the web when necessary rather than relying on assumptions.\n\n' +
    'When reformulating the request as an objective, preserve every material requirement and constraint. ' +
    'Clarify wording, but do not silently narrow, broaden, or reinterpret the requested outcome. Extract ' +
    'and include all details from AGENTS.md and MEMORY.md that affect how the request should be understood ' +
    'or executed, so downstream agents receive the project context they need without having to rediscover it.\n\n' +
    'Do not implement anything. The project is READ-ONLY for you: inspect it as needed to understand the ' +
    'request and codebase, but do not intentionally modify project files.\n\n' +
    'EFFICIENCY\n' +
    'Use each tool call to obtain new information or advance the task. Do not repeat or perform an ' +
    'equivalent inspection when the current context already establishes the fact. Treat successful tool ' +
    'results as authoritative unless something may have changed since.\n\n' +
    'The .argo/ folder is harness bookkeeping — ignore its contents.',
  planner:
    'Your job happens in two phases:\n' +
    '1. Given the objective, determine the most effective implementation strategy and call `conclude` with ' +
    'an ordered list of IMPLEMENTATION UNITS. Each unit is one coherent body of work for one Implementer ' +
    'and may contain multiple coding steps. Implementation units are handoff boundaries, not individual ' +
    'coding steps. Use a single unit when the objective fits naturally within one Implementer run; create ' +
    'additional units only when a handoff materially improves execution, verification, or the ability to ' +
    'plan subsequent work reliably.\n' +
    '2. You will then be resumed for each unit and asked to produce exactly one fully self-contained ' +
    'IMPLEMENTATION ASSIGNMENT for the next Implementer. Adjust the remaining plan naturally as verified ' +
    'results come in.\n\n' +
    'HANDOFF BOUNDARIES\n' +
    'Group work that naturally belongs together, including setup, implementation, wiring, interaction, and ' +
    'tests when they contribute to the same coherent outcome. Do not create a separate unit merely because ' +
    'the objective mentions another requirement or because the implementation contains another technical ' +
    'step. Every additional handoff should have a concrete benefit.\n\n' +
    'DETAILED ASSIGNMENTS\n' +
    'The Implementer sees only its current assignment, never your overall plan or prior planner context. ' +
    'Each assignment must therefore include everything needed to execute that unit correctly: the concrete ' +
    'verifiable outcome, relevant context and dependencies on prior work, relevant files, interfaces and ' +
    'constraints, what is in scope versus what should remain unchanged or deferred, and appropriate ' +
    'verification expectations. Include all details from AGENTS.md and MEMORY.md, as well as prior verified ' +
    'results, that materially affect the current implementation unit. Specify required behavior and ' +
    'constraints without prescribing an implementation technique unless that technique is itself required ' +
    'by the objective or project architecture.\n\n' +
    'SCOPE\n' +
    'The project is READ-ONLY for you. Inspect files as needed to understand the codebase and ground the ' +
    'plan, but do not implement or modify anything.\n\n' +
    'EFFICIENCY\n' +
    'Use each tool call to obtain new information or advance the task. Do not repeat or perform an ' +
    'equivalent inspection when the current context already establishes the fact. Treat successful tool ' +
    'results as authoritative unless something may have changed since.\n\n' +
    'The .argo/ folder is harness bookkeeping — ignore its contents.',
  implementer:
    'IMPLEMENTATION\n' +
    'Read the relevant files and search for information when necessary, rather than relying on assumptions. ' +
    'Prefer the simplest coherent change that fully satisfies the assignment and preserves unrelated behavior. ' +
    'Avoid unnecessary abstractions, dependencies or indirection.\n\n' +
    'VERIFICATION\n' +
    'Unless the assignment explicitly asks for more, verify only the smallest sufficient set of checks, then stop. ' +
    'Trust a successful tool result and your own prior reasoning once either has established a fact with evidence. ' +
    'Do not re-read a file you just wrote to confirm it. ' +
    'If something cannot reasonably be implemented or verified, report that limitation rather than continuing to fail at it.\n\n' +
    'PRECISION\n' +
    'Never reconstruct exact identifiers, paths, URLs, flags, or package names from memory; copy them from ' +
    'observed project or tool output, or inspect the source again.\n\n' +
    'CONCLUSION\n' +
    'Call the conclude tool and summarize what you changed, the resulting project state, the implementation approach, ' +
    'the verification performed, and any important unexpected findings, limitations, or remaining issues.\n' +
    'If you cannot complete the assignment within reasonable effort, state what you tried, what failed, what ' +
    'remains incomplete, and why it cannot be completed as scoped.\n\n' +
    'EFFICIENCY\n' +
    'Use each tool call to obtain new information or advance the task. Do not repeat or perform an ' +
    'equivalent inspection when the current context already establishes the fact. Treat successful tool ' +
    'results as authoritative unless something may have changed since.\n' +
    'When a file already exists and needs a correction, prefer edit_file for targeted changes over a full rewrite.' +
    'Reserve write_file for genuinely new files or cases where most of the file needs to change.\n' +
    'The .argo/ folder is harness bookkeeping — do not touch or inspect its contents.',
}

const SUMMARY_CHAR_CAP = 2000

// Caps a frame's own final-answer text before it's stored as a ledger conclusion's
// `summary` — keeps dependency hand-offs small by construction (buildAssignment below
// only ever forwards THIS capped text, never a dependency's raw episode graph).
export function capSummary(s: string): string {
  return s.length > SUMMARY_CHAR_CAP ? `${s.slice(0, SUMMARY_CHAR_CAP)}…` : s
}

// The concrete mechanism for "only relevant content is shared": a dependency
// contributes its capped conclusion summary + file pointers, NEVER its raw
// transcript. If a frame needs more of ITS OWN history, it calls `ledger` with
// action "messages" itself — explicit, on-demand, never automatic, and scoped to
// that frame's own ledger file only (ledger.ts's readFrame) — there is no
// cross-agent ledger visibility any more.
//
// A frame's assignment is exactly its own objective/task text — the Dispatcher's
// paraphrase (for the Dispatcher itself) or the Planner/Implementer's assigned step.
// No verbatim copy of the original user request is prepended here: only the
// Dispatcher frame sees the raw user message (it's the one classifying it), and
// downstream frames (Planner/Implementer) get scoped to their own assignment only.
export async function buildAssignment(root: string, req: FrameSpawnRequest): Promise<string> {
  return req.assignment
}

// ── Dispatcher task-start verdict parsing ──────────────────────────────────────────
// The Dispatcher is a real Agent-based frame (its own ReAct loop, real tools), not a
// single-shot JSON-mode critic call — so its verdict comes from a simple text
// convention at the end of its final answer (see ROLE_INSTRUCTIONS.dispatcher above),
// used as a fallback when the frame's own `conclude` status wasn't set/valid.
//
// The convention: parseTaskStartVerdict returns an explicit `parsed` flag, so
// "unparseable" is a fact the caller can act on rather than something laundered into a
// positive verdict.
export interface TaskStartVerdict {
  mode: 'answer' | 'simple' | 'objective'
  text: string // the final answer (mode 'answer') or the objective statement (otherwise)
  parsed: boolean // false ⇔ no marker line was found (text is then '')
}

export function parseTaskStartVerdict(finalAnswer: string): TaskStartVerdict {
  const answer = /ANSWER\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (answer) return { mode: 'answer', text: answer[1].trim(), parsed: true }
  const simple = /SIMPLE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (simple) return { mode: 'simple', text: simple[1].trim(), parsed: true }
  const objective = /OBJECTIVE\s*:\s*([\s\S]+)/i.exec(finalAnswer)
  if (objective) return { mode: 'objective', text: objective[1].trim(), parsed: true }
  // No marker found at all — do NOT fall back to the raw final answer text. A real
  // failure observed in eval: the Dispatcher did the fix itself via bash instead of
  // just classifying, then reported that as free-form prose with no ANSWER/SIMPLE/
  // OBJECTIVE line; the raw prose ("All 7 tests pass. The three functions are
  // now implemented: ...") became the "objective" fed to the Planner, which had no
  // idea what to plan for a COMPLETION REPORT and hallucinated an entire unrelated
  // project structure trying to find something to do. Returning empty text here
  // signals "unparseable" so the caller (dispatch.ts's runDispatcherTaskStart) falls
  // back to the ORIGINAL user message instead — always a valid objective by
  // construction, unlike the Dispatcher's free-form answer. `parsed: false` says the
  // same thing explicitly.
  return { mode: 'objective', text: '', parsed: false }
}
