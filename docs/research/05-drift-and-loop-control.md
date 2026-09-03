# Loop, drift and hallucination control

Repetition detection · re-anchoring · stall handling

Hypotheses: **H01** (more iterations improve results — DISMISSED), **H19** (the near-duplicate guard
does nothing and should be deleted), **H20** (L0 fails because it keys on exact args), **H23** (pinned
anchor — see `01`). Roadmap: 2026-09-03 register **Item 1**; 2026-07-30 loop-recovery ladder entry.

---

## 1. What the concept is

Six mechanisms in Argo exist to stop the agent going in circles or wandering off:

| Mechanism | Trigger | Action | Where |
|---|---|---|---|
| Near-duplicate guard | similar recent call | nudge only, never blocks | `loop.ts:83` |
| Loop ladder **L0** | exact `(tool, args)` repeat | **blocks** the call | `loop.ts:120` |
| Loop ladder **L1** | continued repetition | compact / evict | `agent.ts:1651` |
| Loop ladder **L2** | continued repetition | demand a reframe | `agent.ts` (via `loop.ts`) |
| Progress check / stall | iteration counts | ask for a progress statement | `agent.ts:1298` |
| No-progress re-anchor | 12 tool calls with no mutation, then every 8th, max 4× | strongest anti-drift text in the harness (`regroundSteer`, `agent.ts:240`) | `agent.ts:1791` |

Between them they fired **461+ times** across the corpus. **No artifact links any firing to a run
outcome.**

**North star served:** "without looping" and "without losing the goal". This is the concept where
Argo's own measurements are most sharply at odds with its design intent — three of the six mechanisms
have a measured null or negative effect.

---

## 2. External evidence

### Repetition is a length-driven degeneration, not only a reasoning failure

