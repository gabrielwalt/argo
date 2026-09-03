# Context management

Sliding-window eviction · compaction · what to pin · deterministic tool-result collapsing

Hypotheses: **H23** (pinning the objective across eviction prevents goal drift), **H24** (existing
hard tasks can be made long-horizon for free). Roadmap: `docs/roadmap.md` → 2026-09-03 hypothesis
register, **Item 1**.

---

## 1. What the concept is

Argo has 65 536 tokens and a model that must keep working after the conversation exceeds them. Three
distinct mechanisms exist for that, and they are routinely conflated:

1. **Deterministic tool-result collapsing** — older tool outputs are replaced by a stub. No LLM call.
   Implemented: `TOOL_RESULT_COLLAPSE_OVER` (`src/agent.ts:806`).
2. **Episode eviction** — whole action/exploration episodes are stubbed out of the live message
   array, oldest-first, respecting dependencies. No LLM call. Implemented: `src/eviction.ts`, called
   from `src/agent.ts:645`.
3. **LLM compaction** — the model is asked to distil the history into structured state, and the
   history is replaced by it. Two LLM calls (update + validate). Implemented: `src/compaction.ts`,
   triggered at `src/agent.ts:1377` when `prompt_eval_count ≥ num_ctx − 4096` = **61 440 tokens**.

Plus the thing that makes any of them safe: **a pinned anchor** — the objective and current plan held
outside eviction and recited at the tail. `renderPinnedAnchor(objective, plan)` exists at
`src/eviction.ts:70` and **has zero call sites**.

**North star served:** "runs a long time without losing the goal … with good memory of what matters."
Context management is the mechanism by which "a long time" is possible at all, and pinning is the
mechanism by which "without losing the goal" survives it. These are the two halves and only one is
built.

---

## 2. External evidence

### The strongest transferable result: performance degrades with input length, on simple tasks

