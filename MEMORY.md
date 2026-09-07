# MEMORY.md — Persistent learnings for future sessions

## Bash/JS integration gotcha
- `${}` in bash heredocs triggers variable substitution even with quoted delimiters → causes EOF/syntax errors. Use **Python** (`python3 -c`) or escape `\$` when embedding JS template literals in shell scripts.

## Codebase notes
- Single-file vanilla JS app: `public/app.js` + `public/index.html`. No build step.
- Uses native `fetch()` and SSE for real-time updates. API base via `API_BASE` constant (set at top of app.js).
- Server files are in `src/` (TypeScript, compiled to `dist/`). Source is the authoritative target — never modify `dist/` directly.
- Docker image (`docker/agent.Dockerfile`): keep the download-heavy, code-independent layers (apt, Node, sandbox npm packages, Chromium) ABOVE the app `COPY --from=builder`/`COPY public` layers. Docker's cache is linear, so if an app COPY (which changes every build) sits before those, every code rebuild re-downloads Chromium etc. `argo rebuild` reuses the layer cache and passes `--build-arg CACHE_WEEK=$(( $(date +%s)/604800 ))`, referenced in the first download layer, so downloads refresh at most weekly; `argo rebuild --fresh` forces a full `--no-cache --pull` rebuild.

---

## Architecture: Structured Event Stream Persistence

### Core Principle
**The UI is a stupid rendering layer; canonical state lives outside it.** The browser DOM is only a view. All conversation and trace history must be reconstructable from a single source of truth without any DOM-snapshot, localStorage, or sessionStorage dependency.

### Canonical Source: Incremental JSONL Event Log
- Every `AgentEvent` emitted during a run is written as a JSON line to the existing per-run `.jsonl` file in `logs/`.
- Events are written **incrementally** (one line at a time) via an async write queue in `src/logger.ts`, not just at flush time. This ensures partial state survives crashes and is visible immediately when any user navigates to that session.
- Each JSONL line has the form: `{ "ts": "...", "seq": N, "event": {...AgentEvent fields...} }`
- The `seq` field is a monotonically increasing integer scoped per run (per `.jsonl` file). It starts at 1 and increments with each event.
- A meta line (`type: '__meta__'`) is written by `flush()` as the first line of the file, containing session metadata (query, model, startedAt, etc.).

### Backend Implementation (`src/logger.ts`)
- `SessionLogger.log(event)`: async; queues the event with an incremented seq, writes it to JSONL via a serial write queue.
- `SessionLogger.getSeq()`: returns the current sequence number (highest seq written so far).
- `SessionLogger.readLogLines()`: reads the file and yields parsed events, skipping malformed lines.
- `SessionLogger.flush()`: waits for all pending writes, then appends the meta line as the first line of the file.
- The `.md` trace is generated from the same entries (unchanged).

### Server Routes (`src/server.ts`) — as implemented
- **`GET /events`** (SSE): streams each event as `{ ...AgentEvent, __seq }`. The per-run `seq` is attached at the bus boundary in the `Agent` emit callback (the agent passes `logger.getSeq()` as a second arg to its `emit`), so the live stream carries the same `seq` the JSONL persists — this is the dedup key.
- **`GET /logs/:filename`**: returns `{ events }` for ONE run file — `readLogEvents` parses the run's JSONL, skips the `__meta__` line, and merges the per-run `seq` onto each event as `__seq`. There is NO session-level replay endpoint; the client lists a session's runs via `GET /logs` (`listSessions`, which sorts each session's `runs` by `startedAt`) and fetches each run file in order.
- All DOM-persistence routes (`/api/dom`, `.argo/dom/`) are removed.

### Client Rendering (`public/app.js`) — as implemented
- **Two render paths, shared DOM helpers (NOT one shared dispatcher).** The plan was to route live + replay through one `handleEvent`, but they legitimately differ, so replay has its own dispatcher: live `handleEvent(event)` also drives live-only side effects (status bar, busy state, git/file refreshes, iteration/token counters) and does NOT render user messages (the submit handler adds them optimistically); replay `handleEventForSession(event)` omits all those side effects and DOES render user messages (no submit handler on replay). Both call the same DOM builders (`startTraceBlock`/`addTraceItem`/`addChatMessage`/`finalizeTraceBlock`), so visual output matches.
- **`replaySessionRuns(runs)`**: fetches `GET /logs/:filename` per run (runs sorted by `startedAt`), rendering each run's events in file order via `handleEventForSession`; returns the last `__seq` (the current run's high-water mark).
- **Page load / return-to-live**: `boot()` sets `currentLiveSessionId` from `/status`, replays the live session's runs (`loadHistory` → `replaySessionRuns`), then `finishReplay()`. `returnToCurrentSession()` does the same on demand.
- **Viewing a past session**: `viewSession()` clears `messagesEl` and replays that session's runs; live SSE keeps arriving but `handleEvent` suppresses its rendering while `viewingSession` is set, so no dedup/buffering is needed there.

