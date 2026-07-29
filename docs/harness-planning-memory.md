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

## Open question for the user
When a single prompt clearly contains several tasks, should the harness **auto-decompose** it into a
sequenced task list, or only sequence the steps the model itself records in its plan? Auto-decompose
is more powerful but leans harder on a small model getting the split right — likely worth a flag +
an A/B once Stage 3 exists.