Chroma's *Context Rot* includes a deliberately trivial **repeated-words** task — models replicate a
series of repeated words — and finds performance degrades with input length across 18 models including
Qwen3 ([Chroma](https://research.trychroma.com/context-rot)). **Class C, transferability
DIRECT-ish** (Qwen3 in the panel).

The design implication is significant and easy to miss: if repetition is partly a function of context
length, then **the cheapest anti-repetition mechanism is a shorter context**, not a better repeat
detector. Argo's loop ladder and its context management are addressing the same underlying failure from
two directions, and only one of them is cheap.

### Uniform context induces mimicry

Manus's *"Don't Get Few-Shotted"*: repetitive action-observation pairs make the model "fall into a
rhythm … drift, overgeneralization, or … hallucination"; the recommended fix is deliberate **diversity**
in serialisation and phrasing
([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
**Class D, transferability DIRECT** (prompt-shape only).

Two things follow that Argo has not acted on. First, an escalating steer with **fixed wording** is
itself uniform context — repeating the same block verbatim 170 times across a corpus is the pattern the
advice warns about. Second, the recommended intervention is a *nudge with variation*, **not a block**.
Argo blocks. See §3.

### Keep the failures in context

Manus, same source: leaving failed actions and stack traces in context "shifts its prior away from
similar actions, reducing the chance of repeating the same mistake"; erasing failure "removes evidence
… the model can't adapt". **Class D, transferability DIRECT.**

This is in direct tension with Argo's L1, which responds to repetition by *compacting or evicting* —
and `evict()` strips **oldest action episodes first**, which is where the failures are. All 3 eviction
firings in the corpus came via L1. So Argo's loop response deletes the evidence Manus says prevents the
loop. Flagged in `interaction-matrix.md`.

### Recite the goal at the tail

Manus's `todo.md` recitation is the single best-evidenced anti-drift mechanism in the practitioner
literature, and *Lost in the Middle* supplies the positional mechanism
([arXiv 2307.03172](https://arxiv.org/abs/2307.03172)). **Class D / class B, transferability DIRECT.**
Argo has recitation (`agent.ts:824`) and does not log it, and has a pinned anchor
(`eviction.ts:70`) it never calls. See `01`.

### The named failure patterns match ours

*The Danger of Overthinking* analyses 4 018 SWE-bench Verified trajectories and names three recurring
patterns: **Analysis Paralysis**, **Rogue Actions**, **Premature Disengagement**. Higher overthinking
scores correlate with **decreased** performance; selecting the lower-overthinking solution improved
performance by almost 30 % while cutting cost 43 %
([arXiv 2502.08235](https://arxiv.org/abs/2502.08235)). **Class B, transferability PARTIAL** (large
reasoning models, frontier scale).

The taxonomy transfers cleanly even if the numbers do not: Argo's 43 cap-hit blank frames are Premature
Disengagement plus Analysis Paralysis, and the 12-of-22 verify failures with no subsequent edit are
Analysis Paralysis. Naming them consistently is worth doing.

### What the literature does not offer

**There is no good published work on repetition *detection* in agent harnesses.** No benchmark, no
ablation, no reported precision/recall for a loop guard. Every implementation is a practitioner
heuristic. Saying this plainly matters: **Argo's own 143-block effect measurement is, as far as this
pass could establish, better evidence about loop-guard design than anything available externally.**
Design from our data here, not from analogy.

---

## 3. Our own evidence

### L0 blocks 143 calls and achieves its purpose 6 times

`repetitionKey` is `(tool, exact args)`. 170 firings (12 July, 158 September); **143 carry
`rejected: true`**, so the call is genuinely blocked and an iteration is spent. Of the 143 with an
observable next tool call:

| outcome | n |
|---|---|
| next call targets the same file/path and **mutates** it — the desired effect | **6** |
| next call targets the same file/path and **re-reads/re-runs** it — evasion | **46** |
| next call same tool, different target (ambiguous) | 43 |
| next call a genuinely different action | 23 |
| no further tool call | 20 |
| other | 5 |

**The intended behaviour change occurred in 6 of 143 observable cases (4 %).** The evasions are
textbook and each costs a further iteration:

```
blocked: bash  cat -n /workspace/src/validation.js
next:    bash  cat -n /workspace/src/validation.js 2>&1

blocked: bash  node --test /workspace/test/effort.test.js 2>&1 | head -80
next:    bash  node --test /workspace/test/effort.test.js 2>&1 | tee /tmp/…

blocked: read_file  /workspace/test/event-hook.test.js
next:    bash       cat /workspace/test/event-hook.test.js
```

Appending ` 2>&1`, changing a pipe, or switching `read_file` → `bash cat` defeats the key entirely — and
the model does all three. **46 of 57 same-target follow-ups evade.**

Plus a false-positive class: `ASSESSMENT.md` §4 documents L0 blocking a **Planner's legitimate second
read** of a file it needs, twice in one frame. A guard that spends an iteration punishing correct
behaviour is worse than no guard.

### The near-duplicate guard is the most-fired mechanism in the harness and has a 100 % null result

**180 firings — more than any other mechanism — and in 180 of 180 cases the next tool call is another
call to the same tool.** Its instruction is "take a genuinely different kind of action". It never blocks,
so it costs no iteration directly, but it consumes context every time and it fires on Planner frames
reading files, which is the behaviour that role requires. **H19 is well founded: this is the strongest
deletion candidate in the harness.**

### L2 gives non-Implementer roles advice they cannot act on

15 firings. Two of three sampled traces are positive — the model abandoned its approach ("I have
duplicate content in query.js from multiple edit attempts — let me take a clean approach") or called
`update_plan`. The third is a clear harm case: **a Boss stand-up frame looping on `ledger`
`get_conclusion` received L2's fallback wording, "Produce a revised plan now for solving the current
task a different way" — nonsensical for a checkpoint whose only job is to emit
NONE/INJECT/RESTART/ESCALATE — fired twice, and the frame then hit `ITER 15/15` and stalled blank.**
A loop guard contributing directly to the cap-hit failure mode it exists to prevent.

`hasUpdatePlan` (`agent.ts:1322`) was already patched to stop telling the *Planner* to call
`update_plan`; the fallback branch still gives **every** non-Implementer role planning advice.

### L1 is Argo's de facto context policy, by accident

26 firings, mixed effect. **All 3 episode-eviction firings in the corpus came via L1**
(`agent.ts:1651`), never via the context threshold. So the mechanism nominally responsible for context
management is triggered by the loop guard. Not a design. See `01` §3(c) and
`interaction-matrix.md`.

### Stall checkpoints and the no-progress re-anchor

- **Stall / progress checkpoints: 251 firings** (199 PROGRESS CHECK, 52 STALL). Only **26 followed by a
  mutation within 12 events (10 %)**. *Caveat stated because it matters:* a PROGRESS CHECK explicitly
  asks the model to *state* which steps are done, so a text-only next turn is compliant and this metric
  under-credits the mechanism. What survives the caveat: they fire 199 times across ~317 frames, cost a
  turn each, and **no evidence in the corpus ties a firing to a recovered run.** One positive instance
  is visible: a firing at iteration 45 immediately preceded an `update_plan` that reorganised the
  remaining work.
- **No-progress re-anchor: 30 firings, 10 followed by an edit (33 %).** Its trigger is precise and its
  message (`regroundSteer`, `agent.ts:240`) is the strongest anti-drift text in the harness. 33 % beats
  the stall checkpoints and loses to the plan gate's 95 %. **Keep it; instrument it; do not tune it
  yet.**
- Note `agent.ts:1275`: stall re-ground fractions scale off the iteration cap. If caps become soft
  (`06`), these triggers move with them — check before changing budgets.

### `action.level` is thrown away

`loop.ts` carries `level: L0/L1/L2`; `agent.ts:1659` emits a `message` and **drops `level`**, which is
why five regexes exist downstream to reconstruct it (H16). Batch 1 works around this by counting L0/L1/L2
separately from prose with validated patterns (0 unmatched of 982 September + 361 July `warning`
events), but the field is still the right fix.

### H01 — more iterations made things worse

60 → 90 iterations made `bigproj-effort` **worse**: 5/6 then 3/6, with thrashing, self-reverting, and an
attempted oracle edit. **DISMISSED.** The lever is supervision, not turns. This is Argo's own version of
the overthinking result, and it arrived independently.

---

## 4. Simplest sufficient implementation

The simplest sufficient implementation here is **net deletion plus one changed key**.

### (i) Delete the near-duplicate guard — H19

180 firings, 0 behaviour change, real context cost, known false positives on read-only roles. Deleting it
removes code and prompt surface and should change no quality metric. **If a quality metric drops, it was
doing something invisible** — which is itself the most interesting possible result, so measure before and
after rather than deleting silently.

### (ii) Change L0's key; stop blocking; serve the cache — H20

Three changes to one mechanism, all small:

```
1. Key on a NORMALISED TARGET, not the raw argument tuple:
     - read_file / edit_file / write_file  → resolved absolute path
     - bash                                → (command head verb, referenced path(s))
   So `cat -n X`, `cat -n X 2>&1` and read_file(X) collapse to one key: (read, X).

2. Do not block. Return the CACHED PREVIOUS RESULT with a one-line note:
     "You already ran this at iteration N; here is what it returned."
   Cheaper than a block (no wasted turn), and there is nothing to evade —
   the model gets what it asked for.

3. Exempt a repeat when a MUTATION HAS OCCURRED since the last identical call
   (a non-empty editedPaths delta).
```

Change 3 is the whole false-positive fix and it costs one condition. It is the signal that distinguishes
"re-running tests after a fix" (legitimate, must be allowed) from "re-running tests unchanged" (a loop).
The harness already tracks `editedPaths`; nothing new is needed.

**What going simpler loses.** Deleting the near-duplicate guard but leaving L0's key untouched keeps the
4 % hit rate, the ~80 % evasion rate and the false positives — i.e. keeps the mechanism with the
measured harm and deletes the one with measured neutrality. That is the wrong half.

**Why serving the cache rather than blocking is the simpler design, not the fancier one.** A block needs
escalation logic (L0 → L1 → L2), per-role wording, and a false-positive policy. A cache-serve needs
none of those: the model is not fighting the harness, so there is nothing to escalate. It plausibly makes
L1 and L2 unnecessary — which would remove the accidental coupling to eviction as a side effect.

### (iii) Role-specific L2 wording — trivial

For Boss/Tester frames: "conclude now with your verdict in the required format." Not "produce a revised
plan". And treat the `ledger` tool leniently in the ladder: re-reading a ledger entry is cheap and often
legitimate.

### (iv) Emit `level` instead of reconstructing it — H16

`agent.ts:1659` already has the field. Emitting it retires five regexes. Small, and it makes the counters
rot-proof rather than merely validated.

### (v) Stall checkpoints — instrument before touching

251 firings, effect unknown for an instrumentation reason, not an analysis reason. Do **not** tune the
thresholds. Add the `intervention` event with mechanism name and iteration so "did runs that received a
stall check converge more often than those that did not" becomes a query rather than a trace-reading
exercise. Then decide.

### Do nothing about

- **The no-progress re-anchor.** 33 % conversion, precise trigger, best text in the harness. Leave it.
- **Temperature.** Argo pins 0.8 / top_p 0.9 / top_k 40. Lowering it would plausibly reduce repetition,
  but it is a global change affecting everything and it confounds every existing comparison. Raise it as
  an eval-methodology decision (`07`), not a loop-control change.

---

## 5. What to watch out for when implementing

- **Normalising the key raises false positives.** That is the trade: a stricter key catches evasions and
  also catches legitimate re-reads. The mutation-delta exemption (§4 ii.3) is the mitigation. Without it,
  do not ship the normalisation — you would be trading a 4 %-effective guard for a guard that blocks
  correct work more often.
- **Cache-serving must be honest about staleness.** If the file changed on disk since the cached read,
  serving the cache is a correctness bug. Condition it on the mutation delta being empty — which is the
  same check as the exemption, so it costs nothing extra.
- **The blocked-call path is load-bearing for the counters.** `loopSkip` (143) is counted off
  `tool_result.rejected === true` (`types.ts:26`). If L0 stops rejecting, that counter goes to zero and
  looks like a regression. Add a `cacheServed` counter in the same commit or the eval will report a
  false improvement.
- **A loop guard firing on a read-only role is almost always a false positive.** Planner and Tester
  frames read files for a living. Make the guard role-aware or phase-aware, or exempt frames that have
  not yet mutated anything.
- **Do not respond to a loop by deleting context.** L1's compact/evict response is the mechanism that
  removes the failure traces Manus argues prevent the loop, and it is the only path that has ever
  triggered eviction. If L0 is fixed by cache-serving, consider removing L1's evict branch entirely and
  letting the context threshold own eviction — which is what `01` §4 wants anyway.
- **Fixed steer wording repeated 170 times is itself uniform context.** If the escalating steer stays,
  vary the phrasing. It is free.

---

## 6. How to validate it

### Signals that already exist (Batch 1 `metrics.mjs`)

`loopL0`, `loopL1`, `loopL2`, `nearDup`, `progressCheck`, `stall`, `noProgress`, `loopSkip`
(rejections), plus `iters` and `toolCalls`. All validated against the raw logs with **0 unmatched of
982 September and 361 July `warning` events**. Baselines: L0 170, L1 26, L2 15, nearDup 180, stall/progress
251, noProgress 30.

### The evasion-rate metric — the one that matters, and it needs no new code

Post-process any run: for each `rejected` L0 result, classify the next tool call as
mutate-same-target / re-read-same-target / different-target / different-action / none. The script used
for the verification pass was ~20 lines and is re-derivable (probe **P3**).

- **Baseline:** desired effect 6 of 143 (4 %); evasion 46 of 57 same-target follow-ups (~80 %).
- **Works:** after the normalised key plus cache-serving, same-target evasion falls **below 30 %**, and
  total iterations per task falls (each avoided block-plus-evasion saves ~2 turns). With 143 blocks in
  the corpus this is a large enough base to be a real measurement, not a noise reading.
- **Does not work:** evasion ratio flat. Then the normalisation is not capturing the target and the key
  extraction is wrong — check the `bash` path extraction first.

### H19 — deleting the near-duplicate guard

**Works:** no quality metric moves, and context per turn falls slightly. That is a clean win: 180
firings' worth of prompt text removed for nothing.
**Does not work:** pass rate or `drift_or_hallucination` worsens at k=3 on the four `bigproj` tasks.
Then it was doing something invisible and should be redesigned rather than deleted.
**Effect size:** given the suite's saturation (`07`), a pass-rate change on 4 tasks × 3 runs is barely
resolvable. The defensible primary metric is **total LLM turns and context per turn**, with pass rate as
a non-regression check.

### False-positive rate — a new metric, and it is the important one

Nothing currently counts "a guard fired on behaviour the role required". Cheapest definition that is
mechanically checkable: **a loop-guard firing in a frame that has not yet mutated any file.** Count it.
Baseline is derivable from existing logs (the Planner cases are already documented). Target: near zero
after the role/phase awareness and the mutation-delta exemption.

### Stall checkpoints — needs the `intervention` event first

Say it plainly: **the effect of 251 firings cannot be measured with today's artifacts.** The event must
carry mechanism name and iteration, and the run row must carry the outcome, before the question "did a
stall check help" is answerable. Until then, do not tune and do not claim.

### H23 — see `01` §6

Drift incidence is the primary metric, not pass rate. The pinned anchor is the drift mechanism with the
strongest external support and zero local evidence, because it has never run.

---

## 7. Links

- **H01** — DISMISSED. More iterations made `bigproj-effort` worse. §3.
- **H19** — OPEN, delete the near-duplicate guard. §4(i), §6.
- **H20** — OPEN, normalise the L0 key. §4(ii), §6.
- **H16** — OPEN, emit `action.level`. §4(iv).
- **H23** — OPEN, pinned anchor. See `01`.
- Roadmap: 2026-09-03 register **Item 1**; 2026-07-30 "Loop-recovery ladder + harness tasks/memory".
- Program: `/shared/argo-program/PLAN.md` BATCH 2 group 2c.
- Related: `interaction-matrix.md` (L1 × eviction; loop guards × legitimate re-reading; L2 × non-Implementer
  roles), `01` (shorter context is the cheapest anti-repetition mechanism), `06` (H01 and the overthinking
  result).
