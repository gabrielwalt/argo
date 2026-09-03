# 10. The Hermes Differential

Hermes is a competing local coding agent, driving the same `qwen3.6` model via the
same local Ollama instance, on the same eval tasks. On `bigproj-observability` it
used 11 model calls / 237,196 input tokens and passed; Argo used 75 calls /
930,342 input tokens and failed. This document traces both trajectories end to
end, quotes both systems' prompts, and ranks the candidate explanations by what
the transcripts actually show — not by plausibility.

Sources: Hermes's SQLite dump at `scratch/hermes-diff/` (five full transcripts,
40 session headers with `system_prompt`/`model_config`); Argo's per-run JSONL
logs under `/mnt/argo-data/logs/{bigproj,commander}/`; the eval ledger at
`/mnt/argo-data/eval-runs/history.jsonl`; Argo's source in `src/`, read at
commit `d7544f4`. `src/` is a moving target — `loop.ts`/`agent.ts`/`config.ts`
(loop-guard work) and `dispatch.ts`/`frames.ts`/a new `schema.ts`
(control-plane work) are under active edit by other scoops as of this
writing — so source is quoted by function/constant name below, never by line
number, and no claim here depends on the exact current line count of any
file. The run-log evidence (§1) is unaffected by this: it is a record of what
already executed, not of the current source tree.

## 1. The trajectory diff

### 1.1 `bigproj-observability` — Hermes session `20260903_132523_ff558f` vs Argo run `2026-09-03T16-53-22..._bigproj-observability_r1`

The task: implement `exportTasksToCsv` in `src/export.js`, add `getAuditLog()`
and an optional `onEvent` hook to `TaskService` in `src/service.js`. The task
text is explicit: *"Three new failing tests are seeded at
test/export.test.js, test/audit-log.test.js, and test/event-hook.test.js — read
them first, then make the full suite pass."* `allowFiles` for scoring is
`src/export.js, src/service.js, src/store.js, MEMORY.md` — no test file is
meant to change.

**Hermes (single session, no sub-agents):**

| step | action |
|---|---|
| 1 | One turn, 3 parallel `read_file` calls: the three seeded test files |
| 2 | One turn, 3 parallel `read_file` calls: `service.js`, `export.js`, `test/helpers.js` |
| 3 | `write_file` on `export.js` (it was a one-line stub — a full rewrite is the correct move here) |
| 4–8 | 5 sequential `patch(mode=replace)` calls on `service.js`, one per method (constructor, `create`, `update`, `transition`, `remove`) — each `old_string` is an exact byte-for-byte slice of the file it had just read |
| 9 | one `terminal` call: `node --test` on the three seeded files — 8/8 pass |
| 10 | final answer, done |

11 model calls, 14 tool calls, 6 files read, 0 files read twice, 0 files
touched outside `allowFiles`. Score: 100, PASS.

**Argo (Boss → Planner → 2×Implementer → Tester, one dispatch run):**

| frame | role | model calls | tool calls | prompt tokens |
|---|---|---|---|---|
| `boss-mtlrkp1y-1` | task-start checkpoint | 4 | 7 | 17,464 |
| `planner-mtlrl70h-8` | initial plan | 8 | 12 | 28,919 |
| `planner-mtlrl70h-8` | plan-format retry | 1 | 0 | 5,435 |
| `implementer-mtlrm20r-15` | `export.js` | 10 | 6 | 45,642 |
| `tester-mtlrmlsg-20` | verify claim | 6 | 5 | 47,864 |
| `implementer-mtlrq168-25` | `service.js` (**heaviest**) | **46** | **45** | **785,018** |
| **total** | | **75** | **75** | **930,342** |

75 calls, 930,342 tokens, matches the anchor exactly. The heaviest frame is
61.3% of calls and 84.4% of tokens — matches the anchor's "61%/84%" figures
precisely (both independently recomputed from the raw JSONL, not taken on
faith). Peak context in that frame: 31,287 / 65,536 (47.7%). No
`compact_start`, `compaction`, or `eviction` event anywhere in the run.

Inside `implementer-mtlrq168-25` (tool-call composition: 20 `bash`, 10
`read_file`, 10 `edit_file`, 5 `write_file`):

