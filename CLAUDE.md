# Local Argo — Claude Code Instructions

**Mission:** Argo is a **contained coding harness for locally-running LLMs** (Qwen, Mistral, …) — local, private, self-contained agentic coding. That harness is the goal; the tools that currently realize it are *means, not ends*. **Ollama** fills the "run local models" gap and **Docker** fills the "contain the environment" gap, and either should be swappable for a leaner or better fit (llama.cpp / LM Studio / vLLM / mlx for inference; WASI or similar for containment — see `SANDBOXING-ALTERNATIVES.md`). "Local model" is the hard requirement; the specific runtime and sandbox are not. Stay **lean and local**: fewer services and fewer third-party dependencies is always better — adopt an external service or API only when it delivers real value no local option provides (e.g. web search via Tavily today, a reluctant exception to replace with a local alternative when one exists), never as clutter. When weighing a dependency (including reusing another harness like Pi), a multi-provider/remote-oriented stack is a poor fit here: it is weight Argo pays for capabilities it will never use.

**Governing principle:** Simplicity is elegant and the ultimate sophistication. Every line of code and every visual effect must earn its place. No unnecessary abstractions, no gratuitous animations, no layers of indirection. When in doubt, do less.

**Lean by default:** Prefer the option with the smallest resource footprint (memory, running processes, dependencies, disk) whenever it doesn't sacrifice a capability Argo actually needs. Before adding a persistent process, a new heavyweight dependency, or a standing container, check for a lighter path first (on-demand launch instead of always-on, a narrower tool instead of a general-purpose one). When leanness would cost real capability (e.g. dropping Docker/Playwright for something that can't spawn real processes or run native code), keep the capability — lean is a tiebreaker between equally-capable options, not a reason to regress functionality. A lighter, non-Docker sandboxing approach was researched in depth and deliberately deferred — see `SANDBOXING-ALTERNATIVES.md` before re-litigating this from scratch.

