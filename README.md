# Argo

A **contained coding harness for locally-running LLMs** (Qwen, Mistral, and the like). The goal is local, private, self-contained agentic coding: model weights stay on your machine and inference never leaves it, while the agent works inside an isolated environment. The agent itself has normal internet access (bash, fetch tools) the same way a developer's terminal would.

**Means, not ends.** The *harness* is the goal — not any particular vendor. Today Argo fills two gaps with two tools: **Ollama** runs the local models, and **Docker** contains the agent's environment. Neither is a goal in itself. If a leaner or better tool fills either gap — a different local runtime (llama.cpp's `llama-server`, LM Studio, vLLM, mlx) for inference, or a lighter sandbox for containment — Argo should be able to swap it in. "Local model" is the requirement; "Ollama" is just today's implementation.

**Lean and local.** Fewer moving parts and fewer external services is better. Everything runs on your machine by default; a third-party service or API is adopted only when it delivers real value that no local option provides, never as clutter. Where a remote dependency is currently unavoidable — e.g. web search, which is inherently bound to whoever indexed the web (today via Tavily) — it is a reluctant, clearly-marked exception, to be replaced with a local alternative the moment a good one exists.

---

Local models are on a steep improvement curve. Quantized 14B models already rival hosted models on coding tasks, and that gap will narrow further. The limiting factor is no longer raw capability — it is containment, observability, and tooling. Argo is built around those three constraints.

Docker covers the main containment concern. Each workspace gets an isolated container with only the project folder mounted. The agent can execute bash, read and write files, fetch pages, and run Playwright scripts — but it cannot see other projects or reach host paths outside the mount. It's a filesystem boundary, not a network or resource one: containers keep normal outbound internet access and no CPU/memory caps, and nothing stops the agent from reading and transmitting whatever secrets already live inside the mounted project itself (that's unavoidable for a tool that needs to read a codebase to work on it). Argo's own operational secrets (API keys) are held separately and never handed to the container — see the zero-trust section in CLAUDE.md.

The execution environment is JS-native by design. Agents run Node.js + CommonJS `require()`, Playwright, and bash — the same toolchain as the projects they work on. No Python intermediary, no translation layer, no impedance mismatch between what the agent writes and what the codebase expects. The packages the agent can `require()` are the packages a JS developer would actually reach for.

The cockpit metaphor captures the UI intent: the developer stays in the loop. Every agent decision streams to the trace panel in real time — model thoughts, tool calls with arguments, tool results with timing. The file browser, git log, and session log are all live. The developer can read, guide, correct, and revert at every step. The logging layer produces structured JSONL + Markdown for every session, creating a learning flywheel: compare models, tune parameters, iterate on system prompts with actual data.

---

## How it works

Three runtime modes, controlled by environment variables:

```
┌─────────────────────────────────────────────────────────────┐
│  HOST MACHINE                                               │
│                                                             │
│  Ollama daemon :11434   ←── shared by all instances         │
│                                                             │
│  Central server :3000   ←── started on-demand by CLI        │
│  ├── Serves workspaces.html at /                            │
│  ├── Injects __WS__ context, serves index.html at /ws/:name/│
│  ├── Proxies /ws/:name/* → worker container                 │
│  └── Manages Docker lifecycle (attach / detach)             │
│                                                             │
│  ~/.config/argo/env     ←── global config (API keys, model) │
│  ~/.config/argo/workspaces.json  ←── registry               │
└──────────────────────┬──────────────────────────────────────┘
                       │ HTTP proxy
         ┌─────────────┴──────────────┐
         │                            │
┌────────▼───────┐           ┌────────▼───────┐
│ argo-test-one  │           │ argo-my-blog   │  (one per workspace)
│ :3101          │           │ :3102          │
│                │           │                │
│ /workspace ←── │vol        │ /workspace ←── │vol
│   ~/Sources/   │           │   ~/Sources/   │
│   test/test-one│           │   my-blog      │
│                │           │                │
│ (everything    │           │ (everything    │
│  else: ordinary│           │  else: ordinary│
│  container fs) │           │  container fs) │
└────────────────┘           └────────────────┘
```

