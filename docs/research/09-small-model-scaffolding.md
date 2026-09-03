# Making a small local model punch above its weight

Scaffolding, representation and constraint for long, complex tasks on one ~24 GB local model

Written 2026-09-03. Broader in scope than `01`–`08`: this document is not "what does Argo do", it is
"what is known about closing the gap between a 65 k-context local model and a frontier model, and
which of it applies here." It deliberately includes ideas Argo has never considered and ideas that
would **replace** parts of Argo rather than add to them.

Three levers organise it, and every entry below is one of the three:

1. **Reduce what the model must hold at once** — representation, not just eviction.
2. **Reduce what it must decide freely** — constrain the output space and the action space.
3. **Move work the model does badly into deterministic code** — localisation, validation, ordering.

---

## 0. Platform facts, verified before anything is proposed

Almost every idea below depends on what Ollama actually exposes. These were read from Ollama's own
source and docs on 2026-09-03, not assumed.

| Fact | Detail | Source |
|---|---|---|
| **JSON-schema constrained decoding exists** | `format` on `/api/generate` and `/api/chat` accepts `json` **or a full JSON schema**. The blog frames schema mode as "more reliability and consistency than JSON mode". | [api.md](https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md) L52, L511, L524; [blog](https://ollama.com/blog/structured-outputs) |
| **Raw GBNF grammars are not exposed** | The only constraint surface is `format`. No `OLLAMA_GRAMMAR`, no grammar field. | [envconfig/config.go](https://raw.githubusercontent.com/ollama/ollama/main/envconfig/config.go) — full env list |
| **`format` on a thinking model costs a second pass** | `routes.go` runs "structured outputs via double request": when `format` is set and the model has the thinking capability, the first completion runs **unconstrained** (`currentFormat = nil`) so the model can think, then a second request applies the schema. A `forceImmediate` path skips the double request when `req.Think` is explicitly false. | [server/routes.go](https://raw.githubusercontent.com/ollama/ollama/main/server/routes.go) L2742–2790, L2935 |
| **Per-request thinking budget** | `think` accepts a boolean **or a level**: `"low"`, `"medium"`, `"high"`, `"max"`. | api.md L48, L498 |
| **Prefix-cache reuse is directly measurable** | Every response carries `prompt_eval_cached_count` — "number of prompt tokens read from the cache" — alongside `prompt_eval_count` and `prompt_eval_duration` ("time evaluating **uncached** prompt tokens"). | api.md L103–104 |
| **Context length is a configuration, not a hardware ceiling** | Ollama's VRAM-based defaults: <24 GiB → 4 k, 24–48 GiB → 32 k, **≥48 GiB → 256 k**. Confirmed in code (`totalVRAM >= 47*GibiByte`). Overridable by `OLLAMA_CONTEXT_LENGTH` or per-request `num_ctx`. Docs: agents and coding tools "should be set to at least 64000 tokens". | [context-length.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/context-length.mdx); routes.go L2055–2062 |
| **KV cache can be quantised** | `OLLAMA_KV_CACHE_TYPE` (default `f16`): `q8_0` ≈ ½ memory "usually no noticeable impact"; `q4_0` ≈ ¼ with "small-medium loss". Requires Flash Attention (`OLLAMA_FLASH_ATTENTION`, automatic where supported). **Explicit caveat: "Models that have a high GQA count (e.g. Qwen2) may see a larger impact on precision from quantization."** | [faq.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/faq.mdx) L344–369 |
| **Parallelism costs context** | `OLLAMA_NUM_PARALLEL` default 1, and "Required RAM will scale by `OLLAMA_NUM_PARALLEL` * `OLLAMA_CONTEXT_LENGTH`". | faq.mdx L335 |
| **Speculative decoding exists, and can be draft-model-free** | `draft_num_predict`: "Maximum number of speculative draft tokens to predict per step when a draft model is available. Separate draft models default to 4; **embedded MTP tensors** require setting this parameter." | [modelfile.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/modelfile.mdx) L156 |
| **LoRA adapters: Qwen is not supported** | Ollama's `ADAPTER` supports "Llama … Mistral … and Gemma". And `mlx_lm.fuse --export-gguf` is "limited to Mistral, Mixtral, and Llama style models in fp16 precision" — while MLX LoRA *training* does list Qwen2. | [import.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/import.mdx) L35–39; [mlx-lm LORA.md](https://raw.githubusercontent.com/ml-explore/mlx-lm/main/mlx_lm/LORA.md) L11, L134–135 |
| **Sampler defaults** | `repeat_last_n` 64, `repeat_penalty` 1.0 (disabled by default), `temperature` 0.8, `top_k` 40, `top_p` 0.9, `num_ctx` 2048. | modelfile.mdx L149–159 |

**One thing I could not verify and nobody should assume:** whether `format` (schema) and `tools` in the
*same* request behave sensibly. `routes.go` handles both in one handler with a state machine, and the
docs document them in separate sections without ever combining them. **This needs a five-minute
empirical probe before any design depends on it** — see §1 §7.

### Argo's current position against those facts

| | Current | Where |
|---|---|---|
| Constrained decoding | `format: 'json'` — **JSON mode, never a schema** — on three calls only: compaction (×2), critic, grounding. The main tool-calling loop passes `tools` and no `format`. | `compaction.ts:234,274`, `critic.ts:199`, `grounding.ts:196`, `agent.ts:976-983` |
| | And the code already knows JSON mode is insufficient: *"qwen sometimes emits either despite format:\"json\""* | `critic.ts:168` |
| Thinking budget | Never set. No `think` parameter anywhere. | — |
| Sampling / context | `temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 65536` — set in **`public/app.js:202`**, the UI, and posted per session. `ModelOptions` (`types.ts:8-13`) carries only those four fields. There is no server-side floor: `this.options.num_ctx ?? 65536`. | `public/app.js:202`, `agent.ts:1524` |
| Cache measurement | `prompt_eval_cached_count` is never read or logged. | — |
| Tool-output shaping | Already strong: `TOOL_RESULT_COLLAPSE_OVER = 600`, `KEEP_RECENT_TOOL_RESULTS = 4`, and `truncateOutput` keeps a 500-char head plus a verbatim tail with an omission marker — deliberately tail-biased because "the decisive line … is almost always at the end". | `agent.ts:189-190`, `tools/truncate.ts` |
| Action space | 10 tools; per-role subsets landed (`ROLE_TOOLS`, and a typed `FramePolicy` in `types.ts:145` applied at `dispatch.ts:157` via `policyFor(role)`). Planner: 4 tools. Implementer: 9. | `frames.ts`, `types.ts:145` |

Two things changed in `src/` while this pass was running, and the document reflects the new state:
**`update_plan` has been removed from `ROLE_TOOLS.planner`** and **a typed per-role `FramePolicy` now
exists**, so the Planner trap (`02`) is fixed at the class level, not just the instance. The code
comment records the result: *"The 6 Planner frames that never called it concluded in two messages."*

### The new substrate changes what is testable

`tj/commander.js` at `/mnt/test/commander`, `eval-baseline` tagged. Measured directly:

- **4 180 lines in `lib/`**, with `lib/command.js` at **2 790 lines** — one file is ~67 % of the source
  and, at roughly 4 chars/token, ~25 k tokens: **38 % of the whole context window in a single
  `read_file`.**
- 112 test files, ~1 052 top-level `test`/`it` calls in 197 `describe` blocks (the cone reports 1 373
  tests / 210 suites including nested), 12 277 lines of tests, **2.0 s** for the whole suite.
- `npm test` is `node --test && npm run check:type:ts` — so **`typings/index.d.ts` (1 113 lines) and
  `typings/index.test-d.ts` (787 lines) are part of the gate**, via `tsd` and `tsc`.
- `tsconfig.json` sets `allowJs: true, checkJs: true, strict: true` — so **`lib/*.js` is type-checked
  through JSDoc**, and `tsconfig.js.json` runs that check alone.
- `eslint.config.js` and `.prettierrc.js` present; zero runtime dependencies.

That is four independent deterministic oracles (tests, JS type-check, TS typings check, lint/format) at
2-second granularity over a codebase that cannot fit in context. Several ideas below were
untestable yesterday and are testable today because of it.

---

## 1. Schema-constrained decoding for control-plane outputs

### What it is
Pass a JSON schema in Ollama's `format` parameter for the turns whose output is a **decision**, not
code: the Boss's task-start classification, the Tester's verdict, the Planner's task graph, the
critic's and grounding critic's judgments. The token stream is constrained during generation, so a
non-conforming output is not merely detected — it is unrepresentable.

### Why it helps a small model specifically
Every one of Argo's verdict contracts is currently a *free-text convention* the model must remember to
honour under load: emit `TRIVIAL:`/`ANSWER:`/`OBJECTIVE:`, emit `RELEASE` or `REDO`, emit a JSON block.
Instruction-following fidelity under long context is exactly the capability a small model has least of,
and Argo's own defences against that are all *post-hoc*: a marker-loss retry, a defensive tool-call
parser, four fail-open verdict parsers. Constraining the decode replaces a probability of compliance
with a guarantee, and it removes the retry — one fewer round-trip on the critical path.

### Evidence
- **Ollama supports it.** Schema in `format`, on `/api/chat`. Verified above. *(Strong on capability;
  transferability DIRECT — it is our own runtime.)*
- **Argo's code already concedes JSON mode is not enough:** *"qwen sometimes emits either despite
  format:\"json\""* (`critic.ts:168`). Schema mode is strictly stronger than JSON mode. *(Strong,
  local.)*
- **Counter-evidence, and it is real.** *Let Me Speak Freely?* reports "a significant decline in LLMs
  reasoning abilities under format restrictions", with stricter constraints causing greater degradation
  ([arXiv 2408.02442](https://arxiv.org/abs/2408.02442)). *(Suggestive; transferability PARTIAL — the
  models are mid-size open models, so closer to Argo than most.)*
- **Rebuttal, with reproductions.** .txt re-ran the same tasks on the same model (Llama-3-8B-Instruct)
  and could not reproduce, identifying that the paper's structured and unstructured prompts "are
  markedly different … not apples-to-apples", and that the structured prompts omitted information the
  model needed ([blog.dottxt.co](https://blog.dottxt.co/say-what-you-mean.html)). *(Suggestive;
  interested party, but the specific methodological objection is checkable and concrete.)*
- **The decisive discriminator is what is being constrained.** Aider benchmarked returning code as
  markdown vs inside a JSON tool call, 133 cases × 5 runs
  ([aider.chat](https://aider.chat/2024/08/14/code-in-json.html)). Pass rates from the published data:

  | model | markdown | JSON | JSON (strict) |
  |---|---|---|---|
  | gpt-4o-2024-08-06 | 60.2–61.7 | 56.4–60.2 | 54.1–59.4 |
  | claude-3.5-sonnet | 60.2–60.9 | 51.9–55.6 | — |
  | **deepseek-coder V2 0724** (the open model) | **59.4–61.7** | **48.9–53.4** | — |

  The penalty is **largest for the open model — roughly 9 points** — and larger with strict schema
  enforcement. *(Strong: 5 runs per cell, published per-run data; transferability PARTIAL-to-DIRECT,
  and the open-model row is the most relevant one.)*

  **The rule this settles:** constrain the **control plane** (verdicts, enums, small graphs); never
  constrain a **code-bearing** output. The two bodies of evidence stop conflicting once split that way.
- Practitioner corroboration that the failure class is common enough to engineer around: Goose ships an
  experimental **Ollama tool shim** for models that "intermittently output tool calls as plaintext
  instead of structured API responses", explicitly citing providers where models "mix reasoning tags
  (`<think>`) with tool calls, causing parsing failures"
  ([tool-shim.md](https://raw.githubusercontent.com/block/goose/main/documentation/docs/guides/tool-shim.md)).
  Its implementation needs a second interpreter model (`mistral-nemo`) — **out of scope here**; the
  value is the confirmation that this is a standard local-model problem, and that Argo's `format`-based
  answer is cheaper than Goose's.

### Does Argo's measured behaviour suggest it would help?
Yes, and this is the best-targeted idea in the document.

| Failure | Count | Fixed by construction? |
|---|---|---|
| Boss task-start marker loss → `parseTaskStartVerdict` fail-open | 2 marker-retry firings (both recovered), plus 32 marked classifications out of 94 task-starts | Yes |
| Stand-up verdicts with **no keyword at all** | **3 of 22**, all reading as "all clear" via `parseBossVerdict`'s fail-open | Yes |
| Tester verdict unparseable vs genuinely RELEASE — indistinguishable | 29 of 29 RELEASE, **0 REDO in 85 frames**, `parseTesterVerdict` fails open | Yes for the parse half |
| Malformed qwen tool call rejected by Ollama's Go backend as an XML parse error | part of 9 `chatWithRetry` firings, 7 recovered | Only if `format`+`tools` compose — **unverified** |
| `parseTaskGraph` fail-open to a one-step graph | 84 of 85 graphs | Yes |

### Smallest sufficient implementation
Three schemas, applied at three existing call sites, on frames that are **already** short and
non-code-bearing:

```
BossVerdict     { action: enum[TRIVIAL,ANSWER,SIMPLE,OBJECTIVE], objective?: string }
TesterVerdict   { verdict: enum[RELEASE,REDO], reason: string }
TaskGraph       { steps: [{ id, title, dependsOn: string[] }] }   // no verify field
```

Set `think: false` on those three calls so Ollama takes the `forceImmediate` path and does **not** pay
the double request. Then delete the corresponding regex parsers and keep the fail-open branches only as
assertions that should now be unreachable.

**What going smaller loses.** Doing only the Tester verdict fixes the highest-value site (a stalled
Tester currently approves silently) but leaves the Boss marker retry and `parseTaskGraph` in place.
Doing only `format: 'json'` → schema on the three *existing* JSON calls (critic, grounding, compaction)
is even smaller, needs no new schemas beyond what those prompts already describe, and is a good first
commit — but it touches none of the frame verdict paths, which is where the fail-opens are.

### What it would replace or make unnecessary
- The Boss marker-loss retry (`dispatch.ts:302`) — a whole mechanism, deletable.
- The five verdict regexes in `frames.ts`/`dispatch.ts`.
- Part of the defensive tool-call fallback parser, **if** `format` composes with `tools`.
- It does **not** replace the cap-hit fail-open fix (H13): a schema guarantees the *shape* of an
  answer, not that an answer arrived. A capped frame still returns nothing to constrain.

### How to validate it
**Probe first, one command, before any design work** — this is the gating unknown:

```
curl -s localhost:11434/api/chat -d '{"model":"qwen3.6:latest","stream":false,
  "think":false,
  "messages":[{"role":"user","content":"List the files in /tmp"}],
  "tools":[{"type":"function","function":{"name":"bash","parameters":{...}}}],
  "format":{"type":"object","properties":{"verdict":{"type":"string","enum":["RELEASE","REDO"]}},"required":["verdict"]}}'
```
Three possible outcomes, all informative: a tool call (format ignored), a schema-conforming object (tools
ignored), or an error (mutually exclusive). **The design differs in each case**, and no amount of reading
settles it.

Then, on the verdict paths:
- **Works:** unparseable-verdict count goes to **0** across a k=3 battery, from a baseline of 3 of 22
  no-keyword stand-ups plus 2 marker retries. This is a counter check on existing logs, not a quality
  judgement — `metrics.mjs` already classifies these events.
- **Works, second signal:** total LLM turns per task falls slightly, because the retry turns disappear.
- **Does not work:** quality on the four `bigproj` tasks drops, or classification distribution shifts
  (e.g. `OBJECTIVE` share moves far from its measured 9 %) — that would be *Let Me Speak Freely*'s effect
  showing up on our own control plane, and the schema should then be loosened (fewer required fields,
  no `description` prose in the schema) rather than abandoned.
- **Falsifier:** if the probe shows `format` and `tools` are mutually exclusive **and** constraining the
  verdict frames measurably degrades their content, the idea reduces to "schema-ify the three existing
  `format: 'json'` calls" and nothing more.
- **Effect size:** the parse-failure counts are small integers (3, 2, 0-of-85). Going to zero is a
  correctness result, not a statistical one. Do not try to read a pass-rate effect from it.

### Cost
Small: three schema literals, three call-site changes, one flag. Runtime cost per turn: **zero if
`think:false` on those calls**; a full second prompt evaluation per constrained call if not — which on
a 60 k-token prompt is the single most expensive mistake available here.

---

## 2. Repository representation instead of file contents

### What it is
Give the model a **symbol-level map** of the repository — files, classes, method and function
signatures, ranked by relevance to the current task and fitted to a token budget — plus targeted reads
of specific line ranges, instead of whole files.

### Why it helps a small model specifically
Two distinct wins. First, capacity: `lib/command.js` is 2 790 lines ≈ 25 k tokens, **38 % of the window
for one file**, and the model must then reason over the other 62 %. Second, and less obvious, quality:
performance degrades with input length even on trivial tasks, so a 25 k-token file makes every
*subsequent* judgment worse, not just the current one. A map is the only intervention that reduces
input length without discarding information — the information moves from "text in context" to "index
plus an address I can dereference".

### Evidence
- Aider sends "a list of the files and classes, methods and function signatures from everywhere in the
  repo", selected for large repos with **a graph-ranking algorithm** over the dependency graph, fitted
  to `--map-tokens` (default **1 k tokens**) ([aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html)).
  *(Anecdotal on effect size — no ablation published; transferability DIRECT, and a 1 k-token budget for
  whole-repo structure against a 25 k-token single file is the whole argument.)*
- Anthropic: prefer **just-in-time retrieval** with lightweight identifiers loaded on demand, and note
  that unguided runtime exploration lets an agent "waste context … chasing dead-ends"
  ([Anthropic](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
  *(Anecdotal; transferability PARTIAL — the dead-end warning is *stronger* for a small model, which is
  precisely the argument for giving it structure up front rather than expecting Cline-style
  discovery.)*
- Cline's counter-position — no index, no embeddings, "Discovery, Not Retrieval" — is about **vector
  indexes**, not symbol maps, and its stated precondition is a model strong enough to explore well
  ([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/)).
  A ctags/tree-sitter symbol map is not an embedding index: it is derived deterministically, is cheap
  to rebuild, and cannot be stale in the way a vector store is. **The lexical-not-vector ruling in `04`
  stands and this does not violate it.**
- LongFuncEval measures the adjacent effect directly: **7 % to 91 % degradation in answer retrieval as
  tool response length increases** ([arXiv 2505.10570](https://arxiv.org/abs/2505.10570)). A whole-file
  `read_file` is a long tool response. *(Strong; transferability PARTIAL — long-context models, but the
  direction is unambiguous and the magnitude range is large.)*

### Does Argo's measured behaviour suggest it would help?
Partly measured, partly newly relevant.

- **Peak prompt context 64 266 of 65 536** — 1 270 tokens of headroom. On `bigproj` (827 LOC) that
  peak was reached anyway. On commander it will be reached by *two* file reads.
- **1 849 of 5 003 turns already exceed ~15 k tokens.**
- The 251 stall/progress firings with a 10 % mutation-conversion rate and the 30 no-progress re-anchors
  are consistent with frames spending turns orienting rather than acting — which is what a map is for.
  *(Consistent with, not evidence of. Nothing in the corpus attributes a stall to file size.)*
- **Contrary signal, stated because it matters:** roadmap Item 8 (file-size discipline) was marked
  "explicitly speculative — I looked and found no supporting evidence", and the largest file the agent
  had worked on failed on stale `old_string` edit matches, **not** context exhaustion. The corpus does
  not contain a file-size failure. Commander is the first substrate where one is *possible*, so this
  idea should be validated on commander and not justified from `bigproj` history.

### Smallest sufficient implementation
**Do not build Aider's graph ranking.** Two stages, and stage 1 may be enough:

*Stage 1 — a static, unranked map, generated by one shell command.* For a zero-dependency JS repo,
`grep`-derived signatures are adequate:

```
lib/command.js (2790)
  class Command
    .command(nameAndArgs, actionOptsOrExecDesc, execOpts)   :412
    .createCommand(name)                                    :455
    .addCommand(cmd, opts)                                  :512
    ...
lib/option.js (377)
  class Option
    .default(value, description)                            :91
```

Name, arity, line number. Emit it into the same tail block as the pinned anchor, capped at ~1 500
tokens (2.3 % of the window for the whole repository's structure). One-shot at frame start; regenerate
only when a file's mtime changes.

*Stage 2 — only if stage 1 measurably helps:* relevance ranking, and a `read_symbol(file, name)` tool
that returns one function body plus its line range instead of a file.

**What going smaller loses.** Dropping line numbers loses the addressability that makes a targeted read
possible; the map degrades into a vocabulary list. Dropping the map entirely and only adding
`read_file(path, startLine, endLine)` is genuinely smaller and captures part of the win — but the model
then has to guess line ranges, which is a decision it has no basis for making.

### What it would replace or make unnecessary
- Most of the pressure behind eviction and compaction. `01` §3 already shows isolation cuts compaction
  demand (12 of 14 compactions were in the single-loop workspace); a map cuts what enters the window in
  the first place, which is strictly better than evicting it afterwards.
- Plausibly makes the `evict()` cliff (`maxLiveChars` 4× below its trigger) a non-issue rather than
  something to fix.
- It does **not** replace the pinned anchor: a map is *where things are*, the anchor is *what we are
  doing*.

### How to validate it
On commander, `k=3`, map ON vs OFF, on a task that requires touching `lib/command.js`:

- **Works:** peak prompt tokens per frame drops materially — from an expected ~40 k+ (one `command.js`
  read plus history) to under ~20 k; **tool calls before the first edit** falls; pass rate holds or
  improves. The first two are already derivable (`prompt_eval_count` per `ollama_request`, `tool_call`
  events); no new instrumentation needed.
- **Does not work:** the model ignores the map and reads whole files anyway. Countable directly: whole-file
  `read_file` calls per frame. If that number does not fall, the map is prompt weight for nothing —
  and the fix is a tool change (make whole-file reads *unavailable* above N lines), not a better map.
- **Effect size:** peak-context is a continuous per-turn measure with thousands of observations, so
  k=3 is ample. A 2× reduction in peak context is unambiguous; 10 % is noise from history length.
- **Falsifier:** if commander tasks pass at the same rate with and without the map *and* peak context
  is unchanged, then whole-file reads were not the binding constraint even on a 2 790-line file, and
  Item 8's "no evidence" verdict extends to the new substrate.

### Cost
Stage 1: small — one generator (~60 lines of shell or a small module), one cap, one call site in the
existing tail block. Runtime: one `grep` pass per changed file, negligible; ~1 500 tokens per turn,
which is real and must be measured against what it saves.

---

## 3. Deterministic localisation from the test oracle

### What it is
Stop asking the model *where the problem is*. Run the tests, take the failures, and hand the model the
failing test names, their assertion messages, and the source files those tests exercise — computed by
the harness. The model receives a location; it does not search for one.

### Why it helps a small model specifically
Localisation is search over a space the model cannot see. It is also the phase where a small model
burns the most turns and where a wrong answer is most expensive, because every subsequent turn inherits
the wrong file. A test runner does this task perfectly, in 2.0 seconds, with no context cost. This is
the cleanest available instance of lever 3: the work is not hard, it is just not the model's strength.

### Evidence
- **Agentless** replaces the agent loop with a fixed three-phase pipeline — **localisation**, repair,
  patch validation — "without letting the LLM decide future actions or operate with complex tools" —
  and achieved the highest performance among all open-source approaches on SWE-bench Lite (32.00 %) at
  $0.70 per instance ([arXiv 2407.01489](https://arxiv.org/abs/2407.01489)). *(Strong; transferability
  PARTIAL — frontier model, and its localisation is model-driven over a repo structure rather than
  test-driven. The transferable claim is narrower and still important: **a fixed pipeline that removes
  agentic choice beat every agent**.)*
- Spectrum-based fault localisation — ranking source lines by their co-occurrence with failing tests —
  is decades-old, deterministic software-engineering practice. It needs no model. *(Strong as
  established practice; I did not find a study applying it as an LLM-agent scaffold, so treat the
  combination as untested rather than validated.)*
- Reflexion's 91 % pass@1 on HumanEval came from looping on **test feedback**
  ([arXiv 2303.11366](https://arxiv.org/abs/2303.11366)) — evidence that external test signal is the
  productive channel. *(Strong; transferability PARTIAL.)*

### Does Argo's measured behaviour suggest it would help?
Yes, on two counts.

- **The executable `verify` gate already proves the model can be given test output — and that the
  output as delivered is not actionable enough.** 109 verify executions, 22–24 failures, and only **6 of
  22 followed by an edit within 12 events (27 %)**; 12 produced no edit; 4 were followed directly by
  another verify failure, including three consecutive in one frame. Two visible causes: the failure
  output is truncated to **1 500 chars**, and the model sometimes writes a `verify` command that cannot
  ever pass. Test-derived *localisation* attacks the same weakness from the other end: instead of
  "here is a failure, go find the cause", it is "here is a failure and the three files its test
  exercises".
- **`bigproj` could not support this well; commander can.** 2.0 s for the full suite means the harness
  can afford to run it on entry, after every edit, and at the done-gate, and still spend less wall-clock
  than one model turn.

### Smallest sufficient implementation
```
1. On frame start (and after each mutation), run `node --test` and parse the TAP output.
2. For each failing test file, emit: test name, first assertion message, and the source
   files that file imports (a one-line `grep` for `from '../lib/...'`).
3. Put that block in the frame's assignment. Nothing else changes.
```

Import-following is a crude proxy for coverage and it is enough here: commander's tests import the
specific `lib/` modules they exercise. **What going smaller loses:** dropping the import-following and
passing only test names leaves the model to map test → file, which is the guessing step being removed.
**What going bigger would cost:** real coverage instrumentation (`node --experimental-test-coverage`)
gives line-level attribution, which is better and adds a dependency on coverage output format — do it
only if the import proxy measurably mislocalises.

### What it would replace or make unnecessary
- The model-supplied `verify` command's failure mode. If the harness owns the test invocation, the model
  can no longer register a structurally impossible `verify` — which is 4 of 22 observed failures and the
  largest single verify failure class.
- Plausibly the entire `update_plan`-supplied `verify` field, and with it one whole surface of the task
  ledger. That is a deletion, not an addition.
- Part of the pressure for a repo map (§2) on bug-fix tasks specifically — though not on feature-addition
  tasks, where no test fails yet.

### How to validate it
- **Works:** tool calls before the first edit falls, on bug-fix tasks, ON vs OFF at k=3. Baseline is
  directly measurable from existing `tool_call` events. A meaningful effect on commander is **≥40 %
  fewer** pre-edit tool calls; a 10 % change is task variance.
- **Works, second signal:** the verify-fail → edit conversion rate rises from 27 %.
- **Does not work:** the model edits a file the localiser did not name, at the same rate as before. Then
  its localisation was already adequate and this is machinery for nothing.
- **Falsifier:** on a task where the correct fix is in a file that no failing test imports, the localiser
  points the wrong way and the model must be able to ignore it. **Author that task deliberately** — a
  localiser the model cannot override is worse than none, and this is the failure mode to look for
  before trusting it.
- **Effect size caveat:** feature-addition tasks have no failing tests at frame start, so this idea only
  applies to a subset. Report the subset separately or the aggregate will hide the effect.

### Cost
Small: a TAP parser (`node --test` output is line-oriented), an import grep, one assignment field.
Runtime: **2.0 s per invocation on commander** — cheaper than any model turn by an order of magnitude.

---

## 4. Narrow the action space

### What it is
Fewer tools visible per turn, tighter schemas, and one kind of decision per turn. Not fewer
*capabilities* — fewer simultaneously-offered options.

### Why it helps a small model specifically
Tool selection is a classification problem over the tool list, and its difficulty grows with the list.
A small model that picks wrongly does not fail cleanly: it calls a forbidden tool, gets rejected, and
often calls another forbidden tool — spending budget on navigating its own option space rather than the
task.

### Evidence
- **LongFuncEval: a 7 % to 85 % performance drop as the number of tools increases**, plus 13 % and 40 %
  degradation as multi-turn conversations get longer ([arXiv 2505.10570](https://arxiv.org/abs/2505.10570)).
  *(Strong; transferability PARTIAL — long-context models on enterprise tool catalogs, not coding. The
  range is wide, but the sign is consistent and the mechanism is the same classification problem.)*
- **"Less is More" (DATE 2025): "selectively reducing the number of tools available to LLMs
  significantly improves their function-calling performance, execution time, and power efficiency on
  edge devices"** — execution time reduced up to 70 %, power up to 40 %
  ([arXiv 2411.15399](https://arxiv.org/abs/2411.15399)). *(Strong; transferability **DIRECT-ish** — edge
  hardware and small models is the closest published setting to Argo's in this whole document.)*
- SWE-agent's thesis that interface design drives agent behaviour — "the design of the ACI can impact
  agents' behavior and performance" ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793)). *(Suggestive;
  transferability DIRECT as a design principle.)*
- Manus: "Mask, Don't Remove" — use a state machine that masks tool availability per state rather than
  adding and removing tool definitions, to protect the prompt prefix
  ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  *(Anecdotal; transferability DIRECT and it matters for §6 — see the interaction.)*

### Does Argo's measured behaviour suggest it would help?
This is Argo's most-repeated failure by raw count.

- **262 rejected tool calls**: role-restriction 102, loop-block 143, plan-gate 17.
- **Of the 102 role rejections, 67 (66 %) are followed by another call to a forbidden-class tool.** Only
  10 switch to an allowed tool; 25 end the frame. Distribution: **Boss 53, Planner 48, Tester 1** — the
  two roles the restriction exists to constrain simply keep hammering.
- Nine such rejections occurred in a single Planner frame.
- **23 of 94 Boss task-starts (24 %) end with the workspace dirty** — the Boss self-attempting work at a
  checkpoint where it has only `bash`.

Contrast: the **plan/act gate**, which is a *state* rather than a *list*, gets **95 % compliance** (77 of
81 firings followed by a `plan` event within six events). The harness's own data says a constrained state
works and a rejection message does not.

### Smallest sufficient implementation
Two changes, both subtractive, and the second is nearly free:

```
1. Drop `bash` from the Boss's task-start frame. It is the tool it abuses (53 of 102 rejections),
   and at task-start its job is to read enough to classify, not to fix.
   `read_file` + `ledger` is sufficient for that job.

2. Rejection text states the affordance, not the prohibition:
     "You cannot write files in this frame. Your job is to emit <CONTRACT>. Do that now."
   And after the SECOND rejection of the same forbidden tool, force the frame to conclude.
```

**What going smaller loses.** Text-only (change 2 alone) leaves the Boss with the tool it misuses and
relies on prose to stop it — which is the configuration that produced 67 of 102. Change 1 alone accepts
that the Boss can then never self-attempt; that is a real trade, and the measured cost of the current
middle position is that Argo pays for both.

**What going bigger would cost.** Per-turn tool masking driven by a state machine (Manus's approach) is
the principled version, and it conflicts with prefix caching (§6): changing the tool list changes the
prompt prefix and invalidates the cache from that point. Do not build it until §6 is measured.

### What it would replace or make unnecessary
- Most of the role-restriction rejection traffic, and the prompt text currently spent instructing the
  Boss not to do what it is given a tool to do.
- Possibly the `TRIVIAL_DIFF_LINE_LIMIT`/dirty-workspace override for task-start frames, since a frame
  with no mutating tool cannot leave the workspace dirty. That is one guard fewer.

### How to validate it
- **Works:** role rejections fall from 102 (Boss 53) toward zero for task-start frames, and Boss
  task-start iterations fall inside their 10-iteration budget. Counters exist (`roleReject`). Pure
  counter check, no judge.
- **Works, second signal:** the "dirty after task-start" rate falls from 23 of 94.
- **Does not work:** classification quality degrades — `OBJECTIVE`/`TRIVIAL`/`ANSWER` distribution shifts
  away from the measured 84 % fast-path share, or `TRIVIAL`-classified tasks start failing because the
  Boss can no longer confirm a fix cheaply. That is the risk and it should be watched explicitly.
- **Effect size:** 102 → under 20 is unambiguous. Anything above 60 means the affordance rewording did
  nothing and the tool removal is doing all the work.

### Cost
Trivial: one array literal and one message string.

---

## 5. Deterministic validation of every edit

### What it is
Before an edit is accepted, the harness checks it mechanically: does the file still parse, does the type
checker still pass, does the linter still pass. A failing edit is rejected with the exact error, in the
same turn, as a tool result — not discovered three turns later by a test run.

### Why it helps a small model specifically
A small model's edits fail in mechanical ways — unbalanced braces, a bad `old_string` match, a stale
line reference — far more often than in reasoning ways. Each such failure currently costs the model
several turns to notice, and in the worst case it does not notice and builds on broken code. Immediate,
precise mechanical feedback converts a multi-turn debugging detour into a single-turn correction, and it
is free.

### Evidence
- SWE-agent's ACI explicitly includes guardrails such as rejecting malformed edits before applying them,
  and reports that interface design changes agent behaviour
  ([arXiv 2405.15793](https://arxiv.org/abs/2405.15793), [swe-agent.com](https://swe-agent.com/latest/background/)).
  *(Suggestive; transferability DIRECT.)*
- Aider runs a linter after edits and its benchmark tracks `syntax_errors` per run as a first-class
  metric; the published JSON for the JSON-vs-markdown experiment shows deepseek-coder accumulating up to
  **11 syntax errors in a single 133-case run** under the JSON edit format
  ([aider.chat](https://aider.chat/2024/08/14/code-in-json.html)). *(Strong that syntax errors are a real
  and measurable failure class for open models; transferability DIRECT.)*
- Manus's "Keep the Wrong Stuff In" — leaving the failure and its error in context shifts the model's
  prior away from repeating it
  ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  *(Anecdotal; transferability DIRECT. It also argues for surfacing the rejection as a normal tool error
  rather than silently reverting.)*

### Does Argo's measured behaviour suggest it would help?
Partly, and the evidence is thinner than for §1–§4 — say so.

- The documented `test-two` failures were **stale `old_string` edit-match failures**, which the workspace's
  own hand-written `AGENTS.md` addresses with a re-read-before-edit rule. That is the same class.
- 165 July `tool_result.error` values include **`old_string not found in …` ×36** — a real, counted
  mechanical edit-failure population.
- 12 of 22 verify failures produced no subsequent edit, which is consistent with the model not being able
  to act on the feedback it got. Not proof.
- **Commander makes this much stronger than `bigproj` did:** `checkJs: true, strict: true` means
  `tsc -p tsconfig.js.json` type-checks `lib/*.js` through JSDoc, and `npm test` already gates on `tsd`
  plus `tsc` over 1 900 lines of typings. So an edit can be checked against a *type* system, not just a
  parser.

### Smallest sufficient implementation
```
After a successful edit_file/write_file on a .js file, run `node --check <file>`.
If it fails: revert the write, and return the parse error as the tool result
(rejected: true), naming the line.
```

`node --check` is built in, takes milliseconds, and needs no configuration. **What going smaller loses:**
returning the error *without* reverting leaves broken code on disk that a later test run will blame on
the wrong change. Reverting is what makes the check safe.

**One step bigger, and probably worth it on commander:** after the syntax check passes, run
`tsc -p tsconfig.js.json` and surface only *new* diagnostics (diff against the baseline set). That
catches semantic breakage the tests would find later, at sub-second cost. Cap the surfaced diagnostics
at the first three — LongFuncEval's tool-response-length finding applies to error output too.

### What it would replace or make unnecessary
- A share of the verify-gate's work, moved earlier and made cheaper.
- Some of the loop traffic: an edit that fails and is retried blindly is one of the shapes L0 fires on.
- Nothing existing is deleted outright. This is an addition — which is a mark against it relative to
  §1–§4, and the reason it ranks lower.

### How to validate it
- **Works:** `old_string not found` and syntax-error tool results per run fall; verify-fail → edit
  conversion rises; total turns per task falls. All countable from existing events.
- **Does not work:** the check fires rarely (say under 2 % of edits) — then the model was not making
  mechanical errors on this substrate and the machinery is dead weight. **Measure the firing rate before
  adding the type-check layer**, exactly as the mechanism-verification pass would have wanted for the
  three mechanisms that fire and do nothing.
- **Effect size:** the firing rate itself is the primary reading. Below 2 % of edits → revert the idea.

### Cost
Trivial for `node --check` (~15 lines). Small for the `tsc` layer plus baseline-diagnostic diffing.
Runtime: milliseconds for the parse check; `tsc` on commander is seconds and should be gated to the
done-path, not every edit.

---

## 6. Prefix-cache discipline, and measuring it

### What it is
Keep the prompt prefix byte-stable across turns so the KV cache is reused, and **measure the reuse**
using `prompt_eval_cached_count`, which Ollama already returns on every response.

### Why it matters here
It decides whether several other ideas are cheap or expensive. If the prefix is cached, a pinned
objective, a repo map and a recited plan cost almost nothing per turn beyond their token count in the
window. If the prefix is *not* cached — because a timestamp, a rotating tool list, or a re-ordered
system block changes it — then every one of those bytes is re-evaluated every turn, and the anchor that
H23 wants becomes a per-turn tax. **This bears directly on H23 and on §2 and §4.**

It also bears on a measured mystery: the unexplained **5–8× per-iteration slowdown** (~14 s/iteration
versus ~2 s/iteration for the same tasks the same morning, both on `qwen3.6`). Cache invalidation is a
candidate explanation alongside model-eviction thrash, and `prompt_eval_cached_count` distinguishes
them: a cache-miss cause shows as a collapse in cached tokens; a model-reload cause shows in
`load_duration`.

### Evidence
- `prompt_eval_cached_count` — "number of prompt tokens read from the cache" — and
  `prompt_eval_duration` — "time spent in nanoseconds evaluating **uncached** prompt tokens" — are
  documented response fields ([api.md](https://raw.githubusercontent.com/ollama/ollama/main/docs/api.md)
  L103–104). *(Strong; transferability DIRECT — our own runtime.)*
- Manus: keep the prompt prefix stable and the context append-only; do not add or remove tools mid-task;
  do not inject per-second timestamps — all framed explicitly as KV-cache protection
  ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  *(Anecdotal on magnitude; transferability DIRECT — the mechanism is architectural.)*

### Does Argo's measured behaviour suggest it would help?
Unknown, and that is the point: **Argo has never read this field.** What can be said now:

- Every turn re-sends the whole message array (`agent.ts:976-983`), so prefix stability is determined by
  whether the *head* of that array is stable. The system prompt is stable; the injected project context
  (`PROJECT_CONTEXT_CHAR_CAP = 8000`) is stable within a run; the tool list is per-role and stable within
  a frame. So a high cache-hit rate is *plausible* — but the collapsing of older tool results
  (`TOOL_RESULT_COLLAPSE_OVER = 600`, `KEEP_RECENT_TOOL_RESULTS = 4`) **rewrites history in place**,
  which invalidates the cache from the first rewritten message onward. That is a specific, checkable
  suspicion and it has never been checked.
- If it is true, Argo's most-endorsed context mechanism is silently paying a re-evaluation cost on every
  turn where a collapse happens.

### Smallest sufficient implementation
```
Log prompt_eval_cached_count / prompt_eval_count / load_duration on every ollama_request event.
```
Two fields on an existing event. Nothing else. Then read the data before changing anything.

**What going smaller loses:** everything — the whole value here is the measurement, and no design
decision about the anchor's cost is defensible without it.

**If the data shows poor reuse**, the smallest fix is to make collapsing **append-only**: instead of
rewriting an old tool result in place, leave it and append a note. That preserves the prefix at the cost
of some tokens, and the trade is then quantified rather than guessed.

### What it would replace or make unnecessary
Nothing directly. It makes the cost side of H23, §2 and §4 knowable, and it may explain the 5–8×
slowdown that currently invalidates every wall-clock comparison in the project — including the 1.6×/6×
figures the roadmap treats as settled.

### How to validate it
It is instrumentation; the validation is that the numbers are sane. Concretely: on a 40-turn run, cached
tokens should be a large and *increasing* fraction of prompt tokens; a turn where a collapse fires should
show a visible dip. **If cached tokens are near zero throughout, that is a major finding** and it changes
the ranking of everything in this document.

### Cost
Trivial: two fields. Zero runtime cost.

---

## 7. Thinking budget per turn

### What it is
Use Ollama's `think` parameter — boolean or `"low"|"medium"|"high"|"max"` — to spend reasoning where it
pays and suppress it where it does not: high on a planning or diagnosis turn, off on a verdict turn or a
mechanical edit.

### Why it helps a small model specifically
A small model's thinking tokens are both its main asset and its main cost. Argo currently gets whatever
the model's default is, uniformly, on every turn — including on 10-iteration classification frames whose
entire output is one enum, and on the 22 stand-ups whose output is one keyword. Thinking on those turns
buys nothing and consumes both latency and context.

### Evidence
- The parameter exists and takes levels (api.md L48, L498). *(Strong; transferability DIRECT.)*
- Qwen3's documented hybrid thinking modes — a thinking mode for complex problems and a non-thinking mode
  for "quick, near-instant responses" with "thinking budget control"
  ([Qwen3 blog](https://qwenlm.github.io/blog/qwen3/)). *(Suggestive; the family is right, the specific
  build here is not verifiable from public docs.)*
- **The strongest evidence is a warning, not an endorsement.** *The Danger of Overthinking* analyses
  4 018 SWE-bench Verified trajectories: higher overthinking scores **correlate with decreased
  performance**, and reasoning models overthink more; selecting the lower-overthinking solution improved
  performance ~30 % and cut cost 43 % ([arXiv 2502.08235](https://arxiv.org/abs/2502.08235)). *(Strong;
  transferability PARTIAL — frontier reasoning models. The direction matters more than the magnitude.)*
  So the default expectation should be **less thinking on action turns**, not more thinking on hard ones.
- s1's budget forcing shows gains from *more* thinking, but on single-turn reasoning, not agentic loops
  ([arXiv 2501.19393](https://arxiv.org/abs/2501.19393)). *(Strong for its setting; transferability WEAK
  — recorded because it is the argument someone will make, and it does not survive H01.)*

### Does Argo's measured behaviour suggest it would help?
- **H01 is the local version of the overthinking result**: 60 → 90 iterations made `bigproj-effort`
  worse (5/6 → 3/6), with thrashing and an attempted oracle edit. Argo has already measured that more
  model deliberation, at the loop level, hurts.
- **The interaction with §1 is the concrete win**: `think: false` on the constrained verdict calls avoids
  Ollama's structured-outputs double request entirely (`forceImmediate`, `routes.go:2769`). So §1 and §7
  are not two ideas competing for attention — §7 is what makes §1 free.
- 22 stand-ups and 94 task-start frames are pure classification work. That is ~116 frames of thinking
  that could plausibly be off.

### Smallest sufficient implementation
```
think: false on the Boss task-start frame, the stand-up frame, and the Tester verdict turn.
Leave everything else at the default.
```
Three call sites, one boolean. **What going smaller loses:** nothing much — this *is* the small version.
**What going bigger would cost:** per-turn adaptive levels ("high on the first turn of a frame, low
after") is a policy with no evidence behind it and a real chance of degrading diagnosis turns. Do not.

### What it would replace or make unnecessary
Nothing on its own. It removes the double-request cost from §1, and it may recover several seconds per
classification frame — which matters only because long-horizon runs are wall-clock-bound.

### How to validate it
- **Works:** classification accuracy holds (the 84 % fast-path share is stable, and marker emission does
  not regress) while per-frame wall-clock and generated tokens fall. `eval_count` per frame is already
  available.
- **Does not work:** `TRIVIAL`/`ANSWER` misclassifications appear — e.g. a genuinely tripartite task
  routed `SIMPLE`. That is the risk, and `OBJECTIVE` share (measured at 9 %, 3 of 32) is the number to
  watch. With only 32 marked classifications in the whole corpus, this is a **low-power measurement**;
  do not claim a routing effect from one battery.
- **Falsifier:** if `think:false` changes verdict *content* materially, the model is using thinking to do
  the classification and the parameter should stay default on that frame.

### Cost
Trivial: one field on three calls. Runtime: strictly negative (saves tokens).

---

## 8. Turn construction as a pure function over a durable store

### What it is
Stop treating the conversation as an accumulating transcript that is occasionally trimmed. Instead, the
harness **composes** each turn's input from a durable store: objective, plan with statuses, the last N
observations, the current diff, the current failing tests. The model becomes close to a pure function
from that composed state to the next action.

### Why it helps a small model specifically
Every alternative to this is a policy for *removing* things from a history that is growing for reasons
unrelated to what the model needs now. Eviction, compaction and collapsing are all repairs to that
premise. If the harness composes the input instead, the input is small **by construction** and never
needs repair — and the content is what the harness has decided is relevant, not what happens to be
recent.

### Evidence
- 12-Factor Agents, Factor 3 ("Own your context window"): "You don't necessarily need to use standard
  message-based formats… At any given point, your input to an LLM in an agent is 'here's what's happened
  so far, what's the next step'", and Factor 12 ("Make your agent a stateless reducer")
  ([humanlayer/12-factor-agents](https://github.com/humanlayer/12-factor-agents)). *(Anecdotal — a
  practitioner design doc with no measurements; transferability DIRECT.)*
- Factor 10 ("Small, Focused Agents"): keep agents to "3-10, maybe 20 steps max" because "as context
  grows, LLMs are more likely to get lost or lose focus". *(Anecdotal; notable because it independently
  lands on ~20 steps, the same number as Gabriel's chunk directive.)*
- Manus's restorable externalisation — offload the bulky observation to a file, keep the reference
  ([Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)).
  *(Anecdotal; transferability DIRECT.)*
- Context-rot: performance degrades with input length even on trivial tasks, across 18 models including
  Qwen3, and their LongMemEval condition compares a ~300-token focused prompt against the full ~113 k
  conversation containing the same answer, with consistent degradation for the full input
  ([Chroma](https://research.trychroma.com/context-rot)). *(Suggestive; transferability DIRECT-ish. This
  is the mechanism: composing a focused input is not only cheaper, it is *better*.)*

### Does Argo's measured behaviour suggest it would help?
Indirectly but consistently. Argo already has four separate repairs to the accumulating-history premise —
`TOOL_RESULT_COLLAPSE_OVER`, `KEEP_RECENT_TOOL_RESULTS`, episode eviction, LLM compaction — of which one
has fired 3 times (always via the loop guard, never via its own threshold) and one 14 times, and neither
has ever been A/B'd. **Four mechanisms, one measured purpose between them.** That is the signature of
repairing the wrong thing.

Counter-consideration, and it is serious: Argo's frames are *already* short-lived composed contexts. A
frame gets a `buildAssignment` message and runs 10–60 iterations. So Argo has the architecture at frame
granularity and the transcript problem only *within* a frame — where the longest frames are Implementers
at 60 iterations. This idea therefore has less headroom here than it would in a single-loop agent, and
that is why it ranks mid-table rather than top.

### Smallest sufficient implementation
Do not rebuild the loop. Take the one piece that is missing and cheap:

```
Per turn, the tail block contains exactly:
  [OBJECTIVE — immutable]        (from the ledger; H23's anchor)
  [PLAN + statuses]              (existing task-ledger render)
  [CURRENT DIFF — paths + stat]  (from the per-frame git snapshot, `08` §4i)
  [FAILING TESTS]                (from §3, when applicable)
capped, in that order, replaced wholesale each turn — never appended.
```
That is one composed block, built from durable state, on top of the existing history rather than instead
of it. It delivers most of the benefit and none of the rewrite.

**What going smaller loses:** without the diff and failing-tests lines, the model must re-derive current
state from the transcript, which is the thing being avoided. **What going bigger costs:** replacing the
message history entirely is a redesign of `agent.ts`'s core loop, and it would invalidate every
mechanism measurement in the corpus. Not now, and possibly not ever.

### What it would replace or make unnecessary
- If it works well, it reduces episode eviction and LLM compaction to fallbacks for pathological cases,
  and the `evict()` cliff stops mattering. That is a plausible route to deleting `eviction.ts`'s
  threshold path and one of the two context mechanisms.
- It subsumes part of §2 and §3 by giving them a home in the prompt.

### How to validate it
- **Works:** peak prompt tokens per frame flattens as iterations grow, instead of rising; compaction and
  eviction firing rates fall toward zero; pass rate holds. Peak context per turn is already available.
- **Does not work:** the model contradicts the composed block — acts on a file the diff says it already
  changed, or re-runs a test the block says is passing. Countable, and it would mean the block is being
  ignored, which points at position or size rather than content.
- **Falsifier:** if the composed block plus the existing history is *larger* than the history alone was,
  and quality does not improve, it is duplication. **This is a real risk** and it is the same trap as
  reciting the plan twice (see `interaction-matrix.md`, M16 × M26).

### Cost
Small if scoped as above (one render function, one call site, reusing three existing sources). Runtime:
the block's token count, every turn — which is why §6 must be measured first.

---

## 9. Forced grounding at the point of assertion

### What it is
Require the claim and its evidence in the same output: quote the line before asserting what the code
does; cite `file:line` for every factual statement about the repository. A post-hoc grounding pass asks
"was that true?"; this makes the untrue version harder to emit.

### Why it helps a small model specifically
Fabrication is cheapest when nothing has to accompany the claim. Requiring a verbatim quote next to each
assertion means the model must attend to the retrieved text at the moment of generation, which is where
the error otherwise occurs. It is also strictly cheaper than a critic pass: no extra LLM call, no extra
round-trip.

### Evidence
- **According-to prompting** — directing a model to ground responses against previously observed text —
  improved grounding by the paper's QUIP-Score across three corpora, "with the additional benefit of
  often improving end-task performance", and prompts asking for *less* grounding measurably decreased it
  ([arXiv 2305.13252](https://arxiv.org/abs/2305.13252), EACL 2024). *(Strong for the mechanism —
  including the bidirectional control result; transferability PARTIAL: pre-training-corpus grounding, not
  in-context source grounding, and not code.)*
- GopherCite — training a model to support answers with verified quotes
  ([arXiv 2203.11147](https://arxiv.org/abs/2203.11147)). *(Strong but **transferability NONE** as a
  method: it requires RL training. Recorded because it establishes that quote-supported answering is a
  learnable, evaluable behaviour, not because we can do it.)*
- Anthropic's fresh-context code-review subagent checks **the diff**, not the narrative
  ([Anthropic](https://www.anthropic.com/engineering/claude-code-best-practices)). *(Anecdotal;
  transferability DIRECT — same instinct, applied at review time rather than assertion time.)*

### Does Argo's measured behaviour suggest it would help?
Yes, and it targets Argo's best-documented fabrication.

- The grounding guard fires **27 times** (17 `ok`, 10 `revise`) and produced the harness's best guard
  output: *"Cites 'Bernardi Glassworks' in sources but it was never fetched"*. But it is **one-shot**
  (`groundingChecked` set before the check, `agent.ts:1596`), and the fabricated citation **survived into
  the final artifact** (`bille.html:380-381`, 5 occurrences). H05: removes severe errors, does not reduce
  total fabrications.
- `DOC_EXTS` (`grounding.ts:47`) means the guard **can never fire on a coding task**, so on the entire
  eval suite Argo has *no* fabrication defence at all. Meanwhile the quality judge caught the Boss final
  frame hallucinating *"All 9 tests pass"* on a run scored PASS.
- **Assertion-time grounding works on code, where the post-hoc guard cannot.** That is the gap it fills.

### Smallest sufficient implementation
Prompt-level, no new mechanism:

```
In the frame contract for Boss/Tester conclusions:
  "Every factual claim about the code must carry a file:line reference.
   Every claim that a test passes must quote the runner's summary line verbatim.
   If you cannot cite it, do not claim it."
Then the harness spot-checks mechanically: extract file:line references from the conclusion
and verify each file exists and has that many lines. Emit a `grounding_refs`
event with {claimed, resolvable}.
```

The mechanical check is what makes this more than a prompt: it is a deterministic, cheap falsifier for
the easiest class of fabrication (a citation to a line that does not exist).

**What going smaller loses:** the prompt alone is a text convention, and Argo's own principle —
harness-level signal over text convention — exists because those have already been observed to fail
here. The resolvability check is ~20 lines and turns it into a signal.

**What going bigger costs:** requiring a verbatim quote *and* verifying the quote appears in the file is
better and needs the file content at check time — worth doing for the Tester's conclusion specifically,
since that is the claim the Boss acts on.

### What it would replace or make unnecessary
- It is the cheap general-purpose version of the grounding guard, and it works on the 100 % of the eval
  suite the guard cannot reach. If it works, the bounded-re-check upgrade to the grounding guard
  (`03` §4iii) may be unnecessary, and `ARGO_CRITIC` stays off permanently.
- It also supplies part of what `08` §4i wants: a Boss conclusion whose claims are checkable.

### How to validate it
- **Works:** `resolvable / claimed` reference ratio is high (>90 %) and, critically, **unresolvable
  references are non-zero at least once** — a checker that never fires is not evidence of grounding, it
  is evidence the model stopped citing.
- **Works, second signal:** the quality judge's `drift_or_hallucination` list shrinks at k=3 on the four
  `bigproj` tasks plus commander. This is a judge-based metric capped at 20 points, so treat a clean
  split (3/3 → 0/3) as the readable outcome and anything narrower as noise.
- **Does not work:** the model emits plausible-looking `file:line` references that resolve but are
  irrelevant — citation theatre. Detectable only by sampling; check five conclusions by hand before
  trusting the ratio.
- **Falsifier:** claim count per conclusion collapses (the model avoids asserting anything rather than
  citing). Watch conclusion length and claim count, not just the ratio.

### Cost
Small: prompt text plus a ~20-line reference resolver. Runtime: one `stat` per reference.

---

## 10. Edit format: never route code through a schema

### What it is
A policy, not a mechanism: code-bearing outputs go through `edit_file`/`write_file` with plain string
arguments — never inside a constrained JSON schema, never as a stringified blob with escaped newlines.

### Why it helps a small model specifically
Escaping code into JSON is a second, orthogonal task the model must perform correctly *while* writing
the code, and it competes for the same capacity. The measured penalty falls hardest on open models.

### Evidence
Aider's benchmark, 133 cases × 5 runs (§1 table): **deepseek-coder V2 drops from ~59–62 % on markdown to
~49–53 % on JSON**, roughly 9 points, versus a few points for gpt-4o. Their conclusion: "LLMs produce
lower quality code if they're asked to return it as part of a structured JSON response … Benchmarks show
that models struggle with syntax errors in the code they write, related to quoting and escaping it into
JSON" ([aider.chat](https://aider.chat/2024/08/14/code-in-json.html)). *(Strong; transferability
PARTIAL-to-DIRECT, and the open-model row is the relevant one.)*

### Does Argo's measured behaviour suggest it would help?
Argo is **already on the right side of this** — `edit_file` takes plain `old_string`/`new_string`, not a
schema-constrained blob. So the value here is **defensive**: it is a rule that stops §1 from being
over-applied. The single most likely way to damage Argo while implementing §1 is to reach for a schema on
an edit tool because schemas worked so well on verdicts.

Write it down as a constraint on §1, not as work.

### Smallest sufficient implementation
One line in `CLAUDE.md` / the design docs: **constrain the control plane, never the code plane.** Cost:
zero.

### How to validate it
Not applicable — it is a prohibition. The validation is that nobody violates it. If someone wants to
test it, the experiment is Aider's and it has been run.

---

## 11. Learning from Argo's own successful traces, without training

### What it is
Mine the harness's own logs for reusable patterns and inject them as **text**: either induced workflows
("to add a method to `TaskService`: read `src/service.js`, add the method, add a test, run `node --test`")
or extracted insights ("`npm test` in this workspace also runs `tsc`; a JS-only change can still fail").
No weight updates.

### Why it helps a small model specifically
A small model's weakest asset is procedural knowledge about *this* codebase and *this* harness. That
knowledge is sitting in 567 run logs. Injecting a short, relevant, previously-successful procedure is the
cheapest possible substitute for capability, and it is exactly the kind of thing a small model follows
well (it is instruction-following, not reasoning).

### Evidence
- **Agent Workflow Memory**: induces reusable workflows from past experience and selectively provides
  them, improving success rates by **24.6 % and 51.1 % relative** on Mind2Web and WebArena, while
  reducing steps taken; works both offline (from training examples) and online (from test queries)
  ([arXiv 2409.07429](https://arxiv.org/abs/2409.07429)). *(Strong effect sizes; transferability PARTIAL —
  **web navigation, not coding**, and web tasks are far more repetitive across instances than coding
  tasks are. Expect much less here.)*
- **ExpeL**: an agent that autonomously gathers experiences and extracts natural-language insights from
  past trajectories, recalling them at inference, with "consistent enhancement in its performance as it
  accumulates experiences" — explicitly motivated by fine-tuning being resource-intensive
  ([arXiv 2308.10144](https://arxiv.org/abs/2308.10144), AAAI-24). *(Suggestive; transferability PARTIAL.)*
- Anthropic's memory-tool result (+39 % with context editing, of which **+29 % is context editing alone**)
  suggests the memory half of such pairings contributes less than the context half
  ([Anthropic](https://www.anthropic.com/news/context-management)). *(Suggestive; a caution about
  expected magnitude.)*

### Does Argo's measured behaviour suggest it would help?
Mixed, and the local evidence is a warning.

- **The one time Argo distilled its own trace into durable text, it wrote transcript sludge** —
  `Called bash({"command":"ls /workspace/tests/"}) Result: …` — twice, into a file re-injected every
  iteration (H15, `04` §3). Automatic distillation has a 0-for-2 record here.
- But the failure was in *what* was extracted (an in-run working-memory schema reused for cross-run
  knowledge), not in the idea of extracting. And the one high-quality section in that file — a
  hand-written "Editing convention" — is exactly the artifact this idea would produce, which is weak
  evidence that the artifact is valuable when correct.
- **The multi-turn task work (H25) is the natural first home for this**, and it does not exist yet.

### Smallest sufficient implementation
```
A hand-written `AGENTS.md` in each eval workspace, seeded from what the logs already show
(e.g. for commander: "npm test also runs tsc over typings; lib/*.js is type-checked via
JSDoc with strict:true; tests import the specific lib module they exercise").
```

That is the smallest version and it is **not automation at all** — a human reads the logs once and
writes ten lines. It captures most of the value, has none of the H15 failure mode, and Argo's memory read
path already injects it (`selectAgentsSections`, `agent.ts:830-849`).

**What going smaller loses:** nothing measurable. **What going bigger costs:** automatic induction
re-introduces the H15 risk, and it must not write into the same file a human curates. If it is ever
built, it writes to a separate `.argo/workflows.md` with a hard filter, and it runs **at end of run**, not
mid-run.

**Important precondition, from `04` §4:** seeding `AGENTS.md` into an eval workspace is a **task hint**
and will inflate scores. It must be part of the workspace's `eval-baseline` and identical across both
harnesses in any Argo-vs-Hermes comparison, or the comparison is void.

### What it would replace or make unnecessary
- It is the cheap alternative to fine-tuning (§13) and, unlike fine-tuning, it is possible here.
- It makes the `ARGO_MEMORY` read path reachable for the first time — currently unreachable in every eval
  workspace, because only `test-two` has these files.

### How to validate it
- **Works:** tool calls before the first edit falls with `AGENTS.md` present vs absent, at k=3 on
  commander. Existing events; no new instrumentation. A meaningful effect is **≥25 % fewer** pre-edit
  tool calls.
- **Works, second signal:** the specific failure the note warns about stops occurring (e.g. runs stop
  being surprised that `npm test` type-checks).
- **Does not work:** no difference — then either the note is not being selected (check with the
  `memory_select` event from `04` §4iv, which does not exist yet and is a prerequisite) or the model is
  not reading it.
- **Falsifier for the automated version specifically:** if induced workflows increase the judge's
  `drift_or_hallucination` list, distillation is re-importing noise and should be abandoned — the same
  falsifier as H26's.

### Cost
Zero for the hand-written version, beyond an hour of reading logs. Medium and risky for the automated
version. Runtime: the file's tokens, bounded by `PROJECT_CONTEXT_CHAR_CAP = 8000`.

---

## 12. Context as a hardware allocation decision

### What it is
Treat the context window as something to be *bought* with memory rather than accepted as given. Three
knobs: `OLLAMA_CONTEXT_LENGTH` / `num_ctx`, `OLLAMA_KV_CACHE_TYPE`, `OLLAMA_FLASH_ATTENTION`.

### Why it might help
Argo runs at 65 536 tokens and reached 64 266. Ollama's own default for a ≥48 GiB machine is **256 k**,
and its docs recommend "at least 64000" for agentic and coding tools — i.e. Argo is at the recommended
*floor*, not a ceiling. If the machine can hold more KV cache, the cheapest possible answer to "the
codebase does not fit" is a bigger window, with no code change at all.

### Evidence and the reasons to be careful
- VRAM-based defaults and the override are documented and confirmed in code
  ([context-length.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/context-length.mdx);
  `routes.go:2055-2062`). `ollama ps` reports the allocated `CONTEXT` and the GPU/CPU split.
  *(Strong; transferability DIRECT.)*
- `OLLAMA_KV_CACHE_TYPE=q8_0` uses "approximately 1/2 the memory of f16 with a very small loss in
  precision … usually has no noticeable impact"; `q4_0` ≈ ¼ with "small-medium loss"
  ([faq.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/faq.mdx) L361-367). *(Strong on
  the memory arithmetic; transferability DIRECT.)*
- **The disqualifying caveat, from the same doc: "Models that have a high GQA count (e.g. Qwen2) may see
  a larger impact on precision from quantization than models with a low GQA count."** Argo runs a Qwen
  model. *(Strong, and it names our family specifically.)*
- **Counter-argument from the strongest evidence in this whole body:** context-rot shows performance
  degrading with input length across 18 models including Qwen3, and the LongMemEval condition shows a
  ~300-token focused prompt beating the ~113 k full conversation containing the same answer
  ([Chroma](https://research.trychroma.com/context-rot)). **A bigger window does not make a long prompt
  work; it makes a long prompt possible.** Buying context to avoid building §2 and §8 would be buying
  the ability to degrade more gracefully.

### Does Argo's measured behaviour suggest it would help?
Only in one specific way. H24 wants long-horizon conditions *cheaply*, and the current plan is to
**lower** `COMPACT_RESERVE_TOKENS` to force compaction at ~16 k. Note the direction: the project's own
next experiment makes the effective window *smaller*, deliberately. That is the right instinct and it is
the opposite of buying more context.

The one thing worth doing here is measurement, not change: run `ollama ps` during a run and record the
allocated `CONTEXT` and the `PROCESSOR` split. If the model is partially offloaded to CPU, that is a
plausible contributor to the unexplained 5–8× slowdown, and it is a one-command check.

### Smallest sufficient implementation
```
Record `ollama ps` output (CONTEXT, PROCESSOR) once per eval batch, into the run record.
```
Change nothing else.

### What it would replace or make unnecessary
Nothing. It removes an unknown, and it would explain a slowdown that currently invalidates every
wall-clock comparison.

### How to validate it
The check is the value. **If `PROCESSOR` is ever not 100 % GPU, that is a finding** and it outranks
several ideas above, because it means a fraction of every run is executing at CPU speed.

If someone does want to raise `num_ctx`: A/B 65 k vs 128 k on commander at k=3, watching pass rate,
peak context and per-iteration wall-clock. **Prediction: no quality gain and a wall-clock loss**, per
context-rot. Worth one battery to close the question, not more.

### Cost
Trivial for the measurement. The KV-cache quantisation change is one env var and I would **not** make it
on a Qwen model without an explicit A/B, given the GQA caveat.

---

## 13. Considered and set aside

Each of these looked appealing. Here is why it is not worth it here.

**Local fine-tuning / LoRA on Argo's own traces.** Blocked on toolchain, not just cost. MLX LoRA
training does list Qwen2 as supported, but `mlx_lm.fuse --export-gguf` is "limited to Mistral, Mixtral,
and Llama style models in fp16 precision", and Ollama's `ADAPTER` directive supports only "Llama …
Mistral … and Gemma" architectures
([LORA.md](https://raw.githubusercontent.com/ml-explore/mlx-lm/main/mlx_lm/LORA.md) L11, L134-135;
[import.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/import.mdx) L35-39). So a Qwen
adapter cannot be loaded by Ollama and cannot be exported to GGUF by MLX. The remaining path is: train
the adapter, fuse to fp16 safetensors, convert with llama.cpp's `convert_hf_to_gguf.py`, re-quantise,
`ollama create` — producing a **second full ~24 GB model** on a 48 GB machine, per experiment, with no
way to A/B without swapping models. Against that: §11 gets a large fraction of the benefit as text, in
an afternoon, reversibly. **Verdict: not now. Revisit only if Ollama adds Qwen adapter support**, which
is a checkable condition rather than a judgement.

**Speculative decoding.** Newly *possible* and worth recording, because the previous ruling ("park,
unproven") predates the evidence: Ollama's `draft_num_predict` documents both a separate draft model
(default 4 tokens/step) and **"embedded MTP tensors"**, i.e. multi-token prediction heads inside the
model itself — which would need **no second resident model**
([modelfile.mdx](https://raw.githubusercontent.com/ollama/ollama/main/docs/modelfile.mdx) L156).
Whether the specific build Argo runs has MTP tensors is a one-command check (`ollama show`). **Verdict:
worth the one command, nothing more.** Speed is out of the score, and its only real relevance is that a
200-iteration run at 14 s/iteration may be infeasible where 2 s/iteration is fine — so if MTP is free,
take it; do not build for it.

**Sampler-level repetition control.** Tempting given 170 L0 firings, and wrong. `repeat_last_n` defaults
to **64 tokens**, so the penalty cannot see a tool call repeated hundreds of tokens earlier — the exact
distance Argo's loops occur at. Setting `repeat_last_n: -1` (= `num_ctx`) with a raised `repeat_penalty`
across a 65 k window would penalise the token repetition that *correct code* is full of. **Verdict: no.
This also explains why the loop problem must be solved at the harness level** — a useful negative result,
because it forecloses a knob someone will otherwise reach for.

**A second model of any kind** — judge, draft, tool-shim interpreter, compression model. Out by the
stated constraints, and `OLLAMA_NUM_PARALLEL`'s documented behaviour makes the cost concrete: "Required
RAM will scale by `OLLAMA_NUM_PARALLEL` * `OLLAMA_CONTEXT_LENGTH`". Recorded once here so each idea above
does not have to re-litigate it. Note that Goose's tool shim and Aider's architect/editor split — two of
the most attractive patterns in the local-agent space — are both excluded by this, and their goals are
addressed here by §1 and §3 respectively.

**Vector/embedding codebase index.** Unchanged from `04` §2: chunking tears code apart, indexes decay
against a mutating repo, and it adds a service plus an embedding model
([Cline](https://cline.ghost.io/why-cline-doesnt-index-your-codebase-and-why-thats-a-good-thing/)). §2's
symbol map is deterministic and derived, and is not this. **Verdict: still no.**

**Raw GBNF grammars.** Would allow constraining a tool-call syntax exactly rather than via JSON schema.
Ollama does not expose it — the full env list and API surface contain no grammar parameter. **Verdict:
unavailable; do not design for it.**

**Multi-agent parallelism, in any form.** `dispatch.ts:7` is a ruling, and Anthropic's own 90.2 %
multi-agent result is attributed largely to spending more tokens in parallel with ~15× the token cost
([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system)). **Verdict: settled.**

---

## 14. Ranked shortlist

Ranked by expected value per unit of complexity, given what Argo has measured and what commander now
makes testable.

| # | Idea | Cost | Targets a failure we exhibit | Deletes something | Verdict |
|---|---|---|---|---|---|
| **1** | **§6 Prefix-cache measurement** | trivial (2 fields) | the unexplained 5–8× slowdown | no | **Do first.** Gates the cost side of H23, §2, §4, §8 |
| **2** | **§1 Schema-constrained control plane** (+ §7 `think:false`) | small | 3 of 22 no-keyword verdicts, 2 marker retries, 84/85 graphs, 4 fail-open parsers | **yes** — marker retry, 5 regexes | **Do second**, after the format+tools probe |
| **3** | **§3 Deterministic localisation from tests** | small | 27 % verify-fail→edit conversion; 4 of 22 impossible `verify` commands | **yes** — the model-supplied `verify` field | **Do third.** Newly possible: 2.0 s oracle |
| 4 | §4 Narrow the action space | trivial | **262 rejected calls; 67 of 102 role rejections followed by another** | yes — a guard | Highest raw failure count, smallest change |
| 5 | §2 Repo map (stage 1 only) | small | 64 266/65 536 peak; `command.js` = 38 % of the window | maybe — eviction's threshold path | Do on commander; do not build stage 2 first |
| 6 | §11 Hand-written `AGENTS.md` per workspace | ~zero | `ARGO_MEMORY` read path unreachable everywhere | no | Cheapest thing on the list; guard the eval-fairness precondition |
| 7 | §9 Forced grounding at assertion | small | grounding guard cannot fire on code at all; Boss hallucinated "All 9 tests pass" | maybe — the bounded-re-check upgrade | Fills a gap the existing guard structurally cannot |
| 8 | §5 Deterministic edit validation | trivial→small | 36 `old_string not found` errors | no | Measure the firing rate before building the `tsc` layer |
| 9 | §8 Composed tail block | small (scoped) | 4 context repairs, 1 measured purpose | potentially `eviction.ts`'s threshold path | Do the scoped version *with* H23, not separately |
| 10 | §12 `ollama ps` measurement | trivial | possible CPU offload behind the slowdown | no | One command per batch |
| — | §10 Never schema-wrap code | zero | — | — | A rule, not work. Write it next to §1 |

### Top three, and why in that order

**1. Measure the prefix cache (§6).** Two fields on an event. It is first not because it is the most
valuable but because it is the cheapest thing that changes other decisions: whether a pinned objective is
nearly free or a per-turn tax, whether a 1 500-token repo map is affordable, whether per-turn tool masking
is allowed at all, and possibly what the 5–8× slowdown is. Every one of those is currently guessed. There
is also a specific suspicion worth confirming or killing: collapsing old tool results **rewrites history
in place**, which would invalidate the cache from that point — meaning Argo's most-endorsed context
mechanism may be paying a hidden re-evaluation cost on every collapse.

**2. Schema-constrain the control plane (§1), with `think:false` (§7).** This is the largest structural
win available, because it converts a class of failure from "detected and retried" to "impossible". It
targets four separate fail-open parsers, one whole retry mechanism, and the specific weakness a small
model has most of — instruction-following fidelity on an output contract under load. It ranks second only
because of one unverified dependency: whether `format` composes with `tools`. **Run the probe in §1 §7
before anything else is scheduled** — it is one `curl`, and the design differs in all three outcomes.
The evidence also tells us exactly where the boundary is: Aider's 5-run data shows an open model losing
~9 points when code is forced through JSON, so this is a control-plane-only intervention, and §10 is the
rule that keeps it there.

**3. Deterministic localisation from the test oracle (§3).** Highest ceiling of the three, and it only
became practical yesterday: 1 373 tests in **2.0 seconds** means the harness can consult a perfect
localiser more cheaply than the model can think. It is also the purest instance of lever 3 — the work is
not hard, it is just not a small model's strength — and, unlike §1 and §6, it can *delete* a mechanism:
if the harness owns the test invocation, the model can no longer register a `verify` command that cannot
pass, which is 4 of 22 observed verify failures. It ranks third only because it needs a trap task (a fix
in a file no failing test imports) before it can be trusted, and because it does not apply to
feature-addition tasks at all.

**Why §4 is not in the top three despite the biggest number.** 262 rejected calls is Argo's largest
single failure population and the fix is one array literal — so on raw ratio it should win. It is fourth
because the fix is *already partly landed* (per-role `ROLE_TOOLS`, the new typed `FramePolicy`), the
remaining change is one tool removal whose main risk is that the Boss can no longer cheaply confirm a
`TRIVIAL` fix, and the failure it removes is wasted iterations rather than wrong answers. It should still
ship early — it is the cheapest item on the list after §11 — just not ahead of the three that change
what the harness can know.

---

## 15. The authorised recitation measurement — where exactly to put it

Gabriel authorised logging the final message's first 200 chars once per iteration, to establish whether
plan recitation reaches the outgoing prompt. Recommendation:

**Emit it from `chatCall`, immediately before the `return withTimeout(this.ollama.chat({...}))` at
`agent.ts:976`** — not from the recitation site at `agent.ts:824`. The point is to observe the array that
is actually sent, after every push, collapse and rewrite has happened. Logging at the construction site
would prove only that the code ran, which is already known from reading it.

**One scope detail, checked, because it changes the diff.** `chatCall` is declared
`private chatCall(systemPrompt: string)` (`agent.ts:913`) and has **neither `emitAndLog` nor the
iteration number in scope** — `emitAndLog` is a closure local to `chat()` (`agent.ts:1331`). But
`chatWithRetry` already takes it: `private async chatWithRetry(systemPrompt: string, emitAndLog: (e:
AgentEvent) => void)` (`agent.ts:1000`), and it is the only caller of `chatCall` (`agent.ts:1002,1008`).
So the minimal correct change is to thread it one level further and read the iteration from the existing
field:

```ts
// 1. agent.ts:913 — widen the signature
private chatCall(systemPrompt: string, emitAndLog: (e: AgentEvent) => void) { … }

// 2. agent.ts:1002 and :1008 — pass it through
return await this.chatCall(systemPrompt, emitAndLog)

// 3. agent.ts, immediately before `return withTimeout(this.ollama.chat({...}))`
const tail = messages[messages.length - 1]
emitAndLog({
  type: 'prompt_tail',
  iteration: this.lastIterationCount,          // agent.ts:413
  messageCount: messages.length,
  role: tail?.role ?? null,
  tail: String(tail?.content ?? '').slice(0, 200),
})

// 4. types.ts — add the variant to AgentEvent (types.ts:15) so the emit type-checks
```

Do not gate it behind a flag: it is 200 chars per turn into the session log, and a flag is one more thing
that can be off when someone looks.

Two additions worth making in the same commit, because they are nearly free and answer §6 and §12:

- Log `messages[0].role` and its first 60 chars **once per frame** (guard on `this.lastIterationCount === 1`)
  — confirms the prefix is what it should be, without 60 chars of noise per turn.
- On the **response** side, add `prompt_eval_cached_count`, `prompt_eval_count` and `load_duration` to the
  existing `token_usage` record. That is §6 in its entirety, and `metrics.mjs` can then derive a
  cache-hit rate per run with no further work.

What to look for: the last message should be the pinned-anchor/task-ledger block with the current step
marked. **Three failure modes this would expose**, all currently invisible: the tail is a tool result
rather than the recitation (the push is being overtaken); the tail is the recitation but with no step
marked (the ledger is empty); or the tail is the recitation twice (the duplication trap in
`interaction-matrix.md` M16 × M26). One line, and it settles "the #1 lever" either way.

---

## 16. Links

- Concept docs: `01` (context), `02` (decomposition), `03` (supervision), `04` (memory), `05` (loops),
  `06` (budgets), `07` (eval), `08` (communication), `interaction-matrix.md`.
- Hypotheses touched: **H23** (§6 prices the anchor; §8 composes it), **H24** (§12 — note the project's
  own next experiment makes the window *smaller*, deliberately), **H05** (§9 fills the gap the guard
  cannot reach), **H13** (§1 does *not* fix it — a schema guarantees shape, not arrival), **H15** (§11 is
  its safe form), **H25** (§11's natural home), **H19/H20** (§13 forecloses the sampler knob), **H01**
  (§7's prior).
- Roadmap: 2026-09-03 register **Item 0** (the events in §6 and §15 are its residue), **Item 8**
  (file-size discipline — §2 is the substantive version, and it should be validated on commander rather
  than justified from `bigproj`).
- New substrate: `/mnt/test/commander`, `eval-baseline`. Oracles: `node --test` (2.0 s),
  `tsc -p tsconfig.js.json` (JSDoc type-check of `lib/*.js`, `strict: true`), `tsd` + `tsc` over 1 900
  lines of typings, `eslint`, `prettier`.