**Zero trust toward the LLM:** The agent itself is treated as untrusted code, not a collaborator with implicit access. Two concrete rules follow: (1) it should never be able to reach anything on the host beyond its own mounted folder — this is what Docker's filesystem scoping is for, and it only covers the container's own execution; it does not and cannot protect secrets that already live inside the mounted project itself (a `.env` file in the user's repo, credentials the agent needs to read to do its job). (2) it should never hold Argo's own operational secrets (API keys) directly — those stay in central's process memory, and tools that need them (`web_search`) call a shadow proxy (`/internal/*` on central) instead of receiving the raw key. The agent can still trigger the *action* (a search); it just never sees or can exfiltrate the *credential*. See `src/health.ts`, `src/auth.ts`, and the `SECRET_KEY_PATTERN` filter in `central.ts`'s `startWorker`.

**The security boundary is the container, not `/workspace`.** `write_file`/`read_file`'s `/workspace` confinement (`file-ops.ts`) is a *workflow* rule — keep writes inside the actual git repo, not silently escape it — not a security layer. Every other path in the container is reachable directly through `read_file`/`write_file` too, same as it already was through `bash` (a general-purpose shell tool is intentionally unrestricted). This was verified directly (live container inspection + empirical testing, not assumed): only two bind mounts exist (`/workspace`, `/app/logs`), no docker socket, no SSH keys, no host root. One real inconsistency was found and fixed: `path.resolve()` is lexical and doesn't follow symlinks, so a symlink created inside `/workspace` (trivial via `bash`) pointing elsewhere used to let `write_file`/`read_file` silently read/write through it, bypassing their own stated confinement — `safePath()` now also re-resolves through `fs.realpath` and checks the *real* path. This didn't cross the actual (container) boundary — `bash` already had equal-or-greater reach — but it meant the workspace confinement's own guarantee wasn't consistently true. Regression tests: `src/tools/file-ops.test.ts`.

**Living documentation:** Keep every `.md` file in this project current. After any work session where new decisions, patterns, or lessons emerged, update the relevant file immediately — never defer. Include only what has lasting value; prune stale content ruthlessly. A good test: "Will this matter in 3 months?" If yes, capture it. If no, cut it. **Especially: whenever the user teaches you a concept or principle essential to Argo's future architecture or implementation, record it in the right file** — this file for working principles and agent-loop/harness design, `DESIGN.md` for visual identity, `MEMORY.md` for terse cross-session facts. Periodically reflect back over everything the user has told you across the whole collaboration and capture anything durable that isn't written down yet; a principle stated in conversation but never recorded is a principle you will lose.

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
The core processing pattern inside a run: the LLM is given the full system prompt + history and produces either (a) a final text answer (no tool calls) or (b) a thought + one or more tool calls. Tool results are appended to history and the loop repeats. Up to `MAX_ITERATIONS` per run (default: 1000).

A **loop-steering guard** (`src/agent.ts`, `REPEAT_WINDOW`/`REPEAT_THRESHOLD`, `loopSteerMessage`) handles the model spinning on a call that yields no new information — measured in real logs at up to **85 consecutive** identical `bash` calls and 11 identical `read_file` calls. Each *executed* `(tool name + JSON.stringify(args))` pair is recorded in a small rolling window (last 6, reset per `chat()`, never persisted). Once an identical call has already run `REPEAT_THRESHOLD` (3) times, the next identical call is **not executed** — re-running only reproduces a result already in context — and an **escalating steer** is injected in its place (a `warning` event + a synthetic `role:'tool'` message): level 1 observes "same result, no new information" and offers concrete escape routes (verify a change where it actually applies — `edit_file` reports the exact lines it changed; try different arguments/a different tool; or give the final answer); level 2+ is firmer ("STOP…"). Escalation resets when a genuinely novel call runs. **It never terminates the run** — the model keeps working; `MAX_ITERATIONS` and the user's stop button are the only hard bounds. This deliberately replaced an earlier *hard-stop* guard that ended a real run at iteration 7 right after a **successful** edit, because the model was re-verifying the wrong lines and looked stuck: the objective is "let it run as long as it needs, but help it out of loops," so a steer — not a kill — is the correct response. The signal is **tool-agnostic** (`tool + args`): 2 of 3 observed loops were `bash`/`sed`. Threshold is loose (steer only from the 3rd repeat) — legitimate consecutive repeats never exceeded 2 in the corpus. Thought-text repetition is intentionally *not* a separate detector: it always co-occurred with an identical tool call this already catches.

**System-prompt philosophy.** `SYSTEM_PROMPT` (`src/agent.ts`) is for *high-level* steering (how to work), **tool awareness**, and Argo context — not obvious low-level do/don't rules the model should already know or can infer. We can't enumerate correct behavior, and a growing wall of such rules dilutes the prompt and effectively dumbs the model down. When a basic failure mode appears, fix it in the **harness** (a tool with real feedback, a loop steer, a guard) rather than adding a prompt line — e.g. `edit_file` (below) replaced a prompt rule about not reusing a stale remembered edit block, making that failure impossible instead of merely discouraged. A maintainer note to this effect sits directly above `SYSTEM_PROMPT`.

**Plan-first working discipline (anti-drift) — the `update_plan` mechanism.** Counters two real failures. (1) *Goal-substitution drift*: asked to fix a simulation whose energy exploded to ~1e33, the model spent ~90 iterations re-deriving a general energy-conserving scheme (~40 throwaway `/tmp` scripts), never reproduced the reported blow-up, never converged — it solved a more interesting problem than the one asked, with no definition-of-done. Root-cause analysis **ruled out compaction**: the run's user prompt is kept verbatim on every compaction (`history[currentRunStart]` is never folded) and the distilled `USER REQUIREMENTS` even retained an earlier "stop rewriting the transport block" constraint — the signal survived and the model drifted anyway, so the failure was the *absence of a working method*, not lost context. (2) *Plan-and-stop*: a first attempt fixed this purely in the prompt ("state a short plan…"), but the model then emitted the plan as **prose with no tool call**, and the ReAct loop's "no-tool-call = done" rule ended the run. **Lesson: prompt wording alone cannot enforce plan-then-act on local models — a prose plan is indistinguishable from a final answer.** So planning is a *harness mechanism*, not just prompt text (`src/agent.ts`):
- **`update_plan` tool** — the model records/refines a plan (one concrete, *verifiable* objective + steps). It is a **tool call**, so recording a plan can never trip the done condition. Intercepted inside the loop (`handleUpdatePlan`), not `executeTool` — it mutates agent state and emits a `plan` event rather than returning sandbox output.
- **Harness-owned plan state, never committed.** `this.currentPlan` lives in memory, is surfaced to the UI as a `plan` event (rendered as a message-level card; refinements pop up as new cards) and logged for replay — deliberately **not** a `/workspace` file, so it is never swept into the auto-commit of the user's repo. Reset per run.
- **Recitation.** `chatCall` re-injects the plan at the *tail* of context every iteration (Manus `todo.md` pattern) so the objective stays in recent attention over long runs; transient, so it survives compaction for free.
- **Re-grounding done-gate (artifact-keyed for versatility).** If a plan is active, the first no-tool-call "done" is nudged **once** to verify the objective against the reported symptom before the run ends. A run with **no** plan (simple question / one-line change) finishes immediately with zero overhead — a run with no plan finishes fast, so trivial tasks and Q&A are untouched.
- **Plan/act gate (enforcement — `isProjectMutation` + the gate in `chat()`).** Real logs proved encouragement alone fails: with `update_plan` deployed, *neither* qwen (dove straight into editing) *nor* devstral (narrated a prose plan and stopped) called it. So planning is enforced, not merely requested — the model reads/greps freely, but a project mutation (`edit_file`/`write_file` under `/workspace`) is **blocked until a plan is recorded** (steered to `update_plan` first, then the change proceeds). Plan-vs-act is thus a state with different rules (Cline/Roo), gated by *about to change the project* rather than a task classifier, so read-only runs and questions never plan (versatility preserved). Known gap: a model that narrates a plan and stops *without attempting a mutation* (devstral — a local-model tool-calling weakness) isn't caught by the gate; a blunt "re-prompt any no-op finish" would tax every one-shot answer (and breaks the retry test's one-shot-answer contract), so it's deferred to a targeted Ollama `tool_choice` experiment. No task classifier, no forced phase, no second model.

