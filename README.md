# Argo

A safe coding harness for local LLMs. Model weights stay on your GPU. Code never leaves your machine.

---

Local models are on a steep improvement curve. Quantized 14B models already rival hosted models on coding tasks, and that gap will narrow further. The limiting factor is no longer raw capability — it is containment, observability, and tooling. Argo is built around those three constraints.

The core safety primitive is Docker. Each workspace gets an isolated container with only the project folder mounted. The agent can execute bash, read and write files, fetch pages, and run Playwright scripts — but it cannot see other projects, cannot reach host paths outside the mount, and cannot exfiltrate data. The container is the boundary. As models become more capable, that boundary matters more, not less.

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
│ /scratch  ←─── │vol        │ /scratch  ←─── │vol
│   ~/.local/    │           │   ~/.local/    │
│   share/argo/  │           │   share/argo/  │
│   scratch/…    │           │   scratch/…    │
└────────────────┘           └────────────────┘
```

**Standalone mode** (`pnpm dev`) — full server on :3001, uses a separate `argo-sandbox` container for bash execution. Used for developing Argo itself.

**Central mode** (`CENTRAL_MODE=1`) — the workspace manager. Started by `bin/argo`.

**Worker mode** (`WORKER_MODE=1 RUNNING_IN_CONTAINER=1`) — API-only, no static files. Bash runs locally inside the container (no docker exec needed).

### Volumes per workspace

| Mount | Source on host | Purpose |
|---|---|---|
| `/workspace` | The project folder you attached | Git-tracked project files |
| `/scratch` | `~/.local/share/argo/scratch/{name}/` | Argo working dir: scripts, temp files, intermediate data |
| `/app/logs` | `~/.local/share/argo/logs/{name}/` | Session logs (JSONL + Markdown) |

---

## Prerequisites

- **macOS** with Docker Desktop
- **Ollama** installed: [ollama.com](https://ollama.com)
- At least one model pulled: `ollama pull qwen2.5-coder:14b`
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

## Daily use

```bash
# Attach any project folder and open Argo
argo ~/Sources/my-project

# From inside the project folder
cd ~/Sources/my-project
argo

# List all attached workspaces
argo list

