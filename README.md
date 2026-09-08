# Argo

A **contained multi-agent coding harness for locally-running LLMs**. Model weights stay on your machine, inference never leaves it, and the agents work inside isolated Docker containers.

Every request goes through a **Dispatcher → Planner → Implementer** pipeline. The Dispatcher classifies the request; for anything beyond a direct answer, a Planner decomposes it into tasks and Implementers execute them. See `docs/architecture.md` for the full design.

## Prerequisites

- **macOS** with Docker Desktop
- **Ollama**: [ollama.com](https://ollama.com) — `ollama pull qwen3.6:latest`
- **Node.js v22**: `nvm install 22 && nvm use 22`
- **pnpm**: `npm i -g pnpm`
- Optional: **Tavily API key** for web search (free tier at [tavily.com](https://tavily.com))

## Setup

```bash
cd ~/Sources/adobe/argo
pnpm install
pnpm build
./install.sh          # symlinks bin/argo to /usr/local/bin/argo
nano ~/.config/argo/env   # add TAVILY_API_KEY, set MODEL
```

The Docker image is built automatically on first use (~5 minutes).

## Usage

```bash
argo ~/Sources/my-project     # attach a project and open the UI
argo list                      # list running workspaces
argo stop                      # stop everything
argo rebuild                   # rebuild the Docker image after changes
argo rebuild --fresh           # full rebuild (re-downloads Chromium etc.)
```

Each workspace gets its own isolated container at `http://localhost:3000/ws/{name}/`.

## Configuration

Global config lives in `~/.config/argo/env`:

| Variable | Default | Description |
|---|---|---|
| `TAVILY_API_KEY` | *(empty)* | Web search API key |
| `MODEL` | `qwen3.6:latest` | Default Ollama model |
| `MAX_ITERATIONS` | `1000` | Max tool-call rounds per query |

## Models

**Use `qwen3.6:latest`** — the only model validated end-to-end. Other models (`devstral:24b`, `llama3.1:8b`) emit tool calls but don't reliably complete multi-step tasks.

Any model pulled via `ollama pull` appears in the UI dropdown automatically.

## Agent Tools

| Tool | Description |
|---|---|
| `bash` | Shell commands in the Docker sandbox |
| `read_file` | Read files (with pattern search) |
| `write_file` | Write files |
| `edit_file` | Replace exact text in a file |
| `fetch_url` | HTTP GET + HTML strip (no JS) |
| `browser_fetch` | Playwright/Chromium (full JS) |
| `web_search` | Tavily web search |
| `ledger` | Query cross-agent message history, recover evicted content |
| `conclude` | End the current frame with status + message |

Not every role gets every tool. Dispatcher and Planner are read-only (no `write_file`/`edit_file`). See `src/frames.ts`.

## Developing Argo

```bash
pnpm dev              # dev server on :3001 with hot-reload
pnpm build            # compile TypeScript
argo rebuild          # bake changes into the Docker image
```

### Adding a new tool

1. Create `src/tools/my-tool.ts` — export a function returning `ToolResult`
2. Add the tool definition to `toolDefinitions` in `src/tools/index.ts` and wire it into `executeTool`
3. Add the tool name to `ToolName` in `src/types.ts`

## Project Structure

```
argo/
├── bin/argo                    # CLI
├── docker/
│   ├── agent.Dockerfile        # Worker image (multi-stage: TS build + Ubuntu runtime)
│   └── sandbox.Dockerfile      # Dev mode only
├── public/                     # Web UI (vanilla JS, no build step)
│   ├── app.js, styles.css, index.html, workspaces.html
├── src/
│   ├── dispatch.ts             # Dispatcher/Planner/Implementer pipeline
│   ├── agent.ts                # ReAct loop, Ollama streaming, tool execution
│   ├── frames.ts               # Per-role tools, budgets, prompts
│   ├── loop.ts                 # Loop-recovery ladder (L0→L1→L2→Halt)
│   ├── eviction.ts             # Deterministic context eviction
│   ├── ledger.ts               # Append-only message ledger
│   ├── server.ts               # Worker API, SSE, git/file endpoints
│   ├── central.ts              # Workspace registry, Docker management, proxy
│   ├── logger.ts               # Per-session JSONL log writer
│   ├── al-logger.ts            # Markdown trace logger
│   ├── config.ts               # Environment config
│   ├── types.ts                # Shared types
│   └── tools/                  # Tool implementations
├── docs/architecture.md        # Architecture overview
├── GLOSSARY.md                 # Terminology
└── MEMORY.md                   # Persistent learnings
```