The `PLANNING` section of `SYSTEM_PROMPT` now points the model at the tool ("call `update_plan`," not "state a plan") and says simple tasks need no plan. Full sourced rationale — Cline/Roo mode-as-state, Manus recitation, Magentic-One stall counter, Aider repo-map, and why NOT a two-phase restart or a second planner model for a single local model — is in `docs/research.md` (Part 1). Deferred to Stage 2 if the real logs warrant it: read-only tool gating during planning, a stall counter that forces a re-plan, and Ollama `tool_choice` forcing. Note: `src/` changes need `pnpm build` + `argo rebuild` to reach production workers; the `update_plan` tool, plan events, and done-gate are all in the worker (`src/`), the plan card/CSS in `public/` (served by central).

**Current direction — what the eval shows (as of 2026-07).** The plan/act mechanism is validated on `qwen3.6`: on the end-to-end eval it completes all four self-verifying tasks (simple additions, the multi-function `store-deps`, and the big cross-cutting `bigproj-deps`), planning once and converging in 7–11 iterations — the 90-iteration drift class is gone. **`qwen3.6:latest` is the target model.** `devstral:24b` and `llama3.1:8b` are kept only as eval comparators: devstral emits tool calls but under-executes (finishes early with the suite still red — a tool-call *emission* ceiling, Phase 2), and llama engages the workflow but lacks the coding depth (it once re-planned seven times to the iteration cap). The eval is the gate for adopting any future model, including a newer qwen — method, task catalog, and the full run log are in `docs/eval-log.md`; the forward plan is in `docs/roadmap.md`. Known gap the eval surfaced: `isProjectMutation` only covers `edit_file`/`write_file`, so a model can write project files through `bash` and bypass the plan/act gate; whether to close it is a Phase-3 decision — measure first. Forward work (better prompts, tools, planning/steering, memory, sub-agents) is measured against the qwen baseline; do not add a loop mechanism the eval does not show helps.

The per-iteration Ollama call (`chatWithRetry` in `src/agent.ts`) gets **one automatic retry**. A failure of *only this call* — `withTimeout`'s own timeout, or a thrown error from the Ollama client (e.g. its Go backend rejecting a malformed qwen3.6 tool-call as `XML syntax error … <function> closed by </parameter>`) — used to end the whole run at the outer catch, forcing the user to notice and resend. It now emits a `warning`, waits `CHAT_RETRY_DELAY_MS` (default 2s, no backoff), and re-issues the identical request once; a second failure falls through to the existing outer catch unchanged. Safe because this call runs *before* any tool executes in the iteration (nothing has side-effected yet) and temperature > 0 gives the retry a real chance of parsing cleanly. This retry is applied to **nothing else** — never to tool execution (a bash command or file write must not be silently re-run) or to compaction. If the user hits stop during the wait, the abort is honored (no retry into a stopped run).

