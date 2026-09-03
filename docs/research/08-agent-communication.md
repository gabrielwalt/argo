# Agent-to-agent communication

What a frame returns · artifact-by-reference · the ledger as shared state

Hypotheses: **H14** (`resumeFrame` silently wipes run state), **H26** (Implementer frames waste turns
rebuilding context — BLOCKED by H17). Roadmap: 2026-09-03 register **Item 3** (context inheritance),
**Item 4** (artifact-by-reference), **Item 5** (rolling stand-up summaries), **Item 6** (Boss verifies
artifacts). Design: `docs/subagents-plan.md`.

---

## 1. What the concept is

Argo's four roles are separate `Agent` instances with separate histories, separate `sessionId`s and
separate compaction state. They communicate through exactly three channels:

1. **The assignment message.** `buildAssignment` (`frames.ts:118-134`) constructs a frame's first user
   message: the objective, the step, and — for `dependsOn` steps — each dependency's capped conclusion
   summary plus its file list.
2. **The `FrameResult`.** Derived from the frame's natural final answer plus diffed files
   (`deriveFrameResult`, `dispatch.ts:191`), with `capSummary` truncating conclusions at **2 000 chars**
   and dependency hand-offs at **500** (`frames.ts:106-110`).
3. **The ledger.** Append-only, tree-structured by `frameId`/`parentFrameId`, with five entry shapes,
   and exposed to the model as a `ledger` tool (`tools/index.ts:224`) offering `getFrameTrail`,
   `getRecent`, `expand` (`ledger.ts:218,227,237`).

`ask()` — the Boss-asks-a-running-frame primitive — was **never implemented**, and is still carried in
`subagents-plan.md`'s open questions as "the most novel/fragile piece here and should get the heaviest
testing before trusting it in the dispatch loop". There is nothing to test.

**North star served:** "without losing track of progress". The ledger is the only artifact that survives
a frame boundary, so it is the only place cross-frame progress can live.

---

## 2. External evidence

### Share traces, not summaries

