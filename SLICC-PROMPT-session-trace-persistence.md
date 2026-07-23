# Prompt for Sliccy — finish session/trace persistence refactor

Paste the GLOBAL CONTEXT block once, then the TASK PROMPT below it, in Sliccy's terminal.

## GLOBAL CONTEXT (paste before the task prompt)

```
You are working on Argo, a local-first AI coding agent platform (Node.js/TypeScript). Read this
before doing anything else.

WHAT ARGO IS: A ReAct-loop coding agent that talks to a local Ollama server (model qwen3.6:latest).
Users attach a project folder as a "workspace"; a dedicated Docker container runs a worker process
that executes the agent loop against that folder, mounted at /workspace. All inference is local via
Ollama. A web UI streams the agent's thoughts/tool-calls/results live over SSE.

ARCHITECTURE (3 processes):
- Central server (src/central.ts, port 3000): workspace registry + Docker container lifecycle,
  proxies browser requests to the right worker container.
- Worker (src/server.ts): runs inside each workspace's container. Owns HTTP routes + the SSE event
  bus (`/events`) and the /chat endpoint driving the agent.
- Agent (src/agent.ts): the ReAct loop. One `chat(userMessage)` call = one "run", iterating up to
  config.maxIterations (default 1000): one Ollama call, then zero-or-more tool calls, appended to
  `this.history`. Ends on a no-tool-call final answer, an unrecoverable error, or user abort.

KEY FILES: src/agent.ts (loop), src/compaction.ts (context compaction), src/logger.ts (SessionLogger
— writes the per-run JSONL/MD logs), src/server.ts (routes + SSE), src/config.ts (env config),
src/tools/*.ts (tool implementations, each returns {output, error?} and never throws), public/app.js
(ALL frontend logic, ALL of it — one plain script tag, NO build step, NO TypeScript — a syntax error
here breaks the entire UI silently, with nothing catching it at build time), public/index.html,
public/styles.css.

RECENTLY LANDED (so you don't duplicate or conflict with this):
- A repetition guard in agent.ts's chat() loop: a rolling record of the last 6 executed
  (tool name + args) pairs; the 4th identical repeat is intercepted (warned, not re-executed); a
  second repeat after the warning ends the run cleanly via autoCommit. Constants REPEAT_WINDOW/
  REPEAT_THRESHOLD, helper repetitionKey().
- chatWithRetry in agent.ts: the per-iteration Ollama call (chatCall helper) gets exactly one
  automatic retry on any failure (timeout or thrown error), after a config.chatRetryDelayMs delay,
  emitting a warning event; a second failure propagates to the outer catch unchanged. Abort-aware
  (checks this.aborted during the wait).
- validateActiveSummary in compaction.ts: a second-pass LLM validation for summarizeActiveMiddle's
  output (which previously had none), checked against the authoritative CompactionState (not just its
  own source messages) so it can't reintroduce something the state already marked invalidated/
  superseded. Mirrors the existing validateCompactionState pattern.
None of the above should need to change for this task — just be aware they exist in agent.ts/
compaction.ts so you don't collide with them if your work touches nearby code.

A PRIOR ATTEMPT AT *THIS SPECIFIC TASK* (session/trace persistence) LEFT REAL CORRUPTION: a previous
agent run editing public/app.js produced a missing closing brace that silently merged two unrelated
functions into one (addSystemMessage's body swallowed the entire chat-submit handler), plus leftover
dead code from the old approach causing an unbalanced brace elsewhere. Both were only found by
actually running `node --check public/app.js` — nothing else caught it (no build step, no type
checker touches this file). RULE FOR THIS TASK: run `node --check public/app.js` after every single
edit to that file, not just at the end. Also: re-read the exact current lines you're about to change
immediately before editing — don't reuse a block remembered from earlier in your own context; a
stale remembered string silently no-ops or partially matches and corrupts structure exactly like this.

CONVENTIONS: no unnecessary abstractions; smallest correct change. No comments unless the WHY is
non-obvious. Tools in src/tools/ never throw. After changes meant for real testing: `pnpm build` then
`docker build -f docker/agent.Dockerfile -t argo:latest .` (neither happens automatically; `pnpm dev`
tsx-watch reflects source instantly for iterating, but isn't what real usage runs through). Add/update
tests for behavior changes (`pnpm test` — Node's built-in test runner via tsx, not Vitest/Jest). Update
CLAUDE.md/README.md if documented behavior changes.
```

## TASK PROMPT — Finish the structured-event session/trace persistence refactor

