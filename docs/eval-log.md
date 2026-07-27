# Argo eval — method, tasks, and run log

Argo improves by measurement, not vibes: **measure → change one thing → measure
again** ("the flywheel"). Every run already writes a full JSONL trace; the eval
turns that into a comparable **number**, and this file is the flywheel's memory —
what we tested, on which harness version, and what we learned. Stamp every entry
with the harness git SHA so results are comparable across commits.

---

## How to run

Both harnesses run on the **host** (Ollama/Docker/Argo live there, not in the browser).

```
npm run eval        # fast single-turn probe — Ollama only
npm run eval:e2e    # slow, truthful end-to-end — needs Argo running + workspaces attached
```

- Default model is `qwen3.6:latest` (our validated agentic model). To vet a
  candidate — a newer qwen or any new local model — pass `EVAL_MODELS="qwen3.6:latest,<candidate>"`.
- E2E prerequisites: `ARGO_PASSWORD` set; `test-one` and `bigproj` attached
  (`argo ~/Sources/test/test-one`, `argo ~/Sources/test/bigproj`) under
  `ARGO_WS_ROOT` (default `~/Sources/test`); each workspace a git repo with a
  **clean, green baseline** committed (the eval seeds a failing test on top and
  `git reset --hard` between runs).
- Each run prints its harness SHA and a ready-to-paste `eval-log entry` block —
  drop it under **Runs** below and fill in the Notes line.

---

## What each harness measures

### Fast probe (`scripts/eval.mjs`)
One turn per cell against `/api/chat` with Argo's real `SYSTEM_PROMPT` (read live
from `src/agent.ts`) and full tool set. **Metric: native-tool-call reliability** —
did the model emit a *native* tool call (so the ReAct loop can act), or stall by
narrating prose / writing the call as text/XML (which Argo can't parse → the run
ends)? PASS = a native tool call (any tool; appropriateness is judged separately),
or a substantive direct answer for the pure-question case. Cheap enough to tune
the prompt and context budget without slow runs.

Tasks: `simple-question` (Q&A, direct answer allowed), `simple-edit` (one-line
change), `web-search`, `complex-plan` (plan + implement).

