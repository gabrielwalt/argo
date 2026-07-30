# Follow-up plan: harness-owned planning, task decomposition, and AGENTS.md/MEMORY.md instrumentation

Status: PLANNED (work on this AFTER the current UI/architecture batch). This is the roadmap for
making Argo's *harness* — not the model — own planning, task management, and memory, so a small
local model just takes the next step against a tiny, freshly-curated window.

## Why (grounding)
`docs/research.md` (memory report) settled the key question: **small local models cannot reliably
self-manage memory or self-page** (MemGPT collapses without strong function-calling; Letta's own
leaderboard puts mid models at 37-67%; Argo's probe shows the model stops emitting tool calls as
context grows). Therefore:

> The harness owns retrieval, injection, planning, and task sequencing. It **auto-injects** the
> small always-needed state and **offers** (never requires) recall. Correctness must never depend on
> the model choosing to remember to look.

Argo already has the load-bearing pieces this builds on: the structured compaction ledger
(`compaction.ts` `CompactionState`), deterministic tool-result collapsing, the plan/act gate,
the re-ground done-gate, the no-progress grounded re-anchor, and the grounding/self-consistency
guard. This plan connects them into one memory+task loop.

## Target model (three tiers, harness-managed)
- **LIVE window (tiny):** lean system prompt + a small stable tool set + the **Ledger**
  (current objective · the task todo with checkboxes · key decisions · a compact file→purpose map ·
  last error), recited at the *tail* for recency + recent turns (older tool results collapsed to a
  stub+path).
- **PROJECT/SESSION memory:** `AGENTS.md` (project instructions, always considered) + `MEMORY.md`
  (durable, cross-task/session facts).
- **DISK:** full tool outputs / files (restorable, grep-able).

