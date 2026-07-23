# MEMORY.md — Persistent learnings for future sessions

## Keyboard shortcuts
- **Alt/Option+Enter does not work reliably** in web UIs — browser/OS intercepts before reaching JS. Use Shift+Enter for newlines instead.
- Shift+Enter already works: handler at `app.js` line 454 uses `!e.shiftKey` to submit on plain Enter, letting Shift+Enter insert naturally.

## State persistence across page reloads
- Workspace switching (`/ws/{name}/`) causes a **full page reload** — in-memory state is lost. Use **sessionStorage** (not localStorage) for ephemeral recovery data like DOM cache.
- Pattern: save `innerHTML` + serialized data to sessionStorage before navigation; restore on load via init-time check.

## DOM caching pattern
- For rich rendered content (trace blocks, tool calls), store `messagesEl.innerHTML` as a DOM snapshot. Preserves collapsed/expanded state, rendering artifacts — far more robust than re-rendering from raw data.
- Diff against server for new messages while the cache is held.

## Bash/JS integration gotcha
- `${}` in bash heredocs triggers variable substitution even with quoted delimiters → causes EOF/syntax errors. Use **Python** (`python3 -c`) or escape `\$` when embedding JS template literals in shell scripts.

## Codebase notes
- Single-file vanilla JS app: `public/app.js` + `public/index.html`. No build step.
- Uses native `fetch()` and SSE for real-time updates. API base via `API_BASE` constant (set at top of app.js).
