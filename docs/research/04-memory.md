# Memory

What persists across runs · what is retrieved when · who curates it

Hypotheses: **H15** (durable memory poisons the file it maintains), **H25** (cross-turn memory needs
multi-turn tasks to be testable at all). Roadmap: 2026-09-03 register **Item 2**.

---

## 1. What the concept is

Two distinct things, and Argo conflates them in one code path — which is the whole finding of this
document.

- **In-run working memory.** State that survives compaction within a single run: the structured
  `verifiedFacts` / `decisionsMade` output of `compaction.ts`. Transcript-shaped facts are useful here.
- **Cross-run durable knowledge.** `MEMORY.md` and `AGENTS.md` in the workspace: conventions,
  invariants, architecture, gotchas. Injected into the system prompt when small, retrieved task-scoped
  at the tail on **every iteration** when large (`agent.ts:830-849`, `PROJECT_CONTEXT_CHAR_CAP = 8000`,
  whole-file threshold at `memory.ts:182`).

`persistToMemory` writes the first into the second (`agent.ts:758`, inside the LLM-compaction branch).

**North star served:** "with good memory of what matters." This is the one clause of the north star for
which Argo currently has **negative** evidence: the only two durable writes in the project's history
made the memory worse.

---

## 2. External evidence

### Do not let a small model manage its own memory