Cognition's *Don't Build Multi-Agents* argues for two principles — **share context, share full agent
traces** — and for defaulting to a single-threaded linear agent. Their concrete failure is subagents
making **conflicting implicit decisions** ("build a Flappy Bird clone" → mismatched bird and
background), and they note Claude Code's subagent, as of mid-2025, **only answers questions, never
writes code, and never runs in parallel**, precisely because a subagent lacks the main agent's context;
its sole benefit is keeping investigation out of the main history
([Cognition](https://cognition.ai/blog/dont-build-multi-agents)).

**Class D, transferability DIRECT** for the serial-handoff half. Argo is single-threaded by invariant
(`dispatch.ts:7`), so the parallel warnings are moot; the "a summary is a lossy channel" warning is not.
Note the tension with Argo's design: Argo's frames are isolated **on purpose**, to keep contexts small,
and Cognition's advice is to share more. Both cannot be maximised. §4 resolves it: share the *machine-derived
artifact* (the diff), not the *narrative*.

### Monitor the trace, not the report

Baker et al. find chain-of-thought monitoring **far more effective than monitoring actions and outputs
alone**, and that a weaker model can effectively monitor a stronger one
([arXiv 2503.11926](https://arxiv.org/abs/2503.11926)). **Class B, transferability PARTIAL.** The
transferable design rule is precise and cheap: **a verifier that reads a self-report is in the weakest
configuration available.** Argo's Tester reads a `capSummary` and, in 4 of 9 recorded cases, the string
*"none (or made via bash, not tracked)"*.

### Condensed returns keep the orchestrator's context clean

Anthropic reports subagents burning tens of thousands of tokens internally and returning ~1 000–2 000
tokens to the lead ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
**Class D, transferability DIRECT** as a shape, and Argo already implements it: `capSummary` at 2 000
chars. Their 90.2 % multi-agent gain is **transferability NONE** — parallel Sonnet subagents under an
Opus lead on breadth-first research, with ~15× the tokens, and their own note that "most coding tasks
involve fewer truly parallelizable subtasks".

### Inter-agent misalignment is a documented, common failure class

MAST's three categories are system design, **inter-agent misalignment**, and **task verification**,
derived from 1 600+ annotated traces across 7 frameworks with κ = 0.88, on a panel that includes Qwen2.5
and CodeLlama on coding tasks ([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)).
**Class B, transferability PARTIAL-to-DIRECT.** Two of the three categories are exactly where Argo's
measurements sit: an empty file list handed to a verifier is information withholding; a Boss releasing on
an unparseable verdict is verification failure.

### Ledger-style shared state: the 31 % figure, corrected

`docs/subagents-plan.md` cites Magentic-One's ablation as attributing 31 % of performance to the ledger
alone. **Verified and corrected**: [arXiv 2411.04468](https://arxiv.org/abs/2411.04468) §5.3, Fig. 3(a)
reports "without the full ledgers, performance drops by 31%" on GAIA validation with GPT-4o — but that
ablation replaces the Orchestrator with AutoGen `GroupChat`, "eliminating both ledgers, planning,
progress tracking, loop detection, and explicit instructions to other agents." **The 31 % is the value of
the whole orchestrator.** Class B for the number; the attribution as cited is unsupported.

---

## 3. Our own evidence

### The ledger earns its place, and that is a real finding

Every deep finding in the last two sessions — Findings 6, 7 and 8, plus the entire mechanism
verification — was reconstructible **only because the ledger exists**. 19 task ledgers on disk. As an
audit trail it is the project's most valuable artifact after the raw logs.

With one caveat that cost a session: **the ledger records frame conclusions, and when the thing that
failed *is* a frame's conclusion, the ledger can only confirm the wrong story.** That is precisely what
happened with the Planner (`02` §3). The per-frame message histories are the more authoritative artifact
in that case. Rule: before concluding "the model can't do X", read the turn-by-turn history of the frame
that was supposed to do X.

### The handoff channel is broken in a specific, measurable way

`filesTouched`/`filesWritten` are documented as "diff-derived, not self-reported" (`types.ts:135`) and
are **neither** — they come from `agent.getEditedPaths()`, which tracks only `edit_file`/`write_file`
calls. **4 of 9 Implementer conclusions in the saved ledgers have `filesWritten: []`** for tasks whose
diffs on disk clearly show `src/` changes; the writes went through `bash`. The Tester is then handed
*"none (or made via bash, not tracked)"* (`dispatch.ts:389`) and has to rediscover the change itself.

This is the same `isProjectMutation` `bash` hole that lets a heredoc bypass the plan/act gate, surfacing
in a second place. **One missing signal degrades two mechanisms.** Its consequence is measured: the Tester
has released 29 of 29 times with zero REDOs (`03` §3), and the quality judge caught the Boss final frame
hallucinating *"All 9 tests pass"* on a run scored PASS.

### Stand-up state does not accumulate

`ledger.recordStandup` (`ledger.ts:145`) has **zero call sites**. Stand-ups are written as `injection`
entries, and only when the verdict is `inject`/`restart` — so **16 of 22 healthy stand-ups left no ledger
trace at all**. The designed `LedgerStandupEntry` shape has never been written. A Boss trying to detect
drift by reading the ledger cannot see that a stand-up already happened. Meanwhile the observed
`bigproj-observability` stand-up made **8 tool calls** re-investigating from scratch.

### Frame isolation is real, and it demonstrably reduces context pressure

Frames get their own `sessionId`, history file and compaction state, so there is no accidental sharing.
Measured consequence: of 14 LLM compactions in the corpus, **12 are in `test-two`** — the workspace used
for baseline single-loop work — and `bigproj`, where multi-agent runs happen, has **one**. That is real
support for the claim that sub-agent isolation and compaction are partially redundant. It does not
eliminate compaction: the 64 266-token peak happened, and the dispatch loop's final return concatenates
every step's summary (`doneSummary`, `dispatch.ts:756`).

### The cost of the current communication pattern

- **The Boss is 202 of ~317 role frames (64 %)** — 94 task-starts, 86 finals, 22 stand-ups — supervising
  61 Implementer frames. A **3.3:1 supervision-to-work ratio**.
- **53 of 102 role-restriction rejections are the Boss's**, repeatedly trying `write_file`/`edit_file` at
  checkpoints where it has only `bash`, burning an iteration each out of a 10–15-iteration budget.
- `dependsOn` context has been supplied to **5 frames** in the entire history, because 84 of 85 graphs
  have one step. So the inter-frame channel that matters most for decomposition is almost entirely
  untested.
- `preempted-incomplete` handoffs: **23**.

### `resumeFrame` silently wipes everything — H14

`resumeFrame` (`dispatch.ts:172`) calls `agent.chat(followUp)`, and `chat()` reinitialises
`recentCalls`, `loopState`, `mutationCountAtLastStallCheck`, `loopSteerEscalated`, `ollamaRetryCount`,
`currentPlan`, `taskList`, `finalReconciled`, `agentsRaw`, `memoryRaw`, `editedPaths`, `fetchedSources`,
`actionTrace` and `episodes` (`agent.ts:1212-1241`); `lastIterationCount` restarts from 1
(`agent.ts:1288`). **Observed:** the marker-retry resume wrote a new log file beginning at `ITER 1/10`.

Consequences, all code-verified and unobserved in effect only because the resume paths have barely run
(2 marker retries, 0 Tester REDOs, 1 replan):

- `getIterationCount()` reports the *resume's* count, so `hitCap`, `justRanLong` (>25 → stand-up) and
  `hadTrouble()` are **blinded on any resumed frame**.
- A resumed Implementer loses its task ledger, plan, per-task verify state and `editedPaths` — so
  `deriveFrameResult` records empty `filesWritten` and `finalReconciled = false` re-arms the
  reconciliation gate.

**This matters for the future: the moment Tester REDO or Planner replan starts working, these become live
correctness problems.** Fix it alongside the Tester and Planner fixes, not after. One of the three most
important interaction findings.

---

## 4. Simplest sufficient implementation

### (i) One signal: a per-frame `git` snapshot — do this one

Take `git status --porcelain` (and `git diff --stat`) at frame start and frame end; derive `filesWritten`
from the difference. Store it in the frame's ledger conclusion.

That single change:

- makes `filesWritten` what `types.ts:135` already claims it is;
- gives the Tester a real diff instead of *"none (or made via bash, not tracked)"*;
- gives the Boss an artifact to verify instead of a self-report (roadmap Item 6);
- closes the plan/act gate's `bash` hole with the same signal (`02` §3).

Four mechanisms improved by one model-independent check. It is the cheapest high-value change in this
document and the external argument for it (Baker et al.) is the strongest external finding in the body.

### (ii) Call `recordStandup` — one line

Every stand-up writes a `LedgerStandupEntry` whatever its verdict, so a stand-up that finds nothing leaves
a trace. Then have the stand-up prompt read accumulated entries **first** and use tools only if they are
insufficient. **Going simpler (cadence without the record)** leaves the Boss unable to see prior
stand-ups, which is today's state and the reason drift detection cannot accumulate.

### (iii) Artifact-by-reference for conclusions — do nothing

Roadmap Item 4. The verdict is **prophylactic, retirable**:

- `capSummary` already truncates conclusions at 2 000 chars and dependency hand-offs at 500;
- Boss frames are short (94 task-starts, 86 finals, all well inside 10–15-iteration budgets) and Boss
  peak context is nowhere near the limit;
- there is **no measured harm** to point at.

Truncation at 2 000 chars is already doing the job the cap exists for. Build the pointer convention and
`.argo/reports/` only if Item 4's falsification test says so (§6). **What going simpler loses: nothing
measurable today.** Note the *diff* half of the same idea (i) is **not** prophylactic — it has measured
harm behind it. Do not bundle them.

### (iv) `ask()` — do not build it

Never implemented, and the design doc itself calls it the most novel and fragile piece. It requires the
Boss to interrupt a running frame, which in a strictly sequential dispatch loop means either suspending
mid-frame (new state machine) or waiting until the frame ends (which is what a stand-up already is).
There is no measured need: the mechanism that would consume it — drift detection — has produced one
actionable verdict in the entire corpus. **Remove it from the open questions rather than carrying it.**

### (v) Implementer context inheritance (H26) — the simplest form already exists

`buildAssignment` already forwards a dependency's capped summary plus its file list. When multi-step
graphs actually execute, extend that to "the last 1–3 Implementer frames" **before** building tag-based
retrieval over `getFrameTrail`/`getRecent`/`expand`. Blocked behind H17 by construction, and the
durable-memory result (`04`) is a live warning about automatic distillation re-importing noise that frame
isolation exists to remove.

### (vi) Fix `resumeFrame` — H14

Add a resume mode to `chat()` that preserves `currentPlan`, `taskList`, `editedPaths`, `episodes` and the
iteration counter, and resets only what a new turn genuinely needs (`recentCalls`, `loopState`,
`ollamaRetryCount`). **Do this before enabling REDO or relying on replan.**

---

## 5. What to watch out for when implementing

- **Do not confuse "isolate contexts" with "withhold information".** Argo isolates frames to keep each
  context small; MAST's second failure category is information withholding. The resolution is that
  *machine-derived* artifacts (diffs, test output, file lists) should always cross the boundary, and
  *narrative* should be capped. Getting this backwards is the current state.
- **A diff can be large.** `git diff --stat` plus the paths is always cheap; the full diff is not. Inline
  it under a line threshold, otherwise write it to a file and pass the path — the restorable-reference
  pattern. This is the one place artifact-by-reference genuinely earns its cost.
- **500 chars is the whole `dependsOn` channel.** If multi-step graphs start running and a downstream
  frame ignores its dependency, check whether 500 chars can carry the dependency's result before blaming
  the model.
- **`doneSummary` concatenates every step's summary** (`dispatch.ts:756`). With one step that is fine.
  With six it is the growth path Item 4 worries about — measure it before assuming it is a problem, and
  measure it *after* multi-step graphs work, not before.
- **Positional step ids collide after a replan.** `readyGroups` is computed once per outer iteration
  (`dispatch.ts:668`); a standup-escalate → `replan()` replaces the graph and clears `doneStepIds`
  (`dispatch.ts:605`), then control returns to the stale `groups` map. Step ids are `s1..sn`, so old and
  new collide and new steps get marked done without running. The failure-status branch above has an
  explicit `break` for exactly this; the escalate path does not. **Fix in the same commit as H17.**
- **`FrameStatus` has six members; `deriveFrameResult` can emit two** (`success`, `gave_up` — the latter
  from a regex on prose). So the dispatch loop's `status === 'failed' || 'killed'` replan branch is
  effectively dead code. Fixing H13 is also what makes it reachable — which means it will run for the
  first time and has never been tested.
- **The Boss's supervision ratio is already 3.3:1.** Any change that makes the Boss verify *more* must
  make the evidence **cheaper to obtain**, not the checkpoint longer. (i) does that; a longer Boss prompt
  does not.

---

## 6. How to validate it

### `filesWritten` — pure log check, no eval run

For every Implementer frame whose workspace diff shows `src/` changes, `filesWritten` must be non-empty.
**Baseline: empty in 4 of 9** saved conclusions. Verifiable against `eval-runs/diffs`, which is already
on disk. Binary; no effect size to argue.

### Does a real diff change the Tester's behaviour?

The mechanism is only worth having if the Tester uses it. Two-arm comparison on the trap task (P2, see
`03`): Tester assignment **with** the diff vs **with** the current fallback string.

**Works:** the arm with the diff produces ≥1 REDO on a task with a deliberately partial implementation,
and the arm without does not. **Does not work:** both arms release. Then the problem is not the channel,
it is the Tester's verdict path or the fail-open, and the diff is necessary but not sufficient.
**Effect size:** binary capability probe; n=1 demonstrates the path, n=3 before claiming a rate.

### Stand-up traces

**Works:** every stand-up writes a ledger entry (baseline: 16 of 22 wrote nothing), and tool calls per
stand-up fall from the observed 8 as the prompt reads summaries first. Both derivable from the ledger and
the frame logs.
**Does not work:** stand-ups still return `NONE` every time. That outcome is uninterpretable without a
drift-trap task — a `NONE` on a run with no drift is correct. **The drift-trap task is a prerequisite for
evaluating stand-ups at all**; say so rather than reading `NONE` as either success or failure.

### Item 4 (artifact-by-reference) — the falsification test

Instrument Boss-frame **peak prompt tokens per checkpoint** (Batch 1's cost vector gives peak context per
run; per-frame needs one field), then run a task with ≥4 Implementer frames after H17.
**Falsified if** Boss context stays flat as frame count grows — in which case `capSummary` is sufficient
and the pointer convention is unnecessary complexity. Prediction from current data: it will be falsified,
because Boss frames run 10–15 iterations and are nowhere near the limit. Run it anyway; it is nearly free
and it retires an item.

### H26 — deferred, metric pre-specified

Once multi-step graphs execute: **tool calls before the first edit per Implementer frame**, and the count
of files re-read that an earlier frame in the same run already read, inheritance ON vs OFF.
**Falsified if** neither number falls, or if inherited context increases drift (the judge's
`drift_or_hallucination` list grows). Both are derivable from existing `tool_call` events — no new
instrumentation.

### H14 — code-level, verified by one resumed frame

**Works:** a resumed frame retains its plan, its task ledger and its iteration count (i.e. the log shows
`ITER 11/60`, not `ITER 1/60`). Verifiable from a single marker-retry or REDO trace. No eval battery
needed.

### Item 7 (delegation thresholds) — measure before enforcing

With Batch 1's counters, measure **frames spawned per difficulty tier**. The trivial tier should show
near-zero framing overhead (`trivial-qa-arithmetic` is already at 2 frames, which is the target); the hard
tier should show frames scaling with genuine work rather than with routing accidents.
**Falsified if** frames per tier are already well-calibrated — in which case prompt judgment suffices and
the policy is unnecessary. Also worth measuring: how often the Boss's 1–2-iteration self-attempt bound is
exceeded in spirit (**23 of 94 task-starts left the workspace dirty**).

---

## 7. Links

- **H14** — OPEN, code-verified. §3, §4(vi). Blocks Tester REDO and Planner replan.
- **H26** — BLOCKED by H17. §4(v), §6.
- **H17 / H18** — decomposition is what makes this channel matter at all. See `02`.
- **H13** — cap-hit → `partial` is what makes the `failed`/`killed` replan branch reachable. See `06`.
- Roadmap: 2026-09-03 register **Item 3** (Implementer inheritance), **Item 4** (artifact-by-reference —
  do nothing, but run the falsification test), **Item 5** (rolling stand-up summaries), **Item 6** (Boss
  verifies artifacts), **Item 7** (delegation thresholds — measure first); "Deliberately NOT adopted" (a
  fifth role, weak-model Boss, LLM parallelism).
- Design: `docs/subagents-plan.md` — note `ask()` should be removed from its open questions (§4 iv), and
  its Magentic-One 31 % citation corrected (§2).
- Related: `interaction-matrix.md` (Tester REDO × resumeFrame; replan × readyGroups; isolation ×
  compaction), `03` (the diff is what makes verification possible), `01` (isolation reduces compaction
  pressure).