Chroma's *Context Rot* report evaluates 18 models — **including Qwen3 models** — and finds that
"performance grows increasingly unreliable as input length grows", on tasks deliberately kept trivial
to isolate length as the only variable. Their LongMemEval condition compares a **focused prompt
averaging ~300 tokens** against the full ~113 k-token conversation containing the same answer, and
observes consistent degradation with the full input. ([Chroma](https://research.trychroma.com/context-rot))

- **Class C, transferability DIRECT-ish.** This is the closest external evidence to Argo's setting
  that exists: it includes the Qwen3 family, and its claim is about input length rather than about
  any model's reasoning. Its limitation is that its tasks are retrieval/replication, not agentic
  coding, so the *size* of the effect on Argo's work is unknown; the *direction* is well supported.
- The practical reading for Argo: reducing live context is not only a capacity measure, it is a
  quality measure. A 40 k-token prompt is worse than a 12 k-token prompt containing the same facts.

*Lost in the Middle* (Liu et al.) established the positional half of this — information in the middle
of a long context is used less reliably than information at the start or end.
([arXiv 2307.03172](https://arxiv.org/abs/2307.03172)) **Class B, transferability PARTIAL** (the
models studied predate qwen3.6, but the U-shaped positional bias has replicated widely). This is the
mechanical justification for reciting the plan at the **tail** rather than the head.

### Deterministic clearing of stale tool results is the cheapest large win

Anthropic reports, on an internal agentic-search eval: **context editing alone +29 %**, memory tool +
context editing **+39 %**, and a 100-turn web-search task that otherwise failed on context exhaustion
completing with **84 % fewer tokens**. Their framing — "once a tool has been called deep in the
message history, why would the agent need to see the raw result again?" — describes the safest,
lightest form of compaction. ([Anthropic](https://www.anthropic.com/news/context-management),
[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))

- **Class C, transferability PARTIAL.** The numbers are on Claude Sonnet 4.5, a frontier model with
  built-in context awareness, on search rather than coding — so do not expect +29 % here. But the
  *mechanism* is model-independent: it is a code operation on the message array requiring no model
  cooperation. That is why it transfers where the memory-tool half does not.
- **Argo already has this** (`agent.ts:806`). The most-endorsed technique in the literature is the
  one Argo built first and never revisited. See §3.

### Manus: restorable compression, plan recitation, keep the failures

Manus offloads bulky observations to files, keeping a restorable reference (URL, path) in context;
rewrites `todo.md` continually to "recite objectives into the end of the context"; and explicitly
warns against erasing failures, because "erasing failure removes evidence … the model can't adapt".
([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus))

- **Class D on effect size** (no numbers published), **class C on scale** ("validated across millions
  of users"), **transferability DIRECT** — these are prompt-shape and file-system changes with no
  model-capability precondition.
- Note the direct tension with eviction: Argo's `evict()` strips **oldest action episodes first**, on
  the reasoning that their effect is durably on disk. Manus's position is that the *failed* actions
  are the ones worth keeping. Both cannot be fully right. See `interaction-matrix.md`.

### Window attention fails when you drop the beginning

StreamingLLM shows that naive window attention — cache only the most recent KVs — collapses once text
exceeds the cache, and that **keeping the KV of a handful of initial tokens largely recovers
performance**, because those tokens act as an "attention sink" even when semantically unimportant.
([arXiv 2309.17453](https://arxiv.org/abs/2309.17453))

- **Class B, transferability WEAK.** This is a KV-cache-level phenomenon inside the attention
  mechanism, not a message-level policy, and Argo does not control the KV cache. Do **not** cite it as
  evidence that pinning the objective helps.
- What it does supply: an independent reason to distrust "just drop the oldest" as a policy. The
  cheapest defensible design keeps a small, always-present head *and* recites at the tail. That is
  what `renderPinnedAnchor` does.

### Compaction shapes: what the literature says to preserve

Claude Code's compaction passes the history to the model to summarise, "preserving architectural
decisions, unresolved bugs, and implementation details while discarding redundant tool outputs", then
continues with the summary **plus the five most-recently-accessed files**; the tuning advice is
*maximise recall first, then trim for precision*.
([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))
**Class D, transferability DIRECT** as a design template — it costs nothing to adopt the shape.

Recursive/hierarchical roll-up is established for book-length text (Wu et al.,
[arXiv 2109.10862](https://arxiv.org/abs/2109.10862)) — **class B, transferability WEAK** for agent
traces, and a poor fit for Argo because each roll-up level is another serial LLM call in a system that
cannot run calls concurrently.

### What does not transfer

- **Sleep-time compute** — pre-computing context offline between turns
  ([arXiv 2504.13171](https://arxiv.org/abs/2504.13171)). **Transferability NONE as designed**: it
  needs spare inference capacity, and Argo has one GPU, one resident model and a hard
  no-concurrency invariant (`dispatch.ts:7`). The transferable residue is trivial and cheap: do
  memory curation *at the end of a run*, when nothing is competing for the GPU. See `04`.
- **Anything premised on a 1 M context.** A frontier model that can hold the whole repository is not
  evidence about a 65 k window; it is evidence that the problem can be bought out of, which Argo
  cannot do.

---

## 3. Our own evidence

All figures from the 567-log verification pass.

| Fact | Value | Where |
|---|---|---|
| Peak prompt context ever observed | **64 266 of 65 536** | 5 003 token observations |
| Observations at/above the 61 440 compaction trigger | **6 of 5 003** | `agent.ts:1377` |
| Observations above ~15 k tokens (`maxLiveChars = 60 000` equivalent) | **1 849 of 5 003** | `eviction.ts` `DEFAULT_EVICTION_BUDGET` |
| LLM compaction firings | **14** (test-two 12, booklet 1, bigproj 1); 12 `validated: true` | `agent.ts:1377` |
| Episode eviction firings | **3**, stubbing **44 episodes** total, **all via the L1 loop-recovery path**, never once via the context threshold | `agent.ts:645`, `agent.ts:1651` |
| `renderPinnedAnchor` call sites | **0** | `eviction.ts:70` |
| Tail recitation of the plan/task ledger | present in code, **not logged**, so never verified in an outgoing prompt | `agent.ts:824` |

Four consequences follow, and they are more interesting than the headline numbers.

**(a) Eviction is a cliff, not a policy.** Its budget (`maxLiveChars = 60 000` ≈ 15 k tokens) sits
**four times below** its trigger (61 440 tokens). So the first time the threshold path is ever taken,
`evict()` will stub essentially every evictable episode in a single pass. The 3 observed firings
already show this shape: ~15 episodes stubbed per firing. The module's own header comment says it
"runs every turn — cheap enough that 'every turn' is the right cadence"; the wiring does not do that.

**(b) The compaction distribution says something about isolation.** 12 of 14 compactions are in
`test-two`, the workspace used for **baseline single-loop** work. `bigproj`, where multi-agent runs
happen, has **one**. Per-frame context isolation demonstrably reduces compaction pressure. It does not
eliminate it — the 64 266-token peak happened — but this is real measured support for the idea that
sub-agent isolation and compaction are partially redundant. See `interaction-matrix.md`.

**(c) Eviction has never run with a pinned objective, because there is none.** The doc comment on
`renderPinnedAnchor` calls the pinned objective "a direct structural fix for the original failure
that motivated this project". Argo evicts today in exactly the configuration the anchor exists to
prevent. It has only happened 3 times, so the harm is potential, not measured — but H24 exists
precisely to make it common.

**(d) The framing finding in `docs/research.md` is superseded and its number is still in the code.**
That report's premise was an internal probe showing tool-call emission collapsing by ~7–12 k *chars*
of live context, with the design goal "keep the LIVE context near the low-thousands of chars". That
probe was **Devstral**; the same report records "Qwen3 was robust to larger context; Devstral
fragile". Argo now runs qwen3.6 exclusively (H02, validated 4/4) and has driven it to 64 266 tokens.
`DEFAULT_EVICTION_BUDGET.maxLiveChars = 60 000` is the fossil of that Devstral-era target, and it is
the direct cause of (a). **Ours supersedes the prior research here.**

**What we cannot determine.** Whether compaction preserves the right things — 14 firings, no A/B, and
the one visible downstream artifact (`test-two/MEMORY.md`, see `04`) suggests its structured output is
transcript-shaped. Whether the tail recitation is present and well-formed — it emits no event.

---

## 4. Simplest sufficient implementation

Three changes. Two are one-liners. None adds a concept.

### (i) Wire the anchor into the recitation block that already exists — 1 call site

`agent.ts:824` already pushes the rendered task ledger as the **last** message on every turn. Put
`renderPinnedAnchor(objective, plan)` output into **that same block**, not alongside it:

```
[OBJECTIVE — immutable, set once by the Boss; never redefine it]
<objective>

[PLAN]  <- the existing task-ledger render, current step marked
```

`ledger.setObjective` already has an immutability guard and is already called from `dispatch.ts`, so
the objective is already stored immutably. Nothing new is needed except surfacing it.

**Why one block and not two:** two separate tail blocks would recite the plan twice per turn. That
costs tokens and creates the uniform, repetitive context Manus identifies as a cause of mimicry and
drift — you would be paying for anti-drift with a drift mechanism. This is not hypothetical; it is
the same class of mistake as the Planner trap.

**Cap it.** Objective plus step titles and statuses. Never step bodies, never verify commands. Target
under ~600 tokens for the whole tail block; if the plan cannot fit, the plan is too big, which is
information in itself.

### (ii) Make the eviction budget relative, not absolute — 1 line

Replace `maxLiveChars: 60_000` with a budget derived from `num_ctx`: roughly **45 % of the window in
chars** (65 536 tokens × ~3.5 chars/token × 0.45 ≈ 100 k chars). Then eviction trims toward a target
that is actually below the trigger rather than 4× below it, and the first firing stops being a cliff.

**Simpler still:** leave the budget alone and only wire the anchor. What that loses: nothing today
(eviction has fired 3 times) — but H24 deliberately makes eviction common, and then the cliff becomes
the dominant behaviour. If you do H24, do this. If you do not do H24, this can wait.

### (iii) H24 — force long-horizon by lowering `COMPACT_RESERVE_TOKENS` — 1 env var

The threshold is `num_ctx − COMPACT_RESERVE_TOKENS`. Set the reserve so the threshold lands near
~16 k tokens and every existing hard task becomes a long-horizon task at **zero authoring cost**.
This is the cheapest available route to measuring the north star.

**What going simpler than the whole set loses.** Doing none of it leaves the north star unmeasurable:
peak context is reached on 6 of 5 003 turns, so the mechanisms that exist for "long" essentially never
run, and no amount of eval work on the current task set will exercise them.

### Explicitly do nothing about

- **A vector store or embedding index.** The argument against is unchanged and one-sided for a lean
  local agent: chunking tears code apart, indexes decay against a mutating repo, and it adds a
  service plus a second model
  ([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/)).
  Argo has grep, `read_file` and a repo it can read directly.
- **Recursive summarisation tiers.** Each level is another serial LLM call in a system that cannot
  parallelise. Not worth it until compaction fires often enough to matter, which is 14 times in
  six weeks.
- **File-size discipline as harness code** (roadmap Item 8). No supporting evidence was found in the
  logs. The largest file the agent has worked on is `test-two/index.html` and its failures there were
  stale `old_string` edit-match failures, not context exhaustion. If it becomes real, a line in
  `AGENTS.md` is the whole fix.

---

## 5. What to watch out for when implementing

- **Do not add a second tail block.** See §4(i). Reciting the same plan twice is a measurable token
  cost and a plausible drift cause.
- **The anchor must be genuinely exempt from eviction and from compaction.** If it is rendered into
  the message array as an ordinary message, `evict()` and `compactHistory` will eventually eat it and
  the mechanism silently becomes a no-op — which is the failure pattern this whole project keeps
  hitting. Render it fresh each turn from the ledger; never let it be a stored message.
- **The immutability of the objective is the point.** If a later Planner or Boss turn can rewrite it,
  the anchor becomes a record of drift instead of a defence against it. `ledger.setObjective`'s guard
  must stay.
- **Eviction removes the failures.** Argo's `evict()` strips oldest **action** episodes first. Those
  are where the error traces live, and Manus's position is that keeping failures in context is what
  stops repeat mistakes. Cheapest mitigation, and it costs one condition: never stub an episode whose
  tool result was an error, until the budget cannot be met any other way.
- **Compaction and eviction currently interact only by accident.** All 3 eviction firings came via
  the L1 loop-recovery block (`agent.ts:1651`), not the threshold. So today the loop guard is Argo's
  de facto context policy. That is not a design, and it should not be relied on.
- **Peak context is 64 266 of 65 536 — 1 270 tokens of headroom.** Anything that adds a fixed
  per-turn cost (an anchor, a longer recitation, injected memory) eats that headroom directly. Budget
  it. `PROJECT_CONTEXT_CHAR_CAP = 8000` already bounds AGENTS.md/MEMORY.md injection; the anchor needs
  its own bound for the same reason.

---

## 6. How to validate it

### Signals that already exist

Batch 1's `metrics.mjs` counts `evict` and `compact` per run and records **peak context** in the cost
vector, validated against the raw logs with 0 unmatched of 982 September + 361 July `warning` events.
So the following need no new instrumentation:

- eviction firings per run, and whether they came via the threshold or via L1;
- compaction firings per run and `validated` rate;
- peak prompt tokens per run;
- iterations and total LLM turns per run.

### Signals that need a new structured event first — say so plainly

- **The recited tail is not logged.** There is no way to confirm the anchor (or today's task ledger)
  is in the outgoing prompt. This must be built before H23 can be claimed either way. Minimum
  version: on iteration 1 and every 10th iteration, log the first 200 chars of the final message.
  That is probe **P5** in `MECHANISM-VERIFICATION.md` §7 and it is a one-line change.
- **`evict` does not record what it removed.** For the cliff question you need `{episodesEvicted,
  charsBefore, charsAfter, trigger: 'threshold'|'L1'}`.

### The experiment

Pre-registered, from roadmap Item 1, adjusted for what Batch 1 now provides:

1. Land the anchor call site and the `evict` event.
2. Set `COMPACT_RESERVE_TOKENS` so the threshold lands near ~16 k tokens (this is H24, and it is the
   experimental condition, not a side change).
3. A/B **anchor ON vs OFF**, `k=3`, on `bigproj-effort` and `bigproj-deps`.

**Would show it working:**
- The quality judge's `drift_or_hallucination` list is empty in more runs with the anchor on. With
  k=3 per arm the only defensible reading is a clean split — e.g. 3/3 arms drifting without, 0/3 or
  1/3 with. **A 2/3 vs 3/3 difference is noise** on tasks documented to range 23–174 iterations.
- `goal_completeness` (already scored by `quality-judge.mjs`) rises, and the final answer names the
  artifacts the recorded objective named. That second check is mechanical and worth adding: does the
  final answer mention every file the objective named?
- Threshold-path eviction events appear, and pass rate does **not** drop. That alone answers a
  question nobody has answered: *is eviction safe?* If pass rate falls with eviction forced on, the
  problem is eviction, not the anchor, and the cliff (§3a) is the first suspect.

**Would show it not working:**
- Drift incidence and pass rate indistinguishable across arms. Then H23 is falsified for the current
  task set: the model holds the goal without help, and the anchor is unnecessary complexity. Say so
  and delete it — do not keep it because the design is elegant.
- Peak context rises with the anchor on and pass rate falls. Then the anchor is competing for the
  1 270 tokens of headroom and it is too big.

**What would falsify H24:** if lowering the reserve makes runs fail for reasons unrelated to context —
e.g. compaction's two LLM calls blow the 180 s timeout repeatedly (this incident is on record once) —
then "long-horizon for free" is not free, and the cost must be stated before the results are used.

**Effect size honesty.** The current suite cannot resolve pass-rate differences: 14 of 18 tasks never
fail for either harness, and the four `bigproj` tasks are the whole signal (see `07`). So for H23 the
primary metric must be **drift incidence and peak-context behaviour**, not pass rate. Anyone who
proposes to settle H23 on pass rate at k=3 is proposing an underpowered test.

---

## 7. Links

- **H23** — pinning the objective across eviction prevents goal drift. Status OPEN. §4(i), §6.
- **H24** — existing hard tasks can be made long-horizon for free. Status OPEN. §4(iii).
- **H02** — qwen3.6 is the only model that reliably drives the harness (VALIDATED). This is what
  makes the Devstral-derived context budget obsolete (§3d).
- Roadmap: 2026-09-03 hypothesis register, **Item 0** (counters — prerequisite), **Item 1** (anchor +
  forced eviction), **Item 8** (file-size discipline — do nothing yet).
- Program: `/shared/argo-program/PLAN.md` BATCH 3, items 1 and 3.
- Related concept docs: `05` (L1 is the only thing that triggers eviction today), `04` (injected
  memory competes for the same headroom), `08` (frame isolation reduces compaction pressure).
