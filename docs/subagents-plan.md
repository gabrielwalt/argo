# Multi-agent architecture: call frames, the ledger, structured eviction, and the Boss

Status (2026-09-02): DESIGN AGREED — this is a buildable spec, intended to be implemented
in one pass (v1 scope at the bottom), landed behind a single flag (`ARGO_AGENTS`, default
off) so the existing, already-validated single-loop path stays the default until this is
proven. Measured against the eval before it's trusted (same rule as everything else in
this project: `docs/roadmap.md`'s "reject any mechanism the eval doesn't show helps").

## Why

Three concrete gaps motivated this, confirmed against the actual code and current
research, not assumed:

1. **One shared context pollutes every role.** `src/agent.ts` keeps exactly one
   `this.history` per session; planning, implementing, and steering all share one growing
   list, so a plan's own reasoning gets buried under implementation noise by the time a
   long task finishes.
2. **Loop detection is mechanical, not semantic.** `src/loop.ts` catches *identical*
   repeated `(tool, args)` pairs (validated against a real 85-repeat run) but can't notice a
   model doing five *different*-looking things that have quietly drifted off the goal.
3. **Compaction (LLM summarization) is itself a hallucination source.** *"Summarization
   under length pressure is a known failure mode... compaction introduces novel errors into
   the context at the exact point where the agent has the least remaining budget to detect
   and correct them"* ([Morph](https://www.morphllm.com/compaction-vs-summarization)); one
   comparative study found LLM-summarized context specifically **underperforms** plain
   sliding-window context in small-model settings — Argo's exact regime. It's also slow
   (documented 180–300s timeouts on big histories) and fires often in practice.

## Hard constraints — settled, not open questions

- **No two LLM calls ever run concurrently, for any role, for any reason.** One GPU, one
  resident model (qwen3.6): there is no real parallelism to gain, only race conditions,
  ordering ambiguity, and GPU contention that slows everything down rather than speeding it
  up. This is an invariant, not a v1-only default — it rules out parallel Implementer
  frames, a parallel/async Boss, and (if ever built) parallel Researcher sub-topics.
  Everything here is one strictly sequential dispatch loop.
- **The harness owns bookkeeping; a model is never required to remember a scheduled
  self-report.** Standups, status transitions, and episode records are harness-derived from
  structured trace data, not produced by asking a model to pause on a timer.
- **The objective is immutable once set, and only the Boss writes it** — never the Planner,
  never a routine replanning round. Changing it is a distinct, loud, ledger-logged act.

## Roles

Every role reuses the same call-frame mechanism (own system prompt, own scoped tool set,
own starting context, own iteration budget) — not separate programs or separate loaded
models.

| Role | Job | Tools | Fires when |
|---|---|---|---|
| **Orchestrator** | **Not an LLM** — the harness's dispatch loop (below) | none, it's code | Always running; owns the ledger |
| **Planner** | Singleton, resumed not respawned. Turns the (Boss-authored, immutable) objective into a task graph; may leave parts open for a later round | `read_file`, `web_search`, `fetch_url`, `ledger`, `update_plan` | First dispatch, and every replanning round |
| **Implementer** | Does the actual work against one scoped, ideally testable goal; can give up with an explanation | full tool set | One per task-graph node (or `frameGroup`) |
| **Tester** | Runs after an Implementer concludes; verifies the specific claim; can resume the Implementer with a targeted follow-up or release it | `read_file`, `bash`, `ledger` — **no write/edit**, it directs fixes, never makes them | Every Implementer conclusion |
| **Boss** | Macro oversight across the whole run: authors the objective, periodic/triggered health checks, final verification | `read_file`, `bash`, `web_search`, `fetch_url`, `ledger` — **no write/edit** | See "The Boss" below — deliberately *not* on every frame conclusion |
| **Researcher** | Multi-source digging with per-claim source+confidence | — | **Deferred to v2**, see bottom |

