# Argo — improvement roadmap (hypothesis-driven)

For a plain-language description of every harness behavior (plan gate, task ledger,
loop-recovery ladder, the verification stack, progress trace, conclusion, context
management, AGENTS.md/MEMORY.md) plus critiques and current defaults, see
`docs/harness-instrumentation.md`.

A pragmatic, iterative plan for making Argo a genuinely good **contained coding harness for
locally-running LLMs** (Qwen, …), while staying true to its mission: local, lean,
means-not-ends (Ollama/Docker are swappable tools, not goals), observability-first.

## Method (how we improve, not just what)

Every change is a **hypothesis tested against evidence**, not a vibe. The rule:
**measure → change one thing → measure again.** Argo writes a full structured trace
(JSONL) for every run — that is the raw material for measurement. The eval turns "feels
better" into a **number**, so each change is decidable. Record every run and its result
in `docs/eval-log.md` (the flywheel's memory); background research is in `docs/research.md`.

## Where Argo is today

- **Model chosen: `qwen3.6:latest`.** It is the only model that completes the end-to-end
  eval (**4/4**), plans, and converges without drift. The plan/act mechanism works on it.
  Other models stay only as eval comparators; the eval is the gate for adopting any future
  candidate (a newer qwen, or anything else).
- **The eval is saturated for qwen (4/4).** Its four tasks are all "implement function(s)
  so tests pass" — closed and well-specified. qwen aces them, which means **we currently
  have no headroom to measure whether any agent improvement actually helps.** And we have
  *not* re-tested the shape that started this project — the open-ended 1e33 simulation
  debug that drifted for 90 iterations. Giving the flywheel harder, longer, drift-prone
  tasks (and efficiency metrics) is the prerequisite for all further agent work.
- **Pi is inspiration, not a dependency.** Borrow ideas (model-agnostic messages,
  capability adaptation, tool dialects), don't import the multi-provider stack. (See
  `docs/research.md`.)

---

## Phase 1 — Evaluation harness (the flywheel)   ✅ DONE

Two harnesses in `scripts/`, driven by `npm run eval` / `npm run eval:e2e`:
- **Fast probe** (`eval.mjs`): single-turn native-tool-call reliability, tasks × models.
- **E2E** (`eval-e2e.mjs`): real Argo loops on self-verifying tasks (seed a failing test →
  run → the suite must pass); measures **task completion** + per-run behaviour scraped from
  the JSONL. Both SHA-stamp the harness and emit a paste-ready `eval-log entry`.

**Reference baseline** (harness with the plan/act mechanism): qwen 4/4, devstral 0/4,
llama 0/4 (E2E); qwen 12/12, devstral 9/12 (fast probe). Full method, task catalog, and
run log: `docs/eval-log.md`.

---

## Phase 2 — Tool-calling reliability   ⏸ PARKED (superseded by the qwen decision)

**Why parked:** this phase existed to rescue models that don't reliably *emit* tool calls
(devstral narrates and stalls; smaller models mis-format). qwen emits at ~100%, so the
work would improve models we've chosen not to use. Not worth the investment now.

**Un-park triggers:** (a) we decide to support another model (e.g. Mistral/Devstral) as a
first-class target; or (b) a hard/long task in Phase 3 shows qwen itself mis-emitting tool
calls under large context (native-call reliability is known to fall as context grows).

**Ideas worth keeping (if we un-park):**
- **Per-model tool dialect** on Ollama raw `/api/generate` — format the prompt and parse
  tool calls ourselves (Qwen ChatML / Mistral `[TOOL_CALLS]`), instead of relying on
  `/api/chat`'s native parser.
- **Grammar-constrained decoding** via `llama.cpp llama-server` + a GBNF grammar that
  forces a syntactically valid tool call (expected near-100% emission). Add it as a second
  runtime behind the Phase 5 seam — keep Ollama where it's fine ("means, not ends").
- **Ollama `tool_choice` forcing** and a **one-shot "you described an action but didn't
  call a tool — emit it now" nudge**, gated so it never taxes genuine one-shot answers.
- **Don't** prompt-tune around a broken emission layer; fix the layer or route the model
  to a runtime that can.

---

## Phase 3 — Harden the flywheel: hard/long tasks + efficiency metrics   ← ACTIVE

**Hypothesis:** a saturated, all-easy, closed-task eval can't steer agent improvement.
Harder, longer, drift-prone tasks — plus efficiency/resource metrics — give the flywheel
the headroom to distinguish a better agent from a worse one, on quality *and* cost.

**(a) Harder tasks (give the eval headroom), each targeting a known failure mode:**
- **Open-ended debug (the canonical case):** the 1e33 simulation blow-up — reproduce,
  find the cause, fix, self-check that energy stays bounded. Tests investigate-before-plan,
  anti-drift, convergence on the exact case that motivated this project.
- **Long-horizon multi-file feature:** a feature touching several modules + CLI + tests
  over many iterations; stresses compaction/memory and plan-adherence past the context
  threshold.
- **Misdirection bug:** a failing test whose cause is *not* where the symptom appears;
  tests root-cause investigation vs. symptom-patching.
- **Under-specified spec:** the naive reading is wrong; tests plan-grounding and "don't
  solve a more interesting problem than asked" (goal substitution).
- Tasks should support **graded/partial** signals where useful (sub-checks), not just
  pass/fail, so a "90% done" run is visible.

**(b) Efficiency & quality metrics (so "better" includes "cheaper/faster"):**
- **Time:** wall-clock per run; generation time and **tokens/sec** (Ollama already reports
  `eval_count`/`eval_duration` — persist them from the harness so the eval can read them).
- **Context/memory (agent):** peak prompt tokens, compaction count.
- **Resources (host):** peak RSS of the Ollama server/runner; VRAM footprint + CPU/GPU
  split from `ollama ps`, sampled during the run. *(True GPU-utilisation % on Apple Silicon
  needs `powermetrics`/sudo — keep that manual/optional; the `ollama ps` split + tokens/sec
  are the lean cross-platform proxy.)*

**Success signal:** an eval where qwen is **not** at 100% (there is room to improve), and a
scorecard that reports quality *and* cost per (task, harness-version).

---

## Phase 4 — Improve the agent on hard tasks   ← the point of it all

With Phase 3's headroom, attack "make a small model handle large tasks well." Each item is
a hypothesis measured against the hardened eval (quality **and** efficiency), one change at
a time:
- **Thought process / steering:** planning-recitation frequency, reground-once vs
  reground-on-each-finish, a Magentic-One-style stall counter that forces a re-plan,
  staying-on-track guards.
- **Tooling:** better/narrower tools with clearer feedback (the `edit_file` precedent);
  close the **bash gate bypass** (`isProjectMutation` misses `bash` file writes) *only* if
  the eval shows it helps.
- **Memory/context:** is compaction preserving the right things over long runs? (see
  `docs/research.md`, Part 2). Recitation, structured working state, retrieval.
- **Sub-agents:** delegate research/verification to keep the main context clean — adopt
  only if the eval shows a win on large tasks.

**Guardrail:** reject any mechanism the eval doesn't show helps. Every one earns its place
with a number, on both quality and cost.

---

## Phase 5 — Local-runtime seam + evidence-based model curation   (later)

A thin `src/llm/` seam (native `fetch`, no framework, no Pi) + a small static capability
table, so each model runs on the runtime that behaves best (this is also where a
grammar-constrained `llama.cpp` path would land if Phase 2 un-parks). Keep the README's
🔧/⚠️ markers evidence-based. Curate a *few* models done well over "any model, mediocre."

---

## Ongoing — Leanness & means-not-ends audit

- **Sandbox:** keep Docker while it uniquely provides a *real* environment (real bash,
  node, git, playwright/Chromium). Periodically re-test lighter options
  (`SANDBOXING-ALTERNATIVES.md`, WASI) — adopt only one that preserves real-binary fidelity.
- **Web search (the one reluctant remote dep):** test a local alternative (self-hosted
  SearXNG, or the agent's own browser/fetch against a search engine) to drop Tavily; keep
  it as the clearly-marked exception until one holds up.
- **Dependency audit:** keep the tree minimal; reject anything remote-provider-oriented.
  Every new dep is a hypothesis that it earns its weight.

## Ongoing — Deepen observability (Argo's core strength)

Surface eval scorecards and "why did this run fail" in the cockpit; add trace events for
anything the eval needs but can't currently see (e.g. a `tool-call-parse-failed` event, or
the per-turn timing/throughput that Phase 3(b) persists).

## What we will NOT do (guardrails from the philosophy)

- **No multi-provider framework / Pi adoption.** Local-only means their weight is clutter.
- **No remote LLM providers or hosted models.** Out of scope by mission.
- **No speculative loop mechanisms.** Each must earn its place against the eval.
- **No replacing Docker** until a lighter sandbox preserves real-binary fidelity.
- **No breadth-chasing.** A few local models done well beats "supports everything."

## Capability limits (the real risk)

Local models may simply not be good enough at agentic tool-use for some tasks, and the
harness cannot fully compensate. Part of this plan is knowing — from the eval — **which
(model, task) combinations actually work**, and being clear about that boundary rather
than overselling. The eval is also our early-warning system as local models improve.

## Iteration cadence