1. Reads `service.js` (real content: `export class TaskService { constructor(store, idGen, clock) {...} _require(id) {...} create(input) {...} }`, 3,737 chars), `test/service.test.js`, `test/helpers.js`, `constants.js` — all whole, all correctly transcribed into context.
2. First mutation attempt: `edit_file` on `service.js` with an `old_string` that does **not** match anything just read — `export function createTaskService(opts = {}) { const clock = ...; const store = createStore(); ... }`, a function-factory-with-closures shape, invented from scratch. **Rejected** by the plan/act gate (`update_plan` not yet called) — the harness happens to catch this one for an unrelated reason before the string-mismatch would have caught it.
3. Calls `update_plan` (a reasonable 5-step decomposition).
4. Immediately writes a **whole-file replacement** of `service.js` with the same invented function-factory architecture — duplicating a `createStore()` inside `service.js` that already exists in `store.js`, importing functions (`validateCreate`, `validateUpdate`) that do not exist in `validation.js`. Also `write_file`s a fabricated `test/helpers.js`, and `edit_file`s a large invented block of new tests into `test/service.test.js`.
5. Runs `node --test` — fails. Reads `service.js` back (only now, after already destroying it), edits it further, reads `store.js`, edits again, reads `validation.js`, runs the test again — still broken, because the file no longer resembles the real module graph at all.
6. Recovers by shelling out to git: `git log --oneline -5`, `git show HEAD:src/service.js | head/tail`, then **`git checkout HEAD -- src/service.js`** — i.e. it detects its own damage and reverts to the pre-edit baseline using version control, inside a single agent frame, with no external signal telling it to do this.
7. Reads the restored real file, and *this time* reimplements it in place with the correct class-based shape (`_require`, `_logAction`, matching the constructor it read at step 1) — the same content it could have produced at step 2.
8. Spends the remaining ~20 calls on residual repair: a same-millisecond clock collision breaking an ordering assertion (fixed with an `advancingClock` helper), a `git stash`/`git stash pop` detour to compare behavior, and several read/tail/grep/edit cycles untangling a broken `describe`/`test` nesting left over from the step-4 blind edit into `test/service.test.js`.

The `bash` calls in this frame are almost entirely `node --test`
re-runs (repeated after nearly every edit) plus the git-recovery sequence —
not exploration.

**Why the run failed regardless of whether the code was eventually correct.**
The Planner's own task graph (see §3.1) instructed the Implementer: *"Add unit
tests to test/service.test.js."* The seeded spec files
(`test/audit-log.test.js`, `test/event-hook.test.js`) are written so that
**no test file needs to change at all** — `audit-log.test.js` uses the
existing, unmodified `makeService()` helper; `event-hook.test.js` constructs
the service directly via `createTaskService({ onEvent })`. Hermes, having
read the real seed files, touched only `src/export.js` and `src/service.js`.
Argo's Implementer, following the Planner's instruction, modified
`test/helpers.js` and `test/service.test.js` — both outside `allowFiles` and
both flagged by the eval's integrity gate:

```
"integrity: baseline-tracked test file CHANGED (M): test/helpers.js"
"integrity: baseline-tracked test file CHANGED (M): test/service.test.js"
```

`gatePassed: false` forces `runScore: 0` — independent of whether
`getAuditLog`/`onEvent` worked. Section 3.1 traces where that bad instruction
came from.

### 1.2 `commander-count-option` — corroborating pattern

Second full trace, different repository (commander.js), same model. Task:
add `Option.count()`. Raw text: *"A failing spec is seeded at
tests/eval-count-option.test.js. Read it first, then read lib/option.js and
the option-value handling in lib/command.js before changing anything. Do NOT
modify any existing test file."*

Argo: 69 model calls, 564,014 tokens, 6 frames. Heaviest frame
(`implementer-mtlvd8fv-8`): 32 calls (46%), 302,338 tokens (54%). Its full
tool-call sequence:

```
read_file lib/option.js
read_file lib/command.js
bash grep -n "handleOptionValue" lib/command.js
bash grep -n "isBoolean|defaultValue|_counted" lib/option.js
read_file lib/command.js
bash sed -n '670,750p' lib/command.js
bash sed -n '250,280p' lib/option.js
bash grep -n ... lib/option.js
bash grep -n ... lib/option.js
bash sed -n ...  (x2)
edit_file lib/option.js
bash sed -n '680,730p' lib/command.js
edit_file lib/command.js
bash node -e "<a hand-written, self-invented verification script>"
```

