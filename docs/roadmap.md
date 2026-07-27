# Argo — improvement roadmap (hypothesis-driven)

A pragmatic, iterative plan for making Argo a genuinely good **contained coding harness for
locally-running LLMs** (Qwen, Mistral, …), while staying true to its mission: local,
lean, means-not-ends (Ollama/Docker are swappable tools, not goals), observability-first.

## Method (how we improve, not just what)

Every change is a **hypothesis tested against evidence**, not a vibe. The rule:
**measure → change one thing → measure again.** Argo writes a full structured trace
(JSONL) for every run — that is the raw material for measurement. The eval turns "feels
better" into a **number**, so each change is decidable. The roadmap is ordered to build
the measuring stick first, then attack the biggest lever, then tune — each step gated on
the last. Record every run and its result in `docs/eval-log.md` (the flywheel's memory);
background research is in `docs/research.md`.

## Where Argo is today

- **The plan/act mechanism works — on a capable model.** `qwen3.6:latest` completes the
  full end-to-end eval (**4/4** self-verifying tasks, including the big cross-cutting
  `bigproj-deps`), records a plan, and converges in 7–11 iterations. The 90-iteration
  goal-substitution drift that motivated this work is gone. **We now measure**: `npm run
  eval` (fast tool-call probe) and `npm run eval:e2e` (real loops), both SHA-stamped.
- **The current ceiling is tool-calling reliability, not reasoning.** On the eval,
  `devstral:24b` emits tool calls (~75% on the probe) but under-executes end-to-end
  (0/4) — it finishes early with the suite still red, never engaging the plan mechanism.
  `llama3.1:8b` engages the workflow but lacks coding depth (0/4; once re-planned seven
  times to the iteration cap). No loop/prompt cleverness fixes a model that won't emit or
  can't complete — **the harness's value is capped by the model's tool-use/agentic
  ability, partly a runtime/format problem, not purely intelligence.**
- **Chosen model: `qwen3.6:latest`.** It is the only model validated end-to-end. The
  others stay as eval comparators; the eval is the gate for adopting any future
  candidate, including newer qwen.
- **Pi is inspiration, not a dependency.** Its multi-provider machinery is weight Argo
  would pay for capabilities it will never use (local-only). Borrow ideas (model-agnostic
  messages, capability adaptation, tool dialects), don't import the stack. (See
  `docs/research.md`.)

---

## Phase 1 — Evaluation harness (the flywheel)   ✅ DONE

**Hypothesis (confirmed):** Argo's structured logs contain enough signal to score agent
behavior; a small, repeatable eval turns "feels better" into a number and makes every
later change decidable.

**Shipped:** two harnesses in `scripts/`, driven by `npm run eval` / `npm run eval:e2e`:
- **Fast probe** (`eval.mjs`): single-turn, loads Argo's real `SYSTEM_PROMPT`, measures
  **native-tool-call reliability** across tasks × models. Cheap enough to tune prompts.
- **E2E** (`eval-e2e.mjs`): real Argo loops on **self-verifying** tasks (seed a failing
  test → run → the suite must pass). Measures **task completion**, and scrapes per-run
  behaviour from the JSONL (iters, tools, plan, gate/reground/steer, peak ctx).
- Both stamp the harness `git rev-parse --short HEAD` and emit a paste-ready
  `eval-log entry`. Task catalog, metrics glossary, and the run log live in
  `docs/eval-log.md`.

**Reference baseline** (working tree with the plan/act mechanism): qwen 4/4, devstral
0/4, llama 0/4 (E2E); qwen 12/12, devstral 9/12 (fast probe). Every future change is a
delta against this.

