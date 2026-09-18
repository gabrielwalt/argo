# Local Argo — Claude Code Instructions

**Mission:** Argo is a **contained coding harness for locally-running LLMs** (Qwen, Mistral, …) — local, private, self-contained agentic coding. That harness is the goal; the tools that currently realize it are *means, not ends*. **Ollama** fills the "run local models" gap and **Docker** fills the "contain the environment" gap, and either should be swappable for a leaner or better fit (llama.cpp / LM Studio / vLLM / mlx for inference). "Local model" is the hard requirement; the specific runtime and sandbox are not. Stay **lean and local**: fewer services and fewer third-party dependencies is always better — adopt an external service or API only when it delivers real value no local option provides (e.g. web search via Tavily today, a reluctant exception to replace with a local alternative when one exists), never as clutter.

**Governing principle:** Simplicity is elegant and the ultimate sophistication. Every line of code and every visual effect must earn its place. No unnecessary abstractions, no gratuitous animations, no layers of indirection. When in doubt, do less.

**Lean by default:** Prefer the option with the smallest resource footprint (memory, running processes, dependencies, disk) whenever it doesn't sacrifice a capability Argo actually needs. Before adding a persistent process, a new heavyweight dependency, or a standing container, check for a lighter path first (on-demand launch instead of always-on, a narrower tool instead of a general-purpose one). When leanness would cost real capability (e.g. dropping Docker/Playwright for something that can't spawn real processes or run native code), keep the capability — lean is a tiebreaker between equally-capable options, not a reason to regress functionality.