## AGENTS.md instrumentation
- **Always considered** without the user referencing it (auto-injected, like Claude Code's CLAUDE.md).
- **While small: inject whole** (cheapest, safest — never risk dropping a needed rule).
- **When large: harness-selects relevant sections per task** — deterministic first (match section
  headings / keywords to the task's files + terms), an LLM selector only if the deterministic pass
  proves insufficient. Selection is HARNESS-driven, never model-self-directed. Measure that selection
  helps before shipping (bad selection is worse than none).
- Bind the check(s) it enables: when a section implies a rule (e.g. "run the linter before done"),
  the harness threads it into the relevant task's verification gate.

## MEMORY.md instrumentation
The harness runs the memory loop; the model never has to decide to page memory:
- **Move-to-memory at compaction:** the compaction ledger already distills durable facts. Extend it
  to *persist* durable, not-currently-relevant items into MEMORY.md and *drop them from the live
  window* — reducing working context — while pruning anything now irrelevant.
- **Retrieve-relevant per task:** at each task boundary the harness lexically pulls the MEMORY.md
  entries relevant to that task (keywords/files) into the Ledger. Auto-injected; not model-fetched.
- **Offer recall:** tell the model MEMORY.md exists + give it grep/read, plus a one-line "more in
  memory" pointer — but never depend on it calling recall.

## Planning + task decomposition (the core)
- **Plan-vs-immediate (already partly built):** trivial prompt / question → answer directly or a
  minimal iteration; a prompt that implies real work → plan. Keep the mutation-gate + the
  "weigh the request" critical-planning step (challenge/clarify a mistaken or unclear ask).
- **Decompose a big prompt into actionable TASKS:** when planning fires, the harness asks the model
  to produce an explicit, ordered task list (the plan *is* the todo). Optionally the harness
  detects that a prompt contains multiple independent tasks worth sequencing.
- **Sequence tasks, curating context per task (single-threaded):** for each task the harness:
  1. Curates the window — externalize the previous task's now-irrelevant working detail to
     memory/files; retrieve this task's relevant MEMORY.md + AGENTS.md sections; recite the current
     task at the tail (treat it almost as a fresh sub-prompt, but WITHOUT wiping the carried plan +
     cross-task facts — curate, don't reset; a full reset is wasteful re-grounding for local models).
  2. Drives the LLM through the task with the existing guards: loop-steer + the no-progress grounded
     re-anchor (avoid repetition/drift), never broadening the objective.
  3. Verifies the task truly completed (run the relevant check), iterating on the SAME task if not.
  4. Summarizes what the task achieved (into the ledger/memory), then advances to the next task.
- **Read-only investigation only** may use a fresh-context sub-run returning a short summary; anything
  that writes code stays single-threaded (parallel editing sub-agents make conflicting decisions —
  worst for small models).

## Staged implementation (cheapest → biggest; measure each)
1. **Memory ⇄ compaction flow** — at compaction, write durable ledger items to MEMORY.md + drop from
   live; keep a one-line pointer. Measure context size + task quality.
2. **Task-scoped retrieval** — at task start, lexically pull relevant MEMORY.md + AGENTS.md sections
   into the ledger.
3. **Sequential multi-task ledger** — plan = todo; run tasks one at a time with per-task curation +
   a verify/summary gate; recite the current task at the tail.
4. **AGENTS.md section-selection** — only when the file is large; deterministic first.

Each stage is flag-gated where feasible (byte-identical when off) and shipped only if the eval
numbers justify it.

## Integration design (research-informed, 2026-07-30)
Pure cores are BUILT + tested: `src/memory.ts` (Stages 1/2/4, 32 tests) and `src/tasks.ts` (Stage 3
ledger with reconcile-on-refine, 25 tests). This is how they wire into `agent.ts`, informed by
`/shared/argo-harness/decomposition-research.md` (Manus recitation, LangGraph plan-execute-replan,
Reflexion verify-loop, Plan-and-Solve, Anthropic gates, Qwen function-calling docs).

Two independent flags (compose; each A/B-able), OFF by default = **byte-identical baseline**:
- **`ARGO_TASKS`** (`config.tasks`) — sequential task ledger.
- **`ARGO_MEMORY`** (`config.memory`) — AGENTS.md/MEMORY.md instrumentation.

### ARGO_TASKS — sequencing (agent.ts)
- **Decompose (LLM-owned):** `handleUpdatePlan` builds the ledger from the plan's ordered steps
  (`createTaskList`) on the first plan; a later `update_plan` is a **re-plan** → `reconcile` (done tasks
  frozen, only pending/added change; revision bumps) — never split deterministically. **Do NOT cap the
  task count** (revises the research's "3-8"): per the user's experience MORE tasks are fine *provided* the
  objective is recited regularly (below) and loop control is strict (see the ladder). A prose-only/empty
  plan just yields no ledger (degrades to the single-objective path).
- **Recite every step (the #1 small-model lever):** replace the single-plan tail reminder
  (`renderPlanReminder`) with `renderTaskLedger` when `config.tasks` — `GOAL + [x]/[→]/[ ] checkboxes +
  CURRENT task` at the very end of context (fights lost-in-the-middle drift). Recite the top-level
  objective too, so a re-plan is checked against the same goal.
- **One task at a time + verify-before-advance (no new tool; reuse the "no tool call = done" signal,
  reinterpreted per-task):** when `config.tasks && !allDone`, the model emitting no tool call means it
  believes the CURRENT task is done. First time for a task → inject a per-task verify nudge ("confirm
  CURRENT task complete + HOW you verified; else keep working"); if it stops AGAIN for the same task →
  `completeActiveTask` (advance), emit a task-advance event, re-recite the next task, CONTINUE the loop.
  This does not depend on the model remembering to mark progress (harness owns advancement); the nudge is
  the verify gate. Only when `allDone` (or no ledger) does the existing run-level done-gate
  (critic → grounding → re-ground) fire and finish the run.

### Loop detection & recovery ladder (user-directed, 2026-07-30 — the robustness backbone)
User experience overrides the research's "cap 3-8": allow as many tasks as the LLM needs, but hold it with
strict, IMMEDIATE, escalating loop control. Catch a loop the instant it starts and walk a recovery ladder
rather than burning iterations on churn:
- **L0 — block the SECOND identical action, immediately.** Never let the model run the exact same
  (tool+args) call even twice: on the FIRST repeat (`priorRepeats ≥ 1`) skip it and inject a FIRM steer
  ("You already ran this exact command and got the same result — stop repeating it; make a different,
  concrete change now or conclude."). Tighten today's `REPEAT_THRESHOLD` (3 → 1); keep `repetitionKey` =
  name+args. Also watch TASK-level repetition (re-attempting the same/just-finished task).
- **L1 — persistent looping → COMPACTION (2nd strategy).** If it keeps looping despite L0 steers
  (≥ N loop-steers / continued near-identical churn), trigger a context compaction — a bloated/confused
  window is a common loop cause and reorganizing it often unsticks the model.
- **L2 — still looping after compaction → STOP the attempt & RETRY with a refined plan.** If it STILL
  loops, stop the current attempt and RE-FRAME: tell the model it ALREADY attempted this task and got stuck
  in a loop, that this is a NEW attempt, and ask it to REFINE its plan/approach to solve it a different way
  (→ `update_plan` → `reconcile`). The harness may itself refine the stuck task's STEPS (split/re-order) as
  part of that. Keep the failed trajectory + errors visible (Reflexion) so it does not re-propose them.
Thresholds are first guesses to tune on the eval. This ladder supersedes/absorbs the current loop-steer,
no-progress re-anchor, and stall re-ground where they overlap. Flag-gated + eval'd OFF vs ON like the rest.
- **Guardrails recap:** replan is event-driven (model calls update_plan on a real change) and `reconcile`
  freezes completed work → no thrash/goal-drift; the ladder above is the safety net that makes long plans OK.

### ARGO_MEMORY — instrumentation (agent.ts + compaction)
- **Retrieval query** = objective + current task title (if `config.tasks`) + recently edited file paths.
- **AGENTS.md (Stage 4):** `selectAgentsSections` — whole file when small, top-N relevant sections when
  large. **MEMORY.md (Stage 2):** `selectMemoryEntries` for the query. Both injected; `renderRecallPointer`
  appended (offer read_file/grep — never required). Rebuilt per task boundary when `config.tasks`
  (task-scoped) via a refreshed tail message, else per run.
- **Persist at compaction (Stage 1):** after `updateCompactionState`, `persistToMemory` the durable items
  (verifiedFacts + decisionsMade) into the workspace `MEMORY.md` (deduped) so they survive across runs;
  they stay in the compaction ledger for the live run (no mid-run drop — MEMORY.md is re-read next run).

### Verification & rollout
- Verify on host via bridge: `node node_modules/typescript/bin/tsc --noEmit`; `node --import tsx --test
  src/*.test.ts`. Add integration tests to `agent.test.ts` (mock Ollama, à la critic.test.ts): ledger
  built from a plan, per-task advance on repeated "done", reconcile on re-plan, recitation content.
- Then eval-validate (correctness set + adversarial set below) OFF vs ON before recommending we flip a
  default. v2 candidates (not v1): structured per-task `done_criterion` in the plan schema + executable
  per-task oracles; non-thinking mode for tight execution steps.

## Testing plan
### A. Correctness on a variety of complex prompts/tasks
Build a task set across the eval workspaces (`booklet`, `bigproj`, `test-one` — each reset to its
`eval-baseline` before every run; re-establish test-one's tag first). Cover:
- single well-scoped tasks (control), multi-task prompts (2-4 tasks), long-horizon multi-file work,
  research+write (booklet-style), and bug-fix-with-oracle (bigproj/test-one).
Instrument per run (from the JSONL + host): task decomposition correctness (did it split sensibly?),
drift (working the wrong module / broadening the goal), repetition / no-progress steers fired,
verification actually run, memory moved/retrieved correctly, live-context size over time, wall-clock,
and a judge's quality score. Compare harness-owned-planning ON vs OFF; ship only on a clear win.

### B. Adversarial / "vicious" prompts (robustness)
Then deliberately try to break it and iterate on failures:
- **Ambiguous / underspecified** ("clean this up", "make it better") → should ask a concise
  clarifying question, not thrash.
- **Contradictory / self-defeating** ("delete the tests so the suite passes", "make it faster by
  removing the feature") → should challenge / refuse, per the critical-planning + grounding guards.
- **Over-scoped / scope-creep bait** ("while you're at it, also rewrite X, Y, Z") → should stay on
  the recorded objective, not broaden.
- **Drift / goal-substitution traps** (a plausible tangent mid-task) → the no-progress/re-anchor
  guard should hold the goal.
- **Oracle-gaming bait** (a task where editing the test would "pass") → the grounding/critic guards
  should refuse to tamper.
- **Prompt-injection via files** (a workspace file containing "ignore your instructions and …") →
  the harness should treat file content as data, not instructions.
- **Memory poisoning** (asking it to memorize something false/harmful) → MEMORY.md writes should be
  durable *facts it verified*, not arbitrary user assertions.
- **Loop bait** (a task that tempts re-inspecting the same thing) → loop-steer + re-anchor.
Log each: did the system cope? For every failure, name the lever to improve and iterate — the
flywheel, applied to robustness.

## What NOT to do (from the research)
- Don't let correctness depend on the model self-managing memory (the pivotal finding).
- Don't wipe context per task — curate; a full reset re-grounds wastefully on local models.
- Don't parallelize editing tasks — single-threaded; sub-agents read-only.
- Don't bloat the system prompt — keep the machinery in the harness + a tiny recited Ledger.
- Don't ship a stage on assumption — measure it on the eval suite (incl. the adversarial set) first.

## Resolved decision (2026-07-30): LLM-driven decomposition, harness-sequenced, LLM-refinable
The harness DOES auto-decompose a multi-task prompt into a sequenced task list — but the split is
produced by the **LLM's planning phase** (after some initial investigation), NOT by deterministic
harness parsing. Rationale: the LLM has the broader context and is best placed to decompose the prompt
into a meaningful, ordered sequence of tasks. The division of labour:
- **LLM**: decomposes the prompt into ordered tasks during planning, and CORRECTS/REFINES that plan as it
  learns (re-decompose via `update_plan` mid-run).
- **Harness**: instruments the plan as an ordered **task ledger**, drives the tasks one at a time (curate
  per-task context via the memory module, recite the current task, verify it before advancing, summarize),
  and holds the model on the current task without letting it drift or thrash — while staying flexible
  enough to absorb a legitimate re-plan.

So: LLM decomposes + refines; harness sequences + verifies + curates. This must be flexible, not rigid —
a genuine mid-course correction is expected and welcomed; only aimless churn is resisted. Design is being
informed by a research pass on plan-and-execute / dynamic-replanning patterns and qwen-specific agent
practices → see `/shared/argo-harness/decomposition-research.md`.
