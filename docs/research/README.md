# Argo research — consolidated concept reference

Written 2026-09-03. Anchored on the measurement pass at harness `fe31f61` (+uncommitted) and on
Batch 1 as landed at `fd171d3`.

This directory is the reference body for every concept and hypothesis Argo rests on. It exists so
that whoever implements a mechanism knows in advance **what to build, what to avoid, and how to tell
whether it worked** — without re-deriving the evidence.

It is not a survey. It is a consolidation: external literature and Argo's own measurements in one
place, with contradictions resolved rather than concatenated.

---

## The one rule that governs everything here

**Argo's own measurements outrank the literature.** They come from this exact setup: one local
`qwen3.6:latest` (~24 GB resident) on a 48 GB Mac, ~65 536-token context, a custom ReAct loop where a
model turn with no tool call is the final answer, and **no two LLM calls ever concurrent** — a
documented hard invariant (`src/dispatch.ts:7`).

Where a paper and our corpus disagree, the corpus wins and the document says so explicitly. Where a
paper's result depends on a property Argo does not have — a 1 M context, parallel agents, a second
model, cheap retries, frontier instruction-following — that is stated as a transferability failure,
not smoothed over.

## Evidence classes used throughout

| Class | Meaning |
|---|---|
| **A** | Measured in Argo's own corpus. Carries a count, a `file:line`, or both. Strongest available. |
| **B** | Strong external: controlled experiment, published, adequate n, effect reported. |
| **C** | Suggestive external: real study or practitioner report with numbers, but a different setting. |
| **D** | Anecdotal: assertion without numbers, n≤2, or a single trace. |

## Transferability tags used throughout

| Tag | Meaning |
|---|---|
| **DIRECT** | Evidence comes from a setting resembling Argo's (small/open model, single stream, tight context) or the mechanism is model-independent. |
| **PARTIAL** | Different setting, but the causal mechanism plausibly survives the difference. The difference is named. |
| **WEAK** | Mechanism is at a different layer or scale; treat as an analogy that suggests a design, not as evidence. |
| **NONE** | Depends on a property Argo does not have. Recorded so nobody rediscovers it as a good idea. |

## The corpus these numbers come from

- **567 run logs** under `/mnt/argo-data/logs/`, 7 workspaces, 2026-07-24 → 2026-09-03.
  89 dated July, 478 dated September, none in August.
- **~5 000 model turns.** September alone: 2 874 `ollama_request` events and 2 874 `iteration`
  events (they match, so per-frame iteration sums are a true LLM-turn count).
- **5 003 prompt-token observations.** Peak prompt context **64 266 of 65 536**. Six observations at
  or above the 61 440-token compaction threshold. 1 849 of 5 003 above ~15 k tokens.
- **~317 role frames** in multi-agent mode: Boss 204, Tester 85, Implementer 61, Planner 23; plus
  194 baseline/top-level frames.

Every `file:line` in these documents was correct at the verification pass. Other work is landing in
`src/` concurrently — **treat line numbers as a starting point for a grep, not as an address.**

## Files