### Replay/live boundary (dedup) — as implemented
- State: `replaying` (buffer live events while true — starts true for the initial page-load replay), `pendingEvents` (the buffer), `liveRunMaxSeq` (per-run high-water mark).
- `es.onmessage`: if `replaying`, push to `pendingEvents`; else `handleLiveEvent(event)`.
- `handleLiveEvent`: when not viewing a past session, dedup by `__seq` — `if (__seq === 1) liveRunMaxSeq = 0` (seq is per-run, so `1` marks a new run's first event, the user message that precedes `start`), then skip if `__seq <= liveRunMaxSeq`, else render and advance the mark.
- `finishReplay()`: sets `replaying = false`, then flushes `pendingEvents` through `handleLiveEvent` (in order, deduped). This is the boundary: no gaps (buffered events flushed) and no duplicates (`__seq` high-water drops any the replay already covered).
- Known limitation (verify in a browser): if `EventSource` connects only AFTER the replay snapshot AND an event's async JSONL append lagged past the snapshot, that single event could be missed — a narrow race at the first ms of page load. A perfect fix needs a server "stream since seq X" cursor, which is more than the smallest mechanism.

### Multi-Workspace / Multi-Session Isolation
- Each workspace has its own `LOGS_DIR`. The `.jsonl` files live inside each workspace's logs directory — cross-workspace isolation is automatic.
- Multiple runs per session are grouped by `sessionId` in the existing `listSessions()` logic.

### Crash Recovery
- Since events are written incrementally, an active run that crashes will have all previously emitted events on disk. The next time anyone opens that session, those partial events are replayed and the UI shows what happened up to the crash point.
- If a flush is in progress when a crash occurs, the last partially-written line may be corrupt. Replay skips lines that fail `JSON.parse`.

### Not Building
- No vector database, no new service.
- No polling (existing SSE + fetch-on-navigation is sufficient).
- No persisted HTML or DOM snapshots.
- No sessionStorage, localStorage, or in-memory DOM caching for persistence.
- No duplicate state stores.

## Model

- Target agentic model: `qwen3.6:latest` — the only model validated end-to-end across the dispatch pipeline's role-scoped frames (Boss/Planner/Implementer). Use it for real work.
- `devstral:24b` emits tool calls but under-executes multi-step tasks. `llama3.1:8b` engages but lacks coding depth. Both are kept only as comparators, not for real work.

## Multi-agent dispatch gotchas (`docs/subagents-plan.md`)

- `Agent.setMaxIterations` has a hard floor of 10 — a smaller request (e.g. a role-specific budget of 6) is silently clamped, so a `hitCap`-style comparison against the *requested* number checks the wrong value. Always size role-specific iteration constants to at least 10, or compare against `agent.getIterationCount()`/the actual clamped max, not the literal constant.
- `autoCommit()` (`src/agent.ts`) can move HEAD forward mid-run (it commits the agent's own work after a run completes). A diff captured against bare `HEAD` afterward can show almost nothing even for a fully correct, large change — diff against the run's own baseline ref (e.g. an `eval-baseline` tag or the pre-run SHA) instead, never bare `HEAD`.
- The Boss's task-start checkpoint (`src/frames.ts`'s `parseTaskStartVerdict`) can skip its required ANSWER:/SIMPLE:/OBJECTIVE: marker line when the answer is a short, direct fact (e.g. "408") — the structured `conclude` status is checked first (`agent.getConcludeStatus()`) and is the authoritative signal; the regex parse is only a fallback for a frame that never concluded cleanly.
- There is no Tester agent any more — the Implementer verifies its own work (build/lint/test, or a direct exercise of the changed behaviour) before calling `conclude` with SUCCESS. There is no separate harness-spawned re-verification step.
- There is no `update_plan` tool, no plan/act gate, and no harness task-ledger sequencing — the Planner's decomposition IS the plan, delivered as free text via `conclude`, and the Implementer just executes the assignment it was given.
