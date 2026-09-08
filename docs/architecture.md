# Argo Architecture

## Dispatch Pipeline

Every user request goes through the same pipeline:

```
User → Dispatcher → (classify)
         ├── ANSWER  → direct response, no sub-agents
         ├── SIMPLE  → single Implementer
         └── OBJECTIVE → Planner → Implementer(s)
```

**Dispatcher** classifies the request, inspects the project (read-only), and routes. At the end of a multi-agent run it also produces the final summary.

**Planner** decomposes an objective into sequential implementation assignments. It has read-only project access, produces one assignment at a time via `conclude`, and sees each Implementer's result before producing the next.

**Implementer** executes one assignment: reads/writes files, runs commands, verifies its work, then concludes with SUCCESS or FAIL.

## Frames

Each agent execution is a **frame** — an isolated Agent instance with its own role, tool allowlist, iteration budget, and conversation history.

## Context Memory — Three-Tier Model

Three-tier model, matching each role's lifecycle:

- **Dispatcher**: Full context across the entire user conversation (all prompts in a session).
  One persistent frame per session — each new prompt resumes the accumulated history.
- **Planner**: Context within one user interaction (spawn → final answer returned to user).
  Fresh between user prompts.
- **Implementer**: Task-specific. Fresh per planned task, ends at conclude.

| Role | Context lifetime | Ledger file |
|------|-----------------|-------------|
| **Dispatcher** | Entire user conversation (all prompts in a session) | One persistent frame file per session (`dispatcher-<sessionId>`), reloaded on each prompt |
| **Planner** | One user interaction (spawn → final answer returned to user) | One frame file per run, fresh between prompts |
| **Implementer** | One task (spawn → conclude) | One frame file per task, fresh per assignment |

The **Dispatcher** is the only role that accumulates context across user turns. It keeps ONE frameId for the whole session (`dispatcher-<sessionId>`, minted on the session's first turn). On the session's first prompt it spawns a normal fresh Agent. On every later prompt, a brand-new Agent instance is still constructed (so per-run state — iteration counters, loop-recovery state, edited-paths tracking — always starts clean), but before it runs, its history is pre-loaded from the SAME frame's ledger file (`Agent.loadHistory`), so it classifies and (at the end of an OBJECTIVE run) concludes with the entire session's prior context already in view. Only clean user/assistant text turns are replayed this way — never raw tool-call/tool-result mechanics or the frame's own opening system messages (those get re-sent fresh by the new Agent instance itself). The Dispatcher's end-of-run conclusion (after an OBJECTIVE run) resumes this SAME persistent frame rather than spawning a separate one-off Dispatcher, so the conclusion also becomes part of the session's accumulated context.

The **Planner** retains context within a single run — it is resumed between tasks to see each Implementer's result and produce the next assignment. Its context resets between user prompts.

Each **Implementer** starts with a clean context for its specific task and concludes independently.

## Ledger

Per-frame append-only JSONL files under `.argo/frames/`. Each frame has its own file. A session registry (`.argo/sessions.json`) maps sessions to their ordered frames.

Each ledger entry has:
- `id` — unique ID (`msg_id`) for recovery via `expand`
- `role` — system/user/assistant/tool
- `content` — the full message text
- Plus UI-only metadata (thinking, toolName, toolArgs, durationMs, etc.) — not visible to agents

**Agent view**: When an agent queries the ledger tool, it sees only its own frame's messages, stripped to `{id, role, content}`. No cross-agent visibility.

**Eviction and the ledger**: Eviction (see Context Management below) replaces older tool-result messages in the live in-memory context with stubs — the ledger file itself is untouched; it always keeps the original, full-content entry for every message ever pushed. A stub embeds the original message's `id`, so the `expand` action can look it up in the ledger and recover the full original content on demand.

## Context Management

Two mechanisms keep the context window bounded:

1. **Tool result collapse** (per-request, non-destructive): older tool results are shortened to stubs before sending to the model. Full content stays in history.

2. **Eviction** (permanent): when context nears capacity, oldest tool-result messages are replaced with stubs. Stubs reference the `msg_id` for recovery: `[evicted — N chars; msg_id "msg-xxx" to recover]`.

## Loop Recovery

The loop-recovery ladder (`src/loop.ts`) detects when an agent repeats the same tool call without progress:
- **L0**: serve the cached prior result, or steer away
- **L1**: trigger a context eviction pass
- **L2**: demand the agent abandon its approach
- **Halt**: end the frame if L2 is ignored repeatedly

## Concluding

The only way a frame ends is by calling `conclude(status, message)`. Status must be one of the role's allowed values (e.g. ANSWER/SIMPLE/OBJECTIVE for Dispatcher, SUCCESS/FAIL for Implementer, PLAN/IMPLEMENT/SUCCESS/FAIL for Planner).

## Data Stores

Two data stores, serving different consumers:

| Store | Location | Purpose |
|-------|----------|---------|
| **Ledger** (per-frame JSONL) | `.argo/frames/` inside the project | Agent memory + UI metadata. Every message every agent sees, plus thinking/tool args/timing. Agents query it via `ledger` tool (stripped to {id, role, content}). |
| **Session JSONL** | `/app/logs/` (mapped to `~/.local/share/argo/logs/{workspace}/`) | Minimal run log. Only: `start` (model/options), `warning` (loop steers with L0/L1/L2), `error` (harness errors), `message` (role:user echo). All other event types are ledger-covered and skipped from disk. |

The session JSONL is approaching redundancy — once the UI migrates to reading from the ledger, it can be removed entirely.
