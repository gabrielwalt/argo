# Task decomposition and planning

When decomposition earns its cost · replanning triggers · plan recitation · the plan/act gate

Hypotheses: **H07** (Planner cannot decompose — DISMISSED), **H17** (removing the task-ledger gate
from non-Implementer frames unblocks decomposition), **H18** (decomposition, once unblocked, beats the
single-Implementer path — BLOCKED by H17), **H26** (Implementer frames waste turns rebuilding context
— BLOCKED by H17). Roadmap: 2026-09-03 register, **Item 3**, **Item 7**; 2026-09-02 multi-agent entry.

---

## 1. What the concept is

Three separable things are usually bundled under "planning", and Argo has all three:

1. **Making a plan exist at all** — the plan/act gate blocks a project mutation until `update_plan`
   has been called (`src/agent.ts:1624`). This is a permission state, not advice.
2. **Keeping the plan in attention** — the plan or task ledger is pushed as the last message every
   turn (`src/agent.ts:824`). Plan recitation.
3. **Decomposing into separately-executed units** — the Planner frame emits a `TaskGraph`; the
   dispatch loop turns steps into Implementer frames with `dependsOn`/`frameGroup`, and can `replan`.

(1) and (2) are cheap, single-frame, and always on. (3) is the expensive one: an extra 20-iteration
frame per `OBJECTIVE`-classified task, plus `parseTaskGraph`, `frameGroup`, `skipTest`, `readyGroups`,
`replan` and the `TaskGraph` type.

**North star served:** "without losing track of progress". A plan is the only artifact that
distinguishes "I have done 3 of 5 things" from "I am busy". Decomposition additionally serves "runs a
long time" by giving each unit a fresh context — but only if it works.

---

## 2. External evidence

### An explicit plan step helps multi-step work