| File | Concepts | Hypotheses |
|---|---|---|
| [`01-context-management.md`](01-context-management.md) | Sliding-window eviction, compaction, what to pin, deterministic tool-result collapsing | H23, H24 |
| [`02-decomposition-and-planning.md`](02-decomposition-and-planning.md) | When decomposition earns its cost, replanning triggers, plan recitation, the plan/act gate | H07, H17, H18, H26 |
| [`03-supervision-and-verification.md`](03-supervision-and-verification.md) | Critics, executable oracles, Tester frames, done-gates, tamper detection | H03, H05, H08, H13 |
| [`04-memory.md`](04-memory.md) | What persists across runs, what is retrieved when, who curates it | H15, H25 |
| [`05-drift-and-loop-control.md`](05-drift-and-loop-control.md) | Repetition detection, re-anchoring, stall handling, hallucination | H01, H19, H20, H23 |
| [`06-iteration-budgets.md`](06-iteration-budgets.md) | Per-frame caps vs a global budget, stand-up cadence, fail-open on cap | H01, H13, H21, H22 |
| [`07-evaluation-methodology.md`](07-evaluation-methodology.md) | Discriminating power, saturation, partial credit, reliability over k, tamper resistance, fair cross-harness comparison | H08–H12 |
| [`08-agent-communication.md`](08-agent-communication.md) | What a frame returns, artifact-by-reference, the ledger as shared state | H14, H26 |
| [`09-small-model-scaffolding.md`](09-small-model-scaffolding.md) | **Broader mandate (added 2026-09-03):** how to make a small local model punch above its weight on long complex work. Constrained decoding, repository representation, deterministic localisation, action-space narrowing, prefix-cache economics, thinking budgets, assertion-time grounding, trace-derived knowledge. Includes verified Ollama platform facts and a ranked shortlist. | H01, H05, H13, H15, H19, H20, H23, H24, H25 |
| [`interaction-matrix.md`](interaction-matrix.md) | Every mechanism pair: synergistic / neutral / conflicting / redundant | cross-cutting |

`01`–`08` answer "what does Argo do and does it work". `09` answers "what else is known that Argo has
not tried". Read `09` §0 first if you are about to build anything that touches the model call: it
records what Ollama actually exposes (schema-constrained `format`, per-request `think` levels,
`prompt_eval_cached_count`, KV-cache quantisation, adapter-architecture limits) with source links, and
several long-standing assumptions do not survive it.

Each concept document has the same seven sections: what it is · external evidence · our evidence ·
simplest sufficient implementation · traps · how to validate · hypothesis and roadmap links.

## How to use this

- **Before implementing a mechanism**, read its concept doc's §4 (simplest sufficient) and §5 (traps),
  then check [`interaction-matrix.md`](interaction-matrix.md) for every mechanism it touches. The
  matrix exists because Argo has already been damaged once by an unexamined pair.
- **Before claiming a mechanism works**, read its §6. Several existing claims fail this test.
- **Before adding a new mechanism**, note that four of Argo's 32 mechanisms fire and cause harm, and
  three never fire at all. Mechanism count is not free: it has already produced a correctness bug and
  a wrong architectural conclusion held across three documents.

## Simplicity is a stated requirement

Gabriel: *"keep things simple. We don't want to add unmanageable complexity and end up with a
spaghetti project that is a total mess. Simplicity is a feature too."*

Every §4 gives the least machinery that still delivers the effect, and says what going simpler would
lose. Several §4 sections say **"do nothing — the existing mechanism covers it"**; those are findings,
not omissions. Specifically:

- Artifact-by-reference for frame *conclusions*: do nothing (`capSummary` already truncates at
  2 000 chars and Boss context is far from its limit). The **diff** half of that idea is not
  prophylactic and should be done. See `08`.
- File-size discipline: do nothing until the logs point at it. See `01` §5.
- Actor-critic (`ARGO_CRITIC`): leave off. The Tester frame does the same job with real tools. See
  `03` and the matrix.
- A fifth role, a weak-model Boss, LLM parallelism: settled against. See `08`.

## Prior claims this body supersedes

These were correct readings of the artifact available at the time; the artifact was wrong or partial.
Anywhere you meet the old number, prefer the new one.

