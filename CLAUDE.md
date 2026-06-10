# Local Argo — Claude Code Instructions

**Governing principle:** Simplicity is elegant and the ultimate sophistication. Every line of code and every visual effect must earn its place. No unnecessary abstractions, no gratuitous animations, no layers of indirection. When in doubt, do less.

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

For multi-line JS scripts, the model should write the script to `/scratch` first (`write_file`), then run it with `bash: node /scratch/script.js`. Inline `node -e "..."` breaks with complex multi-line code.

`browser-fetch.ts` uses `spawn` with stdin instead of `exec` — it generates a CJS script with URL/waitFor JSON-embedded and pipes it to `node --input-type=commonjs` (either locally or via `docker exec -i`) to avoid all quoting/escaping issues.

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
| `src/logger.ts` | Session log writing |
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
| `~/.local/share/argo/logs/{name}/` | Session logs per workspace |
| `~/.local/share/argo/server.log` | Central server stdout/stderr |

## What NOT to do

- Don't add `node_modules/` or `dist/` to git — they're gitignored
- Don't commit `.env` — contains the Tavily API key
- Don't use `exec` for browser-fetch scripts — use `spawn` with stdin (already done; Chromium scripts are too complex for shell escaping)
- Don't put tool logic in `server.ts` or `agent.ts` — keep tools in `src/tools/`
- Don't use ESM `import` in agent-written scripts — `NODE_PATH` only works with CommonJS `require()`
- Don't use `pnpm` in the Dockerfile builder stage — use `npm install --ignore-scripts`
