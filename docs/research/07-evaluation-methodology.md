# Evaluation methodology

Discriminating power · saturation · partial credit · reliability over k · tamper resistance · fair
cross-harness comparison

Hypotheses: **H08** (integrity gate cannot detect tampering — VALIDATED → FIXED), **H09** (the rubric
measures Docker overhead — VALIDATED → FIXED), **H10** (whole-suite correctness gives points for doing
nothing — VALIDATED → FIXED), **H11** (intervention counters silently stopped matching — VALIDATED →
FIXED), **H12** (the suite can distinguish Argo from Hermes — DISMISSED). Full plan:
`/shared/argo-catchup/EVAL-PLAN.md`; applied: `/shared/argo-program/BATCH1-APPLIED.md`.

---

## 1. What the concept is

Argo's method is "measure → change one thing → measure again". **That method is worth exactly as much
as the instrument's resolution.** This document is about the instrument.

Five properties matter:

- **Discriminating power** — can the suite tell two configurations apart?
- **Saturation** — how many items carry information rather than always passing?
- **Partial credit** — can it distinguish "nearly finished" from "did not start"?
- **Reliability over k** — does the metric refuse to be computed from one sample?
- **Tamper resistance** — can a run that gamed the oracle score well?

Plus **fair cross-harness comparison**, which is a separate problem with its own confounds.

**North star served:** none directly, and all of them transitively. Every hypothesis in this body is
settled by a number this instrument produces.

---

## 2. External evidence

### Reliability over k: use pass^k, not mean pass rate