**Decision branch (still open):** if the logs lack a signal we need (e.g. "did the model
try to emit a tool call but fail to parse"), add exactly that event to the trace —
improving observability is always in-bounds.

---

## Phase 2 — Tool-calling reliability (raise the ceiling)   ← active, biggest lever

**Hypothesis:** Most "the agent won't plan/act/work" failures on local models are
tool-call **emission/parsing** failures, not reasoning — and they are fixable at the
runtime/format layer. (The eval already shows this shape on devstral.)

**Tests (decisive A/B, using the Phase-1 eval):** run the same model+task three ways and
compare tool-call success rate:
1. Ollama native `/api/chat` (today's path).
2. Ollama raw `/api/generate` + our **own per-model tool dialect** (Qwen ChatML / Mistral
   `[TOOL_CALLS]`) — we format the prompt and parse tool calls ourselves.
3. `llama.cpp llama-server` with a **GBNF grammar** that forces a valid tool call.
   *(Blocked from the SLICC side by Ollama's `403` origin policy — needs `OLLAMA_ORIGINS`
   set, or run the experiment on the host / inside the worker container.)*

**Success signal:** a clear winner per model (esp. devstral) on tool-call success rate,
with grammar-constrained decoding expected to be near-100%.

**Decision branch:**
- If grammar/dialect fixes it → invest in a **llama.cpp path + owned tool dialect** for
  the 2–3 models we care about (leaner than it sounds; scoped, not a framework). This is
  the mission's "means-not-ends" in action: keep Ollama where it's fine, add a better tool
  for the gap it can't fill.
- If Ollama-native is already reliable for a model → keep it; don't add weight.
- Cheap stopgap meanwhile: a one-shot loop nudge ("you described a next action but didn't
  call a tool — emit it now"), gated so it never taxes genuine one-shot answers. Ship only
  if the eval shows it helps without regressing the read-only control.

**Note:** do not keep prompt-tuning a model that can't emit tool calls. Fix the emission
layer or route that model to a runtime that can.

---

## Phase 3 — Planning, convergence & agent competence (tune what exists, on qwen)

**Hypothesis:** the plan/act gate + `update_plan` + recitation + reground done-gate
improve convergence and reduce drift — but the thresholds are guesses, and there are gaps
the baseline surfaced. This is where most "make a small model handle large tasks" work
lives: better prompts, tools, steering, memory, and possibly sub-agents — each measured
against the qwen baseline.

**Tests:** with the eval, measure iterations-to-done, plan-adherence, and drift **with vs
without** each mechanism. Tune: recitation frequency, whether a Magentic-One-style stall
counter helps, reground-once vs reground-on-each-finish.

**Candidate items (each must earn its place with a number — reject speculative ones):**
- **Close the bash gate bypass.** `isProjectMutation` only covers `edit_file`/`write_file`,
  so a model can write project files through `bash` and skip the plan/act gate. qwen still
  completes tasks, so this is not yet costing us — measure whether gating bash writes
  improves plan-adherence before adding the complexity.
- Stall counter that forces a re-plan; read-only tool gating during planning; Ollama
  `tool_choice` forcing.
- Memory/context: is compaction preserving the right things? (see `docs/research.md`,
  Part 2). Sub-agents for research/verification, if the eval shows a win on large tasks.

**Success signal:** measurably fewer drift incidents and faster convergence on the eval,
with no regression on simple tasks (versatility preserved).

---

## Phase 4 — Local-runtime seam + evidence-based model curation

**Hypothesis:** supporting a *small* set of local runtimes (Ollama-native +
OpenAI-compat/llama.cpp) plus a per-model capability map lets users run each model on the
runtime that behaves best — broadening "runs local models" without bloat.

**Test:** a thin `src/llm/` seam (two implementations on native `fetch`, no framework, no
Pi) + a small static capability table (context window, native-tools vs JSON-fallback,
temperature support, best runtime). Score each (model, runtime) combo on the eval.

**Success signal:** the README's 🔧/⚠️ model markers stay **evidence-based** — "these
local models work well in Argo, on this runtime, with these params," backed by eval
numbers. (qwen3.6 is the current answer.)

**Note:** curate a *few* models done well over "any model, mediocre." Focus beats breadth
for a local harness.

---

## Ongoing — Leanness & means-not-ends audit

**Hypothesis:** Argo can shed weight/services without losing capability.

**Experiments (each its own small hypothesis):**
- **Sandbox:** keep Docker while it uniquely provides a *real* environment (real bash,
  node, git, playwright/Chromium). Periodically re-test lighter options
  (`SANDBOXING-ALTERNATIVES.md`, WASI) — but only adopt one that preserves real-binary
  fidelity. WASI/pure-runtime is attractive for pure compute, insufficient for real tools.
- **Web search (the one reluctant remote dep):** hypothesis — web search can be served
  locally (self-hosted SearXNG) or via the agent's own browser/fetch tools against a
  search engine, removing Tavily. Test a local alternative on real research tasks; if it
  holds up, drop Tavily. If not, keep it as the clearly-marked exception.
- **Dependency audit:** keep the tree minimal; reject anything remote-provider-oriented
  (the Pi lesson). Every new dep is a hypothesis that it earns its weight.

**Success signal:** fewer standing services/dependencies, same capability, measured on
the eval suite (no regression).

---

## Ongoing — Deepen observability (Argo's core strength)

**Hypothesis:** faster diagnosis → faster improvement (this whole effort proved it: the
JSONL logs let us pinpoint devstral's exact failure).

**Test/build:** surface eval scorecards and "why did this run fail" in the cockpit; add
trace events for anything the eval needs but can't currently see (e.g. a
`tool-call-parse-failed` event to distinguish emission failures from reasoning stops).

---

## What we will NOT do (guardrails from the philosophy)

- **No multi-provider framework / Pi adoption.** Local-only means their weight is clutter.
- **No remote LLM providers or hosted models.** Out of scope by mission.
- **No speculative loop mechanisms.** Each must earn its place against the eval.
- **No replacing Docker** until a lighter sandbox preserves real-binary fidelity.
- **No prompt-tuning around a broken tool-call layer** — fix the layer.
- **No breadth-chasing.** A few local models done well beats "supports everything."

## Capability limits (the real risk)

Local models may simply not be good enough at agentic tool-use for some tasks, and the
harness cannot fully compensate. Part of this plan is knowing — from the eval — **which
(model, task) combinations actually work**, and being clear about that boundary rather
than overselling. The eval is also our early-warning system as local models improve: when
a previously-failing model starts passing, we will see it in the numbers.

## Iteration cadence

1. ✅ Phase 1 (eval) landed — baseline recorded. 2. Run the Phase 2 A/B; pick the
tool-calling path. 3. Use the eval to validate/tune Phase 3. 4. Add the Phase 4 seam +
curation. 5. Leanness/observability run continuously in the background. Re-baseline the
eval after every change; keep the "hypothesis → result" log in `docs/eval-log.md` so the
flywheel compounds.
