# MEMORY.md — Persistent learnings for future sessions

## Keyboard shortcuts
- **Alt/Option+Enter does not work reliably** in web UIs — browser/OS intercepts before reaching JS. Use Shift+Enter for newlines instead.
- Shift+Enter already works: handler at `app.js` line 454 uses `!e.shiftKey` to submit on plain Enter, letting Shift+Enter insert naturally.

## State persistence across page reloads
- Workspace switching (`/ws/{name}/`) causes a **full page reload** — in-memory state is lost. Use **sessionStorage** (not localStorage) for ephemeral recovery data like DOM cache.
- Pattern: save `innerHTML` + serialized data to sessionStorage before navigation; restore on load via init-time check.

## Multi-session DOM persistence
- **Server-side**: `.argo/dom/{workspaceName}/{sessionId}.html` stores full DOM snapshots per workspace (independent directories, no cross-workspace interference). Routes at `/api/dom` (POST) and `/api/dom/:sessionId` (GET) in `dist/server.js`.
- **Client-side**: `sessionDOMMap` (sessionId → innerHTML) as fast in-memory path; server files as durable store. `restoreLiveDOM()` called in `boot()` after `currentLiveSessionId` is set.
- **Debounce timer** (`liveDOMTimer`, 2s): fires in three places — `startTraceBlock`, `addTraceItem`, `addChatMessage`. All guarded by `!viewingSession && currentLiveSessionId` so they don't save the wrong session while viewing another.
- **SSE suppression**: `handleEvent` has a guard at top that suppresses all rendering events (thought, tool_call, tool_result, etc.) when `viewingSession` is set. Only status updates (setStatus) and token counters pass through — they don't modify messagesEl.
- **Completion sessions**: re-rendered from logs on first view; subsequent switches use cached DOM snapshots.
- **Cross-workspace**: each workspace has its own `.argo/dom/` subdirectory, so switching workspaces preserves all session traces independently.

## DOM caching pattern
- For rich rendered content (trace blocks, tool calls), store `messagesEl.innerHTML` as a DOM snapshot. Preserves collapsed/expanded state, rendering artifacts — far more robust than re-rendering from raw data.
- Diff against server for new messages while the cache is held.

## Bash/JS integration gotcha
- `${}` in bash heredocs triggers variable substitution even with quoted delimiters → causes EOF/syntax errors. Use **Python** (`python3 -c`) or escape `\$` when embedding JS template literals in shell scripts.

## Codebase notes
- Single-file vanilla JS app: `public/app.js` + `public/index.html`. No build step.
- Uses native `fetch()` and SSE for real-time updates. API base via `API_BASE` constant (set at top of app.js).