# Stop everything when done
argo stop
```

Argo opens at `http://localhost:3000/ws/{name}/`. The workspace list is at `http://localhost:3000/`.

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
MODEL=qwen2.5-coder:14b
MAX_ITERATIONS=20
```

| Variable | Default | Description |
|---|---|---|
| `TAVILY_API_KEY` | *(empty)* | Web search — free tier at tavily.com |
| `MODEL` | `qwen2.5-coder:14b` | Default Ollama model |
| `MAX_ITERATIONS` | `20` | Max tool-call rounds per query before giving up |

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

| Model | Size | Notes |
|---|---|---|
| `qwen2.5-coder:14b` | 9.0 GB | **Recommended.** Strong at code and tool-calling. |
| `llama3.1:8b` | 4.9 GB | Most reliable tool-calling. Good fallback. |
| `gemma3:12b` | 8.1 GB | Good reasoning, weaker tool-calling. |
| `qwen2.5:14b` | 9.0 GB | Strong general tasks. |

To add any model: `ollama pull <name>` — appears in the UI immediately without restart.

---

## Agent tools

| Tool | Description | When it's used |
|---|---|---|
| `bash` | Run any shell command in the Docker sandbox | Scripts, file inspection, git ops, running Node.js |
| `web_search` | Search via Tavily API | Current information not in training data |
| `fetch_url` | HTTP GET + HTML strip. Fast (~100–300ms), no JS | Static pages, APIs, documentation |
| `browser_fetch` | Playwright/Chromium. Full JS execution (~3–5s) | SPAs, dynamic content, pages where fetch_url returns empty |
| `read_file` | Read a file from `/workspace` | Inspecting files directly |
| `write_file` | Write a file to `/workspace` | Saving scripts or results to the project |

### Workspace vs scratch

The agent has two directories:
- **`/workspace`** — the project folder (git-tracked, auto-committed after each task)
- **`/scratch`** — Argo's private working space for scripts, temp files, downloaded data (not committed)

The agent is instructed to keep work-in-progress files in `/scratch` and only write to `/workspace` when modifying the actual project.

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

**Files (right tab)** — file tree for both `workspace/` and `scratch/`. Click any file to preview its contents. Refreshes automatically after each completed task.

**Session Logs (right tab)** — list of all past sessions. Click any entry to read the full trace as Markdown or JSONL. Sessions accumulate across restarts and are the primary source of data for improving prompts and comparing models.

**Git Log (bottom)** — latest commit shown inline; click to expand older ones. Click "diff" to view exact changes. Auto-updates when the agent commits.

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
Switch to `llama3.1:8b` in the model dropdown — most reliable tool-calling.

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
│   ├── agent.ts                ← ReAct loop, Ollama integration, auto-commit
│   ├── config.ts               ← Env vars, path resolution, mode flags
│   ├── types.ts                ← Shared TypeScript types + ArgoEvent union
│   ├── logger.ts               ← Per-session JSONL + Markdown log writer
│   └── tools/
│       ├── index.ts            ← Tool registry (toolDefinitions) + executeTool dispatcher
│       ├── bash.ts             ← Shell execution (local in container, docker exec in dev)
│       ├── browser-fetch.ts    ← Playwright via node --input-type=commonjs stdin
│       ├── fetch-url.ts        ← HTTP fetch + HTML strip
│       ├── file-ops.ts         ← read_file / write_file
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
- **Multi-agent delegation** — multi-workspace support extended to multi-agent workflows: specialised agents running concurrently on different parts of a larger project, coordinated by an orchestrator
- **MCP integration** — expose Argo workspaces as MCP servers so agents can delegate to each other across tool boundaries
- **Agent-to-agent communication** — a local message bus for agents to hand off tasks, share results, and build context cooperatively

---

## Design decisions

| Decision | Reasoning |
|---|---|
| Custom ReAct loop over LangChain/Dify | Frameworks break tool-calling with local Ollama models. Direct API is simpler and more predictable. |
| TypeScript over Python | Consistent with AEM/EDS primary stack (vanilla JS). |
| Docker for sandbox isolation | Limits blast radius without per-command confirmation prompts. Git in `/workspace` provides rollback. |
| Two workspace volumes | `/workspace` for project files (committed), `/scratch` for agent working files (never committed). Keeps git history clean. |
| Central + worker architecture | One agent instance per workspace, isolated state and history. Central server manages routing and Docker lifecycle without Docker-in-Docker. |
| Ollama on host | GPU/Metal access. Docker on macOS cannot expose the Apple Silicon GPU to containers. |
| Tavily over DuckDuckGo | DDG rate-limits aggressively. Tavily 1,000 free requests/month is sufficient for typical use. |
| CJS (`require`) not ESM | `NODE_PATH` resolves CommonJS modules but not ESM imports. Agent-written scripts must use `require()`. |
| JS-native execution over Python | Agents write and run the same JS toolchain as the projects they work on. No translation layer, no impedance mismatch between agent idioms and codebase idioms. |
| `spawn` + stdin for browser-fetch | Playwright scripts are too complex for shell escaping via `docker exec bash -c`. Piping to `node --input-type=commonjs` via stdin avoids all quoting issues. |
| SSE over WebSockets | Server-push only. REST handles the other direction. Simpler protocol, better browser debugging. |
| Vanilla JS frontend | Consistent with AEM/EDS stack. No build step. No framework to keep up to date. |
| `npm install --ignore-scripts` in Dockerfile | pnpm v11 blocks esbuild postinstall due to supply-chain policy. The Dockerfile builder uses npm instead. |
