# Argo — improvement roadmap (hypothesis-driven)

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
     Pull Ollama vision models (`llama3.2-vision`, `llava`, `moondream`, `qwen2.5-vl`); qwen3.6 already reports a `vision` capability. A vision-capable agent is a coming requirement.

**Standing product requirements (from the user) — status:**
- Quality/reliability of complex, long-running tasks **over** speed or resource efficiency → the organizing principle of Phase 4.
- Run for very long without losing the goal, hallucinating, looping, forgetting progress, or mismanaging memory → the north star (below); the 90-iter test measured exactly this and showed a lone model degrades, which motivates the critic.
- Improve planning, reasoning, tooling, steering, supervision, staying on-track → Phases 3–4.
- **After producing a plan, execute without an extra "proceed" prompt** → ALREADY satisfied: the plan/act gate blocks a mutation until a plan is recorded, then auto-proceeds with no user confirmation (see `CLAUDE.md`).
- Evaluate models by distinct capabilities (the five axes above), not one universal best → capability matrix.
- Dual-model (qwen works, another reviews plan + implementation while running) → step 2.
- Measure quality on realistic, difficult tasks → the `bigproj` E2E eval + the supervisor eval.

North star: an agent that runs ~indefinitely without losing the goal, hallucinating, looping, or losing track — with good memory of what matters. Run history: `docs/eval-log.md`.