**Iteration**
One pass through the ReAct loop: one Ollama API call + zero-or-more tool executions. Iteration `N` is shown in the status bar while the agent works. Each iteration appends to the Ollama message history.

**Thought**
The LLM's text content in a response that appears alongside or before tool calls — its visible reasoning. Shown as a collapsed trace item. Some models emit thoughts before every tool call; others only when they need to plan.

**Tool**
A named capability the agent can invoke. Each tool is defined in `src/tools/` and registered in `src/tools/index.ts`. Available tools: `bash`, `write_file`, `read_file`, `edit_file`, `fetch_url`, `browser_fetch`, `web_search`. Every tool returns `{ output: string, error?: string }` — they never throw. `write_file`/`read_file`/`edit_file` accept any absolute path in the container; `/workspace/...` is the only one that's confined and git-tracked. `edit_file` (`file-ops.ts`) does an exact-string replace and **reports what it did** — occurrences replaced plus the updated lines, line-numbered — or errors clearly when the text is missing or matches more than one place, so an edit never applies silently or to the wrong spot (the failure behind a real "did my edit work? let me look again…" loop). Prefer it over an in-place `sed`, which gives no such feedback.

**Context window**
The LLM's token budget for one Ollama call (the full history + system prompt + tool definitions). Configured via `num_ctx` (default 32,768). Shown as a token counter in the header. Compaction triggers at `config.compactThreshold` (default 66.7%) of `(prompt_tokens + config.compactGenerationReserve)` — the reserve accounts for the *next* response, not just what's already consumed. Both are env-configurable (`COMPACT_THRESHOLD`, `COMPACT_GENERATION_RESERVE`).