MemGPT casts the LLM as an OS paging data between a fixed main context and external storage, driven by
the model's own function calls. The paper's own nested key-value task shows GPT-3.5 at **0 % at one
nesting level**, because it fails to chain enough lookups
([arXiv 2310.08560](https://arxiv.org/abs/2310.08560)). Letta, the productised successor, warns that
"weaker models can cause the agent to behave in unexpected ways"
([Letta](https://docs.letta.com/guides/server/providers/ollama)), and its memory-management leaderboard
puts frontier models at 84–93 %, `gpt-5-mini` at 67 %, `claude-haiku` at 43 %, and open-weight models
at 37–39 % ([leaderboard.letta.com](https://leaderboard.letta.com)).

**Class B for the paper, class C for the leaderboard, transferability DIRECT.** Deciding *when and what*
to remember is the single weakest capability band for models in Argo's class. The design consequence is
settled and needs no re-litigating: **the harness owns injection of always-needed state; the model is
offered, never relied on for, retrieval.**

### Letta's data model is worth stealing; its autonomy is not

Memory blocks — small, labelled, size-limited, **always visible, no retrieval needed** — are a good
shape ([Letta](https://docs.letta.com/guides/core-concepts/memory/memory-blocks)). **Class D,
transferability DIRECT.** Argo's `MEMORY.md`-injected-when-small is already this pattern.

### File-based memory, restorable compression

Manus treats the file system as "the ultimate context … unlimited, persistent, directly operable" and
makes every compression restorable — drop a page's body, keep its URL
([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
Anthropic ships the same idea as a file-based memory tool, and reports **memory tool + context editing
= +39 %** on an internal agentic-search eval
([Anthropic](https://www.anthropic.com/news/context-management)).

**Class C, transferability PARTIAL.** The +39 % is Claude Sonnet 4.5 on search, and **+29 % of it comes
from context editing alone** — i.e. most of the measured gain is the deterministic half that Argo
already has (`agent.ts:806`), not the memory half. That decomposition is the useful part of the number
and it argues *against* prioritising memory work over context work.

### Extraction-and-consolidation architectures work for conversation

Mem0 dynamically extracts, consolidates and retrieves salient information, beating full-context
baselines on LOCOMO with ~90 % lower token cost and 91 % lower p95 latency
([arXiv 2504.19413](https://arxiv.org/abs/2504.19413)). **Class B, transferability WEAK.** LOCOMO is
multi-session *dialogue*, evaluated by an LLM judge; the salient facts are stable personal details.
Code memory is different: the facts churn with the repo, and the failure mode is a stale fact confidently
recalled — precisely Cline's argument against indexing
([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/)). Do
not read Mem0's numbers as a reason to build a memory service for Argo.

### Retrieval: lexical, not vector — unchanged and one-sided

Cline explicitly refuses to index or embed the codebase (chunking tears code apart, indexes decay,
embeddings double the security surface); Claude Code uses `glob`/`grep` just-in-time; Aider uses a
tree-sitter, graph-ranked repo map ([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/),
[Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[Aider](https://aider.chat/docs/repomap.html)). **Class C/D, transferability DIRECT.** The prior
research's conclusion — adopt lexical, reject vectors — survives entirely. Nothing found in this pass
argues otherwise, and Argo has no measured retrieval failure to motivate a change.

The one caveat worth carrying: Cline's discovery-not-retrieval method works because the *model* is
strong enough to explore well. A small model explores worse, and Anthropic notes runtime exploration
"can waste context … chasing dead-ends". That argues for giving a small model **structure up front** (a
cheap repo map) rather than for embeddings.

### Does not transfer

**Sleep-time compute** — pre-computing memory offline between turns
([arXiv 2504.13171](https://arxiv.org/abs/2504.13171)). **Transferability NONE as designed**: one GPU,
one resident model, no concurrency (`dispatch.ts:7`). The transferable residue is nearly free and worth
taking: **curate memory at the end of a run, not during it.** Nothing is competing for the GPU then,
and the run's outcome is known — which is exactly the information the current mid-run write path lacks.

---

## 3. Our own evidence

### The write path has fired twice and both writes were harmful

`persistToMemory` (`agent.ts:758`) sits inside the LLM-compaction branch, so it needs a compaction
*and* `this.memory` on. Compaction fired 14 times; the write fired **twice**, both on 2026-07-30 in
`test-two`. `/mnt/test/test-two/MEMORY.md` carries two `## Session memory (2026-07-30)` blocks at lines
**101** and **130**, in the exact `formatMemoryAppend` shape (`memory.ts:346`). Verbatim:

```
- Called bash({"command":"ls /workspace/tests/"})
Result: test_curl.js  test_energy.js  test_runner.js  test_vector_propagation.js
- Called bash({"command":"node /workspace/tests/test_brush.js 2>&1"})
Result: Results: 2 passed, 3 failed
- Called bash({"command":"node /workspace/tests/test_brush.js 2>&1"})
Result: Results: 4 passed, 1 failed
```

The system prompt (`agent.ts:86`) says `MEMORY.md` is for "durable, reusable facts — tersely, in place —
never one-off task state". This is one-off task state verbatim, **including intermediate test counts
that are false by the end of the session**. And the two blocks are near-duplicates of each other:
`dedupeAgainst` compares item-by-item, so slightly different transcript lines both survive.

**Root cause, precisely.** `messagesToText` renders a tool call as `Called bash({…})`
(`compaction.ts:141`). The compaction prompt then instructs *"Only VERIFIED FACTS may contain things
directly confirmed by a tool result"* and *"Copy exact paths, URLs, identifiers, commands, and error
messages verbatim"* (`compaction.ts:211-215`). The model complies exactly. `persistToMemory` writes
`verifiedFacts + decisionsMade` straight to disk.

**`verifiedFacts` is doing two incompatible jobs** — in-run working memory, where a transcript-shaped
fact is useful, and cross-run durable knowledge, where it is noise. Nothing filters between them.

**Why this is harmful and not merely useless:** `MEMORY.md` is auto-injected when small and retrieved
task-scoped at the tail on **every iteration** when large. So this content is fed back into every
subsequent run in that workspace, and `selectMemoryEntries` will happily surface
`Result: Results: 2 passed, 3 failed` as "relevant memory" for any task mentioning tests. The one
genuinely valuable part of that file — a hand-written "Editing convention" section that reads like real
hard-won knowledge — is now mixed with auto-appended noise. **H15 is a self-poisoning loop:** the write
path degrades the read path, and the read path runs every turn.

### The read path is unreachable and unobservable

- `selectAgentsSections` and `selectMemoryEntries` are called on every `chatCall`
  (`agent.ts:830-849`).
- **Of the five workspaces, only `test-two` has an `AGENTS.md`** (5 033 chars, above the 2 000-char
  whole-file threshold at `memory.ts:182`, so section selection would engage) **and only `test-two` has
  a `MEMORY.md`.** `bigproj`, `eval-suite2`, `test-one` and `booklet` have neither.
- **So the entire read side of `ARGO_MEMORY` is unreachable in every eval workspace**, and every eval
  conclusion about "tasks + memory ON" measured the task ledger alone.
- They **emit no events**. The selected sections are pushed into the outgoing `messages` array and never
  logged. There is no way to tell from any artifact whether a selection happened, what it selected, or
  whether it was relevant.

Unit-tested (`memory.test.ts`, 311 lines), reachable in principle, **behaviourally unobserved and
unobservable.**

### The volume question, answered

Gabriel asked whether durable memory becomes the leak that eviction was meant to close. **Measured
answer: no, not by volume.** `PROJECT_CONTEXT_CHAR_CAP = 8000` bounds the injection at ~2 k tokens
against a 65 536-token window, and the tail retrieval is task-scoped. The conflict is **quality**, not
volume: noise re-injected every iteration for the rest of the workspace's life. Fix the write path; the
cap already handles the size.

### Where our evidence supersedes prior research

`docs/research.md` Part 2 §D recommends "Tier 1 (one small-model call): when the window crosses a
threshold, extract durable facts into the structured ledger schema". That is what was built, and it
wrote sludge. The design is not wrong in principle; the implementation shares one extraction between
two incompatible consumers. **The prior recommendation must be read with that correction: two consumers
need two extractions, or the durable one needs to be a deliberate act.**

---

## 4. Simplest sufficient implementation

The simplest sufficient implementation of durable memory in Argo is **less machinery than exists
today**, not more.

### (i) Delete the automatic write path

Remove the `persistToMemory` call from the compaction branch. Rationale, entirely from our own data:
it has fired twice, both writes were harmful, and **the only high-quality content in the only
`MEMORY.md` that exists was written by hand.** Nothing measurable is lost.

### (ii) Replace it with one narrow tool, and one harness-side filter

```
remember(fact: string)   // appends one line under a dated heading in MEMORY.md
```

Harness-side, reject the write (as a tool error the model sees) if the string contains:

- `Called ` or `Result:` — a tool-call rendering;
- `\d+ passed` / `\d+ failed` / any bare count — transient state;
- a path under `/tmp` or a run-specific/session path;
- more than ~200 chars — durable facts are terse by nature.

Block-level dedupe as well as item-level, and cap the file. That is roughly 20 lines and it is the
smallest thing that can deliver "good memory of what matters" without re-creating the poisoning loop.

**What going simpler still loses — and the trade to accept explicitly.** An explicit tool depends on
the model choosing to call it, which is the fragility the literature documents (MemGPT 0 % on nested
lookups; open-weight models at 37–39 % on Letta's memory leaderboard). So expect **under-writing**.
That is the right failure direction: "no memory written" is recoverable and invisible; "noise written
and re-injected into every future run in this workspace" is neither. State this trade in the commit
message so nobody later "fixes" it by re-automating the write.

### (iii) If an automatic write is wanted anyway: do it once, at the end of the run

The transferable residue of sleep-time compute. A single extraction after the final answer, with a
prompt that asks specifically for **project-durable statements** (conventions, invariants, gotchas,
architecture) and explicitly forbids tool-call renderings, counts and run-specific paths — a *different*
prompt from `compaction.ts`'s. One LLM call per run, off the critical path, with the run's outcome
known. Still needs filter (ii); the filter is what makes it safe, not the prompt.

### (iv) Make the read path observable — one event

`{type:'memory_select', file, sections|entries, chars}` on each `chatCall` that injects something. Two
lines. Without it, `ARGO_MEMORY` cannot be evaluated at all, in either direction. This is the clearest
single case for roadmap Item 0.

### (v) H25 — multi-turn tasks, the only way to test any of this

`scripts/eval/tasks.mjs` has no follow-up support: every task is a single `prompt` string, `e2e.mjs:216`
posts it once, and `resetWs` wipes the workspace between tasks. The `sessionId` plumbing already exists
(`src/server.ts`, `SessionLogger`), so the harness side is ready.

Simplest form: a `turns: [...]` array on a task, and a loop in `e2e.mjs` that skips the reset between
turns. Apply it to **one or two** workspaces, 3–4 follow-ups each, not the whole catalog — k runs × N
turns multiplies wall-clock and the suite is already slow.

### Explicitly do nothing about

- **A vector store / embedding model.** §2. Unchanged, one-sided, and no local retrieval failure
  motivates it.
- **Model-driven memory paging** (MemGPT-style eviction/paging decisions). §2. Wrong bet for this model
  class.
- **A memory service or graph memory.** Mem0's setting is not Argo's, and the cost is a service plus a
  second model.
- **Seeding `MEMORY.md` into eval workspaces to make the read path reachable.** Tempting and wrong: a
  hand-written memory file is a *task hint*, and it would inflate scores without measuring the
  mechanism. The mechanism must be measured on memory the agent itself produced across turns — which is
  (v).

---

## 5. What to watch out for when implementing

- **The write path and the read path form a loop.** Anything written is re-injected every iteration for
  the rest of that workspace's life. There is no expiry and no review step. Treat a durable write as
  irreversible from the agent's point of view, because in practice it is.
- **Two consumers, two extractions.** If you keep an automatic write, do not reuse `verifiedFacts`. The
  measured failure is exactly the reuse.
- **`dedupeAgainst` is item-level.** Near-duplicate blocks both survive; that is why there are two
  blocks in `test-two/MEMORY.md`, not one. Block-level dedupe is part of the fix, not a nicety.
- **Memory competes for the last 1 270 tokens of headroom.** Peak prompt context is 64 266 of 65 536.
  `PROJECT_CONTEXT_CHAR_CAP = 8000` bounds it today; if the pinned anchor lands (`01`), both are
  spending the same scarce budget. Do not raise the cap without re-measuring peak context.
- **Multi-turn tasks change what "reset" means.** `resetWs` between turns is what makes the current
  suite reproducible. Skipping it inside a sequence is correct; skipping it *between sequences* would
  destroy reproducibility. Keep the boundary explicit.
- **A `remember` tool adds a tool schema to every turn.** Manus's advice against adding/removing tools
  mid-task applies: add it once, for all frames that can write, and leave it.

---

## 6. How to validate it

### H15 — verdict by inspection, no eval needed

After the fix, run any task in a workspace with a `MEMORY.md` and check the file:

- **Works:** no tool-call renderings (`Called `, `Result:`), no transient counts, no `/tmp` paths, no
  duplicate blocks. Every appended line is a statement that would still be true next week.
- **Does not work:** any of the above appear. This is a deterministic string check, not a judgement.

### H25 — the metric is already specified and it is a good one

Author one workspace with 3–4 follow-ups of comparable difficulty (add feature A; then feature B that
must respect A's convention; then a bug fix touching both).

**Primary metric: tool calls before the first edit on turn N.** If the agent benefits from turn N−1,
that number falls across turns. This is derivable from existing logs (`tool_call` events and the first
`edit_file`/`write_file`) — **no new instrumentation needed**, which is rare and worth exploiting.

**Secondary:** does it re-derive facts it already established? Countable as "files read on turn N that
were already read on turn N−1".

**Works:** turn-3 discovery cost materially below turn-1 with memory ON, and above it with memory OFF.
With k=3 per arm and 3 turns, a meaningful effect is a **≥30 % reduction in tool-calls-to-first-edit
between turn 1 and turn 3** with memory on, and no such reduction with memory off. Smaller than that is
not separable from task-order effects.

**Does not work / falsified:** turn 3 costs the same discovery effort as turn 1 with memory ON, or
memory ON is indistinguishable from memory OFF. Then cross-run memory is not earning its place and the
`remember` tool plus the injection path should be reconsidered — including deletion.

**A confound to control:** on turn 2 the agent may still have the *workspace* (files it created), which
is memory of a kind independent of `MEMORY.md`. The memory-OFF arm controls for this correctly, so run
both arms; do not infer memory value from the ON arm alone.

### What needs a new event before anything here is measurable

- `memory_select` (§4 iv). Without it, "memory ON" and "memory ON but nothing was selected" are
  indistinguishable — and given only `test-two` has the files, the second is what has been happening in
  every eval to date.
- A `memory_write` event recording what was written and by which path (tool vs automatic).

---

## 7. Links

- **H15** — OPEN, verdict by inspection. §3, §4(i–ii), §6.
- **H25** — OPEN, blocked on multi-turn task support. §4(v), §6.
- **H24** — related: lowering the compaction threshold makes the compaction branch (and therefore the
  old automatic write path) fire far more often. If the write path is not fixed first, H24 will multiply
  the poisoning. See `interaction-matrix.md`.
- Roadmap: 2026-09-03 register **Item 2** (multi-turn task sequences), **Item 0** (counters).
- Program: `/shared/argo-program/PLAN.md` BATCH 3 items 2 and 4.
- Related: `01` (the injection competes for context headroom; the +29 %-of-+39 % decomposition argues
  context work outranks memory work), `08` (the ledger is the in-run cross-frame memory and it works).
