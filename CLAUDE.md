# Local Argo — Claude Code Instructions

**Governing principle:** Simplicity is elegant and the ultimate sophistication. Every line of code and every visual effect must earn its place. No unnecessary abstractions, no gratuitous animations, no layers of indirection. When in doubt, do less.

**Living documentation:** Keep every `.md` file in this project current. After any work session where new decisions, patterns, or lessons emerged, update the relevant file immediately — never defer. Include only what has lasting value; prune stale content ruthlessly. A good test: "Will this matter in 3 months?" If yes, capture it. If no, cut it.

**Debug in the browser:** Use the Claude Preview MCP (`preview_start`, `preview_screenshot`, `preview_click`, `preview_eval`) for real browser testing when: (a) the user explicitly asks for it, (b) a complex UI change was implemented and confidence in immediate correctness is low, or (c) the user is reporting the same issue a second time. For straightforward fixes, read the code and ship — no browser verification needed. When testing is warranted, the workflow is: reproduce first → confirm root cause with eval/screenshot → fix → verify before declaring done. Launch config: `~/.claude/launch.json` (port 3001 standalone, or `http://localhost:3000/ws/{name}/` for the real worker).

---

## Conceptual model

Everything in this section is a precise definition. When writing code or UI copy, use these terms exactly — no synonyms.

### System layer

**Argo**
The system as a whole. A local-first AI agent platform that lets a user interact with LLMs to work on code projects. All model inference happens on the user's GPU via Ollama; no data leaves the machine.

**Central server**
A single long-running Node.js process (`src/central.ts`) on port 3000. Owns the workspace registry, manages Docker container lifecycles (start, stop, check), and HTTP-proxies all `GET /ws/:name/*` requests to the correct worker. There is exactly one central server per host.

**Worker**
A Node.js process (`src/server.ts`) running *inside* a Docker container, one per attached workspace, on a port in the range 3101–3199. Handles chat, tool execution, SSE streaming, file browsing, and git operations. The worker has no access to the host filesystem except through the two mounts it was given.