| Superseded claim | Where it appears | Correct value | Why |
|---|---|---|---|
| "Eviction has never fired" | `ASSESSMENT.md` §5.2c, `docs/roadmap.md` 2026-09-02 entry | **3 firings**, 44 episodes stubbed, all via the L1 loop-recovery path | Read from `eval-runs/history.jsonl` (33 rows) instead of the 567-log corpus |
| "Compaction fired twice" | same | **14 firings** (test-two 12, booklet 1, bigproj 1), 12 validated | same |
| "Peak context 16 616 tokens" | same | **64 266 of 65 536**, with 6 observations at/above the 61 440 trigger | same |
| "The grounding guard has never fired" | same | **27 firings** (17 `ok`, 10 `revise`) — it emits `critic`, not `warning` | Scanned the wrong event type |
| "The Planner cannot decompose (0 for 5, then 4 for 4 failures)" | `docs/roadmap.md` Finding 7, `ASSESSMENT.md` pre-§4, eval-log | **8 of 8** large-task Planner frames emitted valid 2–5-step graphs. The harness discarded every one. | Read frame *conclusions* from the ledger, when the thing that failed was the conclusion |
| "Keep live context in the low thousands of chars" | `docs/research.md` Part 2, framing finding | qwen3.6 runs correctly to 64 266 tokens. The 400–3 000-char figure was a **Devstral** probe. | Generalised from a model Argo no longer uses. `DEFAULT_EVICTION_BUDGET.maxLiveChars = 60 000` still encodes it — see `01` §5 |
| "Magentic-One attributes 31 % of performance to the ledger alone" | `docs/subagents-plan.md` | The 31 % ablation replaced the whole Orchestrator with AutoGen `GroupChat`, removing **both ledgers, planning, progress tracking, loop detection and explicit agent instructions together** | Verified against the paper: [arXiv 2411.04468](https://arxiv.org/abs/2411.04468) §5.3, Fig. 3(a). The figure is real; the attribution to the ledger alone is not supported |
| `g=0` / `s=0` in eval rows | `docs/eval-log.md`, several conclusions | Artifacts of two broken counters. Fixed in Batch 1; validated 0 unmatched of 982 September + 361 July `warning` events | `gate` broke at `e045d0a`; `steer` blind since 2026-08-04 |

`docs/research.md` carries a dated superseded-claims banner pointing here.

## Sources

Everything external cited in these documents, with the URL that was checked on 2026-09-03.

**Practitioner / vendor**
- Manus — *Context Engineering for AI Agents* — https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus
- Anthropic — *Effective context engineering for AI agents* — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Anthropic — *Managing context on the Claude Developer Platform* — https://www.anthropic.com/news/context-management
- Anthropic — *How we built our multi-agent research system* — https://www.anthropic.com/engineering/multi-agent-research-system
- Anthropic — *Building effective agents* — https://www.anthropic.com/engineering/building-effective-agents
- Anthropic — *Claude Code best practices* — https://www.anthropic.com/engineering/claude-code-best-practices
- Cognition (Walden Yan) — *Don't Build Multi-Agents* — https://cognition.ai/blog/dont-build-multi-agents
- Cline — *Why Cline Doesn't Index Your Codebase* — https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/
- Cline — *Plan and Act* — https://docs.cline.bot/features/plan-and-act
- Aider — *Repository map* — https://aider.chat/docs/repomap.html · *Architect/editor* — https://aider.chat/2024/09/26/architect.html
- Roo Code — *Using modes* — https://docs.roocode.com/basic-usage/using-modes
- Letta — *Memory blocks* — https://docs.letta.com/guides/core-concepts/memory/memory-blocks · *Ollama / weak-model warning* — https://docs.letta.com/guides/server/providers/ollama · *Memory leaderboard* — https://leaderboard.letta.com
- Chroma — *Context Rot: How Increasing Input Tokens Impacts LLM Performance* (18 models incl. Qwen3) — https://research.trychroma.com/context-rot
- Microsoft Research — *Magentic-One* — https://www.microsoft.com/en-us/research/articles/magentic-one-a-generalist-multi-agent-system-for-solving-complex-tasks/
- Qwen — *Function calling* — https://qwen.readthedocs.io/en/latest/framework/function_call.html · *Qwen3 blog* — https://qwenlm.github.io/blog/qwen3/
- OpenHands — *Local LLMs* — https://docs.all-hands.dev/usage/llms/local-llms

**Papers**
- Huang et al. — *Large Language Models Cannot Self-Correct Reasoning Yet* — https://arxiv.org/abs/2310.01798
- Cemri et al. — *Why Do Multi-Agent LLM Systems Fail?* (MAST) — https://arxiv.org/abs/2503.13657
- Cuadron et al. — *The Danger of Overthinking* — https://arxiv.org/abs/2502.08235
- Yao et al. — *τ-bench* (pass^k) — https://arxiv.org/abs/2406.12045
- Panickssery et al. — *LLM Evaluators Recognize and Favor Their Own Generations* — https://arxiv.org/abs/2404.13076
- Baker et al. — *Monitoring Reasoning Models for Misbehavior* — https://arxiv.org/abs/2503.11926
- Aleithan et al. — *SWE-Bench+* — https://arxiv.org/abs/2410.06992
- Xia et al. — *Agentless* — https://arxiv.org/abs/2407.01489
- Shinn et al. — *Reflexion* — https://arxiv.org/abs/2303.11366
- Liu et al. — *Lost in the Middle* — https://arxiv.org/abs/2307.03172
- Xiao et al. — *Efficient Streaming Language Models with Attention Sinks* — https://arxiv.org/abs/2309.17453
- Muennighoff et al. — *s1: Simple test-time scaling* — https://arxiv.org/abs/2501.19393
- Maia Polo et al. — *tinyBenchmarks* — https://arxiv.org/abs/2402.14992
- Fourney et al. — *Magentic-One* — https://arxiv.org/abs/2411.04468
- Packer et al. — *MemGPT* — https://arxiv.org/abs/2310.08560
- Lin et al. — *Sleep-time Compute* — https://arxiv.org/abs/2504.13171
- Chhikara et al. — *Mem0* — https://arxiv.org/abs/2504.19413
- Wang et al. — *Plan-and-Solve Prompting* — https://arxiv.org/abs/2305.04091
- Yao et al. — *ReAct* — https://arxiv.org/abs/2210.03629
- Wu et al. — *Recursively Summarizing Books* — https://arxiv.org/abs/2109.10862

**Argo-internal primary artifacts** (read these before the documents here, if you have time for only one thing)
- `/shared/argo-program/HYPOTHESIS-LEDGER.md` — H01–H26, statuses, pre-registered criteria
- `/shared/argo-catchup/MECHANISM-VERIFICATION.md` — 32 mechanisms, firing counts, what happened next
- `/shared/argo-catchup/ASSESSMENT.md`, `/shared/argo-catchup/EVAL-PLAN.md`, `/shared/argo-catchup/EVIDENCE-planner-trap.md`
- `/shared/argo-program/BATCH1-APPLIED.md` — what the counters now measure and how they were validated
- `/shared/argo-program/LOG-FACTS-bigproj.md` — cap-hits and graph steps, one row per log
- `docs/roadmap.md`, `docs/eval-log.md`, `docs/harness-instrumentation.md`, `docs/subagents-plan.md`,
  `docs/actor-critic.md`, `docs/grounding.md`, `docs/research.md` (now carries a superseded-claims banner)
- `/shared/argo-harness/decomposition-research.md` — the planning/task-sequencing survey behind
  `ARGO_TASKS` (Plan-and-Execute vs ReAct, replanning triggers, Qwen tool-call templates). Its
  conclusions are folded into `02`; its Qwen-template advice is now moot (H02 settled on one model).
  Companions `memory-module.md`, `tasks-module.md`, `wire-report.md` are implementation reports for
  `src/memory.ts`, `src/tasks.ts` and the `agent.ts` wiring — useful for locating call sites, no
  independent evidence.
- `/shared/argo-planning-research.md` and `/shared/argo-memory-research.md` — the two surveys merged
  into `docs/research.md`. Read the banner there first.
- `/shared/argo-supervisor-eval-report.md` + `supervisor-eval-run-3x*.txt` — the primary evidence for
  **H03** (5 candidates, RUNS=3; only qwen3.6 flagged oracle-gaming 3/3).

**One design document referenced by the code but missing from the repo:** `src/memory.ts`'s module
report cites `docs/harness-planning-memory.md` as the source of its Stages 1/2/4, and that file does
not exist under `docs/`. If it exists elsewhere it should be restored; the memory design rationale is
otherwise reconstructible only from `/shared/argo-memory-research.md` and `/shared/argo-harness/memory-module.md`.
