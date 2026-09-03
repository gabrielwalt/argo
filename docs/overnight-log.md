# Overnight run journal — 2026-09-03

Working log for the overnight plan at `~/.claude/plans/polished-sniffing-dragonfly.md` (also
summarized in the task list, tasks #43-49). This file is the source of truth if the conversation
context gets compacted — always update it immediately after a concrete step, not just at the end.

**Ground rules for this run**: no `git commit` on Argo source without being asked (working tree
stays uncommitted, noted below); every harness fix goes through tsc → targeted unit tests →
docker build → re-run the task that surfaced it → re-run the 11-task regression battery before
moving on; n=1 per run unless confirming something that matters.

## Status: Phase 5 in progress (bigproj-deps done + fixed, bigproj-effort next)

## Phase 1 — Regression + fix validation
- Fix already made pre-overnight: `TASK_START_MAX_ITERATIONS` 6→10 in `src/dispatch.ts` (was being
  silently clamped to 10 by `Agent.setMaxIterations`'s own floor anyway; the `hitCap` comparison
  was checking against the wrong number, risking false "preempted-incomplete" classifications).
- Baseline to beat: shared-8 total wall-clock **592s** (11/11 pass), measured just before this fix,
  full table in `docs/eval-log.md`'s 2026-09-03 entry.
- **Result: 11/11 pass.** Shared-8 total wall-clock 999s this run vs 592s the run before the fix —
  noisier, not better, but every individual per-task iteration count is in the same range as
  before (e.g. sanity-pool it=10 vs it=11, race-semaphore it=35 vs it=23) except aider-transpose
  (11 it but 366s — ~33s/iteration, ~6x the ~5s/iteration typical of the other rows this same run,
  which reads as a transient slow-LLM-call/system-load blip rather than more work being done).
  Consistent with this project's own well-documented temp=0.8 n=1 variance (see e.g. bigproj-effort
  in `docs/eval-log.md`'s July history: "23-49+ it" for literally the same task/config). **Not
  treated as a regression** — no new qualitative misbehavior found, TASK_START_MAX_ITERATIONS fix
  is correctness-only and doesn't explain a broad slowdown. Moving on; will get a 3rd data point
  for the shared-8 total later if time permits, but not blocking the night on it.
- bigproj (tasklab) baseline sanity-checked standalone: `node --test` → 37/37 pass, no GPU needed.

## Phase 2-7
Not started yet.

## Decisions log
- **Plan adjustment (before Phase 2 proper started)**: found `~/Sources/test/bigproj` (tasklab) —
  an existing, already-vetted, self-authored zero-dependency multi-layer task-tracker codebase
  (`src/{cli,service,task,store,query,validation,errors,ids,formatter,constants,index}.js`, clean
  layering) that was ALREADY used for real multi-file eval tasks in this project's history, with
  fixtures already sitting in `scripts/eval-fixtures/bigproj-*.test.js` and task defs already wired
  into `scripts/eval-e2e.mjs` (`bigproj-deps`, `bigproj-effort`, `bigproj-duedate-bug`). Per
  CLAUDE.md's own history: `bigproj-deps`/`bigproj-effort` were explicitly documented as
  "HARD, long-horizon... multi-file; stresses memory/convergence" for the OLD single-loop baseline
  (34 it/395s one run; effort notoriously high-variance 23-49+ it, sometimes failing at the 60-iter
  cap) — i.e. genuine historical evidence this pair is hard enough to matter, PLUS free baseline
  numbers to compare against without re-running the old harness. `bigproj-duedate-bug` is a
  single-file debug task — good medium-tier bridge case.
  **Decision**: use these 3 as the PRIMARY large/medium tier instead of spending ~1-1.5h vetting an
  unfamiliar external repo (real risk: native deps, flaky tests, a codebase too large for the
  Planner to productively read within its own iteration budget) — direct application of the
  "don't waste time re-deriving what already exists" token-efficiency lesson. Will still look for
  ONE genuinely external/downloaded repo later if time in Phase 5/6 permits, as a diversifying data
  point, but it is no longer on the critical path.
  - `bigproj-duedate-bug` -> medium tier (Phase 2/3).
  - `bigproj-deps`, `bigproj-effort` -> large/ambiguous tier (Phase 4/5) — real multi-file feature
    work, real historical drift evidence, no new fixture-authoring needed.
- Quality judge script (`scripts/eval-quality-judge.mjs`) not yet written — planned for Phase 5,
  reusing `src/critic.ts`'s validated self-critique pattern (qwen3.6 judging its own/its team's work).