It never once reads `tests/eval-count-option.test.js` — the file the raw
instruction named explicitly. Instead it writes and runs its own ad hoc
verification snippet, concludes "All verifications passed!", and stops.
Scoring against the actual seeded spec: **4/10 targeted assertions pass**
(`correctness: 24/60`). `gatePassed: true` here (no test file was touched —
this task's implementation didn't require one) — the failure is pure
correctness, not an integrity violation, and it traces to the same upstream
cause as §1.1: the Implementer was never told the spec file existed.

This also directly answers the leading hypothesis (§5): the model, faced
with a 2,000+ line `lib/command.js` and no symbol tool, navigates it with
`grep -n` to find an anchor and `sed -n 'X,Yp'` to read a slice — a
self-invented, serviceable substitute for symbol lookup, obtained with
ordinary shell tools already in its tool belt.

### 1.3 Tool vocabulary, side by side

| | Argo (Implementer role) | Hermes (observed, across 5 sessions) |
|---|---|---|
| file read | `read_file` — whole file, silently truncated at 8,000 chars, no line numbers, no truncation flag returned to the model | `read_file` — whole file, numbered `N\|content` lines, returns `total_lines`, `file_size`, `truncated: bool` |
| file write | `write_file`, `edit_file` (exact-string replace, errors loudly on 0 or >1 matches, echoes the changed region with line numbers) | `write_file`, `patch(mode=replace, old_string, new_string)` — same exact-string-replace contract |
| shell | `bash` (no cwd prefix needed) | `terminal` |
| planning | `update_plan` (Implementer only; Planner/Tester/Boss deliberately do not hold it) | `todo` (used in one of five sessions; optional) |
| search/symbol | `web_search`, `fetch_url`, `browser_fetch` — **no grep/find/symbol tool distinct from `bash`** | `search_files`, `browser_navigate` — **no LSP/symbol tool used in any observed session**, despite `~/.hermes/lsp/` containing a working `typescript-language-server` install |
| navigation used in practice | `grep -n` / `sed -n 'X,Yp'` via `bash`, self-invented | none needed — files in the observed tasks were all small (<5 KB) |

Neither agent's model ever emits a symbol-navigation call. The tool
*vocabularies* are close to interchangeable in what actually gets used for
coding work; the visible difference is not there (§5.1).

## 2. Hermes's system prompt vs Argo's

**Hermes's system prompt** (15,879 chars, byte-identical across all 40
sessions in `sessions-recent.json`, including the anchor) is a generic
assistant/agent-platform prompt: identity, a large mandatory skill catalog
(apple/creative/devops/github/... — irrelevant to coding-agent work most of
the time), memory-management rules, mid-turn steering conventions, and one
task-relevant paragraph:

> "Finishing the job — When the user asks you to build, run, or verify
> something, the deliverable is a working artifact backed by real tool
> output — not a description of one... NEVER substitute plausible-looking
> fabricated output (made-up data, invented file contents, synthesised API
> responses) for results you couldn't actually produce."

There is **no coding-specific guidance** in it at all: no file-editing
convention, no "read before you write" rule, no plan-before-mutate gate, no
loop-detection language, no repository-layout advice. It does not mention
tests, verification workflow, or how to decide "done." Everything Hermes did
well on this task (read seed tests first, minimal diffs, run the targeted
tests, stop) came from the model following the literal user instructions in
an unbroken context — not from prompt engineering.

**Argo's system prompt** (the `SYSTEM_PROMPT` constant, ~1,900 chars base + a
role-specific suffix from `frames.ts`) is coding-specific and structured:

- Tool contracts (`bash` cwd convention, `edit_file`'s exact-match
  semantics, `update_plan` doesn't end the turn).
- An explicit workflow: *"Non-trivial work: read the relevant files first,
  then call update_plan with ONE concrete, verifiable objective... You
  cannot modify files under /workspace until a plan is recorded."* — a
  hard plan/act gate that Hermes has no equivalent of.
- *"Stay on the plan. Call update_plan again only when the work contradicts
  one of its assumptions. Rewriting the same thing many different ways with
  nothing forcing it is drift — stop and return to the plan."*
- *"Before finishing, verify the objective against the original request —
  run the relevant command or test — then give your final answer."*
- PRECISION: *"Never reconstruct an exact identifier, path, URL, flag, or
  package name from memory — copy it verbatim from the tool result where it
  appeared, or re-read the source."*

The Implementer role suffix (`frames.ts`) adds: *"If you cannot complete it
within reasonable effort, say so explicitly... do not grind indefinitely on
the same approach."*

The substantive difference is not tone or length — it is that **Argo
explicitly tells the model not to fabricate identifiers/content from
memory, and the transcript in §1.1 step 2 shows it doing exactly that
anyway** (inventing a function-factory `service.js` four messages after
reading the real class-based one). The instruction exists; a 61-iteration
frame later, the harness's own plan/act gate and loop-steer text (§3.2) are
still fighting the same failure mode with runtime nudges because the system
prompt's static instruction didn't prevent it. Hermes's prompt makes no such
promise and needed none, because in the one detailed case observed here its
model did not make the analogous mistake.

## 3. Ranked explanations

### 3.1 Lossy objective compression at the Boss task-start checkpoint — STRONGEST, mechanistic

**Mechanism.** `dispatch.ts`'s `runBossTaskStart` gives a Boss frame the
full raw user message verbatim (`The user asked: "${userMessage}"`) and asks
it to classify the request and end with one of `ANSWER:` / `TRIVIAL:` /
`SIMPLE:` / `OBJECTIVE: <concrete, verifiable objective>`. Only the text
after that marker survives — wherever `runDispatchLoopBody` persists the
task-start verdict's text via `ledger.setObjective` and re-emits it as the
`objective` event. From that point on, **every
downstream frame — Planner, every Implementer, every Tester, every Boss
standup/final checkpoint — receives only `objective`, never `userMessage`**
(the Planner-frame spawn inside `runDispatchLoopBody`: `assignment: `Objective: ${objective}
...``, and
seven more call sites, none of which reference `userMessage`). The raw
instruction is discarded exactly once, by construction, with no later
recovery path.

**Evidence it actually drops load-bearing content, twice:**

- `bigproj-observability` raw query: *"...Three new failing tests are seeded
  at test/export.test.js, test/audit-log.test.js, and test/event-hook.test.js
  — read them first, then make the full suite pass..."* → Boss's `objective`:
  *"...then verify all tests pass with `node --test`."* The seed-file
  pointer and the "read them first" instruction are both gone. The Planner,
  working only from the objective, invents `test/service.test.js` as the
  target for new tests — a plausible-sounding guess, and wrong. That
  instruction is what caused the integrity-gate violation in §1.1.

- `commander-count-option` raw query: *"...A failing spec is seeded at
  tests/eval-count-option.test.js. Read it first... Do NOT modify any
  existing test file..."* → Boss's `objective`: *"Add `Option.count()`
  method in lib/option.js that sets an internal `_counted` flag..."* — a
  technical implementation sketch (the Boss had itself read the source
  during classification and volunteered a design), with the seed-spec
  pointer and the "do not modify tests" constraint both dropped. The
  Implementer never reads the seed spec once in 32 calls (§1.2), invents
  its own verification, and ships against 4/10 of the actual targeted
  assertions.

- `commander-option-requires` raw query preserves four itemized technical
  requirements almost verbatim in the objective, but drops the same two
  clauses again — "a failing spec is seeded at
  tests/eval-option-requires.test.js. Read it first" and "Do NOT modify any
  existing test file." (This run then errored out for a separate reason
  before producing a scoreable diff, so it corroborates the compression
  pattern but not the downstream consequence.)