### E2E (`scripts/eval-e2e.mjs`)
Real Argo loops on **self-verifying** tasks: a `setup` step seeds a *failing* test
(a spec for a function that doesn't exist yet), the agent runs, then a `check`
command must exit 0. **Metric: task completion** — the agent cannot pass by doing
nothing. Also scrapes per-run behaviour from the JSONL (see glossary). ⚠️
Destructive: `git reset --hard <baseline> && git clean -fd` between runs.

---

## Task catalog (E2E)

| id | workspace | what it seeds / asks | check |
|---|---|---|---|
| `store-addTask` | test-one | implement `addTask(tasks, title)` returning a new array with the task appended | `npm test` |
| `store-removeTask` | test-one | implement `removeTask(tasks, id)` returning a new array without the task | `npm test` |
| `store-deps` | test-one | **hard, multi-fn:** `addDependency` (+ cycle rejection), `getReadyTasks`, `hasCycle` | `npm test` |
| `bigproj-deps` | bigproj (tasklab, ~827 LOC / 11 modules) | **big, cross-cutting:** dependency graph on `TaskService` — `addDependency/removeDependency/getDependencies/getDependents/scheduleOrder/readyTasks`, with topological order + cycle detection + typed errors | `npm test` |

Fixtures live in `scripts/eval-fixtures/`. `bigproj` is the `tasklab` project; its
baseline must be green with the dependency feature **unimplemented** (the eval
seeds `test/dependencies.test.js`).

## Metrics glossary (E2E per-run columns)

- **iters** — iterations to done (or the max-iteration cap).
- **tools** — total tool calls.
- **plan** — number of `update_plan` calls (`0` = never planned).
- **gate** — plan/act gate fired: the model tried to mutate the project before
  planning and was steered to `update_plan` first. *Healthy.*
- **reg** (reground) — done-gate fired: on the first "I'm done" with an active
  plan, the model was nudged once to verify the objective. *Healthy.*
- **steer** — loop-steer fired: an identical call with no new information was
  skipped and replaced with an escalating steer.
- **ctx≈** — peak prompt tokens observed.
- **cmp** — compactions over the run.
- **wall** — wall-clock seconds from prompt to idle (includes the ~3 s status poll).
- **tok/s** — generation throughput. Needs the harness to log Ollama `eval_duration`
  (`token_usage.eval_duration_ms`); shows `?` until that lands (roadmap Phase 3(b)).
- **rss** — peak resident memory (MB) of the Ollama process(es) during the run.
- **CPU/GPU split + VRAM footprint** — from `ollama ps`, sampled during the run. True
  GPU-utilisation % on Apple Silicon needs `powermetrics`/sudo — out of scope; the
  split + tok/s are the lean cross-platform proxy.

A true *stall* (model narrates and stops without acting) emits no warning — it
shows up as low `iters` + `plan=0` + `FAIL`.

---

## Runs

> Baseline caveat: the runs below were made against the **working tree** carrying
> the plan/act mechanism (update_plan + gate + recitation + reground done-gate)
> on top of committed `6e96297`, before that work was committed — recorded here as
> `6e96297+dirty (planning mechanism)`. Once committed, future runs get a clean
> SHA and this becomes the "with planning mechanism" reference point.

### 2026-07-25 — fast probe — harness `6e96297+dirty (planning mechanism)`
Models: qwen3.6:latest, devstral:24b · 3 runs/cell · temp 0.8 · native-tool-call reliability
- qwen3.6:latest: 12/12 (100%)
- devstral:24b: 9/12 (75%)
- Notes: qwen rock-solid across all four task kinds. devstral's failures are not
  random — `stall(prose)` concentrated on the **mutation/plan** tasks (one-line
  change 1/3, plan+implement 2/3), Q&A and web-search pass 3/3. This is the
  tool-call **emission** ceiling (Phase 2), not reasoning — the plan/act and
  reground gates can't help a model that never emits the call that trips them.

### 2026-07-25 — E2E — harness `6e96297+dirty (planning mechanism)` — first attempt (bigproj infra-incomplete)
Models: qwen3.6:latest, devstral:24b, llama3.1:8b · 1 run/task · max_iter 60 · task completion
- qwen3.6:latest: 3/4 completed (bigproj-deps ERR — workspace not yet set up)
- devstral:24b: 0/4 completed
- llama3.1:8b: 0/4 completed
- Notes: qwen completed all three test-one tasks including the hard `store-deps`,
  each with `plan=1` and convergence in 7–8 iters (the 90-iteration drift class is
  gone). `bigproj-deps` failed on infrastructure (workspace/baseline not ready),
  not the model — see next run.

### 2026-07-27 — E2E — harness `6e96297+dirty (planning mechanism)` — clean baseline
Models: qwen3.6:latest, devstral:24b, llama3.1:8b · 1 run/task · max_iter 60 · task completion
- qwen3.6:latest: **4/4 completed (100%)**
- devstral:24b: 0/4 completed (0%)
- llama3.1:8b: 0/4 completed (0%)
- Notes: **This is our reference baseline.** qwen completed every task including
  the big cross-cutting `bigproj-deps` (11 iters, 21 tools, plan=1) — planning +
  converging, no drift. devstral under-executes: `plan=0`/few-iters on 3 of 4,
  finishing prematurely with the suite still red (emission ceiling, matches the
  probe). llama engages the workflow but lacks the coding capability — notably
  `store-removeTask` hit `iters=50, plan=7`: it re-planned seven times and
  thrashed to the iteration cap (a distinct capability-limit failure mode).
- **Decision:** adopt `qwen3.6:latest` as the target model. Keep the eval as the
  gate for future candidates (newer qwen, other local models) and for measuring
  every harness/prompt/tool/memory change from here.