## Findings log

### Finding 3 — Infra bug: eval-e2e.mjs's saveDiff() diffed against the wrong ref
First real Phase 5 run (`bigproj-deps`, genuinely large/multi-file: implement task dependencies +
topological scheduling + cycle detection). The eval script's own background process got killed by
the harness mid-run (not an Argo bug — the container kept running server-side unaffected; I
recovered by polling `/status` directly and manually running the deterministic check once idle).
**Result: 46/46 tests pass** — a full, correct implementation (`addDependency`/`removeDependency`/
`getDependencies`/`getDependents`/`scheduleOrder`/`readyTasks`, Kahn's-algorithm topological sort,
cycle detection) — genuinely good work on the hardest task run so far.
But the FIRST quality-judge pass reported `goal_completeness: 2/10` and hallucination claims,
flatly contradicting the passing test suite. Root cause: `saveDiff()` ran `git diff HEAD`, and
`autoCommit()` (src/agent.ts) had already committed the agent's own work during the run — HEAD had
moved forward to include it, so the diff against "HEAD" showed almost nothing (the implementation
was already baked into the current HEAD, not a pending change against it). **The judge's analysis
was correct given the input it was fed — this was a data-pipeline bug in my own eval script, not
an Argo behavior bug.** Fixed: `saveDiff()` now takes the task's own baseline ref (the same one
`resetWs()` restores to) instead of bare `HEAD`. Re-judged with the corrected diff:
`goal_completeness: 10/10`.

