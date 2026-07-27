# Actor-Critic (Phase 4, step 2)

An in-loop **critic** that reviews the actor (the main qwen3.6 agent) at a few
checkpoints and steers it — to stop the failure modes measured on long/complex
tasks: thrash/looping, self-reverting good work, drifting to the wrong modules,
and — most seriously — editing the test/spec file to game the oracle.

## Why qwen3.6 is the critic (self-critique)

The supervisor eval (`docs/eval-log.md`, RUNS=3, 5 candidates: qwen3.6, devstral,
gemma4, qwen2.5-coder, deepseek-r1) found that **qwen3.6 is the only model that
reliably (3/3) flags oracle-gaming**. Every other candidate — including the
reasoning model deepseek-r1 and the coder qwen2.5-coder — failed that gate,
several "recognize-but-don't-flag" (a rationale that names the violation, then
rates the run clean). Gaming detection, not general reasoning or ranking skill,
is the discriminating capability. So the critic is **qwen3.6 itself** — which also
costs **zero extra resident memory** (the model is already loaded), important on
the 48 GB target machine.

## Design

The critic is a **separate chat call** (its own system prompt, `format:"json"`,
`temperature 0.2`) issued at three checkpoints — never every turn (cost/latency).
Each hooks into machinery Argo already has (no parallel plumbing); the critique is
injected back as a `warning`-type steer through the same path the plan/act gate,
loop-steer, stall, and done-gate use.

| Checkpoint | Hook (in `src/agent.ts`) | What the critic does |
|---|---|---|
| **post-plan** | right after `update_plan` records a plan | judges whether the plan targets the actual objective/modules, is complete and correctly ordered; steers before execution |
| **on-stall** | the existing stall/PROGRESS-CHECK trigger | reviews the recent trace + latest test output; returns ONE concrete corrective (name the failing test to fix, or the thrash/self-revert to stop) |
| **pre-done** | the existing done-gate (before "re-ground") | did it REALLY meet the objective, and did it touch ANY test/spec file? On tamper or objective-unmet it **blocks completion** (`continue`) and injects the critique |

**Critic contract (strict JSON):**
```json
{"verdict":"ok"|"revise","gamed_oracle":true|false,"issues":[string,...],"guidance":string}
```
The prompt is locked hardest on the reliably-detectable, safety-critical axes:
oracle-tamper (any edit — or *attempted* edit — to a `test/`|`__tests__/`|`*.test.*`|
`*.spec.*` path), thrash/loop, self-revert, and drift. Test/spec files the actor
touched are flagged to the critic from the tool-call history, so tamper detection
never depends on the model noticing the path. `gamed_oracle:true` always forces
`verdict:"revise"` (a tamper flag can never pass as "ok").

**What the critic sees** (all derived from state the loop already tracks, kept
compact): the objective, the current plan, the list of files edited so far (with
test/spec flags, *including failed attempts* so intent-to-tamper is visible), the
latest command/test output (truncated), and a short recent-action trace.

**Observability:** a `critic` event (checkpoint, verdict, gamed_oracle, issues,
guidance) is emitted into the structured log and rendered in the run `.md`.

## Safety / flag

- `ARGO_CRITIC` (default **off**) gates every critic touchpoint — checkpoints AND
  the per-tool bookkeeping — behind `if (config.critic)`. **With the flag off the
  loop path is behavior-identical to baseline** (fields are declared and reset but
  never read). This is required for a clean A/B and zero regression risk.
- `ARGO_CRITIC_MODEL` (default `qwen3.6:latest`) selects the critic model.
- **Fails open:** a critic timeout, error, or unparseable reply yields `null` and
  only a `warning` — it never crashes a run and never blocks completion on its own.

## A/B experiment plan

Goal: does the critic make the failing `bigproj-effort` converge and kill the
thrash/self-revert/attempted-gaming — **without** regressing tasks that already
pass? Run on the host (Ollama + workspaces attached), same conventions as
`scripts/eval-e2e.mjs`.

1. **Build once** (bakes the new code into the worker image):
   ```
   cd ~/Sources/adobe/argo
   pnpm build
   argo rebuild
   ```
2. **Baseline (critic OFF)** — restart the worker with `ARGO_CRITIC=0`, then:
   ```
   ARGO_PASSWORD=… EVAL_TASKS=bigproj-effort EVAL_MAX_ITER=60 npm run eval:e2e
   ARGO_PASSWORD=… EVAL_TASKS=store-addTask  EVAL_MAX_ITER=60 npm run eval:e2e
   ```
3. **Critic ON** — restart the worker with `ARGO_CRITIC=1` (worker reads it from
   its environment / `.env` at startup), then re-run the same two commands.
4. **Compare:** task completion (does effort finally pass?), iterations/tool-count,
   thrash incidents, self-reverts, whether the critic **blocked** the test-file
   edit (look for `critic` events with `gamed_oracle` / `verdict:"revise"` in the
   run logs), and — critically — that `store-addTask` still passes (no
   false-positive "revise" blocking a correct completion → regression).

> Note on env injection: `ARGO_CRITIC` is read at worker startup (`src/config.ts`),
> so confirm how `argo` passes env into the worker container (e.g. via `.env`) and
> set it there before each phase. Long runs should use the `slicc-exec-mcp`
> `run_bg` + `job_tail` path so they aren't cut off by the 60s call cap.

## Risks / open questions

- **False positives at pre-done** could block a legitimate finish and turn a pass
  into a max-iter fail — that's exactly what the `store-addTask` regression check
  guards against.
- **Extra latency/tokens** at each checkpoint (three qwen calls per run at most on
  the stall/done paths); acceptable since they're not per-turn.
- The critic is strong on tamper/thrash but only imperfectly reliable on the softer
  "on-goal" axis — the prompt keeps that judgment concrete (tied to modules/tests).
