# Follow-up plan: harness-owned planning, task decomposition, and AGENTS.md/MEMORY.md instrumentation

For a plain-language description of every harness behavior plus critiques and current
defaults, see `docs/harness-instrumentation.md`.

Status (2026-08-04): Stages 1-4 (tasks + AGENTS.md/MEMORY.md memory) and the loop-recovery
ladder are BUILT, wired into `agent.ts`, eval'd OFF vs ON non-regressive (2026-07-30 e2e A/B;
see `docs/eval-log.md`), and now **ON BY DEFAULT** — `ARGO_TASKS`, `ARGO_MEMORY`, and
`ARGO_LOOP` are enabled out of the box (env `=0/false/off` forces off), matching grounding
(also on). Re-validated non-regressive at the new defaults: full suite 175/175, integrated
smoke 2/2. `ARGO_CRITIC` stays OFF (inconclusive value + latency; executable verification is
the preferred lever). `ARGO_AUTOCOMMIT` stays OFF (opt-in). Since the OFF-default checklist
below was written, the biggest verification gap it flagged has been CLOSED — see "Executable
per-task verification + reconciliation" below. This doc is now the design record + remaining
checklist, not a future plan. It documents how Argo's *harness* — not the model — owns
planning, task management, and memory, so a small local model just takes the next step
against a tiny, freshly-curated window.

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

## Staged implementation (cheapest → biggest; measure each)   ✅ ALL FOUR BUILT + WIRED + EVAL'D
1. **Memory ⇄ compaction flow** ✅ — at compaction, write durable ledger items to MEMORY.md + drop from
   live; keep a one-line pointer.
2. **Task-scoped retrieval** ✅ — at task start, lexically pull relevant MEMORY.md + AGENTS.md sections
   into the ledger.
3. **Sequential multi-task ledger** ✅ — plan = todo; run tasks one at a time with per-task curation +
   a verify/summary gate; recite the current task at the tail.
4. **AGENTS.md section-selection** ✅ — only when the file is large; deterministic first. Fixed
   2026-07-30 (commit e718287) to re-select per task at the tail instead of freezing once per run —
   see the ARGO_MEMORY section below.

Each stage is flag-gated (byte-identical when off — `ARGO_TASKS`/`ARGO_MEMORY`); the 2026-07-30 e2e
A/B (see Integration design + Testing plan below) was non-regressive. Flags are now **ON by default**
(2026-08-04; env `=0/false/off` forces off) — see the Status note at the top; the n≥3 + adversarial
validation remains open.

## Integration design (research-informed, 2026-07-30)
Pure cores AND their wiring into `agent.ts` are BUILT + tested + eval'd (2026-07-30 e2e A/B,
non-regressive): `src/memory.ts` (Stages 1/2/4, 32 tests) and `src/tasks.ts` (Stage 3 ledger with
reconcile-on-refine, 25 tests). Below is that wiring, informed by
`/shared/argo-harness/decomposition-research.md` (Manus recitation, LangGraph plan-execute-replan,
Reflexion verify-loop, Plan-and-Solve, Anthropic gates, Qwen function-calling docs).

Two independent flags (compose; each A/B-able), now **ON by default** (were OFF = **byte-identical baseline** for the initial A/B):
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

### Executable per-task verification + per-task summaries + final reconciliation — ✅ BUILT (2026-08-04, closes the biggest verification gap)
- **Executable `verify` per task:** `update_plan` steps can now carry a `verify` shell command
  (`src/tasks.ts` + `src/agent.ts` + `src/tools/index.ts`). At the per-task gate the harness
  RUNS it and only advances the ledger on exit 0; on failure the output is fed back to the
  model as the next turn instead of advancing. A consecutive-failure escalation guard
  (`VERIFY_FAIL_ESCALATE = 3`) prevents an infinite verify-fail loop. This replaces the old
  prompt-only "confirm task complete + how you verified" nudge with a real oracle — the model
  can no longer talk its way past a task it hasn't actually finished.
- **Per-task summaries:** once a task passes its `verify` (or has none and the model reports
  done), the model produces a short what/how summary that is stored on the ledger (`Task.summary`)
  and carried across re-plans (`reconcile` preserves summaries on frozen/done tasks).
- **Final reconciliation:** when all tasks are done, a one-time FINAL RECONCILIATION step feeds
  the top-level objective + every per-task summary back to the model to check for gaps; it can
  re-open work via `update_plan` if something is missing. If complete, the model's user-facing
  final summary is grounded in those per-task records rather than being a free-form recollection.
  This upgrades the old prompt-only conclusion described in `docs/harness-instrumentation.md`.
- Also fixed alongside this pass: AGENTS.md per-task section-selection (previously listed as the
  Stage-4 fix below) is confirmed still per-task, not frozen once at the initial request.

### Loop detection & recovery ladder — ✅ BUILT (`src/loop.ts`, flag `ARGO_LOOP`, now ON by default; user-directed 2026-07-30 — the robustness backbone)
Built **mutation-aware**, refined from the original design below: block the 2nd identical (tool+args)
call only when no project mutation (`edit_file`/`write_file` success) has happened since it last ran —
a legitimate re-check after an edit is never blocked, only genuine no-progress churn is.
`repetitionKey` = name+args, unchanged. A real mutation always resets the streak.
- **L0 — firm re-anchoring steer**, from the first no-progress repeat.
- **L1 — one-shot context compaction** at `l1BlocksBeforeCompact` (= 3) consecutive no-progress
  blocks — a bloated/confused window is a common loop cause; fires once per streak, not every block.
