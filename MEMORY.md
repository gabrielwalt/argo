# MEMORY.md — Persistent learnings for future sessions

## Bash/JS integration gotcha
- `${}` in bash heredocs triggers variable substitution even with quoted delimiters → causes EOF/syntax errors. Use **Python** (`python3 -c`) or escape `\$` when embedding JS template literals in shell scripts.

## Codebase notes
- Single-file vanilla JS app: `public/app.js` + `public/index.html`. No build step.
- Uses native `fetch()` and SSE for real-time updates. API base via `API_BASE` constant (set at top of app.js).
- Server files are in `src/` (TypeScript, compiled to `dist/`). Source is the authoritative target — never modify `dist/` directly.

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

### Server Routes (`src/server.ts`)
- **`GET /events`** (existing): SSE endpoint streaming `AgentEvent` objects to connected browsers.
- **`GET /api/logs/:filename`**: returns raw JSONL content as text/plain for client-side replay.
- All DOM-persistence routes (`/api/dom`, `.argo/dom/`) are removed.

### Client Rendering (`public/app.js`)
- **Shared rendering path**: `handleEvent(event)` (existing) renders a single event to `messagesEl`. Both live SSE and historical replay call this same function — zero duplication.
- **Page load / session switch**: fetch the JSONL via `/api/logs/:filename`, parse all lines, call `handleEvent()` for each event in order. Track the max `seq` from the file. Start SSE and deduplicate: skip any SSE event with `seq <= maxSeq`.
- **Active runs during replay**: since events are written incrementally, the JSONL always contains everything emitted so far (no gap between disk state and what the user has seen via SSE). The SSE deduplication handles the tiny window between reading the file and starting SSE.
- **Multi-turn sessions**: each turn is a separate run with its own JSONL. The client iterates over runs, replays each in order, tracking max seq across all for SSE deduplication.
- **Returning from viewing a past session to current live session**: fetch the current session's JSONL (which has incremental writes), replay everything via `handleEvent()`, then start SSE with deduplication. No DOM snapshot needed.
- **newSession()**: no longer clears any caches — just creates a fresh session and starts rendering from SSE.

### Deduplication Algorithm
```
maxSeq = 0
for each run in session:
    lines = await readLogLines(run.filename)
    for line in lines:
        if line.seq > maxSeq: maxSeq = line.seq
        handleEvent(line.event)

// Start SSE
es.onmessage = (e) => {
    const event = JSON.parse(e.data)
    if ('seq' in event && event.seq <= maxSeq) return // dedup
    handleEvent(event)
}
```

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