**Zero trust toward the LLM:** The agent itself is treated as untrusted code, not a collaborator with implicit access. Two concrete rules follow: (1) it should never be able to reach anything on the host beyond its own mounted folder — this is what Docker's filesystem scoping is for, and it only covers the container's own execution; it does not and cannot protect secrets that already live inside the mounted project itself (a `.env` file in the user's repo, credentials the agent needs to read to do its job). (2) it should never hold Argo's own operational secrets (API keys) directly — those stay in central's process memory, and tools that need them (`web_search`) call a shadow proxy (`/internal/*` on central) instead of receiving the raw key. The agent can still trigger the *action* (a search); it just never sees or can exfiltrate the *credential*. See `src/health.ts`, `src/auth.ts`, and the `SECRET_KEY_PATTERN` filter in `central.ts`'s `startWorker`.

**The security boundary is the container, not `/workspace`.** `write_file`/`read_file`'s `/workspace` confinement (`file-ops.ts`) is a *workflow* rule — keep writes inside the actual git repo, not silently escape it — not a security layer. Every other path in the container is reachable directly through `read_file`/`write_file` too, same as it already was through `bash` (a general-purpose shell tool is intentionally unrestricted). This was verified directly (live container inspection + empirical testing, not assumed): only two bind mounts exist (`/workspace`, `/app/logs`), no docker socket, no SSH keys, no host root. One real inconsistency was found and fixed: `path.resolve()` is lexical and doesn't follow symlinks, so a symlink created inside `/workspace` (trivial via `bash`) pointing elsewhere used to let `write_file`/`read_file` silently read/write through it, bypassing their own stated confinement — `safePath()` now also re-resolves through `fs.realpath` and checks the *real* path. This didn't cross the actual (container) boundary — `bash` already had equal-or-greater reach — but it meant the workspace confinement's own guarantee wasn't consistently true. Regression tests: `src/tools/file-ops.test.ts`.

**Living documentation:** Keep every `.md` file in this project current. After any work session where new decisions, patterns, or lessons emerged, update the relevant file immediately — never defer. Include only what has lasting value; prune stale content ruthlessly. A good test: "Will this matter in 3 months?" If yes, capture it. If no, cut it. **Especially: whenever the user teaches you a concept or principle essential to Argo's future architecture or implementation, record it in the right file** — this file for working principles and agent-loop/harness design, `MEMORY.md` for terse cross-session facts. Periodically reflect back over everything the user has told you across the whole collaboration and capture anything durable that isn't written down yet; a principle stated in conversation but never recorded is a principle you will lose.

**Debug in the browser:** No browser-automation MCP tool is currently configured for this project — verify UI changes by reading the code, and where feasible by driving the running server directly (`curl` against the worker's own routes, e.g. `GET /frames`, `GET /status`) rather than assuming a screenshot tool exists. If a browser-automation MCP tool IS available in a given session, use it for real browser testing when: (a) the user explicitly asks for it, (b) a complex UI change was implemented and confidence in immediate correctness is low, or (c) the user is reporting the same issue a second time — reproduce first → confirm root cause → fix → verify before declaring done. `~/.claude/launch.json` has the standalone launch config (port 3001, or `http://localhost:3000/ws/{name}/` for the real worker) for whatever tool ends up used.

**Always end a task by naming the exact deploy command(s).** Whenever a task touches any file under `src/`, `public/`, `docker/`, or `bin/argo`, the final message must tell the user precisely what to run to see the change in THEIR actual local Argo — not a vague "rebuild if needed". Name the literal command(s), derived from which files changed and which process actually reads them:

- **`public/*` (`app.js`, `styles.css`, `index.html`)** — never needs a rebuild in any mode. Central's `/ws/:name/` route and static middleware read straight from the host's `public/` directory on every request (`src/central.ts`'s `PUBLIC_DIR`/`fs.readFile`) — say "just refresh the browser."
- **`src/*` files that run INSIDE the worker container** (everything except `central.ts` itself — `server.ts`, `agent.ts`, `dispatch.ts`, `frames.ts`, `tools/*`, `eviction.ts`, `loop.ts`, `ledger.ts`, `types.ts`, `config.ts`, `health.ts`, `auth.ts`, ...) — under `pnpm dev` (tsx watch, :3001) this reloads automatically, say so explicitly rather than staying silent. Under the real `argo` CLI, the running worker is a Docker container built from `docker/agent.Dockerfile`, which compiles TypeScript from `src/` INSIDE its own builder stage — a host-side `pnpm build` never reaches it. Say: run **`argo rebuild`** (rebuilds the image from current source), then re-attach the workspace (`argo <path>`) — an already-running worker container is not swapped out from under a live session, so a stale one may need `argo stop` first if a rebuilt image should take over immediately.
- **`src/central.ts` (or anything only central's own process imports/runs)** — this runs on the host as `dist/index.js`, compiled ahead of time. Say: run **`pnpm build`**, then restart central — **`argo stop && argo <path>`**.
- **`bin/argo`** — a plain shell script, no build step. Say: "takes effect on your next `argo` invocation."
- **Nothing under these paths changed** (e.g. a `.md`-only edit, a memory update) — no deploy note needed.

If a task touched multiple categories (e.g. both `server.ts` and `app.js`), give the full combined set of commands, in the order to run them, not just one.

---

## Conceptual model

Everything in this section is a precise definition. When writing code or UI copy, use these terms exactly — no synonyms.

### System layer

**Argo**
The system as a whole. A local-first AI agent platform that lets a user interact with LLMs to work on code projects. All model inference happens on the user's GPU via Ollama; no data leaves the machine.

**Central server**
A single long-running Node.js process (`src/central.ts`) on port 3000. Owns the workspace registry, manages Docker container lifecycles (start, stop, check), and HTTP-proxies all `GET /ws/:name/*` requests to the correct worker. There is exactly one central server per host.

**Worker**
A Node.js process (`src/server.ts`) running *inside* a Docker container, one per attached workspace, on a port in the range 3101–3199. Handles chat, tool execution, SSE streaming, file browsing, and git operations. The worker has no access to the host filesystem except through the `/workspace` mount it was given (plus `/app/logs`, used internally for its own session logs — not part of the agent's working model).

**Docker container**
The isolation primitive. Each workspace attachment creates a dedicated Ubuntu 24.04 container. `/workspace` (the user's project) is the only mount that matters to the agent — the container itself is the working environment, and everywhere else in it is ordinary, ephemeral filesystem that disappears when the container is removed (`--rm`). The container can reach Ollama on the host via the Docker host gateway, but cannot reach any other host filesystem path, other containers, or the internet unless tools explicitly fetch resources.

**Ollama**
The local LLM inference server. Runs on the host (not inside a container). Exposes an HTTP API that workers call to generate responses. Manages model weights on the GPU. Argo's *architecture* is model-agnostic — it talks to Ollama's generic chat API, not to a specific model. Whether a given model actually works well is a separate question: the ReAct loop needs a model tuned for structured, multi-turn tool-calling, and most local models aren't there yet (see Common debugging). That's a model-maturity gap the field is closing, not a hidden dependency Argo's design has on one model.

### Storage layer

**Workspace**
A host filesystem directory that the user has chosen to work on. Mounted read/write into the container at `/workspace`. Always a git repository (initialised on first attach if needed). This is the user's deliverable space: only files the user explicitly asked for as output belong here. The agent treats it like a clean codebase.

**Everywhere else**
The container is the agent's entire working environment; `/workspace` is the only directory that's special. Scripts, intermediate data, downloaded assets, experiments, debug output — all of it can go anywhere else in the container (`/tmp`, the home directory, wherever), with no host-persisted mount and no cleanup to manage: the container already runs with `--rm`, so it all disappears when the container goes away. There used to be a dedicated `/scratch` mount (`~/.local/share/argo/scratch/{name}/` on the host) for this — removed because the real boundary was always the container (see Zero trust toward the LLM), not which path inside it a file happened to live at; a second special-cased directory bought predictability for the agent's structured file tools but no actual isolation. The `bash` tool's `cwd` parameter accepts any absolute path (default `/workspace`) — use it instead of a hand-typed `cd /workspace &&` prefix for anything operating on the project itself (`npm test`, `git`, `node <project file>`).

**Git tracking**
The workspace is always git-tracked. `autoCommit()` initialises a git repo if the folder isn't tracked yet (`git init`), then commits all changes after every successful run. Every run that touches `/workspace` files ends with an `Agent:` prefixed commit. This is a core architectural guarantee — every change is auditable.

**Registry**
`~/.config/argo/workspaces.json`. A JSON array maintained by the central server mapping each workspace's name (derived from the folder name), host path, container name, and assigned port. Persists across restarts. The central server is the sole writer.

**Global env**
`~/.config/argo/env`. A `KEY=VALUE` file for host-level configuration: Tavily API key, default model, etc. Sourced by workers at container start.

**Ledger (session/frame storage)**
`.argo/sessions.json` + `.argo/frames/*.jsonl`, both **inside the workspace** (not under
`~/.local/share/argo/` — that old per-run JSONL+MD log, `history.json`, and `current-session.txt`
are all gone; nothing writes them any more, see `src/logger.ts`'s own header comment). `sessions.json`
(`src/ledger.ts`'s `SessionRegistry`) maps each session to its runs, each run to the ordered frames
(Dispatcher/Planner/Implementer) it spawned. Each frame gets its own append-only JSONL file under
`.argo/frames/<frameId>.jsonl` — every message that frame ever saw, plus UI-only metadata (thinking,
tool args, timing) never sent back to the model. See "Session" and "Conversation" below, and
`GLOSSARY.md` for the full terminology this maps onto.

### Session / interaction layer

**Session and Conversation** (see `GLOSSARY.md` for the canonical definitions — this file doesn't
redefine them a second way). A **Session** is the persistent connection to one workspace, spanning
every prompt the user ever sends it; the Dispatcher is the ONE frame that lives for a session's
entire lifetime (its ledger file is reloaded and extended on every new prompt). A **Conversation**
is one user request through to its resolution — what CLAUDE.md used to call a "Run" — and is scoped
to a single call to `runDispatchLoop`; a Conversation may spawn its own short-lived Planner/
Implementer frames, which start fresh and never carry over to the next Conversation. Sessions are
listed in the session dropdown; switching to a past session loads its messages into the chat view.
Conversations are an internal implementation detail — never surfaced directly in the UI.

**Agent loop (ReAct)**
The core processing pattern inside one frame's run: the LLM is given the full system prompt +
history and produces either (a) a final text answer (no tool calls) or (b) a thought + one or more
tool calls. Tool results are appended to history and the loop repeats. The iteration cap is
per-role, not a single flat number — `src/frames.ts`'s `ROLE_MAX_ITERATIONS` (dispatcher 15, planner
40, implementer 160).

Loop steering — a call repeating with no new information — is handled by `src/loop.ts`'s mutation-aware loop-recovery ladder, not a separate guard in `agent.ts`. See "Loop recovery" below for the full mechanism (L0 cached replay/steer, L1 eviction, L2 forced reframe, `halt`).

**System-prompt philosophy.** Each frame's opening messages (`src/frames.ts`'s `ROLE_IDENTITY`/`ROLE_INSTRUCTIONS`, assembled by `src/agent.ts`'s `chat()`) are for *high-level* steering (how to work) and role-specific instructions — not obvious low-level do/don't rules the model should already know or can infer, and deliberately no tool descriptions (Ollama's own `tools` parameter already shows those), filesystem paths, or memory/git mentions. We can't enumerate correct behavior, and a growing wall of such rules dilutes the prompt and effectively dumbs the model down. When a basic failure mode appears, fix it in the **harness** (a tool with real feedback, a loop steer, a guard) rather than adding a prompt line — e.g. `edit_file` (below) replaced a prompt rule about not reusing a stale remembered edit block, making that failure impossible instead of merely discouraged.

**Multi-agent dispatch, not a single loop.** Argo does not run one undifferentiated ReAct loop over the whole task any more. `src/dispatch.ts`'s `runDispatchLoop` is harness code (never itself an LLM call) that classifies the request via a **Dispatcher** frame (ANSWER / SIMPLE / OBJECTIVE), then either hands the whole thing to one **Implementer** frame (SIMPLE) or to a **Planner** frame that produces an ordered list of implementation units and is then resumed, once per unit, to produce each Implementer's self-contained assignment (OBJECTIVE). Every frame — Dispatcher, Planner, Implementer — is one scoped `src/agent.ts` `Agent` instance: same ReAct loop, same tool-dispatch code, different `allowedTools`/system-prompt suffix/iteration budget (`src/frames.ts`). This replaced an earlier `update_plan`-based single-loop design (`this.currentPlan`, a plan/act gate blocking mutation until a plan existed, harness-owned task-ledger sequencing, an LLM self-critique checkpoint, and a grounding/layout judge) — all of that machinery, plus the Tester agent that used to independently re-verify every Implementer's work, was removed once the dispatch architecture's own role separation and the Implementer's own verification step made it redundant. `conclude(status, message)` is now the ONLY way any frame ends its turn — a turn with no tool calls is a thinking turn, not a finish. (The Dispatcher role was previously named "Boss" — renamed for clarity; the underlying classification/summarization behavior is unchanged.)

**Context management is deterministic, not LLM-summarized.** `src/agent.ts`'s `manageContext` is a single unified pass — no model call, no structured-summary state file: once triggered, it walks assistant/tool messages newest-to-oldest and splits them into a verbatim/collapse/evict budget purely by estimated token cost (see "Context window"/"Context eviction"/"Fix — self-calibrating ratio" below for the exact algorithm and its self-calibrating token estimate). Nothing evicted or collapsed is actually gone: the full original survives in the frame's own append-only ledger file (`src/ledger.ts`, `.argo/frames/<frameId>.jsonl`) and can be recovered via the `ledger` tool's `expand`/`get_msg_id` actions. This replaced an older two-mechanism design — a CWL-episode classifier (exploratory | action) in `eviction.ts` plus a separate `agent.ts` tool-result collapse pass with its own independent trigger — unified because the two had different triggers and could disagree about what to do first; see `eviction.ts`'s own header comment for that history. Nothing in the current code classifies tool calls as episodes any more; `eviction.ts` today is just the shared token-estimation helper `manageContext` calls into.

**Loop recovery.** `src/loop.ts`'s ladder detects a no-progress repeat (same call, nothing changed since it last ran) and escalates: the FIRST no-progress repeat of a given call (up to `maxReplaysPerKey`, default 1) serves back the cached result of the earlier call without re-running it (labeled as a repeat, not a bare block); every escalation past that — the plain L0 steer, L1 (context eviction), and L2 (forced re-plan) — **actually re-runs the tool call for real** (`src/agent.ts`'s tool-dispatch loop, the `duplicateWarning` path) rather than skipping it. This changed 2026-09-18: skipping used to fabricate a `SKIPPED` tool-result error and suppress the real result, which left the model with nothing useful once the ONE cached replay's budget was spent and the earlier real result had aged out of context (evicted/collapsed/superseded) — a duplicate `bash`/`read_file`/etc. call costs nothing to re-run, and nothing about it has actually failed. The ladder's steering prose is instead pushed as a separate, ephemeral **warning** system message immediately AFTER the real tool result (never merged into it, never framed as an `Error:`) — ephemeral via the same `pruneHarnessMessages`/`HARNESS_MESSAGE_MAX_ITERATION_AGE=1` mechanism as a stall/reground nudge, so it informs only the very next model turn and is gone from context one turn later. `supersedeOlderCalls` still runs on a successful re-execution exactly as it would for any other real call, so the OLDER duplicated call (for `read_file`/`write_file`/`edit_file`/`fetch_url`) is still removed from context, not left as a second stale copy. If the model ignores the ladder long enough after L2, the frame `halt`s rather than looping indefinitely — reported as a partial result (never success); `halt` also re-runs its own triggering call for real (with the same warning) before ending the frame, for the same reason. A separate role-gate counter (H21, `noteGateRejection`) bounds a tool call refused for being outside the current frame's `allowedTools` — a genuine, permanent refusal, unlike a duplicate-call repeat, so it is unaffected by any of the above and still fabricates a rejection: escalating wording at the 3rd identical refusal, and the frame stops outright at the 6th.

The per-iteration Ollama call (`chatWithRetry` in `src/agent.ts`) gets **one automatic retry**. A failure of *only this call* — `withTimeout`'s own timeout, or a thrown error from the Ollama client (e.g. its Go backend rejecting a malformed qwen3.6 tool-call as `XML syntax error … <function> closed by </parameter>`) — used to end the whole run at the outer catch, forcing the user to notice and resend. It now emits a `warning`, waits `CHAT_RETRY_DELAY_MS` (default 2s, no backoff), and re-issues the identical request once; a second failure falls through to the existing outer catch unchanged. Safe because this call runs *before* any tool executes in the iteration (nothing has side-effected yet) and temperature > 0 gives the retry a real chance of parsing cleanly. This retry is applied to **nothing else** — never to tool execution (a bash command or file write must not be silently re-run) or to context eviction. If the user hits stop during the wait, the abort is honored (no retry into a stopped run).

**Iteration**
One pass through the ReAct loop: one Ollama API call + zero-or-more tool executions. Iteration `N` is shown in the status bar while the agent works. Each iteration appends to the Ollama message history.

**Thought**
The LLM's text content in a response that appears alongside or before tool calls — its visible reasoning. Shown as a collapsed trace item. Some models emit thoughts before every tool call; others only when they need to plan.

**Tool**
A named capability a frame can invoke. Each tool is defined in `src/tools/` and registered in `src/tools/index.ts`. Full set: `bash`, `write_file`, `read_file`, `edit_file`, `fetch_url`, `browser_fetch`, `web_search`, `ledger`, `conclude`. Not every role gets every tool — `src/frames.ts`'s `ROLE_TOOLS` restricts each frame (only the Implementer holds `write_file`/`edit_file`; Planner and Dispatcher also get `bash`, but for investigation only — `src/frames.ts`'s `patchBashForReadOnly` swaps in a read-only tool DESCRIPTION for those two roles so the schema itself never invites a write, while their own prompts state the project is read-only for them). Every tool returns `{ output: string, error?: string }` — they never throw. `write_file`/`read_file`/`edit_file` accept any absolute path in the container; `/workspace/...` is the only one that's confined and git-tracked. `edit_file` (`file-ops.ts`) does an exact-string replace and **reports what it did** — occurrences replaced plus the updated lines, line-numbered — or errors clearly when the text is missing or matches more than one place, so an edit never applies silently or to the wrong spot (the failure behind a real "did my edit work? let me look again…" loop). Prefer it over an in-place `sed`, which gives no such feedback. `conclude(status, message)` is the only way any frame ends its turn — a turn with no tool calls is a thinking turn, not a finish.

**Context window**
The LLM's token budget for one Ollama call (the full history + system prompt + tool definitions). Configured via `num_ctx` (default 65,536). Shown as a token counter in the header. Context management triggers at `CONTEXT_TRIGGER_PCT` (60%) of `num_ctx` (`src/agent.ts`'s `manageContext`) — **not** `config.compactReserveTokens`: that value only feeds a UI-facing `compactThreshold` display field in `server.ts` and is never read by the actual trigger decision, a docs/code drift that stood uncaught until 2026-09-18 (see Context eviction below for why it mattered in practice, not just as a documentation nit).

**Context eviction**
Deterministic, not an LLM summary — see `manageContext` in `src/agent.ts`. Below the 60% trigger, nothing happens. Once triggered: system/user messages are never touched; assistant/tool messages are walked newest-to-oldest, keeping the newest `CONTEXT_VERBATIM_PCT` (40%) of `num_ctx` worth verbatim, then of the older slice, the next `CONTEXT_COLLAPSE_PCT` (10%) gets COLLAPSED (head(150 chars) + a `[collapsed...; msg_id "X" to recover]` placeholder + tail(150 chars)), and everything past that gets fully EVICTED (bare `[evicted...]` marker, no preview). Nothing evicted is actually gone — the full original survives in the ledger (`src/ledger.ts`) and can be recovered via the `ledger` tool's `expand` action.

Whether the trigger and the internal verbatim/collapse/evict split actually fire at the RIGHT time depends entirely on how well token usage is *estimated* before the real number is known — and a flat chars-per-token constant turned out not to be good enough on its own. **Incident (2026-09-18, test-wind hex-grid run):** `eviction.ts`'s flat `CHARS_PER_TOKEN = 3.5` estimate is structurally blind to the tool-schema definitions sent with every request (never part of `this.history` at all — ~6KB/~1,700+ tokens of constant overhead per call, in that run's case) and was badly miscalibrated for that run's actual content (dense hex-grid coordinate/geometry math tokenizes far denser than the constant assumes). Result: real usage (Ollama's own `prompt_eval_count`) crossed 90% while the harness's own estimate never once reached its 60% trigger in a 13-turn run — `manageContext` never fired, confirmed directly via the UI's per-agent context gauge (which reads the real `prompt_eval_count`, not the estimate, and was accurately reporting 92% the whole time).

**Fix — self-calibrating ratio, not a better constant.** `Agent` now tracks `effectiveCharsPerToken`, recalibrated after every real Ollama response (`recalibrateCharsPerToken`) against the actual `prompt_eval_count`, and used everywhere the flat constant used to be: both the aggregate trigger check (`estimateCurrentTokens`, anchored to the last real measurement plus a calibrated-ratio estimate of whatever's been added since — bounding error to just the recent delta instead of compounding it over a whole run) and the internal per-message verbatim/collapse/evict budget walk inside `manageContext` itself (so the actual shrink decisions use the same corrected ratio, not just the trigger). Recalibration uses the DELTA between two consecutive real measurements, not the running total — a total-based ratio is contaminated by the constant tool-schema overhead (which would make it look artificially dense early in a frame's life, then wrongly apply that skew to much larger later content); a delta cancels the constant term out, isolating an honest per-turn density sample, blended via an EMA (`ALPHA=0.5`) and clamped to `[1,6]` chars/token so one edge-case measurement can't send every later estimate off a cliff. Falls back to the shared default (`eviction.ts`'s `CHARS_PER_TOKEN`) until the first real measurement of a frame's life, and resets on `reset()`/`loadHistory()` (a reloaded frame has no calibration data of its own). Regression suite: `src/eviction.test.ts`, `src/agent.test.ts`.

**Reasoning-artifact reinjection.** A model's own `thinking` output does not reliably survive into its NEXT turn's request just by being attached to a pushed `Message`'s `thinking` field — confirmed live (2026-09-18): whenever a turn also produced real `content` alongside `thinking` (with or without a tool call), the `thinking` half silently failed to reach later context. `Agent.pushReasoningArtifact` (`agent.ts`) is the one channel proven to survive: it re-pushes a turn's own scratch output as an explicit `[Reasoning]\n...`-prefixed assistant message, single-slotted — pushing a new one always removes every message the previous one occupied first, no stub, nothing worth recovering. Three shapes, by turn type: (1) a turn with a real tool call and `thinking` but no `content` — the `thinking` becomes the sole `[Reasoning]` artifact; `content` alongside a real tool call is never reasoning-labeled and is pushed as its own permanent message instead, since it accompanies a kept action. (2) A no-tool-call ("thinking") turn with only one of `content`/`thinking` — that one text becomes the sole artifact (a no-tool-call turn's own `content` is exactly as disposable as its `thinking`, since nothing was concluded either way). (3) A no-tool-call turn with BOTH — pushed as a **paired** artifact (real reasoning first, its own `content` second, both `[Reasoning]`-labeled): the two messages occupy the SAME slot-generation, so the second push never supersedes the first, and only the NEXT distinct reasoning artifact (from any later turn) removes both halves together. Regression suite: `src/agent.test.ts`.

**Model**
The Ollama model identifier (e.g. `qwen3.6:latest`, `llama3.1:8b`). Selected per session in the breadcrumb model picker. Applied on every Ollama API call within that session. Changing the model mid-session takes effect on the next run.

**Model options**
Per-session sampling parameters: `temperature`, `top_p`, `top_k`, `num_ctx`. Configured in the settings panel (⚙), which overrides the model's own preset. There is no single flat default any more — `src/agent.ts`'s `MODEL_PRESETS` sets per-model values on selection (e.g. qwen3.6: `temp=0.6, top_p=0.95, top_k=20`; qwen3.8: `temp=0.7, top_p=0.8, top_k=20`), both at `num_ctx=65536` and `num_predict=16384`. `num_predict` caps the maximum tokens (thinking + content + tool-call JSON combined) any ONE Ollama call may generate — without it, a thinking-enabled qwen3 model can generate up to `num_ctx` tokens of pure thinking before ever producing content, which has intermittently hung Ollama's MLX runner on Apple Silicon. Each preset also sets its own `think` default (qwen3.6: `true`; qwen3.8: `false` — see "Reasoning-artifact reinjection" above for what happens when a turn's whole `num_predict` budget goes to thinking with no tool call, and the qwen3.8 preset's own comment in `agent.ts` for the incident that set `think:false` specifically for that model).

### UI / streaming layer

**SSE (Server-Sent Events)**
The real-time event channel from worker to browser. The browser opens `GET /events` which keeps a persistent HTTP connection open. The worker pushes each agent event as a `data: {JSON}\n\n` frame. The browser's `EventSource` receives and dispatches these to `handleEvent()`.

**Trace block**
A collapsible UI element that appears in the chat window at the start of each run. Receives all agent events (iterations, thoughts, tool calls, tool results, compaction, git commits) as they stream in. Collapsed by default. Title shows "Running…" (gold) during the run, then "Agent trace · N tools · Xs" when done.

**Chat panel**
The left panel (~50% width). Contains: message history (user messages, assistant responses, trace blocks), the optional session-viewing banner, and the input form.

**Files panel**
The right panel (remaining width). Split into: file tree pane (left, default 240px) showing a single tree rooted at the container's filesystem, with `/workspace` expanded and labeled by default and everything else collapsed, and file viewer pane (right) showing the content of the selected file. Both panes are user-resizable.

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
- A **session** spans every prompt sent to one workspace (see "Session and Conversation" in the
  Conceptual model above); each individual prompt is its own **Conversation**, internally one
  `runDispatchLoop` call. Neither "conversation" nor "run" is an implementation detail the UI needs
  to expose — never show either term in the UI.
- The session dropdown shows only sessions (date + query preview + Clear button). No run/conversation counts, no sub-items.
- Terminology: "session" in all UI copy. Never "run", "conversation", or "trace run".

**Layout**
- The main layout is: chat panel (left, `--chat-width` CSS var, default 50%) | resize handle | files panel (right, flex: 1).
- The files panel is split: file tree pane (`--tree-width`, default 240px) | resize handle | file viewer pane.
- All panels are user-resizable via drag handles (`.resize-handle`). Both panels always visible — no collapse.
- The right panel contains **only** the file tree + viewer. No logs tab, no trace tab.
- File viewer opens inline in the right side of the files panel when clicking a file — never in a modal.

**Design system**
- All spacing is a multiple of 4 px.
- Hover on cards always uses gold border tint, never indigo/accent.
- Hover states, spacing, and color tokens live in `public/styles.css` — treat existing patterns there as the design reference.

**No native browser dialogs**
- Never use `confirm()` or `alert()` — they look out of place next to the rest of the UI. Use `confirmDialog(message)` (returns a `Promise<boolean>`, resolves on Cancel/Confirm) for destructive-action confirmations, and `showToast(message)` for transient error/status messages instead of `alert()`.
- Both are defined per-page: in `app.js` for `index.html` (worker/standalone), and inline in `workspaces.html`'s own `<script>` block, since that page is fully self-contained (own `<style>`, no shared JS file). Keep both copies in sync if the component changes.
- Markup: `#confirm-modal`/`#confirm-box` and `#toast-container` — present in both `index.html` and `workspaces.html`.

**How to capture future requirements**
- Whenever the user gives UI/UX feedback that implies a lasting rule, add it to this section immediately — before implementing the feature.

## What this project is

A coding harness for local LLMs running via Ollama. Docker containerisation covers the main containment concern: each workspace gets an isolated container with only the project folder mounted — the agent can execute bash, read and write files, and run Playwright scripts, but cannot reach other projects or the host filesystem outside the mount. It does not cover everything: containers get full outbound network access (no `--network` restriction) and no CPU/memory limits, so it stops the agent from touching the rest of the host, not from running up the network or the machine's resources. A password gate (`src/auth.ts`) protects the web UI itself, since central listens on all interfaces, not just localhost. The execution environment is JS-native (Node.js + CommonJS `require()`, Playwright, bash) — the same toolchain as the projects the agent works on. A web cockpit streams every agent decision in real time; every session is logged as JSONL + Markdown. Model weights stay on your GPU. See README.md for full documentation.

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

**Standalone** (`pnpm dev`) — full server on :3001 (PORT=3001 set in package.json), serves static files + API. Uses a separate `argo-sandbox` Docker container for bash execution (`docker exec argo-sandbox bash -c ...`). For developing Argo itself. Runs on :3001 specifically to avoid conflicting with the `argo` CLI central server on :3000. `WORKSPACE_PATH` is optional — there is no default `./workspace` fallback; if unset, the browser shows a "no workspace mounted" screen (`#no-workspace-screen` in `public/index.html`) with a path input that calls `POST /api/workspace` to mount a folder at runtime (no restart needed — `config.workspacePath` is mutated directly).

**Central** (`CENTRAL_MODE=1`) — workspace manager on :3000. Serves `workspaces.html` at `/`, proxies `/ws/:name/*` to worker containers. Manages Docker lifecycle. Started by `bin/argo`.

**Worker** (`WORKER_MODE=1 RUNNING_IN_CONTAINER=1`) — API-only server inside a Docker container. No static file serving. Bash runs locally (no docker exec — the code is already inside the container). One container per attached workspace.

Flow: `bin/argo attach /path` → ensures git/Docker/Ollama present → ensures image built → starts central server → POST `/api/attach` → central starts worker container → opens browser at `localhost:3000/ws/{name}/`.

## Startup checks

`src/health.ts` (`checkOllama`, `checkDocker`, `checkGit`, `checkEnvironment`) verifies the runtime dependencies Argo has no fallback for. `checkGit` shells out through whichever path `bash.ts` would use (in-container `git --version`, or `docker exec {sandboxContainer} git --version` on the host), so it reflects the actual execution environment, not just the host.

- `bin/argo`'s `cmd_attach` calls `ensure_git`/`ensure_docker`/`ensure_ollama` before starting central (CLI pre-flight, skipped if central is already running).
- `startServer()` (standalone + worker) runs `checkEnvironment()` after `app.listen` and logs `✓`/`✗` per dependency; results are exposed on `GET /status` as `env: { ollama, docker, git }` so the frontend can show `#env-banner`.
- `startCentral()` runs `checkOllama`/`checkDocker` the same way (git isn't central's concern — it never executes commands itself, only proxies to workers).
- These are warnings, not hard failures — a check failing doesn't stop the server, since the dependency may come up moments later (e.g. Docker Desktop still starting). The one hard stop is `bin/argo`'s CLI pre-flight, which does `exit 1` before central ever starts.

## Auth (`src/auth.ts`)

Argo's web UI is password-gated because central listens on all interfaces, not just localhost — see "What this project is". `installAuth(app)` wraps every route after it in `requireAuth`, except `/login` and `/internal/*` (a separate, non-user-facing gate — see Zero trust toward the LLM).

- Password defaults to `unacroquetta` (`config.password`, overridable via `ARGO_PASSWORD` in `~/.config/argo/env`). This is a shared-password gate, not real per-user auth — anyone who reads this file or the source default knows it. It's meant to keep casual LAN traffic out, not to withstand a determined attacker.
- Browser auth is a cookie (`argo_auth`, `sha256(password)`, `httpOnly`, `sameSite=strict`) set by `POST /login`. `GET` requests without it redirect to `/login?next=<original path>` and back on success — don't drop the `next` param when touching this flow, it's what makes login not maroon you on the home screen.
- `bin/argo`'s CLI has no browser session, so it sends the password as an `X-Argo-Password` header instead (`acurl` wrapper) — `requireAuth` accepts either. `ensure_central` sources `~/.config/argo/env` into central's process env before launching it, which is also how `ARGO_PASSWORD` (and in principle other global settings) actually reach central's own `config` — `loadGlobalEnv()` alone only re-reads that file for worker container injection, not for central's own process.
- `installAuth` is called unconditionally in `central.ts`, and only when `!config.inContainer` in `server.ts` — worker mode is reached exclusively through central's proxy (its own Docker-published port is bound to `127.0.0.1`, see `startWorker`), so it doesn't need its own copy of the password to check against.

*How to add a new tool: see the `argo-add-tool` skill.*

## Tool output conventions

- Always return `{ output: string, error?: string }` — never throw
- Truncate long outputs to prevent context window overflow (see `MAX_OUTPUT` constants in each tool, and `truncateOutput` in `src/tools/truncate.ts` for the standard head+tail shape — prefer it over a bare `.slice(0, N)`, which silently drops whatever's past the cutoff even when the useful part is at the end) — **except** `write_file`/`edit_file`, which echo the file's full resulting content back with no cap at all. The distinction: a tool result is only a truncation candidate when its content is external/uncontrolled-size and the tool didn't author it (`bash` output, a fetched page, an existing file `read_file` opens) — `write_file`/`edit_file`'s echo is the model's OWN just-produced text, and cutting it off leaves the model unsure what the back half of its own file says, which is exactly what produces an unnecessary follow-up read to check.
- Errors go in `error` field, not output — argo loop shows them differently in the UI

## The bash tool pattern

`bash.ts` checks `config.inContainer`. `cwd` defaults to `/workspace` and accepts any absolute path — not a security boundary (the container is), just the one directory that's actually special:
- **In container** (worker mode): `execFile('bash', ['-c', command], { cwd: resolvedCwd })`
- **On host** (standalone mode): `execFile('docker', ['exec', '-w', resolvedCwd, sandboxContainer, 'bash', '-c', command])`

Uses `execFile` with an argv array — **not** `exec` with a single command string. `exec()` always runs its string through an *additional*, unintended shell (`/bin/sh -c`) before the command reaches the `bash -c` above. Multi-line commands used to be built via `` `bash -c ${JSON.stringify(command)}` `` passed to `exec()`; that extra outer shell doesn't treat JSON's `\n` escapes as newlines (POSIX double quotes don't recognize that escape) and still expands `$VAR`/`$(...)` inside double quotes — so every multi-line command (heredocs, `for` loops, multi-line `node -e`) arrived corrupted, and variables/substitutions could silently evaluate twice in the wrong shell/environment (e.g. `TMPDIR=$(mktemp -d)` reading back empty). `execFile` hands `command` to the inner `bash -c` as one argv element, byte-for-byte, with no intermediate shell at all. Regression tests: `src/tools/bash.test.ts` (`pnpm test`) — requires a running sandbox container (defaults to `argo-test-one`, override via `TEST_SANDBOX_CONTAINER`).

For multi-line JS scripts, the model uses `write_file` with a path outside `/workspace` (e.g. `/tmp/script.js`), then runs it with `node`. Both `write_file` and `read_file` accept any absolute path in the container. Inline multi-line `node -e "..."` now works correctly (see above) but writing to a script file is still preferred for anything non-trivial — easier to inspect/rerun.

`browser-fetch.ts` uses `spawn` with stdin instead of `exec` — it generates a CJS script with URL/waitFor JSON-embedded and pipes it to `node --input-type=commonjs` (either locally or via `docker exec -i`) to avoid all quoting/escaping issues.

## Session architecture

A **session** (see "Session and Conversation" above) = every Conversation between two `POST /reset`
calls, sharing the persistent Dispatcher frame and its accumulated history.

- `sessionId` is a timestamp string (`2024-01-15T14-30-00`). The active one is
  `.argo/sessions.json`'s `currentSessionId` field (`ledger.ts`'s `setCurrentSession`/
  `getCurrentSession`) — there is no separate pointer file any more.
- `POST /reset` and `DELETE /logs` mint a fresh session ID via `ledger.setCurrentSession`.
- `POST /resume/:sessionId` just switches the `currentSessionId` pointer — the persistent
  Dispatcher frame's own preload (its ledger file, keyed on frame id, not session id) is what
  actually restores context the next time it's spawned; there's no separate "load history into the
  shared agent" step.
- `GET /logs` reconstructs each session's events straight from the ledger
  (`reconstructSessionEvents`/`reconstructFrameEvents` in `server.ts`) — nothing writes a session
  log file for this any more, it's rebuilt on read.
- `DELETE /logs/:sessionId` removes that session's registry entry and every frame file it owns
  (`ledger.deleteSession`).

UI session dropdown shows: "New session" CTA, current live session ("Now"), then past sessions (date + last-query preview + Clear button), then "Clear all history". The live session is filtered from the past list using the session ID from `GET /status`.

## The SSE event flow

```
agent.ts emitAndLog(event)
  → this.emit(event, seq)         dispatch.ts's tagEmit adds __frameId/__role, then
                                   calls server.ts's emitEvent → bus.emit('agent', ...)
    → all SSE clients get:        data: {JSON}\n\n
  → this.traceLogger?.logEvent()  appends to this frame's Markdown trace file (al-logger.ts)
pushCtx() (separately, per message pushed to history)
  → ledger.recordMessage()        appends to .argo/frames/<frameId>.jsonl
```

## Config

`src/config.ts` resolves env vars. Key flags:
- `config.inContainer` — true when `RUNNING_IN_CONTAINER=1`; changes bash execution path
- `config.workerMode` — true when `WORKER_MODE=1`; disables static file serving
- `MODEL` — default Ollama model
- `MAX_ITERATIONS` — default 1000
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

*Common debugging (symptom → cause/fix): see the `argo-troubleshooting` skill.*

## Nav dropdown positioning

All three nav dropdowns (session, workspace, model) use `position: fixed` with coordinates calculated via `getBoundingClientRect()` in JS. Do NOT change `.nav-dropdown` to `position: absolute` — Chrome clips absolute-positioned descendants at `overflow: hidden` ancestor boundaries even when that ancestor is not the containing block. The `#breadcrumb` element must NOT have `overflow: hidden` for the same reason.

## What NOT to do

- Don't add `node_modules/` or `dist/` to git — they're gitignored
- Don't commit `.env` — contains the Tavily API key
- Don't use `exec` for browser-fetch scripts — use `spawn` with stdin (already done; Chromium scripts are too complex for shell escaping)
- Don't put tool logic in `server.ts` or `agent.ts` — keep tools in `src/tools/`
- Don't use ESM `import` in agent-written scripts — `NODE_PATH` only works with CommonJS `require()`
- Don't use `pnpm` in the Dockerfile builder stage — use `npm install --ignore-scripts`
