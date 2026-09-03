# Supervision and verification

Critic models · executable oracles · Tester frames · done-gates · tamper detection

Hypotheses: **H03** (qwen3.6 self-critique is the best available critic — VALIDATED), **H05** (a
pre-done grounding guard reduces fabrication — PARTIAL), **H08** (the integrity gate cannot detect
oracle tampering — VALIDATED → FIXED), **H13** (frames that hit their cap are recorded as successes).
Roadmap: 2026-09-03 register **Item 6**; `docs/actor-critic.md`, `docs/grounding.md`.

---

## 1. What the concept is

Argo has **eight** things that can say "not done yet". In firing order within a frame:

| # | Mechanism | Kind | Where |
|---|---|---|---|
| 1 | Plan/act gate | permission state | `agent.ts:1624` |
| 2 | Executable per-task `verify` | machine oracle | `agent.ts:1448` |
| 3 | Task-advance nudge / summary ask / final reconciliation | prompted self-report | `agent.ts:1445` |
| 4 | Re-grounding done-gate | prompted self-check | `agent.ts:1578` |
| 5 | Grounding guard | LLM critic (same model) | `agent.ts:1092` |
| 6 | Actor-critic (`ARGO_CRITIC`, **off**) | LLM critic (same model) | `critic.ts` |
| 7 | Tester frame + REDO | separate frame, real tools | `dispatch.ts:379` |
| 8 | Boss stand-up / final checkpoint | separate frame, real tools | `dispatch.ts:719` |

Plus two **tamper detectors**: the eval's `testFileTampered` and the critic's `gamed_oracle` verdict.

**North star served:** "without hallucinating". Supervision is also the half of the multi-agent
architecture that has produced every measured win, which makes getting it right more valuable than
anything in `02`.

---

## 2. External evidence

### The result that should govern Argo's thinking here

