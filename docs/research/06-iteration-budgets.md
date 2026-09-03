# Iteration budgets and pacing

Per-frame caps vs a global budget · stand-up cadence · the fail-open on cap

Hypotheses: **H13** (frames that hit their cap are recorded as successes), **H21** (~20 iterations as a
chunk and stand-up cadence beats a hard per-role cap), **H22** (a ~200-iteration global budget is the
right hard boundary), **H01** (more iterations improve results — DISMISSED). Roadmap: 2026-09-03
register, "The iteration-budget directive"; 2026-09-03 "#1-ranked: make the gate chain
iteration-budget-aware"; **Item 5**.

---

## 1. What the concept is

Argo currently has **hard per-role kills** and **no global budget at all**.

`ROLE_MAX_ITERATIONS` (`frames.ts:38-43`), confirmed in the wild by `/shared/argo-program/LOG-FACTS-bigproj.md`:

| role / checkpoint | cap |
|---|---|
| Boss task-start | 10 |
| Boss stand-up / final | 15 |
| Planner | 20 |
| Implementer | 60 |

At the cap, `agent.ts:1801` makes the string `"Reached maximum iterations (N) without a final answer."`
the frame's **final answer**, and `deriveFrameResult` (`dispatch.ts:191`) records that as
`status: "success"`.

Gabriel's directive separates two things the code conflates:

- **~20 iterations is an ideal chunk size and a stand-up cadence** — the Planner should size each
  sub-agent task to roughly that much work, and the harness should trigger a Boss stand-up around that
  interval. **Not a kill.**
- **~200 iterations is a hard global boundary** for the whole run, all frames combined — sized to the
  observation that the agent has never been driven past roughly 200 iterations without ending in
  hallucination. **No cross-frame total exists anywhere.**

**North star served:** all four clauses, indirectly. A budget is how "runs a long time" is bounded, and
the cap fail-open is why "losing track of progress" is currently invisible to the harness.

---

## 2. External evidence

### More turns is not monotonically better — and the reason is named