**Docker container**
The isolation primitive. Each workspace attachment creates a dedicated Ubuntu 24.04 container with exactly two mounts: `/workspace` (the user's project) and `/scratch` (agent working space). The container can reach Ollama on the host via the Docker host gateway, but cannot reach any other host filesystem path, other containers, or the internet unless tools explicitly fetch resources.

**Ollama**
The local LLM inference server. Runs on the host (not inside a container). Exposes an HTTP API that workers call to generate responses. Manages model weights on the GPU. Argo is model-agnostic — any model available in Ollama can be selected per session.

### Storage layer

**Workspace**
A host filesystem directory that the user has chosen to work on. Mounted read/write into the container at `/workspace`. Always a git repository (initialised on first attach if needed). This is the user's deliverable space: only files the user explicitly asked for as output belong here. The agent treats it like a clean codebase.

**Scratch**
A per-workspace temporary directory, stored at `~/.local/share/argo/scratch/{name}/` on the host and mounted at `/scratch` inside the container. The agent's private working space: scripts, intermediate data, downloaded assets, experiments, debug output, installers. Not git-tracked. Ephemeral by design — the user does not care about its contents.

**Git tracking**
The workspace is always git-tracked. `autoCommit()` initialises a git repo if the folder isn't tracked yet (`git init`), then commits all changes after every successful run. Every run that touches `/workspace` files ends with an `Agent:` prefixed commit. This is a core architectural guarantee — every change is auditable.

**Registry**
`~/.config/argo/workspaces.json`. A JSON array maintained by the central server mapping each workspace's name (derived from the folder name), host path, container name, and assigned port. Persists across restarts. The central server is the sole writer.

**Global env**
`~/.config/argo/env`. A `KEY=VALUE` file for host-level configuration: Tavily API key, default model, etc. Sourced by workers at container start.

**Run log**
Two files written per run to `~/.local/share/argo/logs/{workspace-name}/`:
- `{sessionId}_{slug}.jsonl` — machine-readable newline-delimited JSON, one event per line, first line is metadata
- `{sessionId}_{slug}.md` — human-readable markdown trace of the same run
Both files are written atomically when the run completes (`logger.flush()`).

**Session history**
`~/.local/share/argo/logs/{workspace-name}/history.json`. The raw Ollama message array (user + assistant messages) for the current live session. Written after every run. Loaded on server start to restore session context across server restarts. This is what gives the agent memory within a session.

**Current session pointer**
`~/.local/share/argo/logs/{workspace-name}/current-session.txt`. A single line containing the active session ID. Written on session creation or reset. Used to tag new run logs with the correct session ID.

### Session / interaction layer

**Session**
A conversation between user and agent. All runs between two `POST /reset` calls share the same session ID and accumulate history. From the user's perspective a session is a topic or task. Sessions are listed in the session dropdown; switching to a past session loads its messages into the chat view.

**Run**
One invocation of `agent.chat(userMessage)`. The user types a message, the agent loops until it has a final answer or hits the iteration limit, and one JSONL + MD log pair is written. Multiple runs belong to the same session and their messages accumulate in `history.json`. Runs are an internal implementation detail — never surfaced directly in the UI.

**Agent loop (ReAct)**
The core processing pattern inside a run: the LLM is given the full system prompt + history and produces either (a) a final text answer (no tool calls) or (b) a thought + one or more tool calls. Tool results are appended to history and the loop repeats. Maximum 20 iterations per run.

**Iteration**
One pass through the ReAct loop: one Ollama API call + zero-or-more tool executions. Iteration `N/20` is shown in the status bar while the agent works. Each iteration appends to the Ollama message history.

**Thought**
The LLM's text content in a response that appears alongside or before tool calls — its visible reasoning. Shown as a collapsed trace item. Some models emit thoughts before every tool call; others only when they need to plan.

**Tool**
A named capability the agent can invoke. Each tool is defined in `src/tools/` and registered in `src/tools/index.ts`. Available tools: `bash`, `write_file`, `read_file`, `fetch_url`, `browser_fetch`, `web_search`. Every tool returns `{ output: string, error?: string }` — they never throw. `write_file` and `read_file` accept both `/workspace/...` and `/scratch/...` absolute paths.

**Context window**
The LLM's token budget for one Ollama call (the full history + system prompt + tool definitions). Configured via `num_ctx` (default 32,768). Shown as a token counter in the header. When usage reaches 80%, compaction is triggered automatically.

**Compaction**
An automatic mechanism that fires when the context window is 80%+ full. A separate single-turn LLM call summarises the entire history into 3–6 sentences; the history is then replaced with `[user: original prompt, assistant: [summary]]`. The agent continues from the summary without losing the thread. The compact event is shown in the trace block.

**Model**
The Ollama model identifier (e.g. `qwen3.6:latest`, `llama3.1:8b`). Selected per session in the breadcrumb model picker. Applied on every Ollama API call within that session. Changing the model mid-session takes effect on the next run.

**Model options**
Per-session sampling parameters: `temperature`, `top_p`, `top_k`, `num_ctx`. Configured in the settings panel (⚙). Applied to all Ollama calls in the session. Defaults are `temp=0.8, top_p=0.9, top_k=40, ctx=32768`.

### UI / streaming layer

**SSE (Server-Sent Events)**
The real-time event channel from worker to browser. The browser opens `GET /events` which keeps a persistent HTTP connection open. The worker pushes each agent event as a `data: {JSON}\n\n` frame. The browser's `EventSource` receives and dispatches these to `handleEvent()`.

**Trace block**
A collapsible UI element that appears in the chat window at the start of each run. Receives all agent events (iterations, thoughts, tool calls, tool results, compaction, git commits) as they stream in. Collapsed by default. Title shows "Running…" (gold) during the run, then "Agent trace · N tools · Xs" when done.

**Chat panel**
The left panel (~50% width). Contains: message history (user messages, assistant responses, trace blocks), the optional session-viewing banner, and the input form.

**Files panel**
The right panel (remaining width). Split into: file tree pane (left, default 240px) showing `workspace/` and `scratch/` directory trees, and file viewer pane (right) showing the content of the selected file. Both panes are user-resizable.

**Session dropdown**
The breadcrumb nav element for managing sessions. Shows: "New session" CTA, then a uniform list of all sessions (current and past) — each showing only the first-query preview and a Clear button, with no timestamps or message counts. The active session is highlighted. Selecting a past session loads its messages read-only; the Resume button makes it the live session. Clearing any session deletes its logs and history.

**Attach / Detach**
Attach: the user provides a host filesystem path → central server creates or resumes a Docker container, registers the workspace, and navigates the browser to `/ws/{name}/`. Detach: the central server stops the container and removes it from the registry. The workspace files on the host are never touched.

**Auto-commit**
After every run that produces a final answer, `autoCommit()` ensures `/workspace` is a git repo (initialising one if needed), then checks `git status`. If there are uncommitted changes, it generates a short commit message via LLM and runs `git add -A && git commit`. The resulting commit hash is emitted as a `git_commit` event and shown in the trace and git log panel. Runs aborted by the user do not auto-commit.

---

## UI/UX Requirements

These are standing requirements captured from user feedback. Treat them as binding constraints — never regress them.

**Navigation**
- Opening a workspace (from the home page or any nav action) always navigates in the **same browser window/tab** — never `target="_blank"` or `window.open()` for workspace URLs.

**Brand mark (boat + wordmark)**
- The ⛵ boat always faces **right** (`transform: scaleX(-1)`) and is always rendered in **gold** (filter or gradient clip — never a neutral/muted color on its own).
- On hover, the logo/wordmark must **shine brighter** — use `filter: brightness(1.25) drop-shadow(...)`. Never dim it (`opacity: .75` is forbidden for this element).

**Send button**
- The send button is **always gold and fully opaque** — it must never dim or become `opacity < 1`, even when `disabled`.
- On submit: the boat sails away (`sail-away` animation, 0.45 s), then the icon swaps to a stop square (■) and a `ring-pulse` animation runs on the button border while the agent works.
- Clicking the stop icon while the agent is running calls `POST /stop` and signals the agent to abort between iterations.
- On completion: the stop icon disappears and the boat reappears.

**Inline styles**
- No `style=""` attributes in HTML or JS template literals. All visual properties belong in CSS classes. When adding new dynamic elements, define the class in `styles.css` first.

**Agent trace**
- The trace lives **inline in the chat window** as a collapsible `.trace-block` element — not in a separate panel.
- Collapsed by default, expanded on click. Title shows "Running…" (gold) while busy, "Agent trace" with tool count + duration when done.
- Never put the trace in a side panel, tab, or separate view.

**Sessions vs runs**
- A **session** is a conversation (group of user↔assistant exchanges). A **run** is one `chat()` call within a session. Runs are an internal implementation detail — never expose them in the UI.
- The session dropdown shows only sessions (date + query preview + Clear button). No run counts, no sub-items.
- Terminology: "session" in all UI copy. Never "run" or "trace run".

**Layout**
- The main layout is: chat panel (left, `--chat-width` CSS var, default 50%) | resize handle | files panel (right, flex: 1).
- The files panel is split: file tree pane (`--tree-width`, default 240px) | resize handle | file viewer pane.
- All panels are user-resizable via drag handles (`.resize-handle`). Both panels always visible — no collapse.
- The right panel contains **only** the file tree + viewer. No logs tab, no trace tab.
- File viewer opens inline in the right side of the files panel when clicking a file — never in a modal.

**Design system**
- All spacing is a multiple of 4 px.
- Hover on cards always uses gold border tint, never indigo/accent.
- See `DESIGN.md` for the full design system reference.

**How to capture future requirements**
- Whenever the user gives UI/UX feedback that implies a lasting rule, add it to this section immediately — before implementing the feature.

## What this project is

A safe coding harness for local LLMs running via Ollama. Docker containerisation is the core safety primitive: each workspace gets an isolated container with only the project folder mounted — the agent can execute bash, read and write files, and run Playwright scripts, but cannot reach other projects or the host filesystem outside the mount. The execution environment is JS-native (Node.js + CommonJS `require()`, Playwright, bash) — the same toolchain as the projects the agent works on. A web cockpit streams every agent decision in real time; every session is logged as JSONL + Markdown. Model weights stay on your GPU. See README.md for full documentation.

## Key commands

```bash
# Development (argo code itself)
pnpm dev                    # standalone server on :3001 with tsx watch (no Docker worker)
pnpm build                  # compile TypeScript to dist/
lsof -ti :3001 | xargs kill -9   # kill stuck dev server
lsof -ti :3000 | xargs kill -9   # kill stuck central server

# System-wide argo CLI (production use)
./install.sh                # symlinks bin/argo to /usr/local/bin/argo
argo [path]                # attach workspace, start everything, open browser
argo list                  # list running workspaces
argo stop                  # stop all workers + central server
argo rebuild               # rebuild Docker image after Dockerfile changes

# Docker image
docker build -f docker/agent.Dockerfile -t argo:latest .
```

## Architecture

Three modes controlled by env vars:

**Standalone** (`pnpm dev`, no special env vars) — full server on :3001 (PORT=3001 set in package.json), serves static files + API. Uses a separate `argo-sandbox` Docker container for bash execution (`docker exec argo-sandbox bash -c ...`). For developing Argo itself. Runs on :3001 specifically to avoid conflicting with the `argo` CLI central server on :3000.

**Central** (`CENTRAL_MODE=1`) — workspace manager on :3000. Serves `workspaces.html` at `/`, proxies `/ws/:name/*` to worker containers. Manages Docker lifecycle. Started by `bin/argo`.

**Worker** (`WORKER_MODE=1 RUNNING_IN_CONTAINER=1`) — API-only server inside a Docker container. No static file serving. Bash runs locally (no docker exec — the code is already inside the container). One container per attached workspace.

Flow: `bin/argo attach /path` → ensures Docker/Ollama running → ensures image built → starts central server → POST `/api/attach` → central starts worker container → opens browser at `localhost:3000/ws/{name}/`.

## How to add a new tool

Three files to touch:

### 1. `src/tools/my-tool.ts`
```typescript
import type { ToolResult } from '../types.js'

export async function myTool(arg: string): Promise<ToolResult> {
  try {
    return { output: '...' }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
```

### 2. `src/tools/index.ts`
- Add import
- Add entry to `toolDefinitions` array (this is what Ollama sees — description quality matters)
- Add case to `executeTool` switch

### 3. `src/types.ts`
- Add `'my_tool'` to the `ToolName` union

tsx watch reloads automatically in `pnpm dev` — no restart needed. Run `argo rebuild` to bake changes into the Docker image.

## Tool output conventions

- Always return `{ output: string, error?: string }` — never throw
- Truncate long outputs to prevent context window overflow (see `MAX_OUTPUT` constants in each tool)
- Errors go in `error` field, not output — argo loop shows them differently in the UI

## The bash tool pattern

`bash.ts` checks `config.inContainer`:
- **In container** (worker mode): `bash -c <JSON.stringify(command)>` with `cwd: '/workspace'`
- **On host** (standalone mode): `docker exec argo-sandbox bash -c <JSON.stringify(command)>`

`JSON.stringify` handles all quoting/escaping. 30s timeout.

For multi-line JS scripts, the model uses `write_file` with a `/scratch/...` path, then runs it with `node`. Both `write_file` and `read_file` accept `/workspace/...` and `/scratch/...` absolute paths. Inline `node -e "..."` breaks with complex multi-line code.

`browser-fetch.ts` uses `spawn` with stdin instead of `exec` — it generates a CJS script with URL/waitFor JSON-embedded and pipes it to `node --input-type=commonjs` (either locally or via `docker exec -i`) to avoid all quoting/escaping issues.

## Session architecture

A **session** = all agent runs (`chat()` calls) between two `POST /reset` calls, sharing the same conversation history.

- Each `chat()` call writes one `.jsonl` + `.md` file (a "run"), stamped with a `sessionId`
- `sessionId` is a timestamp string (`2024-01-15T14-30-00`), stored in `{LOGS_DIR}/current-session.txt`
- `POST /reset` and `DELETE /logs` generate a new session ID and persist it to that file
- `POST /resume/:sessionId` loads all messages from a past session back into agent history and switches to that session ID
- `GET /logs` returns `SessionGroup[]` (runs grouped by sessionId, newest first) — not flat `LogMeta[]`
- `LogMeta.sessionId` is optional — old log files without it fall into a `'legacy'` group

UI session dropdown shows: "New session" CTA, current live session ("Now"), then past sessions (date + last-query preview + Clear button), then "Clear all history". The live session is filtered from the past list using the session ID from `GET /status`.

## The SSE event flow

```
agent.ts emitAndLog(event)
  → logger.log(event)         writes to in-memory entries
  → this.emit(event)          calls server.ts bus.emit('agent', event)
    → all SSE clients get:    data: {JSON}\n\n
logger.flush() at end         writes .jsonl + .md to logs/
```

## Config

`src/config.ts` resolves env vars. Key flags:
- `config.inContainer` — true when `RUNNING_IN_CONTAINER=1`; changes bash execution path
- `config.workerMode` — true when `WORKER_MODE=1`; disables static file serving
- `MODEL` — default Ollama model
- `MAX_ITERATIONS` — currently 20
- `SANDBOX_CONTAINER` — standalone mode only; must match the running docker container name

## The central server (src/central.ts)

Key details:
- `app.set('strict routing', true)` — required; prevents redirect loops between `/ws/:name` and `/ws/:name/`
- `express.static(PUBLIC_DIR, { index: false })` — required; prevents `index.html` from shadowing the explicit `GET /` route for `workspaces.html`
- `window.__WS__` injection: central reads `index.html`, injects `<script>window.__WS__='name'</script>` before `</head>` — `app.js` derives `API_BASE = '/ws/' + window.__WS__`
- HTTP proxy uses Node.js `http.request` with `proxyRes.pipe(res)` — handles SSE streaming natively without buffering
- Registry at `~/.config/argo/workspaces.json`; global env at `~/.config/argo/env`
- Workers on ports 3101–3199; `isPortFree()` finds next available

## bin/argo

- Uses a symlink-following loop (`while [ -L "$_src" ]`) to find `ARGO_DIR` even when the script is symlinked to `/usr/local/bin/argo`
- `ensure_central`: `central_running()` hits `/api/workspaces` which only exists in central mode; if true, reuses the running central server; if port :3000 is taken by something else, checks `/status` (standalone mode) to give a specific "stop pnpm dev" message vs generic "kill it"
- `cmd_attach`: skips Docker/Ollama/image checks when central is already running; surfaces actual error messages from `/api/attach`
- Uses `node ... & disown $!` (not nohup) to background the central server
- JSON manipulation uses Python3 inline (available on macOS) to avoid jq dependency

## Common debugging

**Argo not calling tools / outputting JSON as text**
→ Switch to `llama3.1:8b`. Some models don't reliably use the native tool-calling API.

**bash tool returning empty output**
→ Standalone: check `docker ps` — container may be stopped. Run `docker start argo-sandbox`.
→ Worker: check `docker ps | grep argo-` and `docker logs argo-{name}`.

**browser_fetch failing**
→ `docker exec argo-{name} node -e "require('playwright'); console.log('ok')"` to verify install.

**`require('pkg')` not found in argo script**
→ Must use `require()` not `import`. Verify `NODE_PATH`: `docker exec argo-{name} printenv NODE_PATH`.

**Port conflict on startup**
→ `lsof -ti :3000 | xargs kill -9`

**Central server fails to start**
→ `cat ~/.local/share/argo/server.log`

**SSE "Connecting…" forever through the proxy**
→ Two causes fixed in `proxyToWorker`: (1) For GET requests, use `proxy.end()` directly — don't use `req.pipe(proxy)` because `req` may have already emitted `end` (due to the `await loadRegistry()` before calling the proxy), and piping an already-ended stream never calls `proxy.end()` so the worker never gets a complete request and never sends headers. (2) Strip hop-by-hop headers (Connection, Transfer-Encoding, etc.) and set `accept-encoding: identity` on the proxied request to prevent the worker from gzip-encoding the SSE stream. Call `res.flushHeaders()` after `res.writeHead()` to send the 200 + SSE headers to the browser immediately.

**ERR_TOO_MANY_REDIRECTS on /ws/:name/**
→ `app.set('strict routing', true)` missing from the Express app in `startCentral()`.

**Root URL serves index.html instead of workspaces.html**
→ `express.static` must be called with `{ index: false }` in `startCentral()`.

**pnpm install blocked in Dockerfile**
→ Dockerfile uses `npm install --ignore-scripts` (not pnpm) — pnpm v11 blocks esbuild postinstall.

## File paths to know

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — routes to central, worker, or standalone |
| `src/central.ts` | Central server: registry, Docker lifecycle, HTTP proxy |
| `src/agent.ts` | ReAct loop + system prompt + auto-commit logic |
| `src/tools/index.ts` | Tool registry — add new tools here |
| `src/server.ts` | All HTTP routes + SSE (worker/standalone) |
| `src/logger.ts` | Session log writing + `listSessions()`, `deleteAllLogs()`, `getSessionMessages()` |
| `src/config.ts` | All env vars + mode flags |
| `docker/agent.Dockerfile` | Multi-stage: TS builder (node:22-alpine) + Ubuntu runtime |
| `docker/sandbox.Dockerfile` | Legacy — used only with `pnpm dev` standalone mode |
| `public/app.js` | All frontend logic |
| `public/styles.css` | All styling |
| `public/index.html` | Argo UI — served at `/ws/:name/` with `__WS__` injected |
| `public/workspaces.html` | Workspace list — served at `/` |
| `bin/argo` | CLI: attach, detach, list, stop, rebuild |
| `~/.config/argo/env` | Global config (API keys, model) |
| `~/.config/argo/workspaces.json` | Workspace registry |
| `~/.local/share/argo/scratch/{name}/` | Argo scratch dir per workspace |
| `~/.local/share/argo/logs/{name}/` | Session logs per workspace (JSONL + MD per run, `history.json`, `current-session.txt`) |
| `~/.local/share/argo/server.log` | Central server stdout/stderr |

## Nav dropdown positioning

All three nav dropdowns (session, workspace, model) use `position: fixed` with coordinates calculated via `getBoundingClientRect()` in JS. Do NOT change `.nav-dropdown` to `position: absolute` — Chrome clips absolute-positioned descendants at `overflow: hidden` ancestor boundaries even when that ancestor is not the containing block. The `#breadcrumb` element must NOT have `overflow: hidden` for the same reason.

## What NOT to do

- Don't add `node_modules/` or `dist/` to git — they're gitignored
- Don't commit `.env` — contains the Tavily API key
- Don't use `exec` for browser-fetch scripts — use `spawn` with stdin (already done; Chromium scripts are too complex for shell escaping)
- Don't put tool logic in `server.ts` or `agent.ts` — keep tools in `src/tools/`
- Don't use ESM `import` in agent-written scripts — `NODE_PATH` only works with CommonJS `require()`
- Don't use `pnpm` in the Dockerfile builder stage — use `npm install --ignore-scripts`
