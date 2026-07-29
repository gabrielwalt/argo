# Grounding & self-consistency guard (Phase 4)

A pre-done guard for **writing / research tasks** — the class the coding critic
(`ARGO_CRITIC`, a test/spec oracle) does not cover. Flag-gated by `ARGO_GROUNDING`,
**OFF by default** so the baseline loop path is byte-identical (clean A/B, zero
regression risk). It reuses the critic model (qwen3.6 self-review) and `critic.ts`'s
robust JSON parse; zero extra resident memory.

## Why

Measured on a real document-construction eval — a French, print-ready A4 booklet built
from live web sources (`~/Sources/test/booklet`, prompt in `scratch/booklet-prompt.txt`),
4 baseline runs. Findings:

- **Structure is already reliable**: every run produced exactly 4 A4 pages, pure-white
  background, self-contained (0 `<img>`, 0 external refs), 10-13 inline `<svg>`, all
  required sections, ~750-915 words, essentially no overflow. So layout/verification was
  NOT the gap (the initial hypothesis was refuted by data).
- **The gap is factual**, in two forms:
  1. **Fabrication of under-sourced specifics.** When a detail is thinly documented the
     model invents a confident specific that is *different across runs* — e.g. the
     secondary artist's school (RISD vs SUNY New Paltz), a teaching affiliation in two
     different cities, an invented venue. Root condition: Argo collapses tool results to
     stay context-lean (`KEEP_RECENT_TOOL_RESULTS`), so the fetched source text has
     scrolled out of the live window by the time the prose is written, and the model
     fills the gap from memory.
  2. **Internal inconsistency.** The same constant restated with different values in one
     document — e.g. a furnace temperature given as 1150 °C in a heading and 2100 °C in
     the body (2 of 4 baseline runs drifted on temperature).

The maintainer authoring note (top of `agent.ts`) says to fix a failure in the HARNESS
with real feedback rather than pile rules into the system prompt. This guard is that:
a checkpoint that reads the actual artifact and returns concrete, actionable feedback.

## What it does

At the PRE-DONE gate, only for a run that produced a **document artifact** (a
`.html/.htm/.md/.markdown/.txt/.rst` file under `/workspace` — see `isDocPath`):

1. **Deterministic pre-scan** (`findNumericConflicts`): extracts every temperature
   mention (°C, °F→°C, "degrés Celsius"), clusters them (tol 75 °C); >1 cluster ⇒ a
   confirmed internal conflict. High precision, near-zero false positives; the concrete
   drift the eval exposed.
2. **Fact-checking critic pass** (`runGroundingCritic`): a separate qwen3.6 call with a
   fact-checking-editor prompt (temperature 0.2, `format:"json"`) that reviews the
   document text + the fetched-source URL list + the confirmed numeric conflicts, and
   flags (a) likely-fabricated/unsupported specifics and (b) internal inconsistencies.
   Same `{verdict,gamed_oracle,issues,guidance}` contract as the coding critic
   (`gamed_oracle` always false here).

On `verdict:"revise"` it injects a concrete steer (guidance + issues + confirmed
conflicts + "re-verify against a fetched source or generalize; reconcile restated
numbers") and **blocks completion** — the loop continues so the agent revises. Runs **at
most once per run** (a once-guard, so it cannot loop). **Fails OPEN**: a timeout / parse
failure / non-writing run yields `null` and never blocks.

## Files

- `src/grounding.ts` — pre-scan + prompt + call + parse (self-contained).
- `src/grounding.test.ts` — unit tests (temperature detection incl. °F and entities,
  clustering, `isDocPath`, prompt assembly).
- `src/agent.ts` — `runGroundingCheckpoint(...)` + a hook in the done-gate + a
  `groundingChecked` once-guard.
- `src/config.ts` — `config.grounding` gate on `ARGO_GROUNDING`.
- `src/types.ts` — adds `'grounding'` to the `critic` event checkpoint union (auditable
  in the JSONL/`.md` logs, same as the coding critic).

## Rollout / A-B

Enable by adding `ARGO_GROUNDING=1` to `~/.config/argo/env` and restarting the worker
(central forwards non-secret global-env vars into the worker container). A/B on the
booklet task: run OFF (baseline) vs ON; metrics = internal temperature-consistency
(objective, distinct values per doc) and a judge's `factual_accuracy` rubric.