τ-bench introduces **pass^k** — the probability that *all* k independent trials succeed — and reports
that state-of-the-art function-calling agents are "quite inconsistent": pass^1 under 50 % while
**pass^8 is under 25 % in retail** ([arXiv 2406.12045](https://arxiv.org/abs/2406.12045)).

**Class B, transferability DIRECT.** This is a metric definition, not a model result; it applies to any
agent. And it is a concrete improvement on Batch 1's rubric: the new 20-point reliability term is *this
task's pass rate over k runs*, i.e. a mean. A mean of 2/3 and 2/3 is indistinguishable from 1.0 and 1/3
pooled — pass^k is not. **For a project whose north star is "runs a long time without losing the goal",
pass^k is the metric that matches the goal**, because it penalises exactly the inconsistency that a
long-horizon agent must not have.

Recommendation: report both. Score on pass^k for the reliability term; report mean pass rate as the
diagnostic.

### Saturated items carry no information; mid-difficulty items carry it all

tinyBenchmarks uses item-response theory to show that **100 curated examples reproduce MMLU
performance estimates** from 14 000 ([arXiv 2402.14992](https://arxiv.org/abs/2402.14992)).

**Class B, transferability PARTIAL** — MMLU is multiple-choice QA, not agentic coding, and IRT needs many
subjects to fit. What transfers is the underlying fact: **an item everyone passes and an item everyone
fails both have zero discriminating power**, and the information lives near p ≈ 0.5. `EVAL-PLAN.md` §3.2
independently specifies a difficulty distribution with the mid band at p = 0.4–0.7 and calls it "where
all discriminating power lives". That is the same conclusion reached from the same principle, and it is
worth noting the convergence: the eval plan is not idiosyncratic.

### The oracle is the weakest link, measurably

SWE-Bench+ manually screened successful patches: **32.67 % involved solution leakage** (the fix was in
the issue text) and **31.08 % passed due to weak test cases**. Filtering both dropped SWE-Agent+GPT-4's
resolution rate from 12.47 % to **3.97 %** ([arXiv 2410.06992](https://arxiv.org/abs/2410.06992)).

**Class B, transferability DIRECT in principle.** Argo's situation is structurally worse in one respect:
the `verify` command inside the harness is **model-supplied**, so the agent partly writes its own
oracle. And structurally better in another: the eval's seeded tests are authored by the harness and now
byte-compared. The transferable rule: **integrity and regression are gates, not points**, which is what
Batch 1 implemented.

### A judge that shares the model with the agent is biased toward it

LLM evaluators show **self-preference**, correlated with self-recognition
([arXiv 2404.13076](https://arxiv.org/abs/2404.13076)). **Class B, transferability PARTIAL.** Argo's
quality judge is `qwen3.6` self-critique, judging `qwen3.6` output. That is a reason to cap the judge's
weight — which Batch 1 does at 20 points, gated behind the deterministic check. Keep it capped. The
same consideration applies asymmetrically in the Argo-vs-Hermes comparison: both harnesses run the same
model, so the judge is equally related to both, which is a genuine mitigation of the bias *for that
comparison specifically*.

### Cost should be reported, not scored

The overthinking result — 30 % better performance and 43 % lower cost from a selection rule — shows cost
and quality are not a single axis ([arXiv 2502.08235](https://arxiv.org/abs/2502.08235)). **Class B,
transferability PARTIAL.** Supports Batch 1's decision to report a cost vector rather than fold speed
into the score.

### Simple baselines belong in the suite

Agentless achieved the best open-source SWE-bench Lite result at $0.70 per instance without an agent loop
([arXiv 2407.01489](https://arxiv.org/abs/2407.01489)). **Class B, transferability PARTIAL.** The
methodological point: **a non-agentic baseline is a meaningful reference line.** Argo has a version of
this already — the `ARGO_AGENTS=0` single-loop path — and it is the *only* comparison that has ever
produced a differing outcome on any task (`bigproj-deps`: baseline FAIL, multi-agent PASS). Keep the
single-loop arm as a standing reference, not as an afterthought.

---

## 3. Our own evidence

### The instrument had no discriminating power, and this is the binding constraint

- **14 of 18 catalog tasks have never failed, for either harness, in any recorded run.** The four that
  have ever varied — `bigproj-deps`, `bigproj-effort`, `bigproj-duedate-bug`, `bigproj-observability` —
  are all in the same workspace and the same task class.
- **The suite has never once separated Argo from Hermes on correctness.** The only documented differing
  outcome is Argo-baseline vs Argo-multi-agent. `bigproj-duedate-bug` failed for *both* harnesses, which
  discriminates nothing. **H12 DISMISSED.**
- **`correctness` produced exactly one value in 12 real scored runs: 70/70.** The partial-credit term
  built specifically to escape the ceiling never once returned a partial value. **H10.**
- **`integrity` produced exactly one value: 15/15 — and structurally could not produce another.**
  `testFileTampered` (`tasks.mjs:96`) ran `git diff --name-only`, which lists only *tracked*
  modifications; every seeded test file is **untracked** (confirmed on the host: `?? test/transpose.test.js`
  in `eval-suite2`; `git ls-files test/` in `bigproj` lists only the six pre-existing tracked tests).
  **H08.**
- **The entire observed dynamic range of the score — 87 to 100 — came from the speed term**, which
  compares Argo-in-Docker against Hermes-on-the-host with `--yolo --ignore-rules`. **H09.**
- **The floor was high where difficulty was.** `correctness = 70 × (passing / all tests the check runs)`,
  and for `bigproj`/`test-one` the check is `npm test` — the whole suite. Doing literally nothing scored:
  `bigproj-duedate-bug` **81**, `bigproj-effort` **75**, `bigproj-observability` **74**, `bigproj-deps`
  **71**. **H10.**
- **Two of three intervention counters were broken.** `gate` worked in July (49 firings) and broke at
  `e045d0a` when the message moved from `warning` to `tool_result.error` (24 September firings invisible);
  `steer`'s regex matched only pre-`ARGO_LOOP` wording and has been blind since 2026-08-04, while the
  ladder fired 158 L0 / 24 L1 / 13 L2 in September. Nothing counted near-duplicate nudges (180),
  stall/progress checkpoints (199+52), verify executions (87/22), role rejections (102), gate round-trips
  (278), or cap-hits (44). **Every `g=0` and `s=0` in the eval log is an artifact; at least two eval-log
  conclusions rest on them and should be withdrawn. H11.**
- **`history.jsonl` was polluted from day one.** Four rows at `2026-09-03T11:35:25` record
  `bigproj-deps`/`effort`/`duedate-bug`/`observability` as `completed:false, score:0, status:"ERR",
  wallMs:0` — a `POST` failure cascade during the documented detach/reattach to set `ARGO_AGENTS=1`.
  `trend.mjs` read them as four real failures.
- **`EVAL_RUNS` defaulted to 1** on tasks documented to range **23–174 iterations and 177–1616 s**
  (`bigproj-effort`). At n=1 a task that always passes is indistinguishable from one that passes 60 % of
  the time — which is exactly the band a discriminating item occupies.

### What Batch 1 fixed, and how it was validated

Landed `fd171d3`. Detail in `/shared/argo-program/BATCH1-APPLIED.md`.

- **Integrity gate that works**: seeded test files compared against the fixture bytes the harness wrote.
  **Demonstrated: +1 byte (2422 vs 2421) voids a perfect run to `total: 0`.** Promoted from 15 points to
  a gate.
- **Regression gate**: every test passing at baseline must still pass; failure ⇒ 0.
- **Correctness scoped to seeded tests only** — the do-nothing floor is now 0, not 71–81.
- **Speed out of the score**, reported as a cost vector, plus a friction vector (rejected calls, loop
  blocks, verify failures, cap-hits, gate round-trips).
- **Counters rebuilt and validated across both event-shape epochs**: 19 `warning` patterns + 3
  `tool_result.rejected` patterns + cap-hit + eviction, each anchored to a `src` `file:line`, with a
  self-check that asserts first-match uniqueness and stamps `counterSelfCheck` on every row.
  **0 unmatched of 982 September `warning` events and 0 of 361 July.** `gate` now counts off the
  structured `tool_result.rejected` field (`types.ts:26`) and only sub-classifies by text, so it cannot
  silently go to zero on a re-wording; unmatched messages are recorded with prefixes in `warnUnmatched`.
- **Three pattern bugs found *because* of that validation** — a 300-char gap dropped 8 of 24
  `verifyFail` and 6 of 113 `summaryAsk`; `roleReject` missed 4 of 102 where a stalled model emitted
  multi-line prose as a tool name; `taskAdvance` missed 3 of 10 July firings on historical wording.
- **Five intervention channels found that need no regex at all** and are now counted by field:
  `tasks.action == 'replanned'` (91 — counted by nothing, anywhere, before), `'advanced'` (105),
  `'planned'` (78), `boss_verdict.action` (1 escalate, 0 inject, 0 restart),
  `task_graph.steps.length` (84 of 85 graphs = 1 step).
- **Schema discipline**: `appendHistory()` throws unless `harness ∈ {argo, hermes}` and `rubricVersion`
  is present. A row that cannot say what produced it is not written. `trend.mjs` refuses to compare
  across `rubricVersion`.
- **`EVAL_RUNS` default 3**; ~7 saturated tasks retired, ~11 kept.

**Batch 1's conclusion is the important one: the instrument now works but still has no discriminating
power.** Authoring hard tasks is the binding constraint on everything else, ahead of most mechanism
work.

### Two measurement hazards that are still open

- **An unexplained 5–8× per-iteration slowdown.** Three single-loop rows at 11:29–11:35 ran at
  ~14 s/iteration (`store-addTask` 12 it / 187 s) against ~2 s/iteration for the same tasks earlier the
  same morning (16 it / 33 s), both on `qwen3.6`. The window immediately follows a Hermes run; Hermes's
  provider is named `ollama-launch` and points at the same `127.0.0.1:11434`; the model is ~23 GB on a
  48 GB machine. **Until this is explained, no wall-clock comparison drawn from interleaved runs holds —
  including the 1.6×/6× figures the roadmap treats as settled.** Standing rule: never interleave.
- **Temperature.** Argo pins temp 0.8 / top_p 0.9 / top_k 40; Hermes sets none. At n=3 on tasks ranging
  23–174 iterations, sampling variance eats the signal. This is a decision, not a finding — see §7.

---

## 4. Simplest sufficient implementation

Batch 1 did most of it. What remains is small and specific.

### (i) Report pass^k as the reliability term

One line in the scorer: `reliability = 20 × (all k runs passed ? 1 : 0)` — or, better, the pass^k
estimate with k stated. Keep mean pass rate in the reported diagnostics. **What going simpler loses:** a
mean lets 2/3 and 2/3 average to the same number as 1.0 and 1/3, and inconsistency is the exact property
the north star forbids.

### (ii) A floor check in the calibration protocol for every new task

`EVAL-PLAN.md` §3 already pilots every new task against a reference implementation. Add: **verify the
do-nothing score is 0.** That single check is what would have caught H10 at authoring time rather than
after 12 runs.

### (iii) The mid band: four to five tasks at p = 0.4–0.7

This is authoring work, not code, and it is the binding constraint. `EVAL-PLAN.md` §3.3 specifies the
classes, each justified by a failure mode observed in Argo's own logs — including `bigproj-cascade`
(a spec whose obvious fix breaks one of the 36 tracked tests, testing whether the model scopes its
self-written oracle too narrowly) and the Tester trap task (P2). **Cheapest first:** `bigproj-cascade`
needs no new workspace and no new code.

### (iv) Keep the single-loop arm as a standing reference

`ARGO_AGENTS=0` is the only comparison that has ever produced a differing outcome. It is also the
non-agentic-baseline discipline the Agentless result argues for. Record `agents` on every row (Batch 1
does) so the two series never pool again.

### (v) Do nothing more about the rubric

The temptation after Batch 1 will be to add dimensions. Resist it: the rubric now has three terms and a
gate, and its problem is **item difficulty**, not scoring resolution. Adding a fourth term to a suite
where 14 of 18 items never vary buys nothing.

---

## 5. What to watch out for when implementing

- **A metric regression can ship inside a correctness improvement.** That is exactly what `e045d0a` did:
  "unified tool-rejection surfacing" was a real improvement and it silently broke the `gate` counter.
  Batch 1's `counterSelfCheck` plus `warnUnmatched` is the structural defence — **do not remove it**, and
  when a message is re-worded, check the row for unmatched prefixes rather than assuming.
- **Prefer counting structured fields over prose.** Five channels turned out to need no regex at all
  (`tasks.action`, `boss_verdict.action`, `task_graph.steps.length`). Any new intervention should emit a
  field, not a sentence.
- **`tasksAdvanced` (105) is deliberately not `taskAdvance` (69).** The ledger emits `advanced` on every
  advance; the nudge warning fires only when a next task exists, so 36 final advances cost no round-trip.
  Both numbers are recorded. Do not "reconcile" them.
- **Never compare across `rubricVersion`.** `trend.mjs` refuses; keep it refusing. Adding three test
  files to `bigproj`'s `eval-baseline` also changed the denominator for `bigproj-deps`/`effort`/`duedate-bug`,
  so their pre-change scores are not comparable to any later row either.
- **Retired tasks are retired from the *score*, not from the smoke check.** `trivial-qa-arithmetic` is the
  only item that exercises the Boss `ANSWER` fast path and it caught the marker-loss regression. Keep the
  floor probes, unscored.
- **Re-verify `bigproj-duedate-bug`'s fixture.** Both harnesses failed the same task the same day after a
  month of it being easy. That points at the task or the workspace state, not at the harnesses. Confirm
  the seeded spec still matches `src/query.js` before drawing further conclusions from it.
- **Do not interleave Argo and Hermes runs.** Standing rule until the slowdown is explained. Pin
  `OLLAMA_KEEP_ALIVE`, warm up, and re-measure.

---

## 6. How to validate the instrument itself

The instrument is the one thing that can be validated **without spending GPU time**, because the
artifacts are already on disk (`eval-runs/diffs`, `eval-runs/ledgers`, 567 logs).

- **Counters:** re-run the pattern set over all 567 logs and confirm the counts match those derivable by
  hand. Batch 1 did this and got 0 unmatched in both epochs. Repeat after any wording change. **Divergence
  means the emitter is wrong**, which is the only possible failure mode of instrumentation.
- **Integrity gate:** the demonstration is the test — (a) clean run must pass; (b) a one-byte edit to a
  seeded test must void the run to `total: 0`; (c) tampering with a tracked test file or the test script
  must void it; (d) with no baseline ref, the gate must report `integrity-unevaluable`, **not** `ok:true`.
  All four are in `BATCH1-APPLIED.md` §Verification recipe.
- **Regression gate:** seed a change that breaks a previously-passing tracked test and confirm score 0.
- **Do-nothing floor:** run the scorer against an untouched workspace and confirm 0 (was 71–81).
- **Discriminating power, measured directly:** after the next k=3 battery, compute per-task pass rate.
  **The suite is fixed when ≥4 tasks land in 0.4–0.7 and at least one task separates two configurations.**
  Until then, report saturation explicitly: a task where every run passes carries no information and must
  be reported as saturated, not as a result (PLAN standing rule 6).
- **The four fabricated `ERR` rows** must be quarantined and `trend.mjs` must refuse them.

---

## 7. Decisions this document cannot make

These need Gabriel, and they change what the numbers mean:

1. **Turn budget for the Argo-vs-Hermes comparison.** Cap Argo at 60 to match Hermes's `max_turns: 60`,
   or run uncapped with turns-to-solve as the primary cost metric? Argo has used 100–104 on hard tasks;
   the current comparison silently gives the two harnesses different budgets.
2. **Temperature for eval runs.** Argo pins 0.8. Lowering it for evals would reduce variance and make
   k=3 much more informative, at the cost of measuring a configuration that is not the shipped one.
3. **A larger external repo as the long-horizon substrate.** `tasklab` at 827 LOC cannot fill a 65 k
   context. This is the blocking dependency for the north star, and no amount of eval engineering
   substitutes for it.

---

## 8. Links

- **H08** — VALIDATED → FIXED. §3. Gate demonstrated at +1 byte.
- **H09** — VALIDATED → FIXED. §3. Speed reported, not scored.
- **H10** — VALIDATED → FIXED. §3. Correctness is seeded-tests-only.
- **H11** — VALIDATED → FIXED. §3. Counters validated cross-epoch, 0 unmatched of 982 + 361.
- **H12** — DISMISSED. §3. The suite has never separated Argo from Hermes on correctness.
- **H24 / H25** — both need eval-side work (a lowered compaction threshold; multi-turn task support).
  See `01` and `04`.
- Primary sources: `/shared/argo-catchup/EVAL-PLAN.md` (diagnosis + replacement suite),
  `/shared/argo-program/BATCH1-APPLIED.md` (what landed and how it was validated),
  `/shared/argo-program/PLAN.md` BATCH 1.
- Roadmap: 2026-09-03 "Eval-strategy rework: rubric scoring (0-100) + speed-ratio target"; 2026-09-03
  "#2 (already done, this pass): eval framework correctness + tracking"; Phase 1 and Phase 3.
- Related: `03` (tamper detection on the agent side), `06` (which budget each harness had).