### Resolved: the Orchestrator is not an agent

Almost everything "Orchestrator" would do is a state-machine transition over ledger events
("Tester released a failure → back to Planner," "Boss escalated → resume Planner with its
diagnosis") — `if`/`switch` logic over data the ledger already has, not judgment. Writing
it as code makes it free, instant, deterministic, and impossible to hallucinate — which
matters especially here, since this layer is responsible for noticing when things have
gone wrong. The one piece that looked like it needed judgment (is this question trivial or
does it need grounding/delegation) has a cheap heuristic first, falling through to the
Planner when the heuristic isn't confident — no dedicated persona needed. The real
separation that matters is *reasoning* (Planner, Boss) vs. *control-flow enforcement*
(harness) — different kinds of thing, not two AI personalities.

## Call frames — the core mechanism

```ts
type Role = 'planner' | 'implementer' | 'tester' | 'boss'

interface FrameSpawnRequest {
  role: Role
  parentFrameId: string | null      // null only for the Planner's first spawn
  assignment: string                // this frame's specific goal/prompt
  dependsOn?: string[]              // frameIds whose distilled output feeds this one
  maxIterations?: number            // per-role default if omitted
}

interface FrameResult {
  frameId: string
  status: 'success' | 'partial' | 'failed' | 'gave_up' | 'killed' | 'restarted'
  summary: string                   // hard-capped, e.g. 2000 chars
  filesTouched: string[]            // diff-derived, not self-reported
  filesWritten: string[]
  confidence?: number
  issues?: string[]
}
```

**Context construction — the concrete mechanism for "only relevant content is shared":**

```ts
function buildStartingContext(req: FrameSpawnRequest): Message[] {
  const pinned = renderPinnedAnchor()     // objective (immutable) + plan — always, in full
  const deps = (req.dependsOn ?? []).map(id => {
    const c = ledger.getConclusion(id)     // the SUMMARY, never the raw trail
    return { role: 'tool', content:
      `PRIOR WORK (frame ${id}, ${c.status}): ${truncate(c.summary, 500)}
       Files: ${c.filesWritten.join(', ') || 'none'}` }
  })
  return [systemPromptFor(req.role), pinned, ...deps, { role: 'user', content: req.assignment }]
}
```

A dependency contributes its capped summary + file pointers, never its raw episode graph.
If a frame later needs more, it calls `getFrameTrail(depFrameId)` itself — explicit,
on-demand, never automatic.

```ts
const ROLE_TOOLS: Record<Role, ToolName[]> = {
  planner:     ['read_file', 'web_search', 'fetch_url', 'ledger', 'update_plan'],
  implementer: ['read_file', 'write_file', 'edit_file', 'bash', 'fetch_url', 'web_search', 'ledger'],
  tester:      ['read_file', 'bash', 'ledger'],
  boss:        ['read_file', 'bash', 'web_search', 'fetch_url', 'ledger'],
}
```

Enforced the same way the tool executor already enforces everything else — a disallowed
call returns `{ output: '', error: 'tool not available in this role' }`, never throws.

### Unifying "cheap task" and "cross-cutting task" into one field

```ts
interface TaskStep {
  role: Role
  prompt: string
  dependsOn?: string[]
  frameGroup?: string   // steps sharing a frameGroup run in ONE frame, fed as sequential
                         // assignments; steps with no frameGroup each get their own frame
}
```

The Planner sets `frameGroup` either because a step is too cheap to warrant its own
Tester pass, or because it touches the same files/logic as another step and must not be
isolated (isolating cross-cutting work is a real, sourced failure mode — Cognition reports
**32.3% of observed multi-agent failures are inter-agent misalignment, failures that cannot
occur in a single-agent system**). Same field, either reason. Tester and Boss both operate
on the *frame*, once, regardless of how many steps were batched into it.

### Persistent vs. ephemeral

- **Persistent, resumed — the Planner only.** Never respawned fresh; a replanning round
  runs the eviction policy over its own history (below), then appends the new round as a
  follow-up turn, preserving its memory of the original reasoning.
- **Ephemeral — Implementer, Tester, each Boss firing.** Spawned, concluded, done. An
  Implementer's "done" is provisional until Tester releases it (frame freed) or resumes it
  with a targeted follow-up (same frame, no lost investigation) — never a fresh respawn for
  a retry within the same attempt.
- **Not a frame — the Orchestrator.** No LLM context, so no lifetime question applies.

## The dispatch loop — the Orchestrator, in full

```
bossCheckpoint('task-start')            # Boss reads the raw user message, grounds it,
                                          # writes the immutable `objective`
actionEpisodesSinceStandup = 0

while not all task-graph steps done:
  ready = steps whose dependsOn are all concluded, grouped by frameGroup
  if none ready: resume Planner with getFrameTrail of whatever's blocking; continue

  group  = pick next ready group
  frame  = spawnFrame(group) or resumeFrame(existing frameId, next step's prompt)
  result = runToConclusion(frame)         # loop.ts's repeat detector runs every tool call
                                            # inside this — see "Boss cadence" below for
                                            # what happens when it fires

  if frame.role == 'implementer':
    verdict = runTester(frame, result)
    if verdict.redo: resumeFrame(frame, verdict.followUp); continue
    result = verdict.release(result)

  actionEpisodesSinceStandup += result.actionEpisodeCount
  if actionEpisodesSinceStandup >= STANDUP_INTERVAL:
    bossVerdict = bossCheckpoint('standup'); actionEpisodesSinceStandup = 0
    applyBossVerdict(bossVerdict)           # none | inject | restart | escalate

  mark group's steps done with result
  if result.status in (failed, gave_up, killed):
    resumeFrame(plannerFrame, replanningPrompt(result))

finalVerdict = bossCheckpoint('final')
if finalVerdict.action == 'escalate':
  resumeFrame(plannerFrame, finalVerdict.guidance); continue     # loop back, don't return yet
else:
  returnToUser(finalAnswer)
```

No hidden state beyond this loop and the ledger it writes to.

## Context management: the pinned anchor, episode-graph eviction, the lossless ledger

`src/compaction.ts` (LLM-summarization, threshold-triggered) is **replaced**, not tuned,
following two implemented, published mechanisms:

- **CWL** ("Beyond Compaction: Structured Context Eviction," [arXiv:2606.11213](https://arxiv.org/abs/2606.11213),
  reference implementation [Kiz8-Team/pi-cwl](https://github.com/Kiz8-Team/pi-cwl)) — a
  deterministic, no-LLM eviction policy. Reported: 89 sequential tasks / 80M tokens, no
  accuracy degradation, plus **20–70% inference cost reduction** from better KV-cache/
  prefix stability (eviction is incremental, not a rewrite, so the prompt prefix stays
  stable turn-to-turn). Single-paper result (April 2026) — validate on Argo's own eval, not
  blind trust.
- **LCM** ("Lossless Context Management," [arXiv:2605.04050](https://arxiv.org/abs/2605.04050))
  — a summary/eviction must never be the only copy; every original stays retrievable.

**The pinned anchor**: `objective` (immutable, Boss-authored at `task-start`) + the current
execution plan (mutable, Planner-authored). Always present, recited at the tail, **never**
subject to eviction — small and structured by construction. This is a direct structural
fix for the original failure that motivated this project: the 90-iteration run that quietly
solved a different, more interesting problem than the one asked.

**The working history** — everything besides the anchor — is a graph of typed episodes,
mapped onto Argo's actual tools:
- **Exploratory**: `read_file`, `web_search`, `fetch_url`, `view_image`.
- **Action**: `write_file`, `edit_file`, a mutating `bash` call. Linked to the exploratory
  episodes it drew on via a **harness-inferred heuristic** (since the last action, or since
  frame start) — not a model-declared dependency (CWL's own design), because correctness
  must not depend on a local model remembering a bookkeeping step. An explicit `link()`
  override exists on the `ledger` tool but is never required — **deferred to v2** unless
  real usage shows the heuristic is wrong.
- **Eviction runs every turn**, deterministic, no LLM call: strips content in graduated
  levels (reasoning trace → bulk output → intermediate artifact → full removal), oldest
  *action* episodes first (their effect is already durably persisted), never evicting an
  exploratory episode while an action still in context depends on it.
- **Rare LLM fallback**: only if eviction alone can't free enough budget because everything
  left is still genuinely load-bearing — a deliberate, named exception (reusing
  `compaction.ts`'s structured-category + validation logic, scoped to just that slice),
  not the default response to a token threshold.

**Nothing evicted is gone** — every episode is a `episode` ledger entry (below), evicted or
not. `expand(episodeId)` on the `ledger` tool re-injects a specific evicted episode's full
original content on demand.

**Sub-agent hand-offs** use TDP's actual mechanism ([arXiv:2601.07577](https://arxiv.org/abs/2601.07577)):
a new frame's context is built from a predecessor's *"specification aggregated with
information retrieved from predecessor dependencies"* — the distilled conclusion, never the
raw episode graph (`buildStartingContext` above).

## The ledger

Append-only JSONL (`/workspace/.argo/ledger.jsonl`), not a database — this project's own
research already settled grep-able files over a database for a near-identical case; the
"friendly methods" below are plain JS functions filtering the parsed file. `.argo/` is
inside the workspace (visible, and reports can sit next to the code they concern) but
**gitignored by default** — the harness ensures the workspace's `.gitignore` has a `.argo/`
entry, appending it if missing. Promotion of anything from `.argo/` into the real project
is a deliberate, visible step, never automatic.

```
/workspace/.argo/
  ledger.jsonl          # the trail — source of truth
  work/<frameId>/       # a frame's own scratch output, auto-namespaced
  reports/<topic>/      # v2 — user-facing drafts, chapter files + an index
```

### Five entry shapes, tree-structured (`frameId` + `parentFrameId`)

- **`delegation`** — `{frameId, parentFrameId, from, to, prompt, contextGiven}`
- **`conclusion`** — `{frameId, status, summary, filesTouched, filesWritten, confidence?, issues?}`
- **`standup`** — `{frameId?, covered, summary, concern?}` — Boss's periodic macro check
  (action-episode-paced, not iteration-paced — see "The Boss")
- **`injection`** — `{targetFrameId, message, reason, injectedBy, expectsResponse?}` — every
  correction, including the Boss's `ask()`, logged the same way, no exceptions
- **`episode`** — `{frameId, episodeId, kind: exploratory|action, tool, argsSummary,
  dependsOn: [episodeId...], evictedAt?}` — written automatically per tool call, never
  deleted even once evicted from the live window

### The API — split by who's responsible for remembering

**Harness-automatic (no tool call, cannot be forgotten):** `delegation` entries (side effect
of spawning), `conclusion`'s mechanical fields (diff-derived `filesTouched`), `episode`
entries (per tool call), the action-episode counter that paces standups.

**Model-invoked, one multiplexed `ledger` tool:**
- `conclude(status, summary, confidence?)` — the frame's own judgment call, kept explicit
  because self-assessment is worth capturing in the model's own words.
- `getGoal()` — the immutable objective. `getAssignment()` — this frame's instructions.
- `getConclusion(frameId)` / `getFrameTrail(frameId)` — a summary vs. a specific frame's
  full story (delegation, standups, injections, kill/restart reason, conclusion).
- `getRecent(n)` — sliding window (Boss's standup input). `getPlan()` — the current,
  mutable plan.
- `expand(episodeId)` — pull an evicted episode's original content back into context.
- `ask(targetFrameId, question)` — Boss-only: inject a question, run the target frame one
  turn to answer it, return that answer.

## The Boss

**Deliberately not a single-shot call** — it needs to actually verify things (read files,
run checks, hit the web), so it's a bounded call frame like Tester, with `read_file`/
`bash`/`web_search`/`fetch_url`/`ledger` and no write access — it verifies, never fixes.

**Three checkpoints, one role** (extends `critic.ts`'s existing per-checkpoint prompt
pattern):
- **`task-start`** — before Planning runs. Grounds the raw user request against real
  files/web where non-obvious, and writes the immutable `objective`.
- **`standup`** — the macro check. **Not fired at every frame conclusion** (that's purely
  Tester's job, per Implementer). Two triggers instead:
  - **Paced by real work, not raw steps**: every ~10 *action* episodes across the whole
    task (tunable; start here, adjust from the eval) — ignoring cheap exploratory reads.
    Semantic drift accumulates over committed changes, not glances, so this paces the check
    to the failure mode's own timescale rather than a flat iteration count.
  - **`loop.ts`'s repeat detector, unchanged plumbing, changed response.** The cheap,
    proven, per-tool-call detection (rolling window, escalating severity count) keeps
    running exactly as it does today. What changes: hitting its threshold no longer injects
    loop.ts's own canned steer text — it fires a Boss standup instead, carrying the
    severity context in (this is the 3rd identical repeat; prior injections already
    failed). The Boss's judgment replaces the canned ladder; one source of "what to do
    about this," not two competing ones.
- **`final`** — before anything returns to the user. Independently verifies the objective
  was actually met (real state, not the chain's self-report). If unsatisfied, it doesn't
  fail the run — it resumes the Planner with what's missing, the *same* escalate action as
  a mid-run failure, just fired at the end instead of mid-run.

**Four possible actions, every checkpoint** (extends `critic.ts`'s `{verdict, guidance,
issues}` with `action`):
- **`none`** — healthy, continue.
- **`inject`** — a targeted correction into the running frame; it continues in place.
- **`restart`** — the current frame's live context ends (possibly poisoned/stuck), but a
  **new** frame immediately starts on the *same* task, with a prompt built from the old
  frame's conclusion (what it did, where it struggled) — a clean-context retry informed by
  the failed attempt, lighter than escalating; no replanning involved.
- **`escalate`** — return to the Planner for a real replan — the task itself looks wrong or
  too big as scoped, not just one bad attempt. Same action whether triggered mid-run or by
  a failed final verification.

**Verifying independently is the default; asking the agent is the fallback.** `ask()`
(above) is for what isn't independently checkable ("why this approach"), used only after
independent verification (reading files, running checks) couldn't resolve the question —
the whole point being not to rely on self-report where a real check is possible. This is
the trickiest single mechanic here (briefly interleaving two frames' turns, even though
nothing is truly concurrent) — deserves the heaviest test coverage of anything in v1.

## Tester

Unchanged from earlier design: fires on every Implementer conclusion specifically (not
Planner, not Boss checkpoints), verifies the specific claim, can resume with a targeted
follow-up or release (success or failure) back to the dispatch loop. No overlap with the
Boss now that the Boss doesn't fire per-frame — Tester is the zoomed-in gate, Boss is the
zoomed-out one.

## Known weaknesses and status

- **Resolved — weak model policing strong model's work.** The Boss is qwen3.6, same
  capability as what it reviews, now with real verification tools rather than just
  judgment — a stronger resolution than "use the same model" alone.
- **Resolved — Ollama multi-model residency/reload trap.** Never applicable; no second
  resident model was ever needed.
- **Resolved — KV-cache/prefix invalidation on every compaction.** CWL's incremental
  eviction is specifically reported to avoid this (the 20–70% cost reduction above).
- **Resolved — concurrency bugs from an async Boss.** Removed by the hard no-parallelism
  rule; nothing here is ever concurrent.
- **Still open — coordination overhead on mid-size tasks.** Measured multi-agent research
  reports coordination overhead that can *exceed* real work (a 4-agent pipeline: ~950ms
  overhead vs. ~500ms processing) and ~3x token cost vs. single-agent. Mitigated by
  `frameGroup` (skip full frame+Tester ceremony for cheap steps) but not eliminated —
  measure wall-clock and token cost on mid-size tasks specifically, not just success rate.
- **Still open — no eval capacity yet to exercise any of this.** The adversarial/vicious
  task set (looping, drift, cross-cutting conflicts) doesn't exist yet. Build it first, not
  after — building infrastructure faster than the ability to measure it violates this
  project's own rule.
- **Resolved — a malformed task-start response corrupted the whole pipeline downstream.**
  Real eval failure (2026-09, `sanity-pool`): the Boss's task-start checkpoint has `bash`
  (needed for legitimate read-only verification) and, on this run, used it to actually
  *fix the failing test itself* — writing the source file via a bash heredoc and running
  the suite to green — then reported that as free prose with no ANSWER/TRIVIAL/OBJECTIVE
  marker. `parseTaskStartVerdict`'s old fallback took the ENTIRE free-form completion
  report as the "objective" verbatim; the Planner, handed an objective that was actually a
  past-tense report of already-finished work, had nothing to plan and hallucinated an
  entire unrelated project structure (`src/solution.js`, `jest.config.js`, a web search
  for `site:/workspace ...`) trying to find something to do, burning all 15 iterations
  with no output. The graph fell back to a single trivial step, so the task still
  completed — but at 28 iterations / 6 frames / 95s for a fix that should have taken ~5.
  Two fixes: (1) `parseTaskStartVerdict`'s fallback now returns empty text on no marker
  found, so `runBossTaskStart` falls back to the ORIGINAL user message (always a valid
  objective by construction) instead of the Boss's possibly-nonsensical free text: (2)
  the task-start assignment now explicitly tells the Boss not to write/edit files at this
  checkpoint even via bash, and that "I could just fix this" is precisely the signal to
  answer TRIVIAL instead of doing it. Read-only bash (running the existing suite to see
  it fail) is still fine and expected. Not a hard tool restriction — same reasoning as the
  plan/act gate's own documented bash-bypass gap (`isProjectMutation`): bash is
  intentionally general-purpose, and the project's own stated principle is to fix a
  concrete failure mode with a real mechanism, not add a brittle command-parsing
  restriction pre-emptively. Worth remeasuring if it recurs.
- **Resolved (harness-level, after the prompt fix above proved insufficient) — the
  Boss fixing the file itself at task-start, again.** The prompt fix above was tried
  first and immediately re-failed on a DIFFERENT eval task (`race-semaphore`): the
  Boss again rewrote the source file via a bash heredoc during task-start, despite
  being explicitly told not to. This is exactly the lesson this project already
  states elsewhere ("fix a basic failure mode in the harness, not with more prompt
  text") — a prompt line cannot reliably stop a capable, over-eager model that has
  the tools to just do the thing. This particular instance compounded badly: the
  malformed non-classifying response triggered the OBJECTIVE fallback, spawning a
  full Planner→Implementer→Tester→standup→final chain to redo/re-verify work that
  was already correctly done, and the Implementer frame alone (re-discovering,
  re-fixing, then self-verifying the fix 20x in a loop for flakiness) took ~26
  minutes, compounding with Tester/standup/final's own from-scratch re-verification
  into a 30-minute TIMEOUT on a task the single-loop baseline solves in 13 iterations
  / 39s. **Real fix**: `runBossTaskStart` (dispatch.ts) now snapshots `git status
  --short` before and after the task-start frame runs. If the workspace is dirty
  afterward — an unambiguous, model-cooperation-free signal — the harness overrides
  whatever the Boss said with a new `'preempted'` mode: the single synthetic step is
  marked done immediately, owned by the Boss's own frameId (it did the real work,
  just under the wrong role), no Implementer/Tester/Planner frame ever spawns, and
  dispatch falls straight through to Jason's own independent final check — which
  still catches it if the unsanctioned fix was actually wrong. This is the same
  "detect via git diff, don't trust a text convention" pattern already used
  elsewhere in this project (autoCommit's own dirty-check). The prompt instruction
  stays (cheap, sometimes still prevents it happening at all) but is no longer the
  only line of defense.
- **Still open, now the central empirical question, not a hypothesis — the Planner has
  NEVER converged on a real task graph on a genuinely large task.** Overnight session
  (2026-09-03, folded into `docs/eval-log.md`'s overnight entry, Finding 7): across every large-task attempt this
  project has measured (`bigproj-deps` x2, `bigproj-effort` x2 — 4-for-4), Tiphys hit its
  iteration budget with zero JSON graph output every single time; the fail-open default
  (one big Implementer frame absorbs the whole objective) did 100% of the real work on
  every large task run so far. A real, separate confusing-advice bug was found and fixed
  (`src/agent.ts`'s stall-checkpoint was telling a stalled Planner to call `update_plan`
  — the Implementer/baseline's own task-ledger tool, unrelated to the Planner's actual
  job of emitting a task graph as its final text answer; `hasUpdatePlan` now requires
  `write_file` too, correctly excluding the Planner) — confirmed harmless but
  insufficient: the Planner still didn't converge after the fix. A budget increase
  (15→20 iterations, Finding 5) also didn't fix it. **Two budget-style fixes have now
  been tried and both failed to make the Planner converge — the next attempt should not
  be a third budget tweak; it likely needs either a fundamentally different output
  contract (the Planner's job — read a real codebase AND draft a structured plan AND
  format it as fenced JSON, all within one budget — may simply be asking too much of one
  frame) or a genuinely larger/more-tangled task than bigproj's 11 files/827 LOC ever
  provides, regardless of how hard the FEATURE being asked for is within it.**
- **Resolved — the Boss's OWN checkpoints (standup, final) could stall blank and be
  silently read as "nothing wrong."** Found immediately after the Finding-7 fix above,
  by the very re-run meant to confirm it (2026-09-03, folded into `docs/eval-log.md`'s
  overnight entry, Finding 8) — more severe than Finding 7's framing, since it's not "the Planner's decomposition
  is unproven," it's "a genuinely FAILING run can reach the user marked done." A real
  run: the Implementer honestly self-reported failure (3 of 6 new tests still red at its
  60-iter cap); an independent Tester frame verified this precisely, itemizing the exact
  3 root causes and concluding "the conclusion of failure is CORRECT" — the Tester did
  its job well. But both the Boss standup AND Boss final checkpoints then hit their OWN
  15-iteration caps with a completely empty answer (`"Reached maximum iterations (15)
  without a final answer."`, recorded `status:"success"`) — and `parseBossVerdict`'s
  fail-open default (`action:'none'`) cannot distinguish that from "the Boss reviewed
  the Tester's clear FAIL and had nothing to add," so the run proceeded as if everything
  were fine, with the Tester's correct FAIL verdict sitting unread. The deterministic
  `npm test` check is what actually caught this — not the harness, and only partially
  the quality judge (which scored the CODE's completeness at 9/10 without weighting the
  actual test outcome enough) — exactly why this project's eval design always runs the
  deterministic check first and treats the judge as a second, non-replacing signal.
  **Fix** (`runBoss`, dispatch.ts): after `spawnFrame`, compare
  `agent.getIterationCount()` against `ROLE_MAX_ITERATIONS.boss` — the SAME
  harness-level, model-independent idiom `runBossTaskStart`'s own `hitCap` check
  already uses (this file's task-start section above). A `'none'` verdict alongside a
  hit cap is overridden to `action:'escalate'`, forcing a replan/re-verify instead of
  silently passing through as "all clear." Both existing `'escalate'` handlers
  (`runStandup`'s branch, the final-verify loop) already do the right thing with no
  further wiring — this is a pure classification fix, the same shape as every other
  "fail-open must not mean invisible" fix in this project (Finding 4/5/6/7 above), just
  caught one checkpoint later in the pipeline than any prior instance, with no
  downstream safety net left to catch it if missed again. Confirmed via a live re-run
  (PASS, `orchestration_sane:true`) and the 11-task regression battery (11/11, 578s, no
  regression) — not yet confirmed against an ACTUAL stall recurrence, since the
  confirmation run happened not to stall; the fix's correctness rests on direct trace
  analysis of the original failing run plus reuse of an already-validated pattern, not
  on having caught a second live stall in the act.
- **New evidence (2026-09-03 overnight, Phase 6 comparative battery) — the first real
  case where multi-agent beats the pre-multi-agent baseline, though not via the Planner.**
  On `bigproj-deps` — the one task in this project's history hard enough to reliably
  break a lone frame — the plain single-loop baseline FAILED outright (60-iter cap, suite
  still red, 815s) while Argo's multi-agent harness PASSED (1616s) and so did Hermes
  (256s). The win comes from the harness's OTHER structural advantages (independent
  Tester verification, Boss checkpoints, the Finding-6 diff-size guard), not from
  Planner decomposition (still unproven per the finding above) — and it costs real time:
  multi-agent was 2-6x slower than Hermes on both large tasks measured. n=1; full numbers
  in `docs/eval-log.md`'s 2026-09-03 (overnight) entry.

## v1 scope

**Build all at once, cut hard to keep it debuggable:**

- **In v1**: Orchestrator (harness code), Planner, Implementer, Tester, Boss (all three
  checkpoints, all four actions, both standup triggers), the full ledger, CWL episode
  eviction + pinned anchor, `frameGroup`, strictly sequential dispatch.
- **Deferred to v2, cleanly separable**: the Researcher role entirely (map-reduce reading,
  source/confidence scoring, `.argo/reports/`, the grounding-guard extension to cover it),
  the `link()` dependency override.
- **Never** (not deferred — ruled out): any form of parallel LLM execution, for any role,
  ever (see "Hard constraints").
- **Rollout safeguard**: one new flag, `ARGO_AGENTS` (default off) — build scope is
  unaffected, but the existing validated single-loop path stays the default until this is
  proven, with a clean, instant escape hatch.

### File manifest

**New**: `src/frames.ts` (spawn/resume/context-build/`ROLE_TOOLS`), `src/ledger.ts` (five
entry types + JSONL + API), `src/eviction.ts` (episode typing + eviction pass + pinned
anchor).

**Modified**: `src/agent.ts` (the dispatch loop above; frame-runner extracted from the
existing loop), `src/critic.ts` (Tester's verdict shape + Boss's three checkpoint prompts +
the `action` field — reuse its existing JSON-coercion plumbing, don't write a second
parser), `src/tasks.ts` (`StepInput` → `TaskStep` with `role`/`dependsOn`/`frameGroup`),
`src/config.ts` (`ARGO_AGENTS` flag).

## Open questions carried forward

- The exact action-episode standup interval (start ~10, tune from real replanning-loop
  cases once the eval exists to test against).
- How aggressive the harness-default episode dependency-linking heuristic should be —
  tune against real frames.
- Whether `expand()` gets used often enough to matter, or whether the graduated eviction
  levels already cover most real need for it.
- Whether an `objective` revision (task-start Boss writing it, or the rare later change)
  should ever require more than a ledger log — e.g. surfacing to the user — given how
  load-bearing "immutable until deliberately changed" is to the whole design's anti-drift
  guarantee.
- Test coverage priority: the `ask()` interleaving mechanic is the most novel/fragile piece
  here and should get the heaviest testing before trusting it in the dispatch loop.