The compression is not uniformly destructive — it sometimes keeps the
concrete technical detail and drops the procedural instruction (as in
`commander-option-requires`, and in a fourth `add-effort-estimates` run
where the spec-file pointer survives but "read it first" and "without
weakening tests" do not) — but in every one of the four instances examined,
**something the eval rubric would grade on was silently discarded at this
one checkpoint**, and there is no mechanism anywhere downstream that could
recover it.

**Why Hermes cannot have this failure mode.** Hermes runs one continuous
session; the user's literal sentence, including the seed-file paths, stays
in context for the full run (message_count is 20-53 across the five
transcripts — nowhere near triggering Hermes's own 50%-context compression
threshold). There is no paraphrase checkpoint for it to be lost at. This is
the one claim in this document with an actual mechanism, not just a
correlation (see §4): Argo's architecture *has a place where information is
discarded by construction*; Hermes's does not.

**What Argo would have to change.** Simplest fix: stop discarding
`userMessage`. Thread it alongside `objective` into every downstream
assignment (`buildAssignment` in `frames.ts` already concatenates a
dependency summary with `req.assignment` — add the original user message as
a third, always-present, unconditional element, not just the Boss's
derived summary). This costs a few hundred extra tokens per frame and
removes the failure mode structurally, independent of model quality.
A cheaper partial fix: instruct the Boss's task-start prompt to preserve
file paths, filenames, and negative constraints ("do NOT...") verbatim in
its `OBJECTIVE:` line rather than paraphrasing them — lower cost, does not
fully close the gap (a paraphrase instruction can still be under-followed by
a small model under a 10-iteration budget).

### 3.2 Self-inflicted rewrite + weak-model grounding failure, amplified by a warn-only loop guard — confirmed once in detail, largest single cost driver in the anchor pair

**Mechanism.** In `implementer-mtlrq168-25` (§1.1), the model read the real,
correct `service.js` (class-based), then on its very next mutation attempt
produced a completely different, invented architecture (function-factory
with closures) that matches neither the file it just read nor any file in
the codebase. This is not a context-window problem (message_count was 11 at
that point, usage under 8%) — it is the model overriding demonstrably
correct, immediately-preceding tool output with what appears to be a strong
generic prior for how a JS "create*Service" factory "should" look. The same
model, given the same file, faithfully reproduced exact `old_string` slices
in the Hermes anchor session (§1.1) — so this is not a deterministic
property of qwen3.6 on this content; it happened once, on this sample, in
this run.

Argo's own harness caught and re-caught the resulting drift: 14 distinct
`warning` events fired inside this one 46-call frame, including four
"you have now called `X` 3 times in a row" no-progress steers and one
identical-call hard steer that re-injected the full plan text. All are
by-design **warn-only** — `agent.ts`'s loop-steer mechanism (`REPEAT_THRESHOLD`,
the no-progress detector guarding `callsSinceMutation`) skips the redundant call
and injects a stronger hint, but never blocks or ends the frame
(`hard_stop_enabled` is not a concept Argo's loop guard has at all; Hermes's
own `tool_loop_guardrails.hard_stop_enabled: false` shows the identical
design choice on Hermes's side — this is not the Argo/Hermes differentiator,
see §5). The model eventually self-recovered by shelling out to
`git checkout HEAD -- src/service.js` — an improvised, correct recovery that
the harness neither suggested nor needed to suggest, but that consumed
roughly the first 24 of 46 calls before real forward progress resumed, and
the remaining ~20 calls were spent untangling knock-on damage in
`test/service.test.js` from the same blind rewrite.

**What Argo would have to change.** Two independent levers, in order of
cost: (a) make the plan/act gate's *first* rejection do more than restate
"call update_plan" — when an `edit_file`/`write_file` targets a path the
agent read in this same frame, and the new content contradicts what was
read, that is detectable structurally (diff the proposed content against
the last `read_file` result for the same path) and could be rejected with a
concrete "this does not match what you read at message N" rather than
relying on the model to notice on its own; (b) give the no-progress steer a
real ceiling — e.g. after N no-progress warnings with no successful test
run, force a "state what's blocking you and either fix it in your next
single edit or return control" rather than letting the frame absorb up to
its full 60-iteration budget. Simplest version: lower `VERIFY_FAIL_ESCALATE`
and give it teeth (an actual escalation to Boss/Tester, not just harsher
wording) rather than adding a new mechanism.

### 3.3 One tool call per model turn, vs Hermes's routine batching — partial, cheap, real

Counting `tool_call` events between consecutive `iteration` events in
`implementer-mtlrq168-25`: 45 of 46 iterations carry exactly one tool call
(one carries zero — the final answer). This holds across the other Argo
frames inspected. Hermes's anchor session opens with two consecutive turns
of three parallel `read_file` calls each; its `3e1465` session batches seven
reads in one turn. Argo's harness code (where a response's `nativeCalls` are mapped into `callsToRun`) already maps
*all* of a response's native `tool_calls`, not just the first — nothing in
the harness prevents multi-call turns; the model itself, in every observed
Argo transcript, simply does not produce them.

This mechanically inflates Argo's *model-call* count relative to *tool-call*
count wherever the work is "read several independent files" — a real,
measurable, cheap-to-test contributor, but not close to sufficient on its
own: Hermes's own tool-call-to-model-call ratio in the anchor is only
14/11 ≈ 1.27, nowhere near the ~5-20x gap. **Strength: real, small, testable;
does not explain the FAIL vs PASS outcome, only some of the raw call-count
overhead.**