```
TASK: Audit and complete Argo's structured-event session/trace persistence refactor. A previous
attempt at this exact task crashed mid-way (a malformed-tool-call error from the model killed the
run at iteration 130) and a follow-up "continue" attempt looped without making progress and was
manually stopped. What was left behind is a partial, partially-broken implementation — some of it is
solid, some of it is dead/missing code. Your job is to make it actually work end-to-end, not start
over.

ORIGINAL GOAL (verbatim, from the request that started this work):

"""
Refactor of Argo's session/trace persistence to the lean structured-event architecture.
Core principle: the UI is a stupid rendering layer; canonical state lives outside it.

- Persist the existing structured AgentEvent stream incrementally to the existing per-run JSONL
  logs while the agent is running.
- JSONL is the canonical trace source; SSE is only live delivery.
- Historical and missed events must be reconstructable from persisted events, including thoughts,
  tool calls/results, compaction, messages, etc.
- The UI should render persisted and live events through the same conversation/trace rendering path
  where practical, while keeping live-only UI state separate.
- Preserve correct ordering across multiple runs in one session.
- Ensure switching sessions/workspaces or reloading loses no events, even while another workspace's
  agent continues running with no UI connected.
- Handle the persisted-replay/SSE boundary without gaps or duplicates, using the smallest mechanism
  necessary.
- Remove the superseded DOM persistence architecture completely: persisted HTML, /api/dom,
  .argo/dom, DOM caches, debounce saves, sessionStorage trace recovery, and related sync logic.
"""

CONFIRMED CURRENT STATE (verify this yourself too, don't just trust this list — but it's a starting
point so you don't waste time re-discovering it):
- LIKELY WORKING: src/logger.ts's SessionLogger already assigns a monotonic `seq` to each event and
  appends incrementally to the run's .jsonl file as events happen (not just at flush/completion).
  src/server.ts has a `GET /logs/:filename` route. DOM-snapshot code (sessionDOMMap, liveDOMCache,
  restoreLiveDOM, saveSessionDOM, /api/dom, .argo/dom) appears fully removed from src/ and public/ —
  confirm this with a full grep, don't assume.
- CONFIRMED BROKEN: public/app.js calls a function `handleEventForSession(event)` in three places
  (inside `viewSession`, `returnToCurrentSession`, and the live-session-reload path) — this function
  is never defined anywhere in the file. Every call site will throw `ReferenceError` at runtime. This
  needs a real implementation: almost certainly it should be the shared rendering logic factored out
  of the existing `handleEvent(event)` function (which currently handles ONLY the live-SSE path and
  contains past-session-viewing special cases that don't belong in a replay-only path — read
  `handleEvent` fully first to decide what's actually shared vs. live-only before extracting).
- CONFIRMED INCOMPLETE: `pendingEvents` (module-level array near the top of app.js) is declared and
  cleared (`.length = 0`) in a couple of places but never pushed to — the mechanism for buffering
  live SSE events that arrive while a persisted-events fetch is in flight (the actual "replay/SSE
  boundary without gaps or duplicates" requirement) does not exist yet. `eventSeqs` (a Set of seen
  seq numbers) IS populated and could be the right foundation for dedup, but nothing currently uses
  it to filter live SSE events against already-replayed ones.
- STALE COMMENT: `handleEvent`'s viewingSession-suppression branch has a comment claiming "The live
  session's DOM is preserved by save-on-switch and the debounce timer" — this refers to the removed
  DOM mechanism and is simply wrong now; fix or remove it once you understand what actually preserves
  state in the current design (it may be nothing, if JSONL replay now serves this purpose — in which
  case say so in the comment instead).

WHAT TO DO:
1. Read src/logger.ts, src/server.ts (routes touching /logs and /events), src/types.ts (AgentEvent
   shape), and public/app.js FULLY (it's one file, all frontend logic lives there) before changing
   anything. Confirm or correct the "confirmed" list above with your own findings.
2. Design and implement the missing piece: a real `handleEventForSession` (or equivalent, naming is
   your call) that renders a persisted/replayed event through the same visual path as live rendering,
   without the live-only special cases (status bar updates, etc. — check which parts of `handleEvent`
   are genuinely live-only vs. shared rendering that both paths need).
3. Implement the actual replay/SSE boundary mechanism: when switching into the live view (or on
   initial page load), fetch persisted events for the current session, render them via the replay
   path, and ensure any live SSE events that arrived during that fetch are neither dropped nor
   rendered twice — use `eventSeqs` (already populated) to dedupe, and decide whether `pendingEvents`
   is actually needed for this or was dead scaffolding from the previous incomplete attempt (if
   unneeded, remove it — don't leave unused state lying around).
4. Verify ordering across multiple runs within one session (the JSONL per-run files need to be read
   and merged in the right order — check how `GET /logs/:filename` currently identifies which file(s)
   belong to a session, and whether multi-run ordering is handled server-side or client-side).
5. Confirm end-to-end: an active run's events are visible in real time; reloading the page mid-run
   shows everything so far with no gaps or dupes; switching to a past session and back to "now" shows
   the correct thing each time; a workspace with no UI connected still has its agent's events fully
   persisted (this should already work if logger.ts's incremental append is solid — just confirm, it's
   backend-only and shouldn't need UI changes).
6. Re-confirm the DOM-removal requirement is actually complete (full grep, not assumption).

VERIFICATION: run `node --check public/app.js` after every edit to that file (see the corruption
warning in the global context above — this is not optional, it's the only thing that will catch a
break here). You likely cannot run `pnpm test`/`pnpm build`/`docker build` in your sandbox (no pnpm/
tsx/docker there) — say so clearly and list exactly what needs to be run on the host, same as your
last two tasks. Also flag explicitly, in your summary, any part of the original spec you could not
verify without a live browser (e.g. actual multi-tab/reload testing) so the host knows what still
needs manual verification.
```
