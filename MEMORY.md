# MEMORY.md — Persistent learnings for future sessions

## Bash/JS integration gotcha
- `${}` in bash heredocs triggers variable substitution even with quoted delimiters → causes EOF/syntax errors. Use **Python** (`python3 -c`) or escape `\$` when embedding JS template literals in shell scripts.

## Codebase notes
- Single-file vanilla JS app: `public/app.js` + `public/index.html`. No build step.
- Uses native `fetch()` and SSE for real-time updates. API base via `API_BASE` constant (set at top of app.js).
- Server files are in `src/` (TypeScript, compiled to `dist/`). Source is the authoritative target — never modify `dist/` directly.

---

## Architecture: Structured Event Persistence (the current plan)

### Problem
The old DOM-snapshot approach (`sessionDOMMap`, `.argo/dom/{workspace}/{sessionId}.html`, `restoreLiveDOM()`) persisted rendered HTML as canonical state. This violates the principle that the UI must remain a lean, stateless projection of agent state — the browser DOM was effectively owning and persisting conversation/trace data.

### Decision: Single Canonical Event Stream
Make the existing event stream incrementally durable by appending **canonical JSON events** immediately upon emission (in `src/logger.ts`'s `logger.log()` path), rather than capturing rendered HTML.

#### Design points
- **One canonical representation**: each `AgentEvent` emitted during a run is written as a JSON line to the existing `.jsonl` log file in `logs/`. This log becomes the single source of truth for conversation + trace history.
- **Monotonic sequence number per run**: add a monotonically increasing integer field to every event (scoped per filename/run) so the client can deduplicate events received via live SSE against events replayed from the persisted file. No new service or DB needed.
- **Incremental writes during active runs**: the `flush()` that currently generates derived artifacts (Markdown trace, etc.) also becomes the point where any in-memory buffered events are appended to the `.jsonl` in order. For actively running sessions, events should be flushed incrementally (not only at end) so they survive crashes and are visible immediately when a user navigates to that session.
- **Existing SSE path stays**: `public/app.js` already subscribes to SSE for live updates during active runs. The client uses the same event objects — no new serialization format is needed.
- **Historical replay via fetch**: `listSessions()` and `readLog(filename)` (already in `src/logger.ts`) can read back the `.jsonl` file. The client calls a new endpoint or reuses an existing one to fetch the full event stream for completed sessions, then renders incrementally from events rather than from DOM snapshots.
- **No HTML persisted**: remove all DOM-snapshot code (`/api/dom` POST/GET routes, `.argo/dom/` directory, `sessionDOMMap`, `sessionMsgMap`, `liveDOMTimer`, `restoreLiveDOM()`, `saveSessionDOM()`) once the event approach works.

#### What persists
Every `AgentEvent` type: `user_message`, `agent_message`, `thought`, `tool_call`, `tool_result`, `git_commit`, `done`, `error`, `warning`, `compact_start`, `compact_progress`, `compact`, and others. Each gets a `{ seq, ts, ...eventFields }` wrapper line in the JSONL file.

#### Client rendering
- Extract a minimal shared primitive: `renderConversationEvent(event)` in `public/app.js` that takes a single event object and appends/rendered DOM to `messagesEl`. This is what both live SSE and historical replay call — no duplication of rendering logic.
- On page load or session switch: fetch the `.jsonl` file, parse all lines as events, replay them via `renderConversationEvent()`. Then start SSE for any remaining live events (deduplicating by sequence number).

#### Crash recovery
- Since events are written incrementally to the `.jsonl`, an active run that crashes will have all previously emitted events on disk. The next time anyone opens that session, those partial events are replayed and the UI shows what happened up to the crash point.
- If a flush is in progress when a crash occurs, the last partially-written line may be corrupt. Add a simple integrity check during replay: skip lines that fail `JSON.parse`.

#### Multi-workspace / multi-session isolation
- Each workspace already has its own `LOGS_DIR` (derived from the workspace mount path). The `.jsonl` files live inside each workspace's logs directory, so cross-workspace isolation is automatic.
- Multiple runs per session are grouped by `sessionId` in the existing `listSessions()` logic — no change needed there.

### Not building
- No vector database, no new service.
- No polling (existing SSE + fetch-on-navigation is sufficient).
- No persisted HTML or DOM snapshots.
- No duplicate state stores (this replaces the DOM-snapshot approach entirely).