**What Argo would have to change, simplest version:** add one sentence to
`SYSTEM_PROMPT` — "If you need several independent pieces of information
(e.g. multiple files), request them together in the same turn rather than
one at a time" — and confirm empirically (not assumed) that qwen3.6 responds
to it under Argo's exact prompt/tool-schema framing, since it does so
unprompted under Hermes's.

### 3.4 `read_file` truncation/line-numbering gap — real tool-capability gap, not shown to have caused this failure

Argo's `read_file` (the `readFile` function in `tools/file-ops.ts`) returns the raw file content
truncated at 8,000 chars with **no signal to the model that truncation
occurred** and no line numbers. Hermes's `read_file` returns
`{content: "1|...\n2|...", total_lines, file_size, truncated}` — line numbers
make exact-region edits and reasoning about position easier, and the
`truncated` flag means the model can tell when it is working from a partial
view. In both traced failures, the files involved were small (under 5 KB)
and truncation never fired, so this gap is not implicated in either
observed failure. It plausibly matters on Argo's other, larger-file bigproj
tasks (`lib/command.js`-scale files noted in the brief) that were not part
of this analysis. **Strength: real and cheap to fix, unverified as a cause
of the two traced failures.**

### 3.5 Sampling parameters (temperature 0.8 / top_p 0.9 / top_k 40, pinned, vs unset) — unresolved, not testable from static logs

Argo's eval harness (`scripts/eval/e2e.mjs:126`) pins
`{temperature: 0.8, top_p: 0.9, top_k: 40, num_ctx: 65536}` on every request,
confirmed in every Argo JSONL's `__meta__.options`. Hermes's `model_config`
column (checked across all five detailed sessions) contains only
`{max_iterations, reasoning_config, max_tokens}` — no sampling overrides at
all, meaning Hermes takes whatever qwen3.6's Ollama-side/model-file default
is. We have no way, without executing anything, to learn what that default
actually resolves to for this model/Ollama build, or whether it differs
numerically from Argo's pinned values. **This is a genuine, confirmed
configuration difference; whether it produces a behaviorally different
sampling distribution is unknown and cannot be determined from logs alone.**
Recommended as a controlled experiment (rerun `bigproj-observability`'s
heaviest sub-task N times at each of a few temperature settings and compare
hallucination-into-invented-architecture rates) rather than claimed as a
finding.

## 4. "Hermes does X" vs "X is why Hermes wins"

Separating description from causal claim, as instructed:

| Hermes does X | Is X why Hermes wins? |
|---|---|
| Issues multiple tool calls per turn | **Partial cause.** Directly reduces model-call count for read-heavy turns (§3.3). Confirmed mechanism, small magnitude — does not touch correctness. |
| Runs as one continuous session, no Boss/Planner/Implementer split | **Cause, with a specific mechanism, not a vibe.** The failure traced in §3.1 requires a paraphrase checkpoint to exist; a single session has none, so it cannot lose the seed-file pointer the way Argo's Boss did. This is the one claim in this document backed by an actual causal chain (raw text present in Hermes's context at every step vs. verified absent from Argo's Implementer context) rather than correlation. |
| Reproduced `old_string` faithfully from content just read, in the one traced case | **Unverified generalization.** We have exactly one forward observation of Hermes editing this file; we did not observe Hermes attempt the isolated sub-task where Argo hallucinated, so we cannot rule out that Hermes would make the same mistake under the same narrow framing. Treat as "did not fail here," not "cannot fail this way." |
| Sets no sampling parameters | **Unresolved** (§3.5). Could matter, could be identical to Argo's in practice; no evidence either way. |
| Never calls an LSP/symbol tool | **Not a cause of anything** (§5.1) — the capability exists in its filesystem but was never invoked in five transcripts. |
| Has a shorter, generic (non-coding) system prompt | **Not shown to be causal.** Hermes's prompt does not instruct any of the behaviors that mattered (read tests first, minimal diffs, stop when done) — those came from the model following the user's literal, uncompressed words. Argo's prompt *does* instruct the relevant behaviors (verbatim-copy, no fabrication, stay on plan) and the model violated them anyway in the one detailed failure. The prompt text is not the differentiator; what each agent's *architecture* does to the user's original words before the model sees them is. |
| Has a `hard_stop_enabled: false` loop guard, same as Argo | **Not a differentiator at all** — both systems made the identical design choice (warn, don't block). |

## 5. Killed hypotheses

### 5.1 LSP / symbol-navigation gap — killed

Zero LSP or symbol-lookup tool calls appear in any of Hermes's five full
transcripts (`grep` over all `tool_name` values across
`msgs-*.json`: `read_file`, `patch`, `write_file`, `terminal`, `todo`,
`search_files`, `browser_navigate` — nothing symbol-shaped), despite a
working `typescript-language-server` install sitting in `~/.hermes/lsp/`.
Both agents edit via the same primitive (exact-string search/replace:
Hermes's `patch(mode=replace)`, Argo's `edit_file`) with no positional/symbol
addressing on either side. Where a file was genuinely large enough to
matter (commander's `lib/command.js`, §1.2), Argo's own model substituted
`grep -n` + `sed -n 'X,Yp'` via `bash` — a serviceable ad hoc symbol-lookup
replacement it invented on the spot, undermining the theory that the tool's
absence is what drives the call-count gap. **Kill this hypothesis outright.**

### 5.2 Context exhaustion / compaction degrading reasoning — killed (per given anchor facts, independently reconfirmed)

Peak context usage in the heaviest `bigproj-observability` frame was
31,287/65,536 tokens (47.7%), independently recomputed from the frame's own
`token_usage` events and cross-checked against the rendered `.md` trace's
`Context usage` lines (max observed: 48%). Zero `compact_start`,
`compaction`, or `eviction` events anywhere in any of the three anchor runs.
The failures happened at well under half the context window, using purely
warn-only loop steering. Whatever went wrong, it was not a resource-pressure
effect.

### 5.3 "`bigproj`'s 2,790-line `lib/command.js` overwhelms Argo with whole-file reads" — killed for this specific failure

`lib/command.js` is never read, written, or referenced anywhere in the
`bigproj-observability` run analyzed in §1.1 — the task's own `allowFiles`
(`src/export.js, src/service.js, src/store.js, MEMORY.md`) never includes
it, and grep across every JSONL in that run's family confirms it. The
"reads whole giant files" framing may hold for *other* recurring bigproj
tasks visible in the log directory (`implement-task-dependencies`,
`add-effort-estimates`, both of which recur many times across July and
September and plausibly do touch larger modules), but that is outside what
was examined here and should not be asserted from this analysis. For the
anchor task actually compared against Hermes, file size is a non-factor:
every file either agent touched was under 5 KB.

### 5.4 "Multi-agent framing gives thrash a per-frame budget to run away inside, and that's why Hermes (single-agent) doesn't thrash" — not supported; direction is backwards

The per-frame 60-iteration budget (`ROLE_MAX_ITERATIONS.implementer = 60`)
is numerically identical to Hermes's own single-session `max_turns: 60`.
Hermes's frame never approached that ceiling (max observed: 21 of 60,
§1.1's 3e1465 session) not because its budget structure is different, but
because it never entered the failure mode that would have needed the extra
turns. If Hermes's model had made the same hallucinated-rewrite mistake
under its own 60-turn cap, nothing in its config would have stopped it any
sooner than Argo's did. The multi-agent split is causally relevant (§3.1,
§4) — but through the objective-compression checkpoint it introduces, not
through frame budgets per se.

### 5.5 Different tool surface / vocabulary size — not a differentiator

Argo's Implementer role has 8 tools (`read_file, write_file, edit_file,
bash, fetch_url, web_search, browser_fetch, update_plan` — `ledger` makes 9);
Hermes's observed working set across five sessions is 7 distinct names
(`read_file, patch, terminal, write_file, todo, search_files,
browser_navigate`) out of a much larger nominal catalog it mostly does not
invoke for coding tasks. Neither the count nor the specific tools present
explain the gap; see §1.3.

## Summary of what would most change the outcome

In descending order of expected effect on the *specific* failures traced
here: (1) stop discarding the raw user message after Boss classification
(§3.1) — removes the mechanism that caused both the integrity-gate zero
score and the un-verified-against-spec correctness failure; (2) make the
plan/act gate check proposed content against just-read content, not just
"has a plan been recorded" (§3.2) — would have caught the hallucinated
rewrite at its first attempt instead of 20+ calls later; (3) prompt for
batched, multi-file tool calls in one turn (§3.3) — cheap, bounded upside.
Sampling parameters (§3.5) and `read_file` metadata (§3.4) are real
differences worth eventually closing but are not shown to have caused
either traced failure.