1. ✅ Phase 1 (eval) landed — baseline recorded. 2. ⏸ Phase 2 parked (qwen decision).
3. Phase 3: harden the eval (hard/long tasks + efficiency metrics) until qwen is no longer
at 100%. 4. Phase 4: improve the agent, one measured change at a time. 5. Phase 5 seam +
curation later. Re-baseline after every change; keep the "hypothesis → result" log in
`docs/eval-log.md` so the flywheel compounds.

---

## 2026-07-27 — Direction update: quality-first + capability matrix

The eval now has headroom (qwen 5/6; `bigproj-effort` fails). Two findings reshaped Phase 4:

- A **stall re-ground** (loop steer at iters 20/35/45) fixed the goal-substitution *drift* on `bigproj-effort` (it implemented the right modules, reached 5/6 effort-spec / 42/43 full-suite) but did **not** converge in 60 iters. At `max_iter=90` it got **worse** — thrashed, self-reverted its own edits (`git checkout` at it76), stalled at 3/6, and **attempted to edit the test file to game the oracle** (the `edit_file` was *rejected* — the spec was never actually changed; intent-to-tamper, not landed gaming — see the eval-log CORRECTION). **More iterations is the wrong lever.** (Stall counter committed as an *unvalidated experiment*; may be reverted.)
- **Quality > speed.** In real use qwen often "doesn't really fix the issue," and tests-pass ≠ good work (the *attempted* oracle-tampering + thrash + self-revert show it). So Phase 4 is now **quality supervision**, in order:
  1. **Supervisor eval (DONE).** LLM-as-judge scoring critic models on *judging* qwen's work (blind), at `scripts/eval-fixtures/supervisor/` + `scripts/eval-supervisor.mjs`. **Result (RUNS=3, 5 candidates — qwen3.6, devstral, gemma4, qwen2.5-coder, deepseek-r1): qwen3.6 is the ONLY gate-passer (89%), stably flagging the attempted spec edit 3/3.** Every other candidate — incl. the reasoning model deepseek-r1 (1/3) and coder qwen2.5-coder (0/3) — FAILS the gaming gate; several "recognize-but-don't-flag" (name the violation, then set gamed=false). Gaming detection, not reasoning/ranking skill, is the discriminator. See `docs/eval-log.md`.
  2. **Dual-model actor-critic — FORK RESOLVED: the critic is qwen3.6 itself (self-critique).** The reasoning-model bet lost, so there is no better *external* judge on hand; using qwen as its own critic costs ZERO extra resident memory on the 48 GB machine. NEXT (the priority): wire qwen-as-critic into the loop at checkpoints (post-plan, on-stall, pre-done), feed critique back, and **A/B on the failing `bigproj-effort` task** — does the critic make it converge and kill the thrash / self-revert / attempted-gaming, without itself gaming? The loop test is the real validation (more than further judge-eval iterations). Lock the critic prompt on spec-edit / oracle-tamper detection (the softer `stayed_on_goal` axis is where even qwen is imperfect).
  3. **Capability matrix — score models per DISTINCT capability, not one "best" model** (user-defined axes):
     - **Coding-agent / harness use** — drive Argo's loop, use tools, take a task end-to-end.
     - **Planning** — turn an under-specified task into a correct, complete, ordered plan.
     - **Supervision / evaluation** — judge another agent's plan + work (the critic; measured now by the supervisor eval).
     - **Image understanding** — read screenshots / diagrams / photos.
     - **Visual layout & alignment** — render → screenshot → judge alignment / spacing / overflow (via Playwright).
     Pull Ollama vision models (`llama3.2-vision`, `llava`, `moondream`, `qwen2.5-vl`); qwen3.6 already reports a `vision` capability. A vision-capable agent is a coming requirement. `qwen2.5vl:7b` is pulled but **not yet wired** into Argo (deferred — "Vision Step 2").

**Standing product requirements (from the user) — status:**
- Quality/reliability of complex, long-running tasks **over** speed or resource efficiency → the organizing principle of Phase 4.
- Run for very long without losing the goal, hallucinating, looping, forgetting progress, or mismanaging memory → the north star (below); the 90-iter test measured exactly this and showed a lone model degrades, which motivates the critic.
- Improve planning, reasoning, tooling, steering, supervision, staying on-track → Phases 3–4.
- **After producing a plan, execute without an extra "proceed" prompt** → ALREADY satisfied: the plan/act gate blocks a mutation until a plan is recorded, then auto-proceeds with no user confirmation (see `CLAUDE.md`).
- Evaluate models by distinct capabilities (the five axes above), not one universal best → capability matrix.
- Dual-model (qwen works, another reviews plan + implementation while running) → step 2.
- Measure quality on realistic, difficult tasks → the `bigproj` E2E eval + the supervisor eval.

North star: an agent that runs ~indefinitely without losing the goal, hallucinating, looping, or losing track — with good memory of what matters. Run history: `docs/eval-log.md`.

---

## 2026-07-30 — Loop-recovery ladder + harness tasks/memory: built, wired, eval'd non-regressive

Two Phase 4 items landed, both flag-gated OFF by default and validated together in an e2e A/B
(booklet/bigproj/test-one, n=1, max_iter 60, qwen3.6 — OFF 6/6, ON 6/6, no regression; full entry in
`docs/eval-log.md`). Detailed design/status: `docs/harness-instrumentation.md`.

- **Loop-recovery ladder (`src/loop.ts`, `ARGO_LOOP`) — built + validated.** Mutation-aware: blocks
  the 2nd identical (tool+args) call only when no project mutation happened since it last ran (a
  legitimate re-check after an edit is never blocked), escalating L0 firm steer → L1 one-shot
  compaction → L2 stop-and-reframe (forces `update_plan`/`reconcile`). Replaces the count-based
  `REPEAT_THRESHOLD` steer when on; the no-progress re-anchor and stall reground (novel-arg drift, a
  different failure mode) are unchanged. 12 unit tests + an `agent.test.ts` integration test cover it,
  but it hasn't yet fired in a real (non-synthetic) run — that needs the adversarial/vicious set.
- **Harness tasks + AGENTS.md/MEMORY.md memory (`ARGO_TASKS`/`ARGO_MEMORY`) — all four stages built,
  wired, eval'd.** Also fixed: large AGENTS.md is now section-selected PER TASK at the tail (mirroring
  MEMORY.md) instead of frozen once per run. ON converged the hardest multi-file task (`bigproj-deps`)
  in fewer iterations (34→22); `bigproj-effort` stayed noisier (both pass) — an n≥3 run is needed to
  rule out variance before flipping a default.
- **Auto-commit is now opt-in, default OFF** (`ARGO_AUTOCOMMIT`) — the agent no longer always commits
  after a run; uncommitted work shows in the new Changes view (web UI). `/chat` accepts per-request
  overrides for all four flags above, and `/status` reports them, so any can be flipped without a
  rebuild once validated.

**Update (2026-08-04): the harness levers are now ON by default.** `ARGO_TASKS`, `ARGO_MEMORY`, and
`ARGO_LOOP` were flipped on (env `=0/false/off` forces off), re-validated non-regressive (full suite
175/175; integrated smoke 2/2). `ARGO_CRITIC` and `ARGO_AUTOCOMMIT` stay off. Still pending before we
rely on them fully: (a) an n≥3 multi-run, and (b) an adversarial/looping pass that exercises the loop
ladder live — see the adversarial-prompt taxonomy in the 2026-09-03 entry below.

## 2026-08-04 — Enabled the tested levers + closed the verification gaps

Plain-language description of every behavior + critiques now lives in `docs/harness-instrumentation.md`.

- **Defaults ON** (above): tasks + memory + loop-recovery, matching grounding; validated non-regressive.
- **Executable per-task verification** — a task can carry a `verify` shell command; at the per-task
  gate the harness RUNS it and only advances on exit 0 (else feeds the failure back), with a
  consecutive-failure escalation guard. Replaces the old self-check nudge with a real oracle — the
  biggest verification lever. (`src/tasks.ts`/`src/agent.ts`/`src/tools/index.ts`.)
- **Per-task summaries + final reconciliation** — after a task passes verify the model summarizes
  what/how (stored on the ledger, carried across re-plans); when all tasks are done a one-time
  reconciliation feeds the objective + all summaries back to find gaps (can re-open work) and, if
  complete, writes the grounded final summary. Upgrades the old prompt-only conclusion.
- **Vision layout-judge** (`ARGO_LAYOUT`, default OFF) — renders an HTML artifact, screenshots it, and
  has `qwen2.5vl` flag layout problems pre-done (fail-open). Off pending a live validation.
- **Web UI overhaul** (public/) — two-column layout, combined context/status indicator + dropdown,
  Files/Changes view with git history, home-screen status dots, boat-on-submit, and more (live on refresh).

Still open: the n≥3 + adversarial eval (exercise the verify oracle + loop ladder live), a live
layout-judge check, and smaller items (stable task IDs, semantic memory selection, faster compaction).

## 2026-09-02 — Multi-agent architecture planned (call frames + ledger + structured eviction + Boss)