**Compaction**
Structured, not a single free-form summary — see `src/compaction.ts`. Three things are always kept verbatim regardless of how long the run has gone: the message that started the *current* run (`history[currentRunStart]`, tracked through the run and not confused with `history[0]`, which is just the session's first-ever message), the antecedent turn immediately before it (bounded lookback, `MAX_ANTECEDENT_SEARCH`, for referential prompts like "fix that"), and a recent verbatim tail of the active run's own iterations (`KEEP_ACTIVE_TAIL`). Everything else is folded into a persisted `CompactionState` (`compaction-{sessionId}.json`, alongside `history-{sessionId}.json`) with explicit categories — USER REQUIREMENTS, VERIFIED FACTS, DECISIONS MADE, CHANGES MADE, TESTS/VERIFICATION, OPEN QUESTIONS, HYPOTHESES, FAILED ATTEMPTS, INVALIDATED CONCLUSIONS — updated incrementally each compaction (new material folds into the existing structured state; a later compaction never re-summarizes an earlier summary as if it were undifferentiated raw text). A second LLM call validates the update against its own source material before it's accepted, specifically checking for unsupported claims, hypotheses promoted to facts, and dropped requirements — this exists because a real session produced exactly that failure (a compacted summary asserted `nextId()` returned `NaN` for negative/float IDs; the agent's own tool results earlier in the same work log showed finite values — the model fabricated the generalization, the source didn't contain it). The separately-compressed active-run summary (`summarizeActiveMiddle`) gets its own second-pass check (`validateActiveSummary`) too — but validated against the authoritative `CompactionState`, **not** only its own source messages: a real compaction re-presented the already-superseded DOM-snapshot session-persistence approach (`liveDOMCache`/`saveSessionDOM`/`restoreLiveDOM`) as current work, and since the raw active messages legitimately still held that earlier discussion, the contradiction was visible *only* against the state's `invalidatedConclusions`/`decisionsMade` (which win — the offending claim is dropped or marked superseded, never the whole summary). Regression suite, including both fixtures: `src/compaction.test.ts`. The `compact_start`/`compact` SSE events carry before/after message counts, context-usage%, and whether validation ran; both are logged to the MD trace and shown in the UI trace block, and `compact_start` also updates the status bar for the duration of the (~1-2 model calls, can take a while) compaction itself.

**Model**
The Ollama model identifier (e.g. `qwen3.6:latest`, `llama3.1:8b`). Selected per session in the breadcrumb model picker. Applied on every Ollama API call within that session. Changing the model mid-session takes effect on the next run.

**Model options**
Per-session sampling parameters: `temperature`, `top_p`, `top_k`, `num_ctx`. Configured in the settings panel (⚙). Applied to all Ollama calls in the session. Defaults are `temp=0.8, top_p=0.9, top_k=40, ctx=65536`.

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

`bash.ts` checks `config.inContainer`. `cwd` defaults to `/workspace` and accepts any absolute path — not a security boundary (the container is), just the one directory that's actually special:
- **In container** (worker mode): `execFile('bash', ['-c', command], { cwd: resolvedCwd })`
- **On host** (standalone mode): `execFile('docker', ['exec', '-w', resolvedCwd, sandboxContainer, 'bash', '-c', command])`

Uses `execFile` with an argv array — **not** `exec` with a single command string. `exec()` always runs its string through an *additional*, unintended shell (`/bin/sh -c`) before the command reaches the `bash -c` above. Multi-line commands used to be built via `` `bash -c ${JSON.stringify(command)}` `` passed to `exec()`; that extra outer shell doesn't treat JSON's `\n` escapes as newlines (POSIX double quotes don't recognize that escape) and still expands `$VAR`/`$(...)` inside double quotes — so every multi-line command (heredocs, `for` loops, multi-line `node -e`) arrived corrupted, and variables/substitutions could silently evaluate twice in the wrong shell/environment (e.g. `TMPDIR=$(mktemp -d)` reading back empty). `execFile` hands `command` to the inner `bash -c` as one argv element, byte-for-byte, with no intermediate shell at all. Regression tests: `src/tools/bash.test.ts` (`pnpm test`) — requires a running sandbox container (defaults to `argo-test-one`, override via `TEST_SANDBOX_CONTAINER`).

For multi-line JS scripts, the model uses `write_file` with a path outside `/workspace` (e.g. `/tmp/script.js`), then runs it with `node`. Both `write_file` and `read_file` accept any absolute path in the container. Inline multi-line `node -e "..."` now works correctly (see above) but writing to a script file is still preferred for anything non-trivial — easier to inspect/rerun.

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

## Common debugging

**`argo attach` behaves like an old version — bugs long since fixed still reproduce**
→ `bin/argo`'s CLI flow runs `dist/index.js` (compiled) and `argo:latest` (a prebuilt Docker image) — neither updates automatically when `src/` changes. `pnpm dev` (tsx watch) is the only path that reflects source instantly; central/worker mode does not. After any change that matters for real usage, run `pnpm build` and `docker build -f docker/agent.Dockerfile -t argo:latest .` (or `argo rebuild` for just the image) before testing through the actual `argo` CLI — otherwise you're debugging against stale code and won't find anything.

**Argo not calling tools / outputting JSON as text**
→ Switch to `qwen3.6:latest` — the only model validated for agentic use in Argo. See README Models table for full findings per model.

**Agent writes scripts but doesn't run them / declares done on empty output / poor multi-step reasoning**
→ Model capability issue. Gemma3/4 models cannot follow the ReAct loop — they lose cause-and-effect across iterations and ignore the system prompt. `gemma3:12b` returns a hard Ollama error ("does not support tools"). Use `qwen3.6:latest`.

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
| `src/compaction.ts` | Structured context compaction — state model, split logic, update/validate LLM calls |
| `src/tools/index.ts` | Tool registry — add new tools here |
| `src/server.ts` | All HTTP routes + SSE (worker/standalone) |
| `src/logger.ts` | Session log writing + `listSessions()`, `deleteAllLogs()`, `getSessionMessages()` |
| `src/config.ts` | All env vars + mode flags |
| `src/health.ts` | Ollama/Docker/git startup checks |
| `docker/agent.Dockerfile` | Multi-stage: TS builder (node:22-alpine) + Ubuntu runtime |
| `docker/sandbox.Dockerfile` | Legacy — used only with `pnpm dev` standalone mode |
| `public/app.js` | All frontend logic |
| `public/styles.css` | All styling |
| `public/index.html` | Argo UI — served at `/ws/:name/` with `__WS__` injected |
| `public/workspaces.html` | Workspace list — served at `/` |
| `bin/argo` | CLI: attach, detach, list, stop, rebuild |
| `~/.config/argo/env` | Global config (API keys, model) |
| `~/.config/argo/workspaces.json` | Workspace registry |
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