*The Danger of Overthinking* analyses 4 018 SWE-bench Verified trajectories: higher overthinking scores
**correlate with decreased performance**, reasoning models overthink more than non-reasoning models, and
simply **selecting the solution with the lower overthinking score improved performance by almost 30 %
while reducing cost 43 %** ([arXiv 2502.08235](https://arxiv.org/abs/2502.08235)). The three named
patterns — Analysis Paralysis, Rogue Actions, Premature Disengagement — are a taxonomy of *what*
extra turns get spent on.

**Class B, transferability PARTIAL.** Large reasoning models at frontier scale, and their selection
method (pick the trajectory with less overthinking) requires generating several trajectories, which Argo
cannot afford. What transfers is the direction and the taxonomy, and it agrees exactly with H01.

### Test-time scaling flattens, then reverses

s1's budget forcing — suppressing the end-of-thinking token to make the model think longer — improves
performance, and the paper is explicit that the gains flatten and the technique has limits
([arXiv 2501.19393](https://arxiv.org/abs/2501.19393)). **Class B, transferability WEAK**: single-turn
reasoning with a distilled model, not a tool-using agent loop, and the mechanism (extend internal
reasoning) is not the mechanism Argo has (extend the number of tool-using turns).

Recording it because it is the strongest-looking external argument *for* larger budgets, and it does not
survive contact with Argo's setting. Anyone proposing "more iterations" on the basis of test-time
scaling should be pointed at H01 and at the overthinking paper.

### Bounded rounds, not open loops

Every mature verification loop in the literature is round-bounded: Reflexion's trials, Magentic-One's
stall counter forcing a re-plan rather than grinding
([arXiv 2303.11366](https://arxiv.org/abs/2303.11366),
[arXiv 2411.04468](https://arxiv.org/abs/2411.04468)). **Class C/D, transferability DIRECT** as a design
constraint. Argo already has `MAX_TESTER_ROUNDS` and a 4-firing cap on the no-progress re-anchor; the
pattern is understood, it just is not applied globally.

### What the literature does not say

**Nobody publishes a defensible number for "iterations before an agent loses the goal".** It depends on
the model, the harness, the context policy and the task. Gabriel's ~200 is a local observation and is
better evidence for Argo than anything external — with one crucial qualification recorded in §3.

Hermes, Argo's comparison harness, is capped at `max_turns: 60`. Argo multi-agent has **no total cap**
and has used 100–104 on hard tasks. Any cost comparison must state which budget each side had; this is a
standing protocol rule, not a nicety.

---

## 3. Our own evidence

### 43 frames ended blank at their cap and were recorded as successes

| role | frames | ended at the cap | rate |
|---|---|---|---|
| Planner | 23 | **9** | **39 %** |
| Boss | 204 | **26** | 13 % |
| Implementer | 61 | 6 | 10 % |
| Tester | 85 | 2 | 2 % |
| baseline / top-level | 194 | 7 | 4 % |

**44 of 44** September `error` events are the cap string — a number nothing had ever counted before
Batch 1. `LOG-FACTS-bigproj.md` makes the shape visible per log: a cap-hit is `N/N` with a terminal
`error` event, e.g. `10/10 error` for Boss task-start frames at 00-11-16, 00-31-34, 00-40-48, and
`15/15 error` for Boss final checkpoints at 00-35-34 and 00-41-55.

**The important nuance, from the cone's log pass:** the log's terminal event *is* `error`, but the
ledger conclusion for the same frame is `status:"success"`. The information is produced and then
discarded at the frame boundary. So **`deriveFrameResult` is the place to fix, not the emit site** — it
must consult the cap/terminal state instead of treating "returned a string" as success.

### The Planner's 39 % is not a budget problem

It is the task-sequencing trap (`02` §3). Raising the Planner's cap would not have helped; the frame was
being killed by a gate on its own output contract. **This is worth stating because "the budget was too
tight" was one of the three failed hypotheses** about the Planner. Budgets are a tempting explanation for
cap-hits and were the wrong one here.

### The gate chain is not budget-aware, and it has ended correct runs

Across the corpus: 76 task-advance nudges + 113 summary asks + 50 final reconciliations + 115 done-gate
re-grounds = **354 forced extra model turns**, none of them budget-aware. September alone: 278.

Diagnosed from two independent traces, with the error signature present in logs since 2026-07-27: **three
consecutive gates firing in iterations 58/59/60 ended a *correct* run in "no final answer".** This is the
roadmap's own #1-ranked finding and it is still unimplemented. Confirmed by inspection: no budget
awareness exists anywhere in `agent.ts`.

### Stand-up cadence is coupled to the wrong signal

The stand-up trigger is **10 action episodes** plus a >25-iteration frame (`LARGE_FRAME_ITERATIONS = 25`)
plus a `hadTrouble()` signal (`dispatch.ts:711-719`) — not an iteration interval. Result: **22 stand-ups,
16 `NONE`, 3 cap-hit blank, 3 no-keyword**, and exactly **one `boss_verdict` event in the whole corpus**
(an `escalate`). `INJECT` and `RESTART` have never fired. `ledger.recordStandup` (`ledger.ts:145`) is
never called, so the 16 healthy stand-ups left **no trace anywhere**.

### Resumed frames blind every budget signal

`resumeFrame` → `agent.chat()` restarts `lastIterationCount` from 1 (`agent.ts:1288`), observed directly:
the marker-retry resume wrote a new log beginning at `ITER 1/10`. So after a resume,
`getIterationCount()` reports the resume's count, and **`hitCap` (task-start), `justRanLong` (>25 →
stand-up) and `hadTrouble()` are all blinded**. Latent today (2 marker retries, 0 REDOs, 1 replan);
live the moment REDO or replan works. H14.

### H01, stated once more because it constrains everything here

60 → 90 iterations made `bigproj-effort` **worse** (5/6 → 3/6), with thrashing, self-reverting and an
attempted oracle edit. **The lever is supervision, not turns.** Any proposal to raise a budget has to
answer this.

### The ~200 figure comes with an analytical caveat that changes its meaning

Gabriel's ~200 is a measurement of Argo **without** its anti-drift machinery: the pinned anchor has never
been called, durable memory has written twice and wrote noise, eviction has fired three times and never
with a pinned objective, and the `MEMORY.md`/`AGENTS.md` read paths are unreachable in every eval
workspace. Whether ~200 is a ceiling or an artifact of running without those is an **open experiment** —
and it is the same experiment as H23's falsification test. That is a reason to run H23 first.

Observed totals today reach **104 across 8 frames**. Nothing would notice 300.

---

## 4. Simplest sufficient implementation

Three pieces, strictly ordered. The ordering is a correctness requirement.

### (i) First: make a cap-hit representable — ~15 lines, no eval needed

```
deriveFrameResult(): iterationCount >= maxIterations → status: 'partial'
parseTesterVerdict / parseTaskGraph / parseBossVerdict: capped ⇒ escalate, never fail open
```

**This must precede (ii) and (iii).** A global ~200 cap *will* be hit sometimes; if the same fail-open
handles it, the harness will discard an entire run's result exactly as it currently discards a Planner's
task graph. Also fix `resumeFrame`'s iteration-counter reset (H14) here, or a resumed frame contributes
nothing to the global total.

### (ii) A global budget: one integer

Put a counter on the run context; add each frame's iteration count as the frame closes; expose the
remaining budget to the Planner (so it can size steps) and to the gates. When
`globalRemaining < max(3, 10 % of the frame's cap)`, the task-advance / summary-ask / reconciliation /
re-ground gates **ask for a final answer instead of another round-trip**. That is the budget-aware yield
already designed in the roadmap, plus one integer.

**Going simpler — a global cap with no yield — is worse than no global cap**, because the run gets killed
at 200 with no chance to summarise, and the fail-open behaviour returns in a new place.

### (iii) Stand-ups on an iteration cadence, alongside the existing trigger

Add "cumulative frame iterations since last stand-up ≥ 20" as an **additional** trigger, not a
replacement for the 10-action-episode one. Call `ledger.recordStandup` so a stand-up leaves a trace
whatever its verdict. Then have the stand-up prompt **read accumulated summaries first** and use tools
only if they are insufficient — the observed `bigproj-observability` stand-up made 8 tool calls
re-investigating from scratch.

**Going simpler — cadence without `recordStandup`** — leaves the Boss unable to see that a stand-up
already happened, which is the current state and the reason drift detection cannot accumulate.

### (iv) Soft caps: last, and only if (i)–(iii) hold

Gabriel's directive is that ~20 is a target size, not a kill. The simplest form of "soft" that is not a
free-for-all: at the per-role cap, inject a **yield** ("you are at your budget — produce your final
answer now in the required format") and allow a small fixed overrun (say +5 iterations) for that answer
to be produced; only then hard-stop, and record `partial`. That converts 43 silent failures into
either real answers or honest partials without unbounding anything.

**What going simpler than the whole set loses.** Doing only (i) already removes the single largest source
of false reporting in the project and needs no eval to verify. If only one thing gets built, build (i).

### Do nothing about

- **Raising the Implementer's 60.** H01 tested exactly this and it got worse. If the Implementer needs
  more than 60 iterations, that is an argument for decomposition (`02`) or for supervision, not for a
  bigger number.
- **Predicting effort before spawning** (roadmap Item 7's "spawn when 20–40 iterations are anticipated").
  It requires predicting effort, which is the class of judgment not to trust to a small model. The Boss's
  bound works precisely because it is **post-hoc and model-independent** (`git status`, a diff line
  count, an iteration count). A post-hoc equivalent — "this frame has now run 25 iterations; the next
  group should have been split" — is implementable, and `LARGE_FRAME_ITERATIONS = 25` arguably already is
  it.

---

## 5. What to watch out for when implementing

- **The ordering is not stylistic.** Soft caps before the fail-open fix reproduce the Planner-trap
  failure at run scale: an entire run's work discarded because the terminal state is unrepresentable.
- **A global budget and per-frame caps genuinely fight.** Two failure directions: a frame with plenty of
  its own budget left gets a "wrap up now" injection because the *global* budget is nearly spent (work
  truncated); or a frame hits its own cap while the global budget is untouched (the global cap never
  binds and is decoration). The yield must be driven by `min(frameRemaining, globalRemaining)`, and the
  two numbers must both be visible in the run record or the interaction is undebuggable.
- **`agent.ts:1275` scales stall re-ground fractions off the cap.** Change a cap and these triggers move
  with it. Re-check before touching budgets — this is called out in the program plan for a reason.
- **Resumed frames restart at 1.** Until H14 is fixed, any global total computed from
  `getIterationCount()` under-counts every resumed frame.
- **Cap-hit → `partial` will make the numbers look worse.** 43 frames' worth of recorded successes
  become partials. Write it in the eval log at the time so it is not mistaken for a regression and
  "fixed" back.
- **Do not tune the stall/progress thresholds in the same change.** 251 firings with an unmeasured
  effect; changing budgets and thresholds together makes both unattributable.

---

## 6. How to validate it

### H13 — no eval run required

Count frames whose conclusion is `Reached maximum iterations (N) without a final answer.` and whose
recorded status is `success`. **Baseline 43.** After the fix: **0**, with the same frames appearing as
`partial`. `metrics.mjs` already counts cap-hits (validated 44 of 44 on September logs). Per-role
baselines above give a breakdown that must also hold.

This is a correctness check, not a statistical one. There is no effect size to argue about.

### H21 — ~20 as a chunk and cadence

**Works:**
- Cap-kills fall (baseline: 43 frames; Planner 39 %, Boss 13 %) **while task completion holds** at k=3 on
  the four `bigproj` tasks. Both halves are required — fewer cap-kills with worse completion means the
  yield is truncating real work.
- `gateRoundTrips` falls from its baseline (September 278) as the budget-aware yield suppresses
  end-of-frame gates. Already counted by `metrics.mjs`.
- Stand-ups produce a trace every time (`recordStandup` non-zero) and their tool-call count per stand-up
  falls from the observed 8, because they read summaries first.

**Does not work:** cap-kills fall and completion falls with them; or stand-ups still return `NONE` every
time. The second outcome is the more likely and the more informative: **22 stand-ups producing one
actionable verdict is an argument that stand-ups are not earning their cost at this task size**, and a
cheaper stand-up may simply be a cheaper way to produce nothing. Testing this needs a drift-trap task
(unbuilt) — without one, a `NONE` verdict is uninterpretable, because there may have been nothing to
find.

### H22 — the ~200 global boundary

This is the **north-star experiment** and it should be run *after* H23 and H24, not before:

1. Land the pinned anchor and force eviction (H23/H24, see `01`).
2. Land (i) and (ii) above.
3. Then measure: **how far past ~200 iterations can a run go with the anchor and durable memory live?**

**Works:** runs exceed 200 cumulative iterations while the final answer still addresses the recorded
objective (`goal_completeness`, plus the mechanical check "does the final answer name every artifact the
objective named"). Then ~200 was an artifact of running without the anti-drift machinery and the number
should be revised upward with the evidence stated.

**Does not work:** drift appears at the same point regardless. Then ~200 is a property of the model and
harness together, and the correct action is to set the hard boundary there and stop trying to raise it.

**Falsifier for the whole framing:** if runs never reach 200 cumulative iterations on any available task
even with `COMPACT_RESERVE_TOKENS` lowered, then the experiment is untestable on the current substrate and
the blocking dependency is task authoring — which is currently the case. `tasklab` at 827 LOC cannot fill
a 65 k context. **This is on Gabriel's open-decisions list (budget for a larger external repo) and it
gates the north star.**

**Effect size:** cumulative-iteration count is a continuous measure with a clean threshold, so k=3 is
adequate. Drift incidence is not: with k=3, only a clean 3/3 vs 0/3 or 1/3 split is readable (see `01` §6).

### Signals that exist vs signals still needed

Exist (Batch 1): `capHits`, `gateRoundTrips`, `iters` (2 874 `iteration` events = 2 874
`ollama_request` events in September, so per-frame sums are a true turn count), `toolCalls`, per-mechanism
firing counts.

Needed: **cumulative cross-frame iteration total per run** (does not exist — frames are independent
`Agent` instances with independent counters), and the frame status distribution
(`success`/`partial`/`gave_up`) per row. Note `FrameStatus` has six members but `deriveFrameResult` can
only emit `success` or `gave_up`, so the dispatch loop's `status === 'failed' || 'killed'` replan branch
is effectively dead code — fixing (i) is also what makes that branch reachable.

---

## 7. Links

- **H13** — OPEN, verdict from counters. §4(i), §6. Prerequisite for H21 and H22.
- **H21** — OPEN, requires H13. §4(iii–iv), §6.
- **H22** — OPEN, requires H13 and is best run after H23/H24. §6.
- **H01** — DISMISSED. §3. Constrains every budget-raising proposal.
- **H14** — `resumeFrame` restarts the iteration counter; blinds every budget signal. §3, §5.
- **H17** — the Planner's 39 % cap-hit rate is a gate bug, not a budget problem. See `02`.
- Roadmap: 2026-09-03 register "The iteration-budget directive: ~20 as a chunk, ~200 as a hard boundary";
  2026-09-03 "#1 (top-ranked): make the harness's 'almost done' gate chain iteration-budget-aware";
  **Item 5** (rolling stand-up summaries at a ~20-iteration cadence).
- Program: `/shared/argo-program/PLAN.md` BATCH 2 item 3.
- Related: `interaction-matrix.md` (global budget × per-frame caps; the gate cluster × per-frame caps),
  `03` (the gates that stack at the end of a frame), `05` (H01 and overthinking).