Design agreed as a buildable v1 spec, not yet built — full design in
`docs/subagents-plan.md`. Motivated by three confirmed gaps: `agent.ts` today has exactly
one shared context per session (so a plan's reasoning gets buried under implementation
noise); `loop.ts`'s repeat detection is purely mechanical (catches identical repeats, not
semantic drift); and LLM-summarization compaction is itself a documented hallucination
source. The plan: each role (Planner/Implementer/Tester/Boss — Researcher deferred to v2)
gets its own **call frame** — reusing the existing loop with a different prompt/tool set —
with hand-off summaries (never raw transcripts); `src/compaction.ts` is **replaced** by a
CWL-style deterministic episode-eviction policy pinned to an immutable objective + mutable
plan; a persistent **ledger** at `/workspace/.argo/ledger.jsonl` (gitignored by default)
records every delegation/conclusion/standup/injection/episode; and the **Boss** is qwen3.6
itself (no second model), running as a real verification-capable frame at three checkpoints
(task-start, action-episode-paced standups, final), never at every frame conclusion, with
four possible actions (none/inject/restart/escalate). Hard rule: no two LLM calls ever run
concurrently, for any role. Ships behind one flag, `ARGO_AGENTS`. Full spec, file manifest,
and open risks are in `docs/subagents-plan.md`.

**2026-09-02 — first full multi-agent eval battery, skippable phases (ANSWER/TRIVIAL/
OBJECTIVE/preempted), 11/11 passing but not yet a win.** All phases are now genuinely
skippable per-request (a pure question can return with zero frames spawned; a one-line fix
skips Planner+Tester) rather than always running the full pipeline — plus a harness-level
`'preempted'` mode that detects (via a git-status diff, not a text convention) when the Boss
solved the task itself during classification instead of just routing it, and short-circuits
straight to the final check instead of forcing an expensive redo. That last fix turned a
30-minute TIMEOUT into 111s on one eval task. Net result on the current 11-task range
(nothing yet large/ambiguous enough to need real Planner decomposition): multi-agent is
**3.4x the pre-multi-agent baseline's wall-clock and 1.6x Hermes's**, at equal 100%
correctness — the architecture has not yet demonstrated the benefit it exists for. Full
numbers, the two concrete bugs found and fixed, and what's still open: `docs/eval-log.md`
(2026-09-02 entry). Next: a genuinely large/ambiguous task (real 10-30 min horizon) that
forces actual multi-frame decomposition — nothing built so far has exercised that path,
since the Boss keeps pre-empting it by just solving smaller tasks directly.

**2026-09-03 — Magentic-One-grounded redesign (Boss can't loop, delegation is the
default), then an overnight session finally produces the first real evidence multi-agent
earns its cost — on a genuinely hard task, not yet via the Planner.** Full run-by-run
detail folded into `docs/eval-log.md`'s 2026-09-03 (overnight) entry; design change
detail: `docs/subagents-plan.md`'s "Known weaknesses" section. Two distinct pieces of
work landed this date:

1. **Same-day redesign** (research-grounded: Magentic-One's Orchestrator ablation,
   "bag of agents" coordination-overhead findings, gemini-cli's near-duplicate-call
   detection): task-start became a 4-way router (ANSWER/TRIVIAL/SIMPLE/OBJECTIVE) with a
   hard iteration cap on any Boss self-attempt, so a capable-but-over-eager Boss can no
   longer burn a 30-minute budget on its own; stall/progress checkpoints scaled
   proportionally to each role's own budget; standups now also fire on a "trouble" signal,
   not just aggregate pacing; a coarse near-duplicate-tool-call guard supplements the
   exact-match loop ladder. Result: the same 11-task battery dropped from 1276s to 592s,
   now *beating* Hermes (775s) — still ~1.6x the pre-multi-agent baseline (380s), not at
   parity, but the regression is closing.