### Finding 4 — Boss over-verifies at OTHER checkpoints too, not just task-start
The corrected judge pass still flagged `orchestration_sane: false`: BOTH the task-start Boss frame
AND the separate FINAL-checkpoint Boss frame hit their iteration caps without emitting a clean
conclusion line (the run still succeeded — `parseBossVerdict`'s fail-open default is NONE when
unparseable — but real iterations were wasted on both ends). The task-start-specific "verify once,
then conclude" fix from Finding 1 only lived in the task-start assignment text, not the shared Boss
system prompt every checkpoint uses — so standup/final never got that guidance at all.
**Fix applied** (`src/frames.ts`, shared `ROLE_SYSTEM_SUFFIX.boss`): added the same "verify each
claim ONCE, then conclude for THIS checkpoint — every checkpoint has its own small budget for
verifying, not looping" instruction to the prompt ALL Boss checkpoints share, not just task-start.
Rebuilding + re-running `bigproj-deps` to confirm before moving to `bigproj-effort`.
**Confirmed run 2** (after Finding 4's fix): 1/1 pass, it=89/frames=7/**wall=1147s (19 min)** — a
genuinely large run this time, `plan=5` (real replanning activity). Judge: `goal_completeness:
10/10` again (6 dependency methods, cycle detection via DFS, deterministic topo sort — fully
correct), but flagged fresh orchestration waste: **the Boss task-start (10-iter cap) AND the
Planner (15-iter cap) both hit their ceilings without producing a usable output** — task-start
never emitted a classification line, Planner never emitted a task graph. The fail-open defaults
saved the run both times (task-start falls back to `userMessage` as the objective; an unparseable
plan falls back to one single-step graph) and one large Implementer frame (49 of its own
iterations) carried the whole objective to a correct, complete result — but this means real
Planner DECOMPOSITION never happened on the one task built specifically to need it.

### Finding 5 — Planner's 15-iteration budget can't converge on a real multi-file codebase
Direct continuation of Finding 4. `ROLE_MAX_ITERATIONS.planner` raised 15→20 (`src/frames.ts`) —
15 wasn't enough room to read even bigproj's 11-file `src/` and produce a task graph JSON.
Also added to the Boss task-start prompt (`src/dispatch.ts`): explicit instruction to read only
enough to CLASSIFY, not to fully understand the codebase — stop and classify OBJECTIVE the moment
real complexity is noticed, since Tiphys has the longer budget for deep reading and the Boss
spending its own short budget on that first only shrinks the room left to classify at all.
Rebuilt; re-running `bigproj-deps` a third time to see whether the Planner now actually produces a
real decomposed graph instead of timing out.

### Finding 6 — SEVERE: Boss's bash-only self-attempt did a full-file rewrite, broke a public API
`bigproj-deps` run 3 (after Finding 5's fixes): **FAILED** (0/1), it=120, wall=771s. Worth
recording precisely because it's the most serious failure of the night. Traced through the full
ledger episode-by-episode (my own first read of the summary truncated too aggressively and briefly
mis-suggested a routing bug in `runBossTaskStart` — re-verified against the untruncated delegation
prompt and confirmed the mode logic itself is correct: this was `preempted-incomplete` exactly as
designed, not a bug in the router).
**What happened**: Boss task-start read 4 files, then — after only ~5 iterations, well within
budget — decided the 6-method dependency feature was TRIVIAL and self-attempted it via `cat >
src/service.js << EOF` (a full heredoc file rewrite: the Boss's ONLY tool is `bash`, it has no
`edit_file`, so a full rewrite is its *only* way to change a file at all). It ran out of its
10-iteration budget before verifying, triggering `preempted-incomplete` correctly — but the
rewrite itself had already reinvented the entire `TaskService` class from scratch (namespace
imports, a changed constructor signature `(store, idGen, clock)` -> `(idGen)`, hallucinated
internals for methods that already existed and worked), silently breaking every other file that
constructs `TaskService` the old way. The Implementer inherited this broken state, spent its own
full 60-iteration budget trying to reconcile/extend it, and the run ultimately failed the check.
**Root cause**: the Boss's only editing tool being `bash` makes "TRIVIAL" self-attempts inherently
risky for anything beyond a truly tiny change — there is no scoped, precise equivalent of
`edit_file`, so any self-attempt beyond one line risks becoming an unreviewed full-file rewrite.
The existing prompt guidance ("if you're not confident it's this small, classify SIMPLE instead")
didn't stop the model from misjudging a 6-method feature as trivial — another instance of this
project's own repeated lesson: a prompt alone doesn't reliably bound behavior a capable model can
choose to ignore.
**Fix applied** (`src/dispatch.ts`): a new harness-level size check, `gitDiffLineCount()` (parses
`git diff --shortstat`) — a self-attempt whose diff exceeds `TRIVIAL_DIFF_LINE_LIMIT` (15 changed
lines) is now treated as `preempted-incomplete` REGARDLESS of whether the Boss claims it finished
or hit its cap; a large diff is itself evidence "this wasn't actually trivial," same standing as
running out of budget. Also strengthened the `preempted-incomplete` handoff prompt to the
Implementer: explicitly examine whether the prior attempt is a careful minimal change or an
unwarranted rewrite, and REVERT it (`git checkout -- <file>`) rather than build on top of a hasty
rewrite if it looks wrong.
Rebuilding + re-running `bigproj-deps` a fourth time to confirm.
**Confirmed run 4**: **1/1 PASS** (up from FAIL) — it=174, frames=9, wall=1616s (**27 min** — now
genuinely in the "many minutes, approaching 30" territory the night's plan set out to reach), and
this is the FIRST run all night to trigger real compaction (`cmp=2`) and heavy replanning
(`plan=13`). Judge: `goal_completeness: 7/10` — the diff-size guard prevented the worst outcome
(the destructive full-rewrite/broken-API failure from run 3 did not recur) but flagged residual,
lower-severity issues: the Implementer still did some unrequested refactoring beyond the stated
objective (`_require` helper removed, `update`/`transition` touched) even though tests still pass;
multiple frames (Boss task-start, Planner, even the 60-iteration Implementer) still hit their
iteration caps before concluding cleanly; two separate Tester rounds produced CONTRADICTORY
verification claims at different points, consistent with real thrashing under genuine task
difficulty (13 replan events is a lot).
**Decision**: per the plan's own discipline ("stop once clearly correct, or after two fix attempts
without further improvement") — this is the 3rd distinct fix on this one task (Findings 4/5/6),
each run costs 15-27 minutes of GPU time, and the trajectory is FAIL->FAIL->PASS with genuinely
improving severity each time. Stopping here on `bigproj-deps` specifically; logging the residual
scope-creep/replan-thrash pattern as an OPEN finding (not re-fixed tonight) and moving to
`bigproj-effort` next, then a regression check, to protect the remaining time budget for the
comparative battery and write-up.

### Open finding (not fixed tonight) — residual scope creep + replan thrash under genuine difficulty
Even after Findings 4-6, a genuinely hard task can still: (a) have the Implementer refactor code
beyond what was asked (tests still pass, but the diff is noisier than necessary), (b) cycle through
several replans with contradictory intermediate Tester verdicts before converging. The system
recovers and still lands a correct, passing result, but not efficiently. A real next step (not
attempted tonight, time-boxed out): a stronger "stay in scope" instruction for Implementer/Tester
specifically, and/or investigating whether the replan trigger itself is firing on transient,
self-correcting Tester disagreement rather than genuine failure.

### Finding 7 — THE central question: Planner has NEVER converged on a real task graph
`bigproj-effort` (second large task): 1/1 PASS on the first attempt, it=96, wall=812s (13.5 min),
`goal_completeness: 10/10` (correct 4-file effort-estimate feature, clean validation/defaults).
BUT the SAME orchestration pattern as every large run tonight: **the Planner hit its (now 20-iter)
budget without ever producing a task graph.** This is now 3-for-3 across every genuinely large
task run tonight (`bigproj-deps` x2 after the fix, `bigproj-effort`) — the Planner has not once
successfully decomposed a real objective into a multi-step graph. Every single large task has
actually been solved by the FAIL-OPEN DEFAULT (one big Implementer frame gets the whole objective
as a single step) — this is the harness's safety net doing 100% of the real work, not Tiphys's
intended decomposition. **This is the central question the whole night was built to answer, and
the honest answer so far is: no evidence yet that Planner decomposition happens at all in
practice, let alone that it helps.**
Traced why: the Planner's episode trace for `bigproj-effort` shows only 5 `read_file` calls across
its full 20-iteration budget — the other 15 iterations were text-only (no tool call), meaning it
was deliberating/drafting in its response text without ever emitting a final, complete JSON code
block. Found a real, separate bug in this same path: the generic stall-checkpoint (agent.ts) was
telling a stalled Planner to "call update_plan now" — but `update_plan` is the BASELINE/Implementer
task-ledger tool, unrelated to the Planner's actual job (emit a JSON graph as its own final text
answer) — the Planner has that tool in its allowed set but no `write_file` to act on a plan it
would produce via it, so this advice was actively confusing, not helpful, likely worsening the
stall it was meant to fix.
**Fix applied** (`src/agent.ts`): `hasUpdatePlan` (the branch selecting stall-message wording) now
requires `write_file` in `allowedTools` too, not just `update_plan`'s bare presence — this
correctly excludes Planner (has `update_plan`, not `write_file`) so a stalled Planner now gets the
generic "conclude with your verdict/answer" wording instead of nonsensical tool-calling advice.
Rebuilt; re-running `bigproj-effort` (the faster of the two large tasks) to see whether the Planner
now actually converges on a real graph.

### Finding 1 — Boss over-verifies its own TRIVIAL attempt instead of concluding
`bigproj-duedate-bug` (medium tier, first run): passed (22 it, 171s), but task-start log showed
the FULL guard stack firing correctly and still not stopping the pattern — PROGRESS CHECK@4,
exact-match loop-steer (identical `read_file`), near-duplicate guard (3x `bash`), PROGRESS CHECK@7,
STALL@9 ("conclude NOW"), then ANOTHER exact-match repeat on `bash` right after the STALL message,
before finally exhausting its 10-iteration budget without ever emitting a clean TRIVIAL/SIMPLE
line. The downstream Implementer (spawned via `preempted-incomplete`) found "the fix is ALREADY
correct" — meaning Boss's own fix, made early, was right the whole time; it just kept re-running
the test to double-check rather than concluding. All the STRUCTURAL guards (budget cap, stall
checkpoints, loop steer, near-duplicate guard) fired exactly as designed — this is a BEHAVIORAL
gap (over-verification), not a missing mechanism.
**Fix applied** (`src/dispatch.ts`, task-start prompt): added explicit instruction — verify a
self-attempted fix ONCE, then conclude immediately; repeated re-verification wastes the budget
that makes self-attempts safe in the first place, and Tester re-checks independently right after
anyway.
**Confirmed**: re-ran `bigproj-duedate-bug` — it=22→**11**, wall=171s→**52s**, task-start frame now
concludes cleanly by iteration ~5 instead of exhausting its whole 10-iteration budget.
**Regression-checked**: re-ran the full 11-task eval-suite2 battery — still 11/11 pass, total
666s (within the same noisy 592-999s band already observed across n=1 runs, no new failures or
qualitative red flags). Phase 2 and 3 done.

Also added (infra, not a behavior change): `saveDiff()` in `scripts/eval-e2e.mjs` captures each
task's final `git diff HEAD` to `~/.local/share/argo/eval-diffs/<taskId>.diff` before the
post-task reset wipes it (same problem `saveLedger()` already solved for the ledger) — needed by
the new `scripts/eval-quality-judge.mjs` (qwen3.6 self-critique over the ledger digest + diff,
reusing `src/critic.ts`'s validated pattern) written for Phase 5. Not yet run end-to-end — the
regression battery above was already in flight (old in-memory script) when this was added, so it
has no saved diffs; will get exercised for real on the first Phase 5 large-tier run below.