- **L2 — stop-and-reframe** at `l2BlocksBeforeAbort` (= 6): tells the model it's looping and forces
  `update_plan`/`reconcile` with a different approach, keeping the failed trajectory visible
  (Reflexion) so it doesn't re-propose it.
Replaces the count-based `REPEAT_THRESHOLD` steer **only** when the flag is on; the no-progress
re-anchor and fixed-iteration stall reground (a *different* failure mode — novel-arg drift, not
identical repeats) are **unchanged** in both modes. Validated: 12 unit tests (`loop.test.ts`) + an
`agent.test.ts` integration test (ON executes a repeat once and escalates L0→L1→L2 while still
completing; OFF runs to `REPEAT_THRESHOLD`), plus a non-regressive e2e A/B. Thresholds (3/6) are
still first guesses — it hasn't yet fired in a real (non-synthetic) stuck run, so tuning stays
TBD-by-eval until the adversarial set below actually exercises it.
- **Guardrails recap:** replan is event-driven (model calls update_plan on a real change) and `reconcile`
  freezes completed work → no thrash/goal-drift; the ladder above is the safety net that makes long plans OK.

### ARGO_MEMORY — instrumentation (agent.ts + compaction)
- **Retrieval query** = objective + current task title (if `config.tasks`) + recently edited file paths.
- **AGENTS.md (Stage 4):** `selectAgentsSections` — whole file when small, top-N relevant sections when
  large. **MEMORY.md (Stage 2):** `selectMemoryEntries` for the query. Both injected; `renderRecallPointer`
  appended (offer read_file/grep — never required). Rebuilt per task boundary when `config.tasks`
  (task-scoped) via a refreshed tail message, else per run. (Fixed 2026-07-30, commit e718287: a
  large AGENTS.md used to be selected once and frozen into the system prompt for the whole run; it is
  now re-selected every iteration via `retrievalQuery()`, exactly like MEMORY.md — only a *small*,
  whole-file AGENTS.md stays in the system prompt.)
- **Persist at compaction (Stage 1):** after `updateCompactionState`, `persistToMemory` the durable items
  (verifiedFacts + decisionsMade) into the workspace `MEMORY.md` (deduped) so they survive across runs;
  they stay in the compaction ledger for the live run (no mid-run drop — MEMORY.md is re-read next run).

### Verification & rollout
- ✅ Verified on host (`tsc --noEmit`; `node --import tsx --test src/*.test.ts`) and
  integration-tested in `agent.test.ts` (mock Ollama, à la critic.test.ts): ledger built from a plan,
  per-task advance on repeated "done", reconcile on re-plan, recitation content, loop-ladder
  escalation, memory OFF-baseline no-op.
- ✅ Eval-validated: 2026-07-30 e2e A/B (correctness set below: booklet/bigproj/test-one, n=1,
  max_iter=60, qwen3.6) — OFF 6/6, ON 6/6, non-regressive; `bigproj-deps` converged faster ON
  (34→22 iters), `bigproj-effort` noisier (both pass). Full entry: `docs/eval-log.md`. Still open
  before flipping a default: an n≥3 run (confirm `bigproj-effort` isn't just variance) and the
  adversarial set below (the loop ladder hasn't fired in a real run yet). v2 candidates (not v1,
  unchanged): structured per-task `done_criterion` in the plan schema + executable per-task oracles;
  non-thinking mode for tight execution steps.

## Testing plan
### A. Correctness on a variety of complex prompts/tasks
Build a task set across the eval workspaces (`booklet`, `bigproj`, `test-one` — each reset to its
`eval-baseline` before every run; `test-one`'s tag was missing and is now established, so its reset no
longer no-ops). Cover:
- single well-scoped tasks (control), multi-task prompts (2-4 tasks), long-horizon multi-file work,
  research+write (booklet-style), and bug-fix-with-oracle (bigproj/test-one).
Instrument per run (from the JSONL + host): task decomposition correctness (did it split sensibly?),
drift (working the wrong module / broadening the goal), repetition / no-progress steers fired,
verification actually run, memory moved/retrieved correctly, live-context size over time, wall-clock,
and a judge's quality score. Compare harness-owned-planning ON vs OFF; ship only on a clear win.
**First pass done** (2026-07-30, n=1): OFF 6/6, ON 6/6, non-regressive — see `docs/eval-log.md`.
**Still open:** an n≥3 run to confirm `bigproj-effort` isn't just noise before flipping a default.

### B. Adversarial / "vicious" prompts (robustness) — OPEN, not yet run
Then deliberately try to break it and iterate on failures — in particular **loop bait**: the only way
to see the loop-recovery ladder actually fire on a real task (so far only unit/integration-tested):
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
- **Loop bait** (a task that tempts re-inspecting the same thing) → the loop-recovery ladder
  (L0 steer → L1 compaction → L2 reframe) with `ARGO_LOOP` on; the no-progress re-anchor otherwise.
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