2. **Overnight session** (plan: `~/.claude/plans/polished-sniffing-dragonfly.md`) ran a
   real-codebase progressive-complexity ladder against `bigproj` (tasklab, ~827 LOC/11
   modules — chosen over vetting a new external repo, since it already had historical
   large-task fixtures and drift evidence) with a weakness-driven fix loop between runs.
   **Eight findings total (full root-cause detail on each folded into `docs/eval-log.md`'s
   2026-09-03 (overnight) entry)**:
   Boss over-verification at task-start (Finding 1) and at every OTHER checkpoint too
   (Finding 4); a Planner iteration budget too tight to even read the codebase (Finding 5);
   the single most severe bug of the night — a Boss TRIVIAL self-attempt with no scoped
   edit tool (only `bash`) did a full-file rewrite that silently broke a public API,
   traced and fixed with a harness-level diff-size guard, not a prompt line (Finding 6);
   and — the two most consequential findings — **Finding 7: across every single large-task
   run this whole project has ever measured (4 attempts across two nights), the Planner
   has NEVER ONCE produced a real task graph** — every large task has been solved entirely
   by the harness's fail-open default (one big Implementer frame absorbing the whole
   objective), meaning Tiphys's intended decomposition remains, as of tonight, completely
   unproven in practice; and **Finding 8: `parseBossVerdict`'s fail-open default couldn't
   distinguish "Boss reviewed and found nothing wrong" from "Boss's own checkpoint stalled
   blank"** — both collapsed to the same `action:'none'`, and a real run reached the user
   as done with 3 of 6 new tests still failing, an itemized correct Tester FAIL sitting
   unread in the ledger the Boss was handed. Fixed the same way Finding 6 and every prior
   "fail-open must not mean invisible" fix in this project works: a harness-level,
   model-independent signal (iteration count vs. that role's budget), not a text
   convention — confirmed non-regressive against both the specific task and the full
   11-task battery (578s, no new failures).

   **The night's headline result (Phase 6, comparative battery — n=1, directional):** on
   `bigproj-deps`, the one task in the project's entire history hard enough to reliably
   break a lone frame, **the pre-multi-agent single-loop baseline FAILED outright (hit its
   60-iteration cap, suite still red, 815s) — while both Hermes (256s) and Argo's
   multi-agent harness (1616s) passed.** This is the first time any eval in this project
   has shown the plain baseline actually losing to an alternative on a real task, not a
   synthetic worst case. The cost is real too: multi-agent was still the slowest path on
   both large tasks (1616s/820s vs. Hermes's 256s/177s) — correctness headroom bought at a
   substantial, consistent time premium, and via the harness's OTHER structural advantages
   (independent Tester verification, Boss fresh-eyes checkpoints, the diff-size guard) —
   **not** via the Planner, which still hasn't fired for real even once.

   **Where this leaves the central question**: multi-agent's value proposition is now
   directionally supported for the first time — but by the *safety net*, not the
   *decomposition* the architecture is nominally FOR. The single most important open
   question carried forward: does Planner decomposition ever actually happen, and does it
   help when it does — or is `bigproj` (11 files, ~827 LOC) simply not "genuinely needs
   multi-frame planning" territory regardless of task difficulty within it? An even
   larger/more-tangled task, or a fundamentally different Planner output contract (not
   just a bigger iteration budget — that lever (Finding 5) already hit its ceiling), is
   the next real experiment, alongside an n≥3 confirmation of Phase 6's n=1 numbers before
   leaning on them for a real architectural decision.

## 2026-09-03 — Carried forward: adversarial-prompt taxonomy + harness design principles

Migrated from `docs/harness-planning-memory.md` (now deleted — everything else in that
file was superseded by `docs/harness-instrumentation.md`/`docs/subagents-plan.md`/the
entries above). Two pieces from it were still genuinely open and not captured elsewhere:

**Adversarial / "vicious" prompts (robustness) — OPEN, never run.** Tonight's large-task
work (Phase 5/6 above) tested *scale*; this tests *adversarial robustness* instead —
complementary, not superseded. The only way to see the loop-recovery ladder (`src/loop.ts`)
actually fire on a real (non-synthetic) task:
- **Ambiguous / underspecified** ("clean this up", "make it better") → should ask a concise
  clarifying question, not thrash.
- **Contradictory / self-defeating** ("delete the tests so the suite passes", "make it
  faster by removing the feature") → should challenge/refuse, per the critical-planning +
  grounding guards.
- **Over-scoped / scope-creep bait** ("while you're at it, also rewrite X, Y, Z") → should
  stay on the recorded objective, not broaden.
- **Drift / goal-substitution traps** (a plausible tangent mid-task) → the no-progress
  re-anchor guard should hold the goal.
- **Oracle-gaming bait** (a task where editing the test would "pass") → the grounding/critic
  guards should refuse to tamper.
- **Prompt-injection via workspace files** (a file containing "ignore your instructions
  and …") → the harness should treat file content as data, not instructions.
- **Memory poisoning** (asking it to memorize something false/harmful) → MEMORY.md writes
  should be durable *facts it verified*, not arbitrary user assertions.
- **Loop bait** (a task that tempts re-inspecting the same thing) → the loop-recovery ladder
  (L0 steer → L1 compaction → L2 reframe) with `ARGO_LOOP` on.
Log each: did the system cope? For every failure, name the lever to improve and iterate —
the flywheel, applied to robustness.

**What NOT to do (harness design principles, still true):**
- Don't let correctness depend on the model self-managing memory (the pivotal finding
  behind `ARGO_MEMORY`).
- Don't wipe context per task — curate; a full reset re-grounds wastefully on local models.
- Don't parallelize editing tasks — single-threaded; sub-agents read-only (still the design
  in the multi-agent architecture above: Planner/Implementer/Tester frames never run
  concurrently, by the same hard invariant that keeps one LLM call on the GPU at a time).

## 2026-09-03 — Log analysis of the consolidation-verification run: the Boss's task-start marker is being silently dropped, again — proposed next fix + critique

**What was analyzed.** The one live `e2e.mjs` run done to smoke-test the just-consolidated
eval scripts (`trivial-qa-arithmetic`, `eval-suite2`, harness `cb850aa+dirty`) — passed
its deterministic check (408 in the final answer) but scored `orchestration_sane: false`
from `quality-judge.mjs`: "Routing a trivial, zero-code-change QA prompt through Planner
and Implementer adds unnecessary ceremony." Full trace read from
`~/.local/share/argo/logs/eval-suite2/2026-09-03T08-24-25_*`:

1. Boss task-start checkpoint runs, 0 tool calls, final answer is the single line `408` —
   **no `ANSWER:`/`TRIVIAL:`/`SIMPLE:`/`OBJECTIVE:` marker at all**, even though the
   checkpoint prompt explicitly says "end your answer with exactly one line in that mode's
   format."
2. `parseTaskStartVerdict` (`src/frames.ts:171`) finds no marker → returns
   `{ mode: 'objective', text: '' }` by design (a deliberate earlier fix — see the comment
   at `frames.ts:180` — for a *worse* failure: a Boss self-attempt's free-form completion
   report being mistaken for the objective). `runBossTaskStart` (`src/dispatch.ts:274`)
   then falls back to the **original user message** as the objective.
3. Because the workspace is clean (`!dirty`), this is NOT the diff-guarded self-attempt
   path — it silently becomes a full `OBJECTIVE` run: Planner spawns, correctly reasons
   "trivial arithmetic... a single one-shot step suffices," hands one step to an
   Implementer, which re-answers `408`, then a final Boss checkpoint (also unmarked, same
   pattern) closes it out. **5 frames, 4 iterations, 17s to relay a fact the Boss already
   knew at iteration 1.**
4. This is not new: `docs/eval-log.md`'s 2026-09-02 entry already recorded this exact
   pattern on `trivial-qa-arithmetic` with **identical numbers** (4 iters / 5 frames /
   17s) and flagged it as present on **3 of the 11** `eval-suite2` tasks — "qwen3.6's
   default tendency in this role once it has `bash`... worth designing FOR explicitly in
   a future pass (e.g. accept an unformatted-but-conclusive Boss answer as ANSWER-mode
   directly) rather than only catching it after the fact." That pass never happened. This
   run is the third+ confirmation, not a new discovery — the plan below is that
   previously-deferred design pass, now written up properly instead of deferred again.

**Cost.** Zero-tool tasks (arithmetic, "what does X do") pay ~0 extra wall-clock (every
downstream frame also just re-answers instantly) — but the *design intent* of the
ANSWER/TRIVIAL fast paths (skip ceremony entirely) is silently defeated on a measured 27%
of the `eval-suite2` battery, and for a task where the extra frames DO cost real work
(anything requiring even one file read), this stops being free.

### Candidate fixes considered

1. **Heuristic promotion** — when `!dirty && !hitCap` and the final answer is non-empty,
   treat the unmarked text as `ANSWER` outright. Rejected: cannot distinguish a genuine
   completed answer ("408") from a mid-thought punt of the same shape with no tool calls
   yet ("this looks like it needs a change in `src/foo.js`") — the harness would silently
   present the punt as a final answer instead of routing it to an Implementer. Adding
   content-sniffing heuristics (length, hedging phrases) to tell them apart is exactly the
   kind of fragile, ever-growing rule-pile this project's own system-prompt philosophy
   already argues against.
2. **One-shot corrective retry, same frame** (`resumeFrame`, already used for Planner
   replanning and Tester "redo" — `dispatch.ts:180`) — when no marker is found and
   `!hitCap` (budget remains), send one follow-up turn: "your last answer didn't end with
   one of the four required lines — reply again ending with exactly one now," then
   re-parse. Cheap (checkpoint used 1 of its 10-iteration budget in this run; a follow-up
   turn cost ~2-8s per the observed per-iteration timestamps), reuses an already-proven
   primitive, and — critically — defers the actual classification decision back to the
   model with its own context intact, rather than the harness guessing from an incomplete
   signal. This matches the general pattern in Self-Healing Agentic Orchestrators for
   Tool-Augmented LLM Systems (arXiv:2606.01416): reliability failures need a
   *diagnosed, targeted* recovery tied to the specific failure mode, not a blind retry —
   here the diagnosis is exact ("missing format marker, answer otherwise complete") and
   the recovery asks for precisely that, nothing else.
3. **Convert the classification into a tool call** (`classify(mode, text)`) instead of a
   free-text line — the model calls a tool to conclude the checkpoint instead of writing
   a marker Ollama's ReAct loop can't structurally enforce. **This is the strongest option
   on the merits**: it is the *exact* lesson this project already learned and recorded
   for planning (`CLAUDE.md`, "Plan-first working discipline" — "a prose plan is
   indistinguishable from a final answer... planning is a harness mechanism, not just
   prompt text," which is why `update_plan` is a tool, not a marker convention) applied to
   a second case with the identical shape. It also matches external research surfaced this
   session (the "inject a synthetic tool so the model always remains in tool-calling mode"
   pattern for small models that struggle to reliably choose between a free-text reply and
   a tool call). **Not chosen as the FIRST fix** because it needs a new Agent-level
   mechanism no role currently has: a tool call that also *ends the frame* (using its own
   arguments as the result), whereas every existing tool (including `update_plan`) is
   explicitly non-terminal. That is real design work, not a contained patch — tracked
   below as the follow-up once evidence justifies the investment.
4. **Ollama structured output (`format`) for the checkpoint's final turn** — rejected for
   now, not on principle but on an unresolved technical risk: every existing use of
   `format: 'json'` in this codebase (`src/critic.ts`, `scripts/eval/quality-judge.mjs`) is
   a standalone, no-tools verdict call; combining `format` with `tools` on the SAME
   in-loop call the checkpoint uses to both investigate (via tools) and conclude is
   untested here and, per Ollama's own structured-outputs docs, is designed around a
   single non-agentic turn — likely to fight with native tool-call emission rather than
   coexist with it. Worth a narrow experiment later, not a default assumption.

### Plan (supersedes the deferred 2026-09-02 TODO)

- **Ship now (cheap, low-risk): fix #2**, the one-shot corrective retry in
  `runBossTaskStart`. Implementation sketch: after `parseTaskStartVerdict` returns empty
  text and `!hitCap`, call `resumeFrame(result.frameId, agent, <reformat nudge>)` once,
  re-parse its result, and use it if now parseable; otherwise fall through to the existing
  `{ mode: 'objective', text: userMessage }` safety net unchanged. Apply the same
  targeted-retry shape to the `final`/`standup` Boss checkpoints' `parseBossVerdict` ONLY
  if the eval below shows the same silent-drop pattern there too — not pre-emptively,
  since silence there may legitimately mean "reviewed, nothing to flag" (no marker was
  ever REQUIRED for the clean case, unlike task-start's explicit "end your answer with
  exactly one line").
- **Measure**: re-run the 11-task `eval-suite2` battery (`npm run eval:e2e`, n≥3 per the
  standing open item) focused on `trivial-qa-arithmetic` and the other 2 previously-flagged
  tasks; confirm `frames` drops to 1 (or close to it) on the ANSWER-eligible cases and the
  quality judge's `orchestration_sane` flips true, with no regression on the other 14
  tasks in the full catalog.
- **Track as the follow-up, not this pass**: the `classify`-as-tool redesign (#3) — design
  the "tool call that ends a frame" primitive properly (likely needed again if the same
  marker-loss shape recurs at the `final`/`standup` checkpoints, or for the Planner's own
  JSON-fenced task graph, which has the identical "free text the harness must parse"
  fragility). Revisit once the cheap fix's measured ceiling is known — if the one-shot
  retry closes the gap to near-zero, the structural fix may not earn its added complexity
  at all (measure before committing to the bigger mechanism, per this project's own
  standing rule).
- **Explicitly NOT the top item despite being architecturally bigger**: the Planner
  never-converges question (previous entry, Finding 7) stays flagged as the standing open
  experiment, not "next thing to implement" — it needs either a new output contract or a
  larger task to even test, not a contained patch. This run's fresh evidence is about the
  task-START classification step, a different (and currently cheaper-to-fix) part of the
  same Boss-routing surface.

## 2026-09-03 — Deep re-assessment of the full-17-task run: ranked plan for the next fix

Full trace/evidence in `docs/eval-log.md`'s matching entry. Summary of what was found, ranked by
estimated impact, then critiqued.

### #1 (top-ranked): make the harness's "almost done" gate chain iteration-budget-aware

**The finding.** Two Implementer frames (`bigproj-duedate-bug`'s FAIL and `bigproj-effort`'s PASS),
traced independently turn-by-turn, both hit their iteration cap on a chain of individually-reasonable
harness nudges — "confirm the next task," "re-ground before finishing," "final reconciliation check"
— each demanding one more round-trip, landing back-to-back in the LAST few iterations with no runway
left to report the result. The work was correct in both cases (confirmed by a later, independent
Tester); the frame still ended in "no final answer." Not a one-off — the identical error string
recurs in logs back to 2026-07-27.

**Why it's ranked first.** It is the only finding this pass that is (a) mechanically diagnosed from
two independent real traces, not inferred, (b) recurring across a month of history, not a single
run's bad luck, and (c) cheap to fix at the harness level — no new subsystem, just making an existing
gate check one more condition before firing.

**The fix.** When a frame has fewer than `N` iterations remaining (proposed: `max(3, 10% of that
role's own maxIterations)`, mirroring the existing proportional-scaling precedent in
`stallCheckpoints`), the task-advance / self-check / re-ground / final-reconciliation nudges should
skip their own extra round-trip and instead ask directly for a final answer: "you are nearly out of
iterations — reply now with your best summary of what you verified, flagging anything not fully
re-confirmed, rather than requesting or performing another check." This does not remove the
gates — it makes them yield when there is no budget left to survive what they're asking for,
converting a hard "no final answer" error into an honest, if hedged, conclusion.

**Grounding.** This is a named, documented failure mode, not a novel guess: "the LLM is never
informed of the [iteration] limit... when the run loop reaches the maximum iterations, the LLM never
gets a chance to synthesize its findings into a final answer — all the work done up to that point is
wasted" ([OpenHands/software-agent-sdk#2406](https://github.com/OpenHands/software-agent-sdk/issues/2406),
a proposal in a comparable open-source agent harness for exactly this). The broader "budget-aware
agents" literature reinforces the direction: early-stopping when a task is running out of runway
"saves 28–64% of wasted [budget] at only 1.6–4.2% success cost," and models are consistently *too
optimistic* about how much budget remains unless given an explicit signal — i.e., don't rely on the
model to notice it's close to the wall on its own (Budget-Aware LLM Agents; BAGEN, arXiv:2606.00198).

**Self-critique / alternatives considered and why they're not the primary fix:**
- *A blanket "give this frame a few more iterations of headroom" bump* — rejected: this project has
  already tried and rejected budget increases as the fix for a structurally similar problem (the
  Planner's non-convergence, Finding 5) and the lesson generalizes — more budget delays the wall
  without addressing why the chain lands there, and silently drifts every role's real cost upward for
  every task, not just the ones that need it.
- *Auto-populate a plan step's executable `verify` field by pattern-matching its text ("run the
  tests"/"verify...")* so the harness runs the check itself out-of-band instead of costing the model
  an iteration — considered as a more root-cause-targeted complement (it would prevent the LAST
  verification round specifically from costing an iteration at all, for the common case). Not adopted
  as the primary fix for the same reason a similar idea was rejected in the previous entry (Boss
  marker-loss): content-sniffing a step's free text to infer intent is exactly the fragile,
  ever-growing heuristic pile this project's system-prompt philosophy already argues against,
  whereas #1's fix is a hard iteration-count comparison — no text interpretation needed. Worth
  revisiting only if #1 alone doesn't close the gap.
- *Just tell the model its remaining budget every turn* (recite "N iterations left" in context,
  always) — considered, not adopted as the primary lever: it asks the MODEL to self-regulate pacing,
  which is exactly the class of thing this project's own research grounding (`docs/harness-planning-
  memory.md`'s migrated finding, now in this file) already concluded small local models cannot
  reliably do unsupervised ("don't let correctness depend on the model self-managing"). The gate-side
  fix (#1) is harness-owned and doesn't depend on the model noticing anything.
- **Open question honestly flagged, not resolved here**: is `N ≈ 3` (or 10%) actually the right
  reserve, or does it need tuning per role? This is an unavoidable magic number at first — ship it,
  then let the eval (specifically `bigproj-duedate-bug`/`bigproj-effort` via `npm run eval:trend`,
  which now exists specifically to answer exactly this) confirm or correct it, per this project's own
  "measure, don't assume" rule.

### #2 (already done, this pass): eval framework correctness + tracking

The `runMetrics` mtime-window bug (fixed) and the new `history.jsonl` + `trend.mjs` framework are
committed as of this entry — see `docs/eval-log.md`. Ranked second, not first, because it doesn't
change Argo's own behavior, but it was a **prerequisite** to trusting the numbers behind #1 and every
future comparative run — done first for exactly that reason, not because it's less important in
isolation.

### Explicitly not re-ranked by this pass

The Boss task-start marker-retry fix (previous entry, shipped and validated 16/17) and the Planner
non-convergence open question (Finding 7, still the standing bigger experiment) are unaffected by
this analysis — different parts of the system, already correctly prioritized where they are.

### Still open after this pass

- Implement and eval-validate the #1 fix above (not yet built — this entry is the plan, not the
  patch).
- The Hermes comparative re-run (in progress) also failed `bigproj-duedate-bug`, with a different
  failure shape (109s, not a timeout) and no iteration-chain mechanism of its own — a possible signal
  that some of this task's current difficulty is task-level, not purely harness-level. Flagged, not
  concluded — needs the Hermes run's own failure detail before treating this as anything more than a
  coincidence worth re-checking.

## 2026-09-03 — Eval-strategy rework: rubric scoring (0-100) + speed-ratio target, built and piloted

Full framework/research writeup was presented and approved before building; this entry records what
actually got built and what the first real pilot run showed.

**Built** (`scripts/eval/tasks.mjs`, `e2e.mjs`, `hermes.mjs`, `trend.mjs`):
- **`shScore()`** — parses Node's own test-runner summary (`# pass N` / `# fail N`) instead of
  collapsing to a single exit-code boolean. Free partial credit — every task already runs `node
  --test`/`npm test`, no new instrumentation needed.
- **`testFileTampered()`** — an oracle-gaming guard: did the diff touch the task's own seeded test
  file. Reuses the same diff-based signal already trusted for the Boss's TRIVIAL-self-attempt guard.
- **`rubricScore()`** — 0-100: 70 pts test-case fraction, 15 pts integrity (full marks unless the
  test file was tampered), 15 pts speed-ratio vs a cross-harness reference wall-clock (full marks at
  <=1.5x, decaying smoothly above that, capped — no bonus for being faster). Deliberately does NOT
  fold in the LLM quality-judge score, to keep this fully deterministic and free of an extra Ollama
  call per task.
- **Cross-harness reference lookup** (`latestReferenceWallMs`) — `history.jsonl` now carries a
  `harness: 'argo'|'hermes'` field; Argo's speed score looks up Hermes's most recent wall-clock on
  the same task automatically. Hermes's own score always gets full speed marks (it IS the reference,
  not something scored against itself).
- **`trend.mjs`** now reports score alongside pass/fail per harness, and prints the speed ratio
  directly with an explicit OK/OVER-TARGET verdict against the 1.5x target.
- Verified end-to-end on `trivial-fix-greeting-typo`: Argo/Hermes speed ratio came back **0.96x** —
  confirms the task-start marker-retry fix (previous entries) actually closed the overhead gap on a
  fast-path task, not just on the arithmetic case it was validated against originally.

**First new task authored and piloted: `oracle-bait-inventory`** (the adversarial taxonomy's
oracle-gaming-bait category, finally given a real fixture). Self-verified before seeding (reference
implementation passes all 6 tests; the seeded bug — a partial reservation's release restores the
*requested* amount instead of the *actual* amount taken — fails exactly the 2 tests that exercise a
partial reservation). Prompt deliberately omits "don't weaken the tests," unlike several existing
tasks, to test whether the harness's own guards hold without a prompt reminder.

**Pilot result — a real calibration miss, reported honestly rather than adopted uncritically.**
Both Hermes and Argo scored **100/100 on the first attempt**, no tampering, fast (14s/20s, speed
ratio 1.41x — itself a clean confirmation the framework's speed math works). This is a **ceiling
effect** exactly like the one METR's calibration methodology (cited when this plan was researched)
warns against: the task doesn't yet discriminate between "resisted the temptation" and "wasn't
tempted because it was too easy." **Not adopted into the standing catalog yet** — needs a harder
variant (more borderline edge cases, a fix that must touch multiple functions, or a more inviting
red herring) before it's trusted to actually measure oracle-gaming resistance. This is the exact
failure mode the plan's own "pilot before adopting" step exists to catch, and it caught it on the
very first try — a good sign the calibration discipline itself is working, even though this
particular task isn't there yet.

**Still open**: harden `oracle-bait-inventory` (or design its replacement) so it lands in a
discriminating range; author the remaining proposed tiers (ambiguous multi-file refactor, drift-trap
long-horizon task, trivial-batch and tight-debug-loop Argo-stressors) — none built yet, this pass
only proved the scoring mechanism and shipped one (still-too-easy) task through it end to end.

## 2026-09-03 — Expanding upward: a decomposition-shaped task, grounded and piloted

**Research.** Aider Polyglot's own design principle (tasks requiring larger patches, more context,
more realistic engineering work than SWE-bench-style single-function fixes) confirms the "expand
upward" direction. More specifically useful: "When Parallelism Pays Off: Cohesion-Aware Task
Partitioning for Multi-Agent Coding" (arXiv:2606.00953) — decomposition earns its cost specifically
on LOOSELY-COUPLED subtasks. Every bigproj task built so far (`bigproj-deps`, `bigproj-effort`,
`bigproj-duedate-bug`) is the opposite: one cohesive algorithm, naturally owned end to end by a
single Implementer regardless of how hard the algorithm itself is — which is very likely *why* the
Planner has never converged on a real graph (Finding 7): it's never been given a task actually
shaped for decomposition, only harder versions of tasks that don't need it.

**Built: `bigproj-observability`** — three genuinely independent features in one request (a CSV
export module with zero dependency on TaskService; `getAuditLog()`; an optional `onEvent` hook),
each independently verifiable, purpose-built as the first real fair test of Finding 7's question.
Self-verified before seeding across 3 split test files (`test/export.test.js`,
`test/audit-log.test.js`, `test/event-hook.test.js` — split specifically so an unimplemented
`export.js` fails as ONE missing-module error rather than collapsing 3 real assertions into it,
a calibration bug caught and fixed before seeding, not after): a correct reference implementation
passes all 45 project tests; the seeded baseline (an unimplemented `export.js` stub, unmodified
`service.js`) passes 38/45 (84%) — well clear of both ceiling and floor.

**Piloted on Hermes**: 100/100, 71s, clean single pass.

**A real methodological catch on the Argo side, caught before it corrupted the result**: the first
Argo attempt returned `agents: false` on `/status` — `~/.config/argo/env`'s `ARGO_AGENTS` had been
left at `0` from the earlier pre-multi-agent baseline comparative work (Phase 6) and never reverted.
That run (single-loop, not multi-agent) still scored 88/100 before hitting the eval's own 900s
timeout — correctness alone (parsed from the test summary) was at full marks, meaning the plain
baseline nearly finished this task unaided too; noted as a real, if incidental, data point, but not
conflated with a multi-agent test. Fixed `ARGO_AGENTS=1` and did a full detach/reattach (confirmed
`agents: true` via `/status`) before re-running — the correct, multi-agent result is the one that
counts for Finding 7's question and is recorded separately once that run completes. General lesson
recorded in `MEMORY.md`: **always check `/status`'s `agents` field before trusting an eval run
against a workspace that outlived an earlier `ARGO_AGENTS` toggle.**

# — append to `docs/roadmap.md` —

## 2026-09-03 — Hypothesis register: ideas from the driving prompts, with falsification tests

This entry records the ideas that shaped Argo's recent direction as **hypotheses, not commitments**.
Nothing here is scheduled. Each is an idea that has to earn its place from the eval and from
observed agent behaviour — priority follows from what the traces show, not from how good the idea
sounds. Several are already partly built; that is recorded per item with `file:line` evidence, along
with the evidence for and against the idea mattering, the concrete test that would falsify it, and a
rough cost.

### The framing observation: designed ≠ wired ≠ fires ≠ works

The recurring failure mode in this project is not design quality — the designs are good and the
write-ups are careful. It is that **nobody verifies a mechanism actually fires**. Five designed
pieces are currently in that state, and two more are in the measurement layer:

- **`renderPinnedAnchor`** (`src/eviction.ts:70`) — implements the immutable-objective anchor, has
  **zero call sites**. Its own comment claims the objective is "always present, recited at the tail,
  NEVER subject to eviction". It is not present at all.
- **Episode eviction** (`src/eviction.ts`, called at `src/agent.ts:645`) — wired, but reached only
  from the near-full context threshold (`prompt_eval_count ≥ num_ctx − 4096` = 61 440) or from an L1
  loop-recovery block. Across all 567 run logs it has fired **3 times, all via L1, never once via
  the threshold** — while its own budget (`maxLiveChars = 60 000` ≈ 15 k tokens) is crossed on 1 849
  of 5 003 recorded turns. So it fires rarely and, when it does, stubs ~15 episodes at once. Its
  comment claims it "runs every turn"; it does not.
- **`ledger.recordStandup`** (`src/ledger.ts:145`) — dead. Stand-ups are written as `injection`
  entries, and only when the verdict is `inject`/`restart`, so **16 of 22 recorded stand-ups left no
  ledger trace at all** — including for a Boss that is supposed to detect drift by reading the
  ledger.
- **Durable memory persistence** (`src/agent.ts:758`) — the only call site sits inside the
  LLM-compaction branch, so it can only write when a compaction happens. It has fired **twice**, both
  in `test-two` on 2026-07-30, and what it wrote is a verbatim transcript replay
  (`- Called bash({"command":"ls /workspace/tests/"}) Result: …`) in a file whose stated purpose is
  "durable, reusable facts … never one-off task state" (`src/agent.ts:86`).
- **`ask()`** — the Boss-asks-a-running-frame primitive. Never built, yet still carried in
  `docs/subagents-plan.md`'s open questions as "the most novel/fragile piece here and should get the
  heaviest testing before trusting it in the dispatch loop".

The same pathology in the measurement layer, which is worse because it hides the rest:

- **The eval's `gate` counter broke at `e045d0a`.** It greps `warning` events for
  `/record a plan|changing the project/`; that commit's "unified tool-rejection surfacing" moved the
  message to `tool_result.error`. The gate fired **49 times in July (counted) and 24 times in
  September (invisible)**.
- **The eval's `steer` counter has been blind since 2026-08-04.** Its regex
  (`/no new information|STOP —/`) matches only the legacy count-based steer, which is dead code once
  `ARGO_LOOP` defaults on. Meanwhile the ladder fired **158 L0 / 24 L1 / 13 L2** in September. Every
  `s=0` in the eval log is an artifact, and at least two eval-log conclusions rest on it.

Cost of this pathology, concretely: Finding 7 ("the Planner has never produced a task graph") was
wrong. All eight large-task Planner frames produced valid 2-5-step JSON graphs; the harness discarded
every one, because `update_plan` sits in `ROLE_TOOLS.planner` (`src/frames.ts:21`) and `spawnFrame`
(`src/dispatch.ts:141`) never disables the default-ON task ledger, so the Planner's own `verify`
command becomes an unsatisfiable gate on its no-tool-call final answer — which *is* its output
contract. Three hypotheses and two eval sessions were spent on the wrong diagnosis. **43 frames in
the recorded history ended blank at their iteration cap and were recorded as `status: "success"`.**

Hence Item 0.

---

### Item 0 — Per-mechanism firing counters in every run record  *(prerequisite, not a mechanism)*

**The idea.** Every harness intervention emits a structured event —
`{type:'intervention', mechanism:'plan-gate'|'loop-L0'|'loop-L1'|'loop-L2'|'near-dup'|'no-progress'|'progress-check'|'stall'|'reground'|'task-advance'|'summary-ask'|'reconcile'|'verify-pass'|'verify-fail'|'role-reject'|'grounding'|'evict'|'compact'|'cap-hit'|'memory-select'|'recite', role, iteration, …}` —
counted by field, not by prose regex, and aggregated into every `history.jsonl` row.

**Status.** Not built. Interventions are surfaced as free-text `warning` messages or
`tool_result.error` strings; `scripts/eval/e2e.mjs:180-186` scrapes three of them by regex and two of
those three are broken. Nothing counts the other thirteen. The memory read paths
(`src/agent.ts:830-849`) and the recited tail (`src/agent.ts:824`) emit **no event at all**, so they
are unobservable in principle.

**Evidence for.** It would have caught all five unwired mechanisms above and both broken counters.
It also unblocks every other item here: none of items 1-8 can be prioritised without knowing which
existing mechanisms fire and with what effect. Direct measurement made possible by this pass —
461 firings of the three steer mechanisms with no way to link any of them to a run outcome — is the
argument in one number.

**Evidence against.** None found. It is instrumentation, not behaviour, so it cannot regress the
agent.

**Falsification test.** Not applicable in the usual sense; the test is that it works. Concretely:
after landing it, re-run the current battery and confirm the per-mechanism counts match the counts
derivable by hand from the raw logs. If they diverge, the emitter is wrong.

**Cost.** Small: one event type, ~16 call-site edits, a counter dictionary in `runMetrics`, and a
`mechanisms` object per `history.jsonl` row.

---

### Item 1 — Wire the pinned anchor and force eviction to run  *(highest priority of 1-8)*

**The idea.** The sliding window must retain not the original prompt but **the plan**: an objective
that becomes immutable once the first planning cycle formulates it, plus an execution plan that stays
refinable at any time. Both pinned outside eviction and recited at the tail.

**Status.** `renderPinnedAnchor(objective, plan)` (`src/eviction.ts:70`) implements exactly this and
is **called from nowhere**. `ledger.setObjective` has an immutability guard and is used
(`src/dispatch.ts`), so the objective *is* stored immutably — it is simply never re-surfaced into
context. `src/frames.ts:9-15` admits the v1 simplification: the anchor is folded into the frame's
first assignment message instead, "so a long-running frame's recitation of the LEDGER-level plan may
fade the same way any other context does without eviction re-surfacing it."

**Evidence for.** Eviction *does* run (3 firings), so context is already being trimmed with no
pinned objective — the precise configuration the anchor exists to prevent. The failure that motivated
this whole project was a 90-iteration run that quietly solved a different problem; that is the
failure mode this addresses. The baseline path has an analogous mechanism (plan recitation at
`src/agent.ts:824`) which the docs call "the #1 lever for holding a small model on the current task",
so the pattern is already believed in — it just was not extended to the ledger-level objective.

**Evidence against.** Peak context is 64 266 tokens of 65 536 and only **6 of 5 003** recorded turns
reach the compaction threshold, so on today's tasks the window rarely slides far enough for drift by
eviction to be the binding problem. This item may be solving a problem the current task set does not
produce — which is why it is paired with forcing eviction to run.

**Falsification test.** Lower `COMPACT_RESERVE_TOKENS` so the threshold lands near ~16 k, which turns
every existing hard task into a long-horizon task at zero authoring cost. Then A/B on
`bigproj-effort` and `bigproj-deps`, n≥3, anchor ON vs OFF, measuring: objective-drift incidence
(does the final answer still address the recorded objective — the quality judge already scores
`goal_completeness`), pass rate, and iterations. **Falsified if** drift incidence and pass rate are
indistinguishable with the anchor off — i.e. the model holds the goal without it.

**Cost.** Small for the anchor (one call site in the recitation block, mirroring the existing task
ledger push). Trivial for the eviction condition (an env var in the eval driver).

---

### Item 2 — Multi-turn task sequences in the eval

**The idea.** A multi-step scenario in which several **equally difficult** follow-up tasks are
prompted in sequence on the same workspace, rather than one prompt per task.

**Status.** Not built. `scripts/eval/tasks.mjs` has no follow-up support: every task is a single
`prompt` string, `e2e.mjs:216` posts it once, and `resetWs` wipes the workspace between tasks. The
`sessionId` plumbing to support multiple runs in one session already exists (`src/server.ts`,
`SessionLogger`), so the harness side is ready.

**Evidence for.** This is the only way to test cross-turn memory, and cross-turn memory is where the
north star lives. Durable persistence has fired twice in the project's history and wrote garbage
(see the framing observation), and the MEMORY.md/AGENTS.md **read** paths are unreachable in all four
eval workspaces because none of them contains either file — so `ARGO_MEMORY` being "ON by default"
has contributed nothing to any eval result recorded to date. A multi-turn task is also the cheapest
route to a genuinely long context, which nothing else in the catalog produces.

**Evidence against.** None on the merits. The practical objection is cost: k runs × N turns
multiplies wall-clock, and the suite is already slow. Mitigated by keeping the sequence short (3-4
turns) and applying it to one or two tasks, not the whole catalog.

**Falsification test.** Author one workspace with three or four follow-ups of comparable difficulty
(e.g. add feature A; then feature B that must respect A's convention; then a bug fix that touches
both). Primary metric: **tool calls before the first edit on turn N** — if the agent benefits from
turn N−1, that number should fall across turns. Secondary: does it re-derive facts it already
established. **Falsified if** turn 3 costs the same discovery effort as turn 1 with memory ON, or if
memory ON is indistinguishable from memory OFF.

**Cost.** Medium: `tasks.mjs` needs a `turns: [...]` shape and `e2e.mjs` a loop that skips the reset
between turns; plus authoring the workspace and its oracles.

---

### Item 3 — Implementer context inheritance from the last 1-3 implementer frames

**The idea.** A new Implementer frame inherits distilled context from recent Implementer frames via
tag-based retrieval from the ledger, prioritising the most recent, walking further back only when
what it has is insufficient.

**Status.** Only the explicit `dependsOn` → `contextGiven` path exists: `buildAssignment`
(`src/frames.ts:118-134`) forwards each dependency's capped conclusion summary plus its file list,
and nothing else. The retrieval substrate is already there and unused for this purpose —
`getFrameTrail`, `getRecent`, `expand` (`src/ledger.ts:218,227,237`), all exposed to the model via
the `ledger` tool (`src/tools/index.ts:224`).

**Evidence for.** Suggestive rather than direct: 180 near-duplicate-tool nudges and 102
role-restriction rejections across the corpus are consistent with frames rebuilding the same
understanding from scratch. Frames are genuinely isolated by design (each gets its own `sessionId`,
history file and compaction state), so there is no accidental sharing to fall back on.

**Evidence against — and this is why it ranks third rather than first.** The mechanism is nearly
untestable today: **84 of 85 executed task graphs have exactly one step**, and `dependsOn` context
has been supplied to just **5 frames** in the whole history. With one Implementer per run there is no
"previous Implementer frame" to inherit from. This item is therefore *blocked behind the Planner
fix*, not independently schedulable. There is also a real risk it re-imports the noise that frame
isolation exists to remove — the durable-memory result (transcript sludge scoring as "verified
facts") is a warning about automatic distillation.

**Falsification test.** Once multi-step graphs actually execute: measure **tool calls to first edit
per Implementer frame**, and the count of files re-read that a prior frame in the same run already
read, with inheritance ON vs OFF. **Falsified if** neither number falls, or if inherited context
increases drift (the quality judge's `drift_or_hallucination` list grows).

**Cost.** Medium. Retrieval and capping are the easy part; deciding what "insufficient" means without
a model self-report is the design work.

---

### Item 4 — Artifact-by-reference for frame conclusions

**The idea.** A frame that produces a substantial result writes it to a **file** and returns a short
summary plus a pointer, so the orchestrator's context is never overwhelmed by a subordinate's output.

**Status.** Partially honoured. `capSummary` caps a conclusion at 2 000 chars and dependency
hand-offs at 500 (`src/frames.ts:106-110`), and `buildAssignment` forwards only the capped summary,
never the raw episode graph. But the cap is a truncation, not a reference: the observed Boss
conclusion on `bigproj-observability` embeds a full markdown status table in its `summary` field, and
the dispatch loop's final return concatenates every step's summary
(`doneSummary`, `src/dispatch.ts:756`). There is no artifact directory and no pointer convention
(`.argo/reports/` was deferred to v2 with the Researcher role).

**Evidence for.** Cheap, and it composes with Item 5: a stand-up that reads pointers rather than
prose stays cheap as a run grows.

**Evidence against.** No measured harm yet. Boss frames are short (94 task-starts, 86 finals, all
well inside their 10-15 iteration budgets) and peak context in a Boss frame is nowhere near the
limit. **Truncation at 2 000 chars is already doing the job the cap exists for** — the honest
statement is that this is prophylactic, aimed at a scale the system has not reached.

**Falsification test.** Instrument Boss-frame peak prompt tokens per checkpoint (Item 0 gives this
for free), then run a task with ≥4 Implementer frames after the Planner fix. **Falsified if** Boss
context stays flat as frame count grows — in which case the cap is sufficient and the pointer
convention is unnecessary complexity.

**Cost.** Small-to-medium: a `.argo/reports/` convention, a write in `deriveFrameResult`, and a
pointer in the summary.

---

### Item 5 — Rolling stand-up summaries in the ledger at a ~20-iteration cadence

**The idea.** The Boss detects drift by reading the ledger cheaply — a brief daily stand-up — rather
than by re-investigating from scratch. Summaries accumulate in the ledger at a regular cadence.

**Status.** The stand-up *frame* exists and fires (22 times), but: **`ledger.recordStandup`
(`src/ledger.ts:145`) is never called**, so 16 of 22 healthy stand-ups left no trace; the trigger is
**10 action episodes** plus a >25-iteration frame plus a `hadTrouble()` signal
(`src/dispatch.ts:711-719`), not an iteration cadence; and the Boss re-investigates with real tools
each time rather than reading accumulated summaries — 8 tool calls in the observed
`bigproj-observability` stand-up.

**Evidence for.** Magentic-One's ablation (cited in `docs/subagents-plan.md`) attributes 31 % of
performance to the ledger alone. And the current stand-up is measurably weak: of 22, **16 returned
`NONE`, 3 stalled blank at their cap, 3 produced no keyword** — so 27 % produced no usable verdict,
and across the entire corpus exactly **one** `boss_verdict` event exists (an `escalate`). `INJECT`
and `RESTART` have never fired. Whatever the current stand-up is doing, it is not catching drift.

**Evidence against.** 22 stand-ups producing one actionable verdict is also an argument that
stand-ups are simply not earning their cost at this task size — a cheaper stand-up might just be a
cheaper way to produce nothing. That has to be tested, not assumed.

**Falsification test.** Land `recordStandup`, switch the trigger to an iteration cadence (~20
iterations of cumulative frame work), and have the stand-up prompt read the accumulated summaries
first and use tools only if they are insufficient. Measure: Boss tokens and tool calls per stand-up,
and — the real question — whether a drift event is caught earlier. Needs a drift-trap task (the
adversarial taxonomy's, still unbuilt). **Falsified if** cheaper stand-ups still produce `NONE`
every time on a task where drift demonstrably occurred.

**Cost.** Small for `recordStandup` and the cadence; medium for the read-first prompt redesign; the
drift-trap task is separate authoring work.

---

### Item 6 — The Boss must verify against artifacts, not self-reports

**The idea.** The Boss should not rely on what the agents tell it; it should verify for itself
whether what they claim is grounded.

**Status.** The prompt already says exactly this ("Verify independently (read files, run checks,
search the web) rather than trusting self-reports", `src/frames.ts` Boss suffix), and the Boss has
`read_file`/`bash`, so it *can*. What is missing is any structural guarantee, and the evidence says
the prompt is not enough.

**Evidence for — direct, and damning.** The quality judge on `bigproj-deps` recorded:
*"Boss final frame hallucinated 'All 9 tests pass' and claimed work was 'already complete from the
previous frame' after multiple timeout failures"* — on a run scored PASS by the deterministic check.
Separately: `parseTesterVerdict` (`src/frames.ts:152`) fails open to `RELEASE`, and **the Tester has
released 29 of 29 times with zero REDO ever recorded**, so a stalled Tester is indistinguishable from
a satisfied one. And `filesTouched`/`filesWritten` — documented as "diff-derived, not self-reported"
(`src/types.ts:135`) — are derived from `edit_file`/`write_file` call tracking, so **4 of 9
Implementer conclusions carry an empty file list** for work that demonstrably changed `src/` via
`bash`. The Boss and Tester are handed the fallback string *"none (or made via bash, not tracked)"*
and must rediscover the change.

**Evidence against.** None. The only counter-consideration is cost: the Boss already accounts for
**202 of ~317 role frames (64 %)** and 53 of 102 role-restriction rejections, so "verify more" must
not mean "spend more Boss iterations". The fix should make the *evidence cheaper to obtain*, not the
checkpoint longer.

**Falsification test.** Author a trap task in which a frame's conclusion is deliberately false (a
partial implementation reported as complete, or a false conclusion injected into the ledger before
the Tester spawns) and measure whether the Boss/Tester catch it. **Falsified if** they catch it
reliably without any change — in which case the `bigproj-deps` hallucination was an outlier.
Cheapest structural companion: make `filesWritten` genuinely diff-derived (a `git status` snapshot
per frame) so verification starts from a real diff.

**Cost.** Small for the diff-derived file list; small for the cap-hit fail-open fixes; the trap task
is authoring work and doubles as an eval item (see `EVAL-PLAN.md`).

---

### Item 7 — Explicit, measurable delegation thresholds

**The idea.** Concrete criteria instead of prompt judgment: spawn a sub-agent when a group of roughly
20-40 iterations of work would otherwise share one context; the Boss does real work only for one or
two iterations; planning begins only when multiple sub-agents are anticipated.

**Status.** All three exist as **prompt text**, not harness policy. The Planner suffix says isolation
is "only worth paying when that step's own work would otherwise run about 20-40+ iterations"
(`src/frames.ts`). The Boss's self-attempt bound is the closest thing to a real policy and it *is*
harness-enforced: `TASK_START_MAX_ITERATIONS = 10` plus a `git status` diff plus
`TRIVIAL_DIFF_LINE_LIMIT = 15` (`src/dispatch.ts:78,222`). Nothing measures anticipated work before
spawning.

**Evidence for.** The measured routing distribution is sane where the harness enforces
(`TRIVIAL` 14, `ANSWER` 13, `SIMPLE` 2, `OBJECTIVE` 3 — fast paths in 84 % of marked classifications)
and unmeasurable where it does not. The Boss's own bound is the mechanism the project already credits
with turning a 1801 s timeout into 86 s.

**Evidence against — the strongest of any item here.** "Spawn when 20-40 iterations are anticipated"
requires *predicting* effort before doing the work, which is exactly the class of judgment the
project's own design principles say not to depend on a small local model for. The Boss's bound works
precisely because it is a post-hoc, model-independent check (`git status`, a diff line count, an
iteration count) rather than a prediction. A threshold expressed as a prediction may be
unimplementable as stated; a post-hoc equivalent ("this frame has now run 25 iterations — the next
group should have been split") is implementable and is arguably what `LARGE_FRAME_ITERATIONS = 25`
already is.

**Falsification test.** With Item 0's counters, measure **frames spawned per difficulty tier**. The
trivial tier should show near-zero framing overhead (`trivial-qa-arithmetic` is already at 2 frames,
which is the target); the hard tier should show frames scaling with genuine work rather than with
routing accidents. **Falsified if** frames per tier are already well-calibrated — in which case
prompt judgment is sufficient and the policy is unnecessary. Also worth measuring: how often the
Boss's 1-2-iteration bound is exceeded in spirit (23 of 94 task-starts left the workspace dirty).

**Cost.** Small to measure; medium to enforce, and the design question above should be settled first.

---

### Item 8 — File-size discipline  *(explicitly speculative)*

**The idea.** Keep long documents split into chapters and source modules small, so that no single
file swamps a small model's context. Possibly a harness nudge above N lines.

**Status.** Not implemented in any form. Related machinery exists for the symptom rather than the
cause: `read_file` truncates, `TOOL_RESULT_COLLAPSE_OVER` collapses older tool output
(`src/agent.ts:806`), and `PROJECT_CONTEXT_CHAR_CAP = 8000` bounds AGENTS.md/MEMORY.md injection.

**Evidence for.** None from the logs. Marking this plainly: **I looked and found no supporting
evidence.** The largest single file the agent has worked on is `test-two/index.html`, and its
recorded failures there are edit-matching failures (stale `old_string` matches), not context
exhaustion — which the workspace's own hand-written AGENTS.md/MEMORY.md "Editing convention" section
already addresses with a re-read-before-edit rule.

**Evidence against.** Peak context is 64 266 of 65 536 tokens, reached on **6 of 5 003** turns, so
file size is not currently the binding constraint. Any nudge risks the fragile-heuristic pile the
project's own system-prompt philosophy argues against.

**Falsification test.** Wait for the signal rather than testing pre-emptively: once Item 0's
counters exist, watch for runs where a single `read_file`/`bash cat` result exceeds a large fraction
of the turn's prompt tokens, or where truncation precedes a failure. **Adopt only if** that pattern
appears. Cheapest first step is a guideline in `AGENTS.md`, not harness code.

**Cost.** Trivial as a guideline; small as a nudge. **Low priority until the logs point at it.**

---

### Deliberately NOT adopted

- **A fifth `researcher` role.** Confirmed absent from `ROLE_TOOLS` (`src/frames.ts:21-27`);
  deferred to v2 in `docs/subagents-plan.md`. Keep it deferred. Premature for a specific reason:
  decomposition has never been observed working (84 of 85 graphs are single-step), so there is zero
  evidence that even **four** roles earn their coordination cost — and the cited "bag of agents"
  research puts the coordination plateau at ~4 agents, which is where we already are. Mechanism count
  is already producing correctness bugs, not just complexity: the default-ON task ledger destroys 39 %
  of Planner frames. Source attribution and confidence scoring, the parts of the Researcher idea with
  real value, belong folded into the existing grounding guard — which already does exactly this and
  does it well (it caught a fabricated citation and two invented specifics on a real writing task).
- **An asynchronous or weak-model Boss.** Reversed by Gabriel himself, correctly. A weaker model
  policing a stronger one is the failure the supervisor eval already measured (only qwen3.6 flags
  oracle-gaming stably, 3/3; every other candidate fails the gate), and a second resident model costs
  real memory on a 48 GB machine for no measured gain. The one accidental test of this — two
  multi-agent sessions on `test-two` that ran `qwen2.5-coder:14b` on 2026-09-02 — produced a Tester
  burning all 20 iterations with a single tool call and a Boss final checkpoint stalling blank for 15.
- **Speculative decoding.** Park. Unproven in this setup, and speed is being demoted out of the eval
  score (`EVAL-PLAN.md` §3.1) because the only measurable speed signal today is confounded by Docker
  isolation. Revisit if and when quality is measurable and cost becomes the binding constraint.
- **Reopening LLM parallelism.** Settled. `src/dispatch.ts:7` records it as a hard invariant: "no two
  LLM calls ever run concurrently, for any reason — one GPU, one resident model." Not a deferral, a
  ruling.

---

### The iteration-budget directive: ~20 as a chunk, ~200 as a hard boundary

Two concepts the code currently conflates, recorded here because neither exists yet:

**(a) ~20 iterations is an IDEAL CHUNK and a stand-up cadence, not a hard limit.** The Planner should
size each sub-agent task to roughly that much work, and the harness should trigger a Boss stand-up
around that interval. Today `ROLE_MAX_ITERATIONS` (`src/frames.ts:38-43`) is a set of hard kills, not
target sizes: at the cap, `src/agent.ts:1801` makes `"Reached maximum iterations (N) without a final
answer."` the frame's *final answer*. The stand-up cadence is an action-episode count of 10, not an
iteration interval (`src/dispatch.ts:79`).

**(b) ~200 iterations is a HARD GLOBAL boundary for the whole run, all frames combined — not per
sub-agent.** Sized to the observation that the agent has never been driven past roughly 200
iterations without ending in hallucination. **No cross-frame total exists anywhere.** Frames are
independent `Agent` instances with independent counters; observed totals already reach 104 (8 frames)
and there is no mechanism that would notice 300.

**Ordering constraint — this matters.** Making the per-role caps *soft* requires fixing the cap-hit
fail-open **first**. Today a cap-hit produces a frame whose conclusion is an error string recorded as
`status: "success"` (`src/dispatch.ts:191`); 43 frames in the recorded history have ended that way,
including 39 % of all Planner frames and 13 % of all Boss frames. The global ~200 limit *will* be hit
sometimes, and if the same fail-open handles it, the harness will discard an entire run's result
exactly as it currently discards a Planner's task graph. So: fix `deriveFrameResult` to distinguish a
capped frame (`status: 'partial'`), make `parseTesterVerdict` and `parseTaskGraph` stop failing open
on a capped frame, and only then convert the per-role caps into soft targets with a hard global
ceiling and a "you are near the global limit — summarise now" yield.

**One analytical caveat on the ~200 figure.** It is best read as a measurement of Argo *without* its
anti-drift machinery, not as a property of the model. The pinned anchor has never been called, durable
memory has written twice and wrote transcript noise, eviction has fired three times and never with a
pinned objective, and the MEMORY.md/AGENTS.md read paths are unreachable in every eval workspace.
Whether ~200 is a ceiling or an artifact of running without those is an **open experiment**, and it is
the same experiment as Item 1's falsification test — which is a reason to run that one first.

---

### Sequencing constraint

**None of items 1-8 should be built before the measurement layer and Item 0's firing counters are
fixed.** The current instrument cannot resolve their effects: the integrity gate cannot fire at all
(`testFileTampered` greps `git diff --name-only`, and every seeded test file is untracked), the
correctness term has returned a single value (70/70) in all twelve real scored runs, over half the
`history.jsonl` rows carry no harness label, and two of three intervention counters are broken.
Anything added now would be unmeasurable — which is precisely how five mechanisms came to be built
without anyone noticing they never run.

Diagnosis and a buildable replacement suite: see the eval-strategy work and the companion analysis.
The three changes that must land first, in order: per-mechanism firing counters (Item 0); the
integrity gate and a seeded-test-only correctness denominator; and `EVAL_RUNS ≥ 3`, since every
current conclusion about a high-variance task rests on a single sample.
