# Reliability pass 2 — findings from live re-testing

**Status: temporary working plan for another Claude Code instance to execute, one phase at a time, in order.** Delete this file (or fold anything still relevant into `CLAUDE.md`/`README.md`) once every phase below is done and verified.

## Context

`RELIABILITY-PLAN.md` (the previous pass — model/iteration defaults, tail-preserving truncation, file-viewer alignment, `REASONING` system-prompt section, `autoCommit` reliability, manual compaction trigger, full-conversation logging, `/workspace`-only filesystem model) has already been fully implemented and deleted. This document is the *next* round, based on live re-runs of the `task-cli` benchmark (`~/Sources/test/test-one`) against `qwen3.6:latest`, using the already-fixed harness. Findings below are grounded in the actual session logs:
- `~/.local/share/argo/logs/test-one/2026-07-21T16-59-47_inspect-the-repository-and-tell-me-what.{jsonl,md}`
- `~/.local/share/argo/logs/test-one/2026-07-21T17-35-06_inspect-the-readme-and-package-configura.{jsonl,md}`
- `~/.local/share/argo/logs/test-one/2026-07-21T17-40-56_trace-the-complete-execution-flow-for-de.{jsonl,md}` — surfaced the deterministic bug in Phase 2.
- `~/.local/share/argo/logs/test-one/2026-07-21T17-58-25_analyse-nextid-mathematically-and-de.{jsonl,md}` — a long turn (9.3 minutes, 6 iterations, 87 messages by the end) that finally exercised compaction for real and surfaced Phase 1, the most severe finding in this document.

Read those logs directly before making changes if you need more detail than is quoted here. Be token-efficient: read only the files named below, make the targeted change, don't refactor around it.

## Confirmed already working (context only — nothing to do here)

Verified directly against source and against the three new live logs, not assumed:
- `maxIterations` is live-adjustable (UI slider, `Agent.setMaxIterations`), defaults are `qwen3.6:latest` / `1000`.
- `SYSTEM_PROMPT` has the `REASONING` section (concurrency/regression/reporting-precision).
- `autoCommit()` (`src/agent.ts:463`) verifies HEAD actually changed before emitting `git_commit`, bases the message on `git diff --cached --stat`, has a non-LLM fallback message, and routes its own `bash` calls through `tracedBash` so they appear in the trace. When there *is* a real diff, this works correctly — real commits, accurate messages, all steps visible. (Its behavior on a *clean* workspace is not fine — see Phase 2.)
- `logger.ts`'s `toMarkdown()` now has a case for every `AgentEvent` type. Cross-checked: the first new log has 59 raw JSONL events across 11 distinct types (`start`, `iteration`, `ollama_request`, `token_usage`, `thought`, `tool_call`, `tool_result`, `message`, `git_commit`, `done`, plus `__meta__`), and the rendered `.md` accounts for all of them. Logging is genuinely complete now, not just in unit tests.
- The `/workspace`-only filesystem model landed: no `SCRATCH_BASE`/scratch mount left in `src/central.ts`, `docker/agent.Dockerfile`'s runtime `WORKDIR` is `/workspace`.

Compaction did eventually get exercised for real (see Phase 1) — the `compact_start`/`compact` event pair fires correctly and the resulting `CompactionState` summary is accurate (checked its content against the actual prior turns; no hallucination). The mechanism itself works. Getting there reliably, quickly, without repeated failures, does not — that's Phase 1.

## Explicitly NOT a bug — do not "fix" this

The second log (`2026-07-21T17-35-06...`) shows `autoCommit` sweeping up a `.gitignore` file the *user* had created by hand alongside the agent's own `data/tasks.json` write, into one commit: `95bbbc5 Agent: Update .gitignore and data/tasks.json`. This looks at first glance like `autoCommit` misattributing someone else's change to the agent. **It is intentional and accepted.** The project owner has explicitly confirmed that `autoCommit` capturing whatever is dirty in `/workspace` — regardless of whether the agent's own tool calls produced it or a human edited files between turns — is acceptable behavior for this project, since `/workspace` is a single shared, git-tracked working tree. Do not add logic to gate `autoCommit` on "did the agent's own tool calls write anything this turn" — that was considered and rejected.

## Phase 1 — compaction thrashes: 3 failed retries burned ~7 of a 9.3-minute turn (top priority — this is the one that prompted this document)

**Finding:** `2026-07-21T17-58-25_analyse-nextid-mathematically-and-de.jsonl` is a single user turn that took 557201ms (9.3 minutes) and 6 iterations. Compaction was triggered 4 separate times within it, as context usage climbed:

| Time (UTC) | Event | messageCount | contextUsagePct | Outcome |
|---|---|---|---|---|
| 18:00:04 | `compact_start` | 81 | 68.7% | |
| 18:01:04 | `warning` | | | **"Context compaction failed (Ollama did not respond within 60s)"** |
| 18:01:49 | `compact_start` | 83 | 87.4% | |
| 18:02:49 | `warning` | | | same 60s timeout failure |
| 18:03:07 | `compact_start` | 85 | 92.8% | |
| 18:05:01 | `warning` | | | same failure (this attempt ran ~114s — two chained 60s sub-calls) |
| 18:05:16 | `compact_start` | 87 | 96.5% | |
| 18:06:43 | `compact` | | | **succeeded** — folded 75 prior messages down to 13 |
| 18:07:17 | `done` | | | final answer |

So roughly 7 of the turn's 9.3 minutes were spent on 3 failed compaction attempts before the 4th succeeded — and each failure let the main loop keep running normally in between, adding more messages and pushing `contextUsagePct` *up* (68.7% → 96.5%) rather than down, right up to the edge of `num_ctx`. One more failure and the very next plain chat call (not just compaction) risked overflowing the context window outright. This is a real near-miss, not a hypothetical one.

**Root cause:** `updateCompactionState`/`validateCompactionState`/`summarizeActiveMiddle` (`src/compaction.ts`, called from `compactHistory` in `src/agent.ts`) are each wrapped in `withTimeout(..., 60_000)`. The *ordinary* per-iteration chat call in the same file (`src/agent.ts:334`) gets `withTimeout(..., 120_000)` — double. But compaction calls are specifically invoked when history has grown large (that's the trigger condition), so they typically have to process *more* prompt content than a normal iteration, not less. On a local, GPU-bound 23GB model (`qwen3.6:latest`), summarizing a large "prior" segment reliably takes longer than 60s once context is already deep into the window — exactly the regime compaction exists to handle. The timeout is tightest exactly when the content is largest.

**Fix:**
1. Raise the compaction sub-call timeouts in `src/compaction.ts` to at least match the main chat call's 120s — 150–180s is more defensible given they may need to process more content, not less. Don't guess a single "right" number from first principles; if there's a cheap way to make it configurable (env var, matching the `COMPACT_THRESHOLD`/`COMPACT_GENERATION_RESERVE` pattern already in `src/config.ts`), prefer that over a new hardcoded constant.
2. Consider whether a failed compaction attempt should block the *next* normal iteration from running before retrying compaction, instead of letting the loop add more history first — right now, failure lets the problem get strictly worse before the next attempt. At minimum, this deserves a comment explaining the tradeoff if you decide not to change it.
3. Don't touch `compactHistory`'s core logic (`splitForCompaction`, the verbatim-survival guarantees) — those aren't implicated here, this is purely a timeout/retry-pacing issue.

**Verify:** re-run the same benchmark turn (or any turn that pushes context usage into compaction range) and confirm compaction succeeds on the first attempt, or at least confirm the timeout increase measurably reduces retries in a live log — don't just trust the unit tests, this specific failure mode only shows up under real model latency.

## Phase 2 — autoCommit burns an Ollama call and a doomed commit on every clean-workspace turn (deterministic bug)

**Finding:** in the third log (`2026-07-21T17-40-56_trace-the-complete-execution-flow-for-de.md`), the turn made zero filesystem changes (pure analysis, no `bash` writes). `autoCommit` ran anyway and got all the way to attempting a real commit:

```
git status --porcelain  →  (no output)      ← workspace is clean
git rev-parse HEAD      →  95bbbc5c73...
git add -A              →  (no output)
git diff --cached --stat → (no output)
[~20s Ollama call generates: "Agent: Fix bug in core module" — a fabricated message, since there was no diff to summarize]
git commit -m 'Agent: Fix bug in core module'  →  ERROR: "nothing to commit, working tree clean"
git rev-parse HEAD      →  95bbbc5c73...  (unchanged — no git_commit event emitted, so no *visible* damage)
```

No incorrect commit reached the user (the HEAD-equality check at the end correctly suppressed the `git_commit` event), but this wastes a real ~20s Ollama round-trip and a doomed `git commit` attempt on **every single turn where the agent made no changes** — which, for a lot of real usage (analysis, tracing, Q&A), is most turns.

**Root cause, confirmed by reading source, not guessed:** `src/tools/bash.ts:37` — `return { output: output || '(no output)' }`. When a command produces genuinely empty stdout, `bash()` returns the literal string `'(no output)'`, not `''`. This is intentional (both the UI and the model itself read `result.output` and benefit from an explicit marker instead of blank text — see `src/agent.ts:412`, where the same `result.output` is fed straight into the model's tool-result message). But `autoCommit()`'s clean-check at `src/agent.ts:468` —

```ts
const checkResult = await this.tracedBash('git status --porcelain 2>/dev/null', emitAndLog)
if (checkResult.error || !checkResult.output.trim()) return
```

— assumes a clean status comes back as `''`. It never does: it comes back as `'(no output)'`, which is truthy after `.trim()`, so the early return never fires and the rest of the function runs unconditionally.

**Why the existing tests didn't catch this:** `src/agent.test.ts`'s `parseChangedFiles returns an empty list for clean/blank status` test (line 24) only exercises `parseChangedFiles('')` and `parseChangedFiles('\n  \n')` — genuine blank strings — never the actual sentinel `bash()` produces in production. The test suite was checking a case that doesn't occur in reality.

**Fix (smallest robust change — don't touch `bash.ts`'s contract, other callers and the model rely on the current sentinel behavior):** in `src/agent.ts`, treat the sentinel as equivalent to empty in `autoCommit`'s clean-check:

```ts
if (checkResult.error || !checkResult.output.trim() || checkResult.output.trim() === '(no output)') return
```

Better: export the sentinel as a named constant from `src/tools/bash.ts` (e.g. `NO_OUTPUT = '(no output)'`) and import it in both places, so the string isn't duplicated/hardcoded in two files.

**Add a regression test** to `src/agent.test.ts` right next to the existing `parseChangedFiles`/`buildFallbackCommitMessage` tests: assert that `autoCommit` (or whatever the clean-check is refactored into, if you extract it into its own exported function to make it testable) treats `'(no output)'` the same as `''`. This is fully deterministic — no live Ollama needed, unlike Phase 3 below.

## Phase 3 — SYSTEM_PROMPT: explicit constraints must beat implied actions

**Finding:** given the identical prompt *"...then run the application's test suite and perform one simple CLI operation. Report exactly what you ran... **Do not modify any files.**"*, two different runs of this same benchmark disagreed:
- The original reference run (`~/Sources/test/test-one/run-1.md`, turn 2) chose only `node src/index.js list` — read-only, correctly honoring "Do not modify any files."
- The new post-fix run (`2026-07-21T17-35-06_inspect-the-readme-and-package-configura.md`, iteration 3) additionally ran `node src/index.js add "Verify test results" 2>&1` — a real write to `data/tasks.json` — directly violating the same explicit constraint in the same message. This got persisted and auto-committed.

This is a genuine instruction-following regression, not a harness/plumbing bug: the model had a legitimate non-mutating option (`list`) available and satisfied "perform one simple CLI operation" with a mutating one instead, without noticing the conflict with "do not modify any files" stated in the same prompt.

**Fix:** add a short, explicit rule to `SYSTEM_PROMPT` (`src/agent.ts`) — either as a new short section or appended to `REASONING` — along these lines:

```
When the user states an explicit constraint (e.g. "do not modify any files," "read-only," "do not commit"), it overrides any other part of the same request that could imply a conflicting action. If a task could be satisfied by either a mutating or a non-mutating action, choose the non-mutating one. If no non-mutating option exists, say so explicitly instead of proceeding anyway.
```

Keep it short — one paragraph, matching the terse style of the existing `REASONING`/`PRECISION` sections.

**Optional verification** (skip if it adds meaningful scope): `test/agent.test.ts` already has a pattern for live-Ollama-gated tests (see how `compaction.test.ts` gates 5 of its tests). If a similarly-gated test is cheap to add here, add one that sends a prompt combining an action request with an explicit "do not modify any files" constraint and asserts no write-capable `bash`/`write_file` tool call occurred. Don't build new test infrastructure for this — only add it if it fits the existing gated-test pattern with a couple of lines.

## Phase 4 — clarify commit-message attribution in docs (small, low priority)

Since `autoCommit` messages are generated from the accumulated `/workspace` diff (see "Explicitly NOT a bug" above), an `Agent: ...` commit message can describe changes the agent didn't make (e.g. a file a human added between turns). Add one clarifying sentence to `README.md` (wherever `autoCommit`/auto-commit behavior is documented) stating that commit messages summarize the diff at commit time, not a strict authorship guarantee. Purely a documentation fix — no code change.

## Phase 5 — verify the git-log panel's expand/diff view (carried over, never completed)

This item was requested in an earlier session but never got written into `RELIABILITY-PLAN.md` before that file was implemented and deleted, so it's still outstanding.

Static read of `public/app.js:530-605` (`refreshGitLog`, `makeCommitEntry`, `showDiff`) and the corresponding CSS in `public/styles.css` (`#git-log.open`, `.git-toggle-btn`) shows no obvious bug — the toggle button is created when `commits.length > 1`, toggles the `.open` class which expands `#git-log`'s `max-height`, and each commit row wires a `diff` button to `showDiff(hash)` which fetches `GET /git-diff/:hash`. This may already work; the earlier "seems to not work currently" report was never confirmed against a real UI.

**Action:** verify live in a browser rather than trust the static read. `~/Sources/test/test-one` currently has exactly two real commits (`14044d2`, `95bbbc5`), which is enough to exercise both the "latest commit" row and the "▼ 1 older" toggle + diff modal in one workspace — use it as the test fixture rather than creating a new one. If a real bug reproduces, root-cause it against the `GET /git-log` and `GET /git-diff/:hash` handlers in `src/server.ts` (not yet inspected in this pass).

## Reporting

Do each phase fully (including its own quick verification) before starting the next. After each phase, report in 2-3 sentences what changed and how you verified it. At the end, give one combined summary and confirm the existing test suite still passes in full.