**Standalone mode** (`pnpm dev`) — full server on :3001, uses a separate `argo-sandbox` container for bash execution. Used for developing Argo itself.

**Central mode** (`CENTRAL_MODE=1`) — the workspace manager. Started by `bin/argo`.

**Worker mode** (`WORKER_MODE=1 RUNNING_IN_CONTAINER=1`) — API-only, no static files. Bash runs locally inside the container (no docker exec needed).

### Volumes per workspace

| Mount | Source on host | Purpose |
|---|---|---|
| `/workspace` | The project folder you attached | Git-tracked project files — the only mount that matters to the agent |
| `/app/logs` | `~/.local/share/argo/logs/{name}/` | Session logs (JSONL + Markdown) |

Everything else in the container (`/tmp`, the home directory, etc.) is ordinary, ephemeral filesystem — no host mount, no cleanup needed, since the container already runs with `--rm`.

---

## Prerequisites

- **macOS** with Docker Desktop
- **Ollama** installed: [ollama.com](https://ollama.com)
- At least one model pulled: `ollama pull qwen3.6:latest`
- **Node.js v22** via nvm: `nvm install 22 && nvm use 22`
- **pnpm**: `npm i -g pnpm`
- Optional: **Tavily API key** for web search — free tier at [tavily.com](https://tavily.com)

---

## Setup

```bash
# 1. Install dependencies
cd ~/Sources/Adobe/argo
pnpm install

# 2. Build the TypeScript
pnpm build

# 3. Install the CLI command
./install.sh
# → symlinks bin/argo to /usr/local/bin/argo

# 4. Edit global config (created automatically on first argo attach)
#    Add your Tavily API key and preferred model
nano ~/.config/argo/env
```

The Docker image is built automatically on first use (takes ~5 minutes — downloads Chromium for Playwright).

---

## Running Argo

### Before you start

Two services must be running on your Mac before launching Argo:

1. **Docker Desktop** — must be open. The `argo` CLI checks this and exits early if Docker isn't responding.
2. **Ollama** — must be serving. Either open the Ollama menu-bar app or run `ollama serve` in a terminal. Verify with `ollama list`.

### Start

```bash
# Attach a project folder and open the UI
argo ~/Sources/my-project

# Or from inside the project folder
cd ~/Sources/my-project && argo
```

This starts the central server on port 3000 (if not already running), creates a Docker worker container for the project, and opens `http://localhost:3000/ws/my-project/` in your browser.

The Docker image is built automatically on first use — this takes ~5 minutes (downloads Chromium for Playwright). Subsequent starts are instant.

### Add another folder

While the central server is already running, just run `argo` again for the new path:

```bash
argo ~/Sources/another-project
```

Each folder gets its own isolated container and URL. Switch between them at `http://localhost:3000/` or via the workspace switcher in the UI.

### List running workspaces

```bash
argo list
```

### Stop

```bash
# Stop all workers and the central server
argo stop
```

Individual workspaces can also be stopped from the workspace list at `http://localhost:3000/`.

### Alternative: standalone dev mode

```bash
pnpm dev
# → http://localhost:3001
```

Runs a single server on port 3001 with hot-reload — no workspace sub-path, no per-workspace containers. Uses a shared `argo-sandbox` container for bash. Use this when developing Argo itself, not for regular agent work. Port 3001 is intentional so it doesn't conflict with the `argo` CLI on port 3000.

### Rollback workspace changes

```bash
cd ~/Sources/my-project
git log --oneline          # see what Argo did
git diff HEAD~1            # diff last commit
git checkout HEAD~1 -- .   # revert to before last commit
git checkout <hash> -- path/to/file   # restore specific file
```

---

## Configuration

### Global config: `~/.config/argo/env`

Created automatically on first `argo attach`. Edit to set your API key and defaults.

```bash
TAVILY_API_KEY=tvly-your-key-here
MODEL=qwen3.6:latest
MAX_ITERATIONS=1000
```

| Variable | Default | Description |
|---|---|---|
| `TAVILY_API_KEY` | *(empty)* | Web search — free tier at tavily.com |
| `MODEL` | `qwen3.6:latest` | Default Ollama model |
| `MAX_ITERATIONS` | `1000` | Max tool-call rounds per query before giving up |

### Dev-only: `.env` (project root)

Used only in standalone `pnpm dev` mode.

| Variable | Default | Description |
|---|---|---|
| `TAVILY_API_KEY` | | Same as above |
| `MODEL` | `llama3.1:8b` | |
| `OLLAMA_HOST` | `http://localhost:11434` | |
| `SANDBOX_CONTAINER` | `argo-sandbox` | Container name for standalone mode |
| `WORKSPACE_PATH` | `./workspace` | |
| `PORT` | `3001` | |

---

## Models

Any model pulled via `ollama pull` appears in the UI dropdown automatically.

**Use `qwen3.6:latest` for agentic work.** It is the only model validated end-to-end in Argo: it completes multi-step tasks, follows the dispatch pipeline's role-scoped prompts, and converges without drift. `devstral:24b` and `llama3.1:8b` emit tool calls but do not reliably complete multi-step tasks — they are kept as comparators, not for real work (details below). The UI marks tool-capable models with 🔧 and non-functional ones with ⚠️; any model pulled with `ollama pull` appears in the dropdown automatically.

| Model | Size | Agentic use | Notes |
|---|---|---|---|
| `qwen3.6:latest` 🔧 | 23 GB | ✅ **Recommended** | The only model validated end-to-end. Reliable native tool calls, strong ReAct reasoning, multi-step tasks with compaction. Eval: 4/4 tasks completed. Requires ~24 GB RAM. |
| `devstral:24b` 🔧 | ~14 GB | ⚠️ Tool-capable, under-performs | Mistral's agentic-coding model. Emits native tool calls (~75% on the single-turn probe) but under-executes end-to-end — finishes early with the suite still failing (eval: 0/4). An emission/behaviour ceiling, not reasoning. Re-vet as it improves. |
| `qwen2.5-coder:14b` | 9.0 GB | ⚠️ Partial | Tool calling works but reasoning is weaker. Prone to hallucinating exact strings (URLs, paths) from memory. Usable for simple, single-step tasks. |
| `llama3.1:8b` | 4.9 GB | ⚠️ Partial | Consistent tool-call API compatibility, but limited reasoning depth — engages the plan workflow yet cannot complete multi-step tasks (eval: 0/4; once re-planned to the iteration cap). Best option on memory-constrained machines. |
| `mistral:latest` | 4.4 GB | ❓ Untested | Not tested in Argo. Tool-calling support unknown. |
| `gemma4:latest` ⚠️ | 9.6 GB | ❌ Fails | Technically emits tool calls but cannot follow the ReAct loop across iterations — declares done on empty output, ignores prior tool results, never delivers files. |
| `gemma3:12b` ⚠️ | 8.1 GB | ❌ Broken | Ollama returns a hard `"does not support tools"` error. The container hangs until the 120 s timeout. Do not use. |

To add any model: `ollama pull <name>` — appears in the UI immediately without restart.

---

## Multi-agent architecture

Every request runs through the dispatch loop (`src/dispatch.ts`) — a harness-code Orchestrator
that never itself calls the model. It routes each task through a **Boss** that classifies the
request (ANSWER / SIMPLE / OBJECTIVE) and, for anything beyond a direct answer, delegates to
dedicated **Planner** and **Implementer** call frames — each its own scoped `Agent` instance
(`src/agent.ts`), reusing the same battle-tested ReAct loop (streaming Ollama calls, deterministic
context eviction, the loop-recovery ladder, tool execution) with a restricted tool set and a
distinct system-prompt suffix.

- **Boss** — classifies the request, has no direct file-modification tools, and (for an OBJECTIVE
  run) writes the final summary once every task is complete.
- **Planner** — read-only. Produces an ordered list of implementation units for a genuinely
  multi-part objective, then is resumed to detail one self-contained Implementer assignment at a
  time, informed by the previous Implementer's own conclusion. There is no separate re-planning
  step — adaptation happens naturally on the next detail call.
- **Implementer** — the only role with `write_file`/`edit_file`/`bash`. Executes one assignment,
  verifies its own work (build/lint/test, or a direct exercise of the changed behaviour), and
  reports SUCCESS or FAIL via `conclude`.

The SIMPLE path (a well-scoped, single-unit change) skips the Planner entirely: Boss →
Implementer → done. If that one Implementer hits its iteration cap without concluding, the run
escalates to the full OBJECTIVE pipeline (Planner → Implementer per task) rather than reporting a
raw cap-hit as failure.

Still sequential, not concurrent: exactly one LLM call runs at a time (one GPU, one resident
model). Every delegation, conclusion, and tool-call episode is recorded to an append-only ledger
under `/workspace/.argo/ledger.jsonl` (`src/ledger.ts`). Full design: `docs/subagents-plan.md`.

### Context management

There is no LLM-summarization compaction step. Context management is entirely deterministic
(`src/eviction.ts`, following CWL — "Beyond Compaction: Structured Context Eviction for
Long-Horizon Agents"): every tool call is typed as an episode (exploratory or action), and when
the live context approaches `num_ctx`, the oldest already-durably-persisted episodes are stubbed
out first — never the objective, never the current prompt. Nothing evicted is actually gone: the
full original survives in the ledger and can be recovered with the `ledger` tool's `expand`
action. A separate, cheaper pass (`KEEP_RECENT_TOOL_RESULTS` in `src/agent.ts`) also collapses
older tool results before they ever reach the eviction threshold, which is what keeps native
tool-calling reliable on a small local model over a long run.

### Loop recovery

A small local model tends to repeat the exact same tool call forever when stuck. The
loop-recovery ladder (`src/loop.ts`) detects a no-progress repeat (same call, nothing changed
since it last ran) and escalates: L0 serves back the cached result of the earlier call (labeled as
a repeat) instead of a bare block; L1 triggers a context eviction pass; L2 forces the model to
produce a revised plan for the same task. If the model ignores the ladder for long enough, the
frame halts rather than looping indefinitely — reported as a partial result, never as success.

---

## Agent tools

| Tool | Description | When it's used |
|---|---|---|
| `bash` | Run any shell command in the Docker sandbox | Scripts, file inspection, git ops, running Node.js |
| `web_search` | Search via Tavily API | Current information not in training data |
| `fetch_url` | HTTP GET + HTML strip. Fast (~100–300ms), no JS | Static pages, APIs, documentation |
| `browser_fetch` | Playwright/Chromium. Full JS execution (~3–5s) | SPAs, dynamic content, pages where fetch_url returns empty |
| `read_file` | Read a file at any absolute path in the container | Inspecting files directly |
| `write_file` | Write a file at any absolute path in the container | Saving scripts or results |
| `edit_file` | Replace an exact string in an existing file | Targeted changes without rewriting a whole file |
| `ledger` | Query the multi-agent delegation/conclusion/episode ledger | Looking up a dependency's prior work, recovering evicted content |
| `conclude` | End the current frame's turn with a status keyword + message | The only way any role (Boss/Planner/Implementer) finishes |

Not every role gets every tool — the Planner and Boss are read-only (no `write_file`/`edit_file`); only the Implementer holds the full write-capable set. See `src/frames.ts`'s `ROLE_TOOLS`.

### The filesystem model

The container is the agent's entire working environment. `/workspace` is the one special directory: the project folder, git-tracked and auto-committed after each task. Everywhere else (`/tmp`, the home directory, wherever) is ordinary, disposable filesystem — freely usable for scripts, downloads, and intermediate work, with nothing to clean up since the container itself is ephemeral.

The agent is instructed to keep work-in-progress files outside `/workspace` and only write there when modifying the actual project.

### Project memory

Two optional, plain-Markdown files at the project root, auto-loaded (fresh, once per run) and appended to the system prompt if present — no embeddings, no database, no daemon:

- **`AGENTS.md`** — human-authored project instructions (conventions, non-obvious constraints). The agent treats this as read-only, the same way it treats this project's own `CLAUDE.md`.
- **`MEMORY.md`** — agent-maintained durable memory: architecture facts, conventions, decisions, recurring pitfalls. The agent is instructed to update it conservatively (durable, reusable facts only — never one-off task state or debugging detail), in place rather than by appending, and to split a section out to `memory/<topic>.md` (with a one-line pointer left in `MEMORY.md`) if it grows large — so detail stays available on demand without bloating every run's context.

Both files live inside `/workspace` like any other project file, so they're versioned and auto-committed the same way code changes are — visible and git-diffable, not a hidden side channel. Each is capped at 8,000 characters on load (same as `read_file`'s own truncation) — see `loadProjectContext()` in `src/agent.ts`.

---

## Sandbox environment

Each workspace worker runs Ubuntu 24.04 with the following pre-installed.

### CLI tools

`bash` `curl` `wget` `git` `jq` `node` `rg` (ripgrep) `fd` `sqlite3` `mlr` (miller) `parallel` `tree` `file` `pv` `dig` `nc` `ping` `unzip` `zip`

### Node.js packages (available via `require()` — `NODE_PATH` is set)

| Package | Purpose |
|---|---|
| `cheerio` | HTML parsing — jQuery-like API, the primary scraping tool |
| `playwright` | Browser automation (Chromium) |
| `js-yaml` | YAML parse/stringify |
| `csv-parse` | CSV parsing |
| `xlsx` | Excel (.xlsx) read/write |
| `pdf-parse` | PDF text extraction |
| `marked` | Markdown → HTML |
| `turndown` | HTML → Markdown |
| `handlebars` | Templating |
| `chalk` | Terminal colors |
| `commander` | CLI argument parsing |
| `date-fns` | Date utilities |
| `iconv-lite` | Character encoding conversion |
| `glob` | File path globbing |

Native `fetch()` is available — no import needed for HTTP requests.

For any other package: `npm install <package>` (installs locally in `/workspace`).

**Important:** use `require()` not `import` — `NODE_PATH` resolves CommonJS but not ESM.

---

## Web UI

Served at `http://localhost:3000/ws/{workspace-name}/`.

**Header** — model picker, context usage counter, settings panel (temperature, top_p, top_k, context window), workspace switcher with dropdown to switch between running workspaces.

**Chat (left)** — conversation with Markdown rendering. "New session" resets history without restarting the server.

**Agent Trace (right)** — live stream of every internal step: iteration counter, model thoughts, tool calls with full arguments, tool results with timing, errors. Long items collapse. This is the cockpit view — every decision the agent makes is visible as it happens.

**Files (right tab)** — a single file tree rooted at the container's filesystem, with `/workspace` expanded and labeled by default. Click any file to preview its contents. Refreshes automatically after each completed task.

**Session Logs (right tab)** — list of all past sessions. Click any entry to read the full trace as Markdown or JSONL. Sessions accumulate across restarts and are the primary source of data for improving prompts and comparing models.

**Git Log (bottom)** — latest commit shown inline; click to expand older ones. Click "diff" to view exact changes. Auto-updates when the agent commits. Commit messages summarize whatever is dirty in `/workspace` at commit time (`git diff --cached --stat`), not a strict authorship guarantee — if a file changed outside the agent's own tool calls (e.g. a human edit between turns), it's swept into the same commit and message.

---

## Developing Argo

Use standalone mode — the server runs directly on your Mac with hot-reload:

```bash
cd ~/Sources/Adobe/argo
pnpm dev
# → http://localhost:3001 (no workspace sub-path)
```

This mode uses the original `argo-sandbox` Docker container (from `docker/sandbox.Dockerfile`) for bash execution. Changes to `src/` or `public/` reload automatically.

After making changes, rebuild the worker image so production use picks them up:
```bash
pnpm build
argo rebuild
```

---

## Adding a new tool

Three files:

**1. `src/tools/my-tool.ts`**
```typescript
import type { ToolResult } from '../types.js'

export async function myTool(arg: string): Promise<ToolResult> {
  try {
    return { output: /* result */ }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
```

**2. `src/tools/index.ts`**
```typescript
// Add import
import { myTool } from './my-tool.js'

// Add to toolDefinitions array (description quality matters — this is what the model reads)
{
  type: 'function' as const,
  function: {
    name: 'my_tool',
    description: 'Clear description of what it does and when to use it.',
    parameters: {
      type: 'object',
      properties: {
        arg: { type: 'string', description: 'What this argument does' },
      },
      required: ['arg'],
    },
  },
},

// Add to executeTool switch
case 'my_tool':
  return myTool(args.arg as string)
```

**3. `src/types.ts`**
```typescript
export type ToolName = ... | 'my_tool'
```

`pnpm dev` picks up changes automatically. Run `argo rebuild` to bake them into the Docker image.

---

## Maintenance

### Rebuild the Docker image

Required after changing `docker/agent.Dockerfile` (adding packages, updating Node.js, etc.):

```bash
argo rebuild
# Then restart any running workspaces:
argo stop && argo <path>
```

### Add an npm package to the image

Edit `docker/agent.Dockerfile` — find the `npm install` block under the sandbox packages section. Add the package name there, then `argo rebuild`.

For a one-off without rebuilding: `npm install <package>` inside the workspace (installs locally, lost on container restart).

### Central server logs

```bash
tail -f ~/.local/share/argo/server.log
```

### Session logs

```bash
ls ~/.local/share/argo/logs/{workspace-name}/
# Each session: .jsonl (machine-readable) + .md (human-readable)
```

---

## Debugging

**`argo attach` says "Port 3000 already in use"**
A dev server is running. Kill it: `lsof -ti :3000 | xargs kill -9`

**Central server fails to start**
Check: `cat ~/.local/share/argo/server.log`

**Worker container won't start**
Check: `docker ps -a | grep argo-` and `docker logs argo-{name}`

**Agent outputs JSON text instead of calling tools**
Switch to `qwen3.6:latest` — the only model validated for agentic use in Argo (see [Models](#models)).

**`browser_fetch` failing**
```bash
docker exec argo-{name} node -e "require('playwright'); console.log('ok')"
```

**`require('cheerio')` not found in agent script**
The script must use CommonJS (`require`), not ESM (`import`). Verify `NODE_PATH` is set: `docker exec argo-{name} printenv NODE_PATH`

**Context window fills up**
Start a new session. Increase context window in the ⚙ settings panel.

---

## Project structure

```
argo/
├── bin/
│   └── argo                   ← CLI command (symlinked to /usr/local/bin/argo)
├── docker/
│   ├── agent.Dockerfile        ← Unified image: multi-stage TS build + Ubuntu runtime
│   └── sandbox.Dockerfile      ← Standalone dev mode only (pnpm dev)
├── public/                     ← Web UI — vanilla JS/HTML/CSS, no build step
│   ├── index.html              ← Argo UI (served at /ws/:name/ by central)
│   ├── workspaces.html         ← Workspace list (served at / by central)
│   ├── app.js                  ← All frontend logic
│   └── styles.css              ← All styles
├── src/
│   ├── index.ts                ← Entry point: central mode or worker/standalone
│   ├── central.ts              ← Central server: workspace registry, Docker mgmt, proxy
│   ├── server.ts               ← Worker/standalone: agent API, SSE, git, files endpoints
│   ├── dispatch.ts             ← The Orchestrator: Boss/Planner/Implementer dispatch loop
│   ├── frames.ts                ← Per-role tool sets, iteration budgets, system-prompt suffixes
│   ├── agent.ts                ← ReAct loop, Ollama integration, auto-commit, loop-recovery ladder
│   ├── loop.ts                 ← Loop-recovery ladder mechanics (repeat detection, cached replay)
│   ├── eviction.ts             ← Deterministic context eviction (no LLM summarization)
│   ├── ledger.ts                ← Append-only delegation/conclusion/episode audit trail
│   ├── al-logger.ts            ← Structured XML trace, one file per agent frame
│   ├── config.ts               ← Env vars, path resolution, timeouts
│   ├── types.ts                ← Shared TypeScript types + AgentEvent union
│   ├── logger.ts               ← Per-session JSONL log writer
│   └── tools/
│       ├── index.ts            ← Tool registry (toolDefinitions) + executeTool dispatcher
│       ├── bash.ts             ← Shell execution (local in container, docker exec in dev)
│       ├── browser-fetch.ts    ← Playwright via node --input-type=commonjs stdin
│       ├── fetch-url.ts        ← HTTP fetch + HTML strip
│       ├── file-ops.ts         ← read_file / write_file / edit_file
│       └── web-search.ts       ← Tavily API client
├── install.sh                  ← Symlinks bin/argo to /usr/local/bin
├── package.json
├── tsconfig.json
├── .env                        ← Dev-mode config (not committed)
└── .env.example                ← Template
```

---

## Roadmap

### Near-term
- [ ] Retry on Ollama connection drops
- [ ] Session history persistence across server restarts (currently in-memory only)
- [ ] Configurable tool output truncation limits
- [ ] UI: show Tavily usage count / remaining credits
- [ ] AEM/EDS-specific tools (EDS publish, import, content fetch)
- [ ] Custom system prompts per workspace type

### Next chapter

The containment model and logging infrastructure point toward more ambitious uses once local models are reliably capable enough:

- **Agent memory** — persistent knowledge of the codebase across sessions, built from the structured JSONL logs already being written
- **Visual trace** — Playwright screenshots streamed into the trace panel so you can see what the agent saw, not just the text it returned
- **Specialised agent roles** — distinct system prompts and tool subsets for test writer, code reviewer, documenter, and migrator roles
- **Multi-agent delegation** — ✅ built; a Boss/Planner/Implementer architecture, sequential (one LLM call at a time), not concurrent — see "Multi-agent architecture" above and `docs/subagents-plan.md`
- **MCP integration** — expose Argo workspaces as MCP servers so agents can delegate to each other across tool boundaries
- **Agent-to-agent communication** — a local message bus for agents to hand off tasks, share results, and build context cooperatively

---

## Design decisions

| Decision | Reasoning |
|---|---|
| Custom ReAct loop over LangChain/Dify | Frameworks break tool-calling with local Ollama models. Direct API is simpler and more predictable. |
| TypeScript over Python | Consistent with AEM/EDS primary stack (vanilla JS). |
| Docker for sandbox isolation | Limits blast radius without per-command confirmation prompts. Git in `/workspace` provides rollback. |
| Single `/workspace` mount | Only project files (committed) get a host mount. Everywhere else in the container is ordinary, ephemeral filesystem — no second special-cased directory needed to keep git history clean, since only `/workspace` is ever auto-committed. |
| Central + worker architecture | One agent instance per workspace, isolated state and history. Central server manages routing and Docker lifecycle without Docker-in-Docker. |
| Ollama on host | GPU/Metal access. Docker on macOS cannot expose the Apple Silicon GPU to containers. |
| Tavily over DuckDuckGo | DDG rate-limits aggressively. Tavily 1,000 free requests/month is sufficient for typical use. |
| CJS (`require`) not ESM | `NODE_PATH` resolves CommonJS modules but not ESM imports. Agent-written scripts must use `require()`. |
| JS-native execution over Python | Agents write and run the same JS toolchain as the projects they work on. No translation layer, no impedance mismatch between agent idioms and codebase idioms. |
| `spawn` + stdin for browser-fetch | Playwright scripts are too complex for shell escaping via `docker exec bash -c`. Piping to `node --input-type=commonjs` via stdin avoids all quoting issues. |
| SSE over WebSockets | Server-push only. REST handles the other direction. Simpler protocol, better browser debugging. |
| Vanilla JS frontend | Consistent with AEM/EDS stack. No build step. No framework to keep up to date. |
| `npm install --ignore-scripts` in Dockerfile | pnpm v11 blocks esbuild postinstall due to supply-chain policy. The Dockerfile builder uses npm instead. |