*Plan-and-Solve* prompting — "first devise a plan to divide the entire task into smaller subtasks,
then carry out the subtasks according to the plan" — consistently beat Zero-shot-CoT
([arXiv 2305.04091](https://arxiv.org/abs/2305.04091)). **Class B, transferability WEAK**: this is
single-turn arithmetic/reasoning prompting, not an agentic loop with tools, and the gain came from
adding *detailed instructions* to the plan step. It supports "make a plan exist" (Argo's item 1); it
says nothing about frame-level decomposition.

ReAct's own limitation, as LangChain's analysis puts it, is that the model "only plans for one
sub-problem at a time", so it is never forced to reason about the whole task
([arXiv 2210.03629](https://arxiv.org/abs/2210.03629),
[LangChain](https://blog.langchain.dev/planning-agents/)). **Class D, transferability PARTIAL** —
it is an argument, not a measurement.

### The strongest evidence for a plan artifact is recitation, not decomposition

Manus writes and continually rewrites `todo.md`, checking items off, explicitly to "recite objectives
into the end of the context … avoiding lost-in-the-middle issues and reducing goal misalignment" over
tasks averaging ~50 tool calls
([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
**Class D on effect size, transferability DIRECT** — it is a prompt-shape change with no capability
precondition, and Argo's docs already call recitation "the #1 lever for holding a small model on the
current task".

### Mode-as-state, not mode-as-instruction

Claude Code's plan mode is a **permission mode**; Cline's Plan mode "cannot modify any files or execute
commands"; Roo's Architect mode has read plus **markdown-only** write access
([Anthropic](https://docs.anthropic.com/en/docs/claude-code/common-workflows),
[Cline](https://docs.cline.bot/features/plan-and-act),
[Roo](https://docs.roocode.com/basic-usage/using-modes)). **Class D, transferability DIRECT.** Argo's
plan/act gate is this pattern and it is the best-evidenced mechanism in the harness (§3). Note that in
all three products the plan→act transition is **human-gated**; Argo's is automatic, which is a real
difference and a place where the transfer is incomplete.

### Ledger-style orchestration: the 31 % figure, corrected

Magentic-One runs an Orchestrator with a **Task Ledger** (facts, guesses, plan) and a **Progress
Ledger** (progress, assignments), with a stall counter that forces re-planning
([Microsoft](https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/)).
Argo's docs cite "31 % of performance attributed to the ledger alone".

**Verified and corrected.** The ablation is real — [arXiv 2411.04468](https://arxiv.org/abs/2411.04468)
§5.3, Fig. 3(a): "without the full ledgers, performance drops by 31%" on the GAIA validation set with
GPT-4o. But the paper's own description of that ablation is that it replaces the Orchestrator with
AutoGen's `GroupChat`, "eliminating both ledgers, planning, progress tracking, loop detection, and
explicit instructions to other agents." **The 31 % is the value of the entire orchestrator, not of the
ledger.** Class B for the number, **transferability PARTIAL and the attribution is wrong as cited** —
do not use 31 % as an argument for a ledger.

### The counterweight: simple pipelines beat agentic scaffolds

*Agentless* replaces the agent loop with a fixed three-phase pipeline (localise, repair, validate),
"without letting the LLM decide future actions or operate with complex tools", and achieved the
**highest performance among all open-source approaches on SWE-bench Lite (32.00 %) at $0.70 per
instance** ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489)). **Class B, transferability PARTIAL**
(frontier model, single benchmark, and Argo's tasks are not all localise-and-patch). The transferable
claim is narrow but important: **added agentic machinery is not automatically a gain, and a fixed
simple pipeline is a serious competitor.** This is the most relevant external result for the H18 kill
criterion.

### Multi-agent systems fail in characteristic ways, and the gains are often minimal

MAST — 1 600+ annotated traces across 7 multi-agent frameworks, 14 failure modes in 3 categories
(system design, **inter-agent misalignment**, **task verification**), inter-annotator κ = 0.88, panel
including **Qwen2.5 and CodeLlama** on coding tasks. Opening sentence: "Despite enthusiasm for
Multi-Agent LLM Systems, their performance gains on popular benchmarks are often minimal."
([arXiv 2503.13657](https://arxiv.org/abs/2503.13657)) **Class B, transferability PARTIAL-to-DIRECT** —
open models, coding tasks, and their two loaded categories are exactly where Argo's measurements sit.

Cognition's position is blunter: parallel subagents make **conflicting implicit decisions**; default
to a single-threaded linear agent; share full traces, not summaries
([Cognition](https://cognition.ai/blog/dont-build-multi-agents)). **Class D, transferability DIRECT**
for the serial-handoff lesson. Argo is single-threaded by invariant, so the parallel half is moot; the
handoff half is not (see `08`).

Anthropic's 90.2 % multi-agent improvement is **transferability NONE**: it is breadth-first *research*
with parallel Sonnet subagents under an Opus lead, and their own report says token usage explains ~80 %
of the variance and that multi-agent burns ~15× the tokens, while "most coding tasks involve fewer
truly parallelizable subtasks"
([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). A design whose gain
comes from spending more tokens in parallel cannot transfer to a system with one GPU and a
no-concurrency invariant.

### Replanning must be event-triggered and rare

Magentic-One gates re-planning on a stall counter; LangGraph's plan-and-execute calls re-plan after
execution; Reflexion loops on concrete test feedback
([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)). The consistent design across all of them is a
**concrete signal** (step failed, verify failed, blocked), not a per-step re-plan. **Class C/D,
transferability DIRECT** — the failure mode being avoided (thrashing, goal churn) is worse for small
models, not better.

---

## 3. Our own evidence

### The single most important fact in this document

**84 of 85 executed task graphs have exactly one step.** One has two. So the dispatch loop's
decomposition machinery — `frameGroup`, `skipTest`, `dependsOn`, `readyGroups`, `replan` — has
**never actually run.** Not "run and failed": never run.

And the reason is not the model. **All 8 large-task Planner frames emitted valid 2–5-step JSON
graphs.** The harness discarded every one:

- `update_plan` is in `ROLE_TOOLS.planner` (`frames.ts:21`);
- the tool schema tells the model to attach a `verify` command (`tools/index.ts:187`), so the Planner
  does;
- `spawnFrame` (`dispatch.ts:141`) never calls `setTasks(false)`, so the default-ON task ledger and
  its executable verify gate are active in the Planner frame;
- the verify gate then intercepts the Planner's **no-tool-call final answer — which *is* its output
  contract** — on every turn until the cap;
- `parseTaskGraph` (`dispatch.ts:398`) fails open to a one-step graph.

Result: **9 of 23 Planner frames (39 %) die at their cap**, and 48 role-restriction rejections came
from Planner frames trying to implement under verify-gate pressure. Full trace evidence:
`/shared/argo-catchup/EVIDENCE-planner-trap.md`.

**H07 is DISMISSED.** The claim "the Planner cannot decompose large tasks (4-for-4 failures)" was a
harness bug read from the wrong artifact: the ledger records frame *conclusions*, and the thing that
failed *was* the conclusion, so the ledger could only ever confirm the wrong story. That wrong
conclusion stood across three documents and cost three hypotheses and two eval sessions.

**This is also the anchor example for the interaction matrix**: harness task-sequencing × non-Implementer
frames is not a complexity cost, it is a correctness bug. See `interaction-matrix.md`.

### What planning machinery *does* work

**The plan/act gate is the cleanest cause-and-effect relationship in the harness.** 81 firings; **77 of
81 (95 %) are followed by a `plan` event within six events**; three sampled traces show the model
reading the gate, calling `update_plan` on its next turn, and re-issuing the blocked edit
(`agent.ts:1624`). Class A. Mode-as-state works here exactly as the literature predicts.

Its known hole is quantified: `isProjectMutation` inspects only `edit_file`/`write_file`, so a `bash`
heredoc, `sed` or `python3` write bypasses the gate entirely — and that path is used often enough to
leave `filesWritten: []` in **4 of 9** saved Implementer conclusions. Closing it needs a real signal
(a `git status` diff after each `bash` call), not command parsing. See `08`.

**The Boss's 4-way router works and is cheap.** 94 task-start frames, hard-capped at 10 iterations
(`dispatch.ts:227`). Classifications actually emitted: `TRIVIAL` 14, `ANSWER` 13, `OBJECTIVE` 3,
`SIMPLE` 2 — **fast paths chosen in 27 of 32 marked classifications (84 %)**, and `OBJECTIVE`, the only
path reaching the Planner, chosen 9 % of the time. Documented cost wins belong to this mechanism:
`race-semaphore` 1801 s → 86 s, shared-8 1276 s → 592 s. Class A.

This matters for the decomposition question: **decomposition is on the path taken 9 % of the time.**
Its upside is bounded by that, unless the routing is wrong.

### What we do not know

- **Whether plan recitation is present in the outgoing prompt.** `agent.ts:824` is verified in code
  and **emits no event**. The mechanism the docs call "the #1 lever" is an untested assumption.
- **Whether decomposition helps.** 0 measurements. H18 is BLOCKED and its kill criterion is
  pre-registered.
- **Whether Implementer context inheritance helps (H26).** With 84/85 graphs single-step there is no
  previous Implementer frame to inherit from. `dependsOn` context has been supplied to **5 frames**
  in the entire history.

### A latent correctness bug that arms the moment decomposition starts working

`readyGroups` is computed once per outer iteration (`dispatch.ts:668`). A `runStandup` returning
`escalate` calls `replan()`, which replaces `graph` and clears `doneStepIds` (`dispatch.ts:605`).
Control then returns to the **stale** `groups` map, spawns frames for the *old* graph's steps, and
writes their ids into the *fresh* `doneStepIds`. Step ids are positional (`s1..sn`), so old and new
collide — **marking new steps done that never ran.** The failure-status branch a few lines above has
an explicit `break` with a comment about exactly this staleness; the standup-escalate path does not.

This has never bitten because `groups.size` has always been 1. **Fix H17 without fixing this and the
first multi-step graph can silently skip work.** Class A (code-verified). This is one of the three
most important interaction findings.

### And one more that arms at the same time

`replan` resumes an existing frame via `resumeFrame` → `agent.chat()`, which **reinitialises
`currentPlan`, `taskList`, `loopState`, `editedPaths`, `episodes`, `finalReconciled` and the iteration
counter** (`agent.ts:1212-1241`, `agent.ts:1288`). Confirmed observationally: the Boss marker-retry
resume wrote a new log file beginning at `ITER 1/10`. Replan has run **once** in the whole corpus, so
this is latent — until it isn't. H14. See `08` §3.

---

## 4. Simplest sufficient implementation

### For H17 the change is subtractive, and it is the highest-value change in the codebase

```
1. spawnFrame(): setTasks(false) for every role except implementer.
   (And review setMemory/setGrounding/setLoop per role rather than inheriting four defaults
    by accident — that omission is the class of bug, not just this instance.)
2. Remove update_plan from ROLE_TOOLS.planner (frames.ts:21).
```

One to three lines. No new concept, no new module, and it deletes behaviour rather than adding it.
`agent.ts:1322` already special-cases the Planner out of `update_plan` advice, so the codebase already
half-believes this.

**Do the `readyGroups` `break` in the same commit.** It is one statement and the alternative is
silently skipped work on the first multi-step graph.

### For H18, build nothing — run the experiment and honour the kill criterion

The pre-registered criterion (HYPOTHESIS-LEDGER H18): *if a multi-step graph does not beat the
single-Implementer path at k≥3, delete Planner / TaskGraph / frameGroup / readyGroups / replan and keep
the supervision half, where all measured value currently sits.*

Keep it. The Agentless result and MAST both say the prior should be sceptical, and Argo's own evidence
separates cleanly: **everything that has produced a measured win is supervision** (Boss router,
independent Tester verification in one trace, diff-size guard, cap-hit escalation); **everything that
has produced zero evidence in five attempts is decomposition.** They ship as one flag and are defended
as one architecture. That framing is wrong and `ASSESSMENT.md` §5.3(i) is right: the axis is
**supervision vs decomposition**, not multi-agent vs single-loop.

### If decomposition is deleted, what replaces it

Nothing needs to be built. The single-Implementer path already has the plan/act gate, `update_plan`,
per-step executable `verify` and tail recitation. That is Plan-and-Solve inside one frame, and it is
the configuration with the evidence. Saying this plainly matters: **the fallback is not a downgrade, it
is the currently better-evidenced design.**

### For H26 (Implementer context inheritance) — do nothing yet

Blocked behind H17 by construction, and there is a real risk it re-imports the noise that frame
isolation exists to remove — the durable-memory result (transcript sludge scoring as "verified facts",
see `04`) is a warning about automatic distillation. When it becomes testable, the simplest form is
the one that already exists: `buildAssignment` already forwards each dependency's capped conclusion
summary plus its file list (`frames.ts:118-134`). Extend that to "the last 1–3 Implementer frames"
before building tag-based retrieval over `getFrameTrail`/`getRecent`/`expand`.

### For replanning triggers — do nothing new

Argo already has stall counters (`agent.ts:1298`), verify-failure escalation, and a Boss escalate →
replan path (`dispatch.ts:581`). The literature's advice is "event-triggered and rare", and Argo's
replan has fired **once**. It is already rarer than rare. The problem is not the trigger, it is that
`parseBossVerdict` fails open to `none`, so the trigger cannot fire. See `03`.

---

## 5. What to watch out for when implementing

- **The Planner trap generalises.** `spawnFrame` sets model, options, tools, role prompt, frameId,
  maxIterations and sessionId — and **no behavioural config at all**. Every default-ON mechanism is
  applied to every role by accident. Fixing `setTasks` fixes the instance; adding a per-role policy
  block fixes the class. Do the class.
- **`parseTaskGraph` fails open to a one-step graph.** After H17, a *future* Planner failure will
  still be silently swallowed. Make a capped or unparseable Planner escalate, using the same
  `resumeFrame`-for-format idiom `b3b998b` already proved for the Boss marker (2 firings, 2 successes).
- **A Planner that decomposes badly is worse than no Planner.** MAST's system-design category and the
  known anti-pattern of over-decomposition both apply. Watch the step-count distribution: 2–5 steps on
  a genuinely tripartite task is right; 8 micro-steps is the failure.
- **Do not justify a tool-shaped `plan_graph` contract on the Planner's behaviour.** The principle
  (free-text output contracts are fragile) is correct and is true of the Boss's marker line. It is
  **not** true here: the Planner's JSON block was never the problem. `ASSESSMENT.md` §5.3(iv).
- **`dependsOn` summaries are capped at 500 chars** (`frames.ts:106-110`). If multi-step graphs start
  running, that cap is the whole inter-frame channel. Check whether 500 chars can carry a dependency's
  result before blaming the model for ignoring it.
- **The Boss's self-attempt habit costs real budget.** The Boss is responsible for **53 of 102**
  role-restriction rejections, repeatedly trying `write_file`/`edit_file` at checkpoints where it has
  only `bash`, out of a 10–15-iteration budget; **23 of 94 task-starts (24 %) end with the workspace
  dirty**. The current middle position — instruct it not to, then let it — pays for both. Pick one:
  drop `bash` at task-start, or accept self-attempts and stop spending prompt text fighting them.

---

## 6. How to validate it

### H17 — no judge, no eval rubric needed

Signal already exists: `metrics.mjs` records `task_graph.steps.length` per run (baseline: 84 of 85 = 1).

```
EVAL_TASKS=bigproj-observability EVAL_RUNS=1 npm run eval:e2e
# then, from the task's ledger jsonl:
#   count entries with kind === 'delegation' && to === 'implementer'
```

**Works:** a `task_graph` event with **≥2 steps** and **≥2 Implementer delegations**. Binary,
unambiguous, no judge. **Does not work:** still 1 step — then the trap was not the whole cause and the
next place to look is `parseTaskGraph`'s input, i.e. the Planner frame's own final message.

Also check: Planner cap-hit rate should fall from 9/23. If it does not, something else in the frame is
still gating its final answer.

### H18 — the real experiment, with the kill criterion pre-registered

`bigproj-observability` and `bigproj-deps`, `k=3`, `ARGO_AGENTS=1`, graph confirmed present.

**Reference numbers to beat** (state which budget each side had, per PLAN standing rule 7 —
Hermes is capped at `max_turns: 60`, Argo multi-agent has no total cap and has used 100–104):
- `bigproj-observability`: Hermes 100 / 71 s; Argo with the broken Planner 87 / 721 s.
- `bigproj-deps`: single-Implementer 1616 s.

**Works:** on the new rubric (60 seeded-test correctness + 20 quality + 20 reliability over k),
decomposition beats the single-Implementer path on **correctness or total LLM turns** on at least one
task at k=3. Given the do-nothing floor is now 0 and correctness is seeded-tests-only, a meaningful
correctness effect is **at least one of three runs moving from partial to complete** where the
single-Implementer arm did not — plus no increase in total LLM turns. A win on wall-clock alone does
not count: speed is out of the score, and the 5–8× per-iteration slowdown is unexplained.

**Does not work:** equal or worse on both tasks. Then execute the kill criterion. The failure mode to
guard against is keeping it because the architecture is elegant.

**Confound to control:** decomposition adds a 20-iteration Planner frame per `OBJECTIVE` task, and
`OBJECTIVE` is chosen 9 % of the time. Report frames-per-task alongside, or the cost of the mechanism
is invisible in the aggregate.

### Plan recitation (P5) — cheapest useful measurement in the project

Log the final message's first 200 chars once per iteration on one run and read it. Expect the
ledger/plan block last, with the current step marked. This converts "the #1 lever" from assumption to
fact for the cost of one line. Do it before anything else in this document.

### H26 — deferred, but the metric is already defined

Once multi-step graphs execute: **tool calls before the first edit per Implementer frame**, and the
count of files re-read that an earlier frame in the same run already read, inheritance ON vs OFF.
Falsified if neither falls, or if the judge's `drift_or_hallucination` list grows.

---

## 7. Links

- **H07** — DISMISSED. §3. The harness discarded 8 of 8 valid graphs.
- **H17** — OPEN, verdict from one run. §4, §6.
- **H18** — BLOCKED by H17. Kill criterion pre-registered in `HYPOTHESIS-LEDGER.md`.
- **H26** — BLOCKED by H17. §4, §6.
- **H14** — `resumeFrame` wipes run state; arms when replan starts working. §3, and `08` §3.
- **H01** — more iterations do not help (DISMISSED); relevant because decomposition's pitch is partly
  "more focused turns". See `06`.
- Roadmap: 2026-09-03 register **Item 3** (Implementer inheritance), **Item 7** (delegation
  thresholds); 2026-09-02 multi-agent architecture entry; 2026-09-03 "Expanding upward: a
  decomposition-shaped task".
- Program: `/shared/argo-program/PLAN.md` BATCH 2 item 2.
- Related: `interaction-matrix.md` (task-sequencing × non-Implementer frames; replan × readyGroups),
  `03` (the supervision half, where the measured value is), `08` (what a frame returns).