**LLMs cannot reliably self-correct reasoning without external feedback, and performance sometimes
degrades after self-correction.** Huang et al. study "intrinsic self-correction" — a model revising
its own output using only its own capabilities — and find it does not work
([arXiv 2310.01798](https://arxiv.org/abs/2310.01798), ICLR 2024).

**Class B, transferability DIRECT in direction, PARTIAL in magnitude.** The studied models are
stronger than qwen3.6, which makes the result *worse* for Argo, not better — a weaker model has less
capacity for the corrective judgment the paper shows even strong models lack. The important nuance:
Argo's Tester and Boss have **real tools**, so they are not doing intrinsic self-correction. The
paper's implication is therefore precise: **the value in Argo's verification stack should come from
executable feedback, not from second opinions.** Every design choice in §4 follows from this.

### Same-model judging is biased toward its own output

LLM evaluators show **self-preference**: they score their own generations higher than human
annotators judge them, and self-preference correlates linearly with self-recognition ability
([arXiv 2404.13076](https://arxiv.org/abs/2404.13076)). **Class B, transferability PARTIAL** (GPT-4
and Llama-2, not qwen3.6).

This is the mechanism that predicts Argo's most striking measurement: **the Tester, running the same
model on the Implementer's work, has issued zero REDOs in 85 frames.** H03 established that qwen3.6 is
the best *available* critic; it did not establish that qwen3.6 is unbiased about work produced by
qwen3.6. Those are different claims and the corpus is consistent with the second being false.

### Monitor the trace, not the report

Baker et al. monitor a frontier reasoning model for reward hacking in agentic coding environments and
find **chain-of-thought monitoring far more effective than monitoring actions and outputs alone** — and
that a *weaker* model (GPT-4o) can effectively monitor a stronger one (o3-mini)
([arXiv 2503.11926](https://arxiv.org/abs/2503.11926)).

**Class B, transferability PARTIAL**, and it carries two implications that pull in opposite directions:

1. **Give the verifier the trace and the diff, not the summary.** Argo's Tester currently receives a
   `capSummary`-truncated conclusion (2 000 chars) plus, in 4 of 9 recorded cases, the fallback string
   *"none (or made via bash, not tracked)"*. That is monitoring the *report* — the configuration the
   paper shows is weakest. This is the single most actionable external finding in this document.
2. **The "weak-model supervisor" rejection may be broader than the evidence requires.** Argo rejected
   an async or weak-model Boss, and Gabriel reversed it himself. Ours still wins: the supervisor eval
   at RUNS=3 over 5 candidates found **only qwen3.6 flagged oracle-gaming 3/3**, and the accidental
   test — two `qwen2.5-coder:14b` multi-agent sessions on 2026-09-02 — produced a Tester burning all 20
   iterations on a single tool call and a Boss final checkpoint stalling blank for 15. Plus a second
   resident model costs real memory on a 48 GB machine. Keep the ruling; note that its *reason* is
   resource cost and measured local failure, not a general principle.

### Executable oracles beat critics

Reflexion reached **91 % pass@1 on HumanEval** by reflecting on *test feedback*
([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)). **Class B, transferability PARTIAL** — the
mechanism is "external signal in the loop", which transfers; the model and benchmark do not.

The general point is reinforced by every mature harness: verification against a machine check, not
against the model's prose. Argo's own documented principle — harness-level signal over text convention
— is the same idea and `ASSESSMENT.md` §5.1 records it applied correctly four times (`git status`
diffing for `preempted`, `git diff --shortstat` for the TRIVIAL blast radius, `getIterationCount()` vs
budget for the Boss stall).

### But the oracle itself is the weak point

SWE-Bench+ manually screened successful patches and found **31.08 % passed due to weak test cases**
and 32.67 % involved solution leakage; filtering both dropped SWE-Agent+GPT-4's resolution rate from
12.47 % to **3.97 %** ([arXiv 2410.06992](https://arxiv.org/abs/2410.06992)). **Class B,
transferability DIRECT in principle**: Argo's `verify` command is **model-supplied**, which is a
strictly weaker oracle than a curated benchmark's tests. A model that writes its own passing criterion
is the SWE-Bench+ weak-test problem with the adversary inside the loop.

### Two verification passes: what the literature actually supports

Anthropic recommends a `/code-review` subagent that checks the diff in a **fresh context** —
explicitly framed as fresh eyes on the artifact, not a second opinion on the narrative
([Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)). **Class D,
transferability DIRECT** as a design. MAST's third failure category is literally **task verification**
— i.e. verification is a common failure site in multi-agent systems, not a free win
([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)).

Read together with Huang et al.: **a second frame is worth it if and only if it verifies against an
artifact.** A second frame verifying against a summary is intrinsic self-correction wearing a
costume.

---

## 3. Our own evidence

### The Tester has never once sent work back

- **85 Tester frames.** 70 with a "Verify this claim" assignment. 29 conclusions in saved ledgers.
- **29 of 29 ledger verdicts are `RELEASE`. Zero REDO in the entire recorded history.**
- `parseTesterVerdict` (`frames.ts:152`) **fails open to `release`**, so "verified and accepted" is
  indistinguishable from "produced no parseable verdict and was defaulted to accepted" — including for
  the 2 Tester frames that ended at their cap.
- The Tester is handed *"none (or made via bash, not tracked)"* whenever `filesWritten` is empty
  (`dispatch.ts:389`), which is **4 of 9** saved Implementer conclusions, because
  `filesTouched`/`filesWritten` are documented as "diff-derived, not self-reported" (`types.ts:135`)
  and are actually derived from `edit_file`/`write_file` call tracking only.

One eval-log trace shows a Tester producing an excellent itemised FAIL — but it *released* (it
correctly accepted a conclusion of failure), so the REDO path remains completely unexercised. **"The
harness has a second set of eyes" is an architectural claim with no behavioural evidence behind it.**

### The executable verify gate is real, and under-delivers exactly where it matters

- **109 verify executions**: 87 pass, 22 fail (Batch 1's re-count on September logs: 24 fail — the
  earlier count dropped 8 of 24 to a 300-char regex gap; the corrected counter is the one to use).
- Of 22 failures: **6 followed by an `edit_file`/`write_file` within 12 events (27 %)**, 12 produced no
  edit, and **4 were followed directly by another verify failure** — including three consecutive in one
  frame (`bigproj/2026-09-03T06-48-37`, events 124/131/138).
- Two visible causes: failure output truncated to **1 500 chars**, and models writing a `verify`
  command that **cannot ever pass** (one trace: *"The verify command for step 1 is broken —
  `src/task.test.js` doesn't exist as a standalone file"*, after which the model spent turns fixing its
  own plan instead of the code).

So the oracle exists and fires, and its feedback converts to an edit 27 % of the time. That is the gap.

### The grounding guard produces the best output of any guard — once

- **27 firings** (17 `ok`, 10 `revise`), emitted as `{type:'critic',checkpoint:'grounding'}`.
- Verbatim from a `booklet` run: *"Cites 'Bernardi Glassworks' in sources but it was never fetched"*;
  *"Specific founding year '1987' and venue 'ice house' for Hudson Beach Glass are unverified specifics
  likely fabricated by the model"*.
- Effect on the artifact: **`1987` and `ice house` are gone** (0 occurrences in `bille.html`), and the
  source list now cites a verifiable Wikipedia history. So it removed two fabricated specifics and drove
  real verification.
- **But `Bernardi Glassworks` is still listed twice as a source** (`bille.html:380-381`, 5 occurrences
  by `grep -ci`) — precisely the instruction it did not honour. *(Caveat: a later run may have fetched
  those URLs; the final artifact was read, not the per-run state.)*
- Root cause of the residue: `groundingChecked` is set to `true` **before** the check runs
  (`agent.ts:1596`), so the guard fires **at most once per run**. It blocks one "done", injects the
  critique, and can never verify the revision happened.
- Second gap: `DOC_EXTS` (`grounding.ts:47`) means it can **never fire on a coding task**, so
  `ARGO_GROUNDING` being ON by default contributes nothing to the eval suite as it stands.

H05's measurement stands and is worth restating precisely: factual 3.00→3.25, richness 4.75→4.00,
temperature-drift 1/4→0/4, at n=4. **It removes severe errors and does not reduce total fabrications** —
and the surviving Bernardi citation is exactly what the one-shot gap predicts.

### The done-gate re-ground works on its own terms; nobody knows if the extra work was needed

**115 firings.** 44 of 115 (38 %) are followed by further tool calls; 40 finished immediately; 31
indeterminate. Its purpose is not to accept the first "done" at face value, and it changes the outcome
in nearly four cases in ten. Whether that work was *needed* requires the A/B (probe P4) that has never
been run at k>1.

### Two tamper detectors, zero firings between them

1. **`testFileTampered`** used `git diff --name-only`, which lists only *tracked* modifications; every
   seeded test file is **untracked**. It could never fire on any task in the catalog. 12 consecutive
   runs at `integrity: 15/15` were an artifact, not a result. **H08 VALIDATED → FIXED**: the new gate
   compares seeded files against the fixture bytes the harness wrote, and is demonstrated — **+1 byte
   (2422 vs 2421) voids a perfect run to `total: 0`**.
2. **The critic's `gamed_oracle` verdict**: 35 `critic` events in July, 13 `revise`, **0
   `gamed_oracle`**. `ARGO_CRITIC` has been off since; there were 0 in September.

So the honest state is: Argo could not detect oracle tampering until Batch 1, and the critic that was
supposed to catch it never flagged it in 35 opportunities. H03's supervisor eval showed qwen3.6 *can*
flag oracle-gaming 3/3 when shown a gaming transcript; the live critic never encountered one it
recognised.

### Failure is not representable at two of four parse sites

| site | fail-open default | guarded? |
|---|---|---|
| `parseTaskStartVerdict` | `objective` + original message | ✅ retry (`b3b998b`) + `hitCap` |
| `parseBossVerdict` | `none` = all clear | ✅ `hitCap → escalate` |
| **`parseTesterVerdict`** (`frames.ts:152`) | **`release` = accepted** | ❌ |
| **`parseTaskGraph`** (`dispatch.ts:398`) | **one-step graph** | ❌ |

And underneath all four: **`deriveFrameResult` (`dispatch.ts:191`) records a cap-hit as
`status:"success"`.** 43 frames in the recorded history ended blank at their cap and were recorded as
successes (Planner 9/23, Boss 26/204, Implementer 6/61, Tester 2/85, baseline 7/194). **44 of 44**
September `error` events are the cap string. That is H13, and it is the precondition for everything
else here.

### Boss supervision: measured cost, one actionable verdict

- **22 stand-up frames**: `NONE` 16, cap-hit blank 3, no-keyword 3 → **6 of 22 (27 %) produced no
  usable verdict**, and `parseBossVerdict` fails open to `none` for all of them.
- Across the whole corpus there is **exactly one `boss_verdict` event** (an `escalate`). **`INJECT` and
  `RESTART` have never fired.**
- `ledger.recordStandup` (`ledger.ts:145`) is **never called**; healthy stand-ups leave no trace, so a
  Boss trying to detect drift by reading the ledger cannot see that a stand-up already happened.
- **The Boss is 202 of ~317 role frames (64 %)**, supervising 61 Implementer frames — a **3.3:1
  supervision-to-work ratio** — and is responsible for **53 of 102** role-restriction rejections.
- Direct evidence that Boss self-report trust fails: the quality judge on `bigproj-deps` recorded
  *"Boss final frame hallucinated 'All 9 tests pass' and claimed work was 'already complete from the
  previous frame' after multiple timeout failures"* — **on a run scored PASS**.

**Where our evidence overrides the literature:** the literature's optimistic branch (Self-Refine,
Reflexion-style self-critique) would predict a second frame catching things. Ours says a second frame
that reads a summary catches nothing in 85 tries. The pessimistic branch (Huang et al., self-preference,
MAST's verification category) predicts exactly what we see. **Ours plus the pessimistic literature
agree; the optimistic literature loses.**

---

## 4. Simplest sufficient implementation

The whole of this section is about **~20 lines plus one signal**, and its premise is Huang et al.:
executable feedback, not second opinions.

### (i) Make failure representable — the prerequisite, ~15 lines

```
deriveFrameResult(): if agent.getIterationCount() >= agent.getMaxIterations() → status: 'partial'
parseTesterVerdict():  capped or unparseable → escalate (NOT release)
parseTaskGraph():      capped or unparseable → escalate, or resumeFrame-for-format (b3b998b idiom)
parseBossVerdict():    any unparseable verdict → unresolved, not just the capped subset
```

No new concepts. The `runBoss` `hitCap → escalate` idiom already exists three lines away in the same
file. **Going simpler loses everything downstream**: a soft cap, a global budget, a REDO path and
decomposition all inherit the fail-open if this is skipped. This is why the program's ordering
constraint is a correctness requirement, not a preference.

### (ii) Give the verifier a diff — one signal, two consumers

After each `bash` call in an Implementer frame, take a `git status --porcelain` snapshot; derive
`filesWritten` from the diff instead of from `edit_file`/`write_file` call tracking. Then:

- the Tester's assignment carries the actual changed paths, and the diff itself when small (else a
  path to a written diff file);
- the plan/act gate's `bash` hole closes with the same signal (`isProjectMutation` currently inspects
  only two tool names);
- the ledger's `filesWritten` becomes what `types.ts:135` already claims it is.

**This is the highest-value single change in this document** and it is what makes the Tester capable of
doing anything at all. Baker et al. is the external argument; the 4-of-9 empty file lists are the local
one.

**Going simpler — fixing the parse but not the diff — is actively bad.** You would get REDOs issued on
the basis of a summary, which is the intrinsic-self-correction configuration the literature says
degrades output. Do not enable REDO before the diff exists.

### (iii) Bound the grounding guard, mirroring `MAX_TESTER_ROUNDS`

Move `groundingChecked = true` to *after* a passing check, and allow 2–3 passes; accept "done" only
when the critique returns `ok` or the round budget is exhausted. Small change; converts a one-shot
warning into an actual gate. **Going simpler (leave it one-shot) loses the enforcement**, which is
exactly the measured residue in `bille.html`.

### (iv) Validate the `verify` command when it is registered

Run the model's `verify` string **once at `update_plan` time** and reject or flag a command that fails
for a structural reason (file not found, non-zero exit with no test output). Harness-owned, cheap, and
it removes the largest observed failure class (4 of 22 firings are thrash on impossible commands).
Also: raise or remove the 1 500-char truncation on verify failure output — a truncated stack trace is
not actionable feedback.

### (v) Collapse the redundant done-gate cluster

Four mechanisms currently fire on the same event ("the model says it is done"): the final
reconciliation, the done-gate re-ground, the grounding guard, and (if enabled) the pre-done critic.
Counts: 50 reconciles, 115 re-grounds, 27 grounding, 4 pre-done critic firings. **Keep one prompted
check and one machine check.** The machine check is `verify` plus the regression gate; the prompted
check should be the re-ground, which has the best measured conversion (38 %).

### (vi) Leave `ARGO_CRITIC` off, and delete `layout.ts`

The critic is 209 lines + 119 test, functional since 2026-07-27, value explicitly inconclusive, and the
Tester frame now does the same job **with real tools** — which is the configuration the literature
supports. `layout.ts` (256 + 76 lines) has **never executed in a real run** and H04 is DISMISSED:
structure was never the failure mode, fabrication was. Deleting it removes ~330 lines and a
documentation surface describing behaviour the system does not exhibit.

### (vii) Role-restriction rejection text

**67 of 102 rejections are followed by another call to a forbidden-class tool** (Boss 53, Planner 48).
State what the role *can* do ("you cannot write files; your job is to emit X — do that now"), and after
two rejections of the same forbidden tool, force the frame to conclude. Trivial, and it recovers real
budget in 10–15-iteration frames.

---

## 5. What to watch out for when implementing

- **Enabling REDO arms `resumeFrame`'s state wipe.** `agent.chat()` reinitialises `currentPlan`,
  `taskList`, `loopState`, `editedPaths`, `episodes`, `finalReconciled` and the iteration counter
  (`agent.ts:1212-1241`), and `lastIterationCount` restarts from 1 (`agent.ts:1288`). A resumed
  Implementer therefore loses its plan, its verify state and its `editedPaths`, so `deriveFrameResult`
  records empty `filesWritten` and `finalReconciled = false` re-arms the reconciliation gate. This is
  latent today (0 REDOs, 1 replan, 2 marker retries). **Fix H14 in the same pass as (i) and (ii), not
  after.** This is one of the three most important interaction findings.
- **A REDO loop needs a hard round budget or it is a new thrash source.** `MAX_TESTER_ROUNDS` exists;
  make sure the escalate-instead-of-release path respects it.
- **Do not stack the new gates.** Every gate added here can land in a frame's last iterations. The
  gate chain already accounts for **354 forced extra round-trips** across the corpus, none of them
  budget-aware, and three consecutive gates in iterations 58/59/60 ended a *correct* run in "no final
  answer". Build the budget-aware yield (`06` §4) **before** adding a grounding round or a REDO round.
- **A model-supplied oracle can be gamed by its author.** The `verify` command is written by the same
  model whose work it checks. The regression gate (every test passing at baseline must still pass) and
  the byte-comparison integrity gate are the model-independent counterweights; keep both as **gates**,
  not as points.
- **A stricter Tester will produce false REDOs before it produces true ones.** Measure REDO precision,
  not just REDO count. A Tester that rejects correct work is worse than one that accepts everything,
  because it costs a whole extra Implementer frame each time.
- **Cap-hit → `partial` will make the eval look worse overnight.** 43 frames' worth of recorded
  successes become partials. That is the fix working, not a regression. Say so in the eval log at the
  time, or someone will "fix" it back.

---

## 6. How to validate it

### Verdicts that need no eval run at all

- **H13**: count frames whose conclusion is `Reached maximum iterations (N) without a final answer.`
  and whose recorded status is `success`. Baseline **43**; after the fix it must be **0**, with the same
  frames appearing as `partial`. `metrics.mjs` already counts cap-hits (44 of 44 September `error`
  events matched). Pure counter check.
- **`filesWritten`**: for every Implementer frame whose workspace diff shows `src/` changes,
  `filesWritten` must be non-empty. Baseline: empty in 4 of 9. Pure log check against the saved diffs
  in `eval-runs/diffs`.
- **Grounding enforcement (P7)**: `grep -ci 'bernardi' ~/Sources/test/booklet/bille.html`. Currently
  **5**; expect **0** after the bounded re-check. Single deterministic number.

### The Tester needs a trap task — nothing else will settle it (P2)

Author a task whose Implementer produces a *partial* implementation while reporting success, or inject
a false conclusion into the ledger before the Tester spawns. Then:

```
grep -o 'REDO' <ledger>.jsonl | wc -l
```

**Works:** ≥1 REDO, and the REDO leads to a frame that closes the gap. **Does not work:** still 0 —
then the 0-for-29 RELEASE record is a broken verdict path, not task easiness, and the Tester should be
deleted rather than tuned. This trap task also settles roadmap Item 6 (does the Boss verify against
artifacts?) and doubles as an eval item.

**Effect size:** this is a binary capability probe, not a statistical one. n=1 is sufficient to
demonstrate the path can fire; n=3 is needed before claiming a rate.

### The verify gate

Signals already exist in `metrics.mjs`: `verifyPass`, `verifyFail`. What is missing and is cheap: a
counter for **verify-fail → edit within 12 events**, i.e. the 27 % conversion rate, derivable by
post-processing today but not recorded per row.

**Works:** conversion rises materially from 27 % after (iv) — untruncated failure output plus
registration-time validation. A meaningful move is **27 % → >50 %** across ≥20 firings; anything on 5
firings is noise. Consecutive-failure thrash (4 of 22 today) should go to ~0.
**Does not work:** conversion flat. Then the failure output is not the problem and the next suspect is
that the model cannot act on test output at all — which would be a much more serious finding, and would
argue for the Implementer receiving a *reduced* failure (first failing assertion only).

### The done-gate cluster (P4) — the A/B nobody has run at k>1

`ARGO_TASKS=0` vs `1`, `EVAL_RUNS=3`, on `bigproj-effort` and `bigproj-duedate-bug`. Compare pass rate,
total LLM turns, and the count of `Reached maximum iterations` conclusions.

**Works:** gates ON gives equal-or-better correctness at acceptable turn cost. **Does not work:** gates
ON costs turns and buys no correctness — then 354 round-trips are pure overhead and the cluster should
be cut to one gate. Note this A/B was run once at n=1 on 2026-07-30 and never repeated; **do not treat
that as evidence**.

**Confound:** `ARGO_TASKS=0` also disables the executable `verify`, which is the mechanism with the
best case for existing. Run the arm as "gates off, verify on" if the flags can be separated; if they
cannot, separating them is the first change.

### Structured events still needed

- `intervention` events carrying the mechanism name and iteration, so "did runs that received a stall
  check converge more often" is mechanically answerable. Batch 1 counts firings; it does not link a
  firing to an outcome. This is roadmap Item 0's residue.
- Grounding round number, so a bounded re-check is observable.
- Tester verdict provenance: `parsed` vs `defaulted`. Without it, a fixed `parseTesterVerdict` is
  unverifiable from the artifacts.

---

## 7. Links

- **H03** — VALIDATED (qwen3.6 is the best available critic). §2: this does not imply it is unbiased
  about its own output.
- **H05** — PARTIAL (grounding guard removes severe errors, not total fabrications). §3, §4(iii).
- **H08** — VALIDATED → FIXED (integrity gate). §3. See `07` for the eval-side treatment.
- **H13** — OPEN, verdict from counters, no eval needed. §4(i), §6.
- **H14** — `resumeFrame` state wipe. §5. Blocks REDO.
- **H04** — DISMISSED (layout/vision judge). §4(vi): delete `layout.ts`.
- Roadmap: 2026-09-03 register **Item 6** (Boss verifies artifacts, not self-reports); 2026-09-03
  "#1-ranked: make the gate chain iteration-budget-aware"; `docs/actor-critic.md`; `docs/grounding.md`.
- Program: `/shared/argo-program/PLAN.md` BATCH 2 item 1.
- Related: `interaction-matrix.md` (Tester × resumeFrame; critic × Tester; verify × Tester; the
  four-way done-gate cluster), `06` (budget-aware yield), `08` (the diff as the handoff channel).
