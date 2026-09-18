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

**Eviction and the ledger**: `manageContext`'s collapse/evict tiers (see Context Management below) shorten or replace older messages in the live in-memory context with stubs — the ledger file itself is untouched; it always keeps the original, full-content entry for every message ever pushed. A stub embeds the original message's `id`, so the `ledger` tool's `expand`/`get_msg_id` actions can look it up and recover the full original content on demand.

## Context Management

`agent.ts`'s `manageContext` is a single unified pass, no model call involved: once triggered (at `CONTEXT_TRIGGER_PCT`, 60% of `num_ctx`), it walks assistant/tool messages newest-to-oldest and splits them into three tiers by estimated token cost:

- **Verbatim** (newest ~40% of `num_ctx` worth): untouched.
- **Collapse** (next ~10% worth): shortened to a head(150 chars) + placeholder + tail(150 chars) preview — unless that would produce a stub LONGER than the original, in which case it's left untouched instead.
- **Evict** (everything older): replaced with a bare `[evicted — N chars; msg_id "..." to recover]` marker, no preview.

The token estimate driving all three tiers is self-calibrating, not a flat chars-per-token constant: `effectiveCharsPerToken` is recalibrated against Ollama's own real `prompt_eval_count` after every response (delta-based, so the constant per-request tool-schema overhead cancels out). A flat constant alone was confirmed live to badly under-estimate dense content, letting the 60% trigger never fire even at 92% real usage — see the root project's `CLAUDE.md` ("Context eviction"/"Fix — self-calibrating ratio") for the full incident and fix.

Two other mechanisms keep live context from growing unnecessarily large in the first place, independent of the trigger above: `supersedeOlderCalls` fully removes (no stub) an older read/write/edit/fetch call once a later one on the SAME path/URL succeeds, and `pushReasoningArtifact` keeps at most one `[Reasoning]`-labeled scratch-output artifact live at a time (see "Reasoning artifacts" below). This replaced an earlier two-mechanism design — a CWL-episode classifier (`eviction.ts`) plus a separate tool-result collapse pass with its own independent trigger — unified because the two could disagree about what to shorten first.

## Reasoning artifacts

A model turn's own `thinking` does not reliably survive into its NEXT turn's request merely by being attached to a pushed message's `thinking` field — confirmed live: whenever a turn also produced real `content`, the `thinking` half silently failed to reach later context. `pushReasoningArtifact` reinjects a turn's own scratch output as an explicit `[Reasoning]\n...`-prefixed message instead — the one channel proven to survive — single-slotted (pushing a new one always removes whatever the previous one occupied, no stub). A no-tool-call turn that produced BOTH `thinking` and its own `content` pushes a PAIRED artifact (real reasoning first, its own content second) that supersedes as a unit; `content` accompanying a REAL tool call is never reasoning-labeled — it stays a normal, permanent message, since it accompanies a kept action rather than pure scratch output.

## Loop Recovery

The loop-recovery ladder (`src/loop.ts`) detects when an agent repeats the same tool call without progress, and escalates:
- **L0**: the FIRST no-progress repeat of a given call is served the cached prior result without re-running it (labeled as a repeat). Every LATER repeat of that same call — through L1 and L2 — actually RE-RUNS the tool for real (nothing about a duplicate call has failed) and appends a separate, ephemeral (one-iteration) warning message right after the real result, instead of fabricating a rejection.
- **L1**: also triggers a context eviction pass (`manageContext`).
- **L2**: demands the agent abandon its approach; still re-runs the call for real.
- **Halt**: ends the frame if L2 is ignored repeatedly — also re-runs its own triggering call for real (with the same warning) before ending.

A separate, permanent-refusal counter bounds a tool call outside the frame's own role (never re-executed — a role restriction can't be satisfied by trying again): escalating wording at the 3rd identical refusal, frame stop at the 6th.

## Concluding

The only way a frame ends is by calling `conclude(status, message)`. Status must be one of the role's allowed values (e.g. ANSWER/SIMPLE/OBJECTIVE for Dispatcher, SUCCESS/FAIL for Implementer, PLAN/IMPLEMENT/SUCCESS/FAIL for Planner).

## Data Stores

One data store now — the per-frame ledger, plus a small registry mapping sessions to frames:

| Store | Location | Purpose |
|-------|----------|---------|
| **Ledger** (per-frame JSONL) | `.argo/frames/` inside the project | Agent memory + UI metadata. Every message every agent sees, plus thinking/tool args/timing. Agents query it via `ledger` tool (stripped to {id, role, content}). |
| **Session registry** | `.argo/sessions.json` inside the project | Maps each session to its runs, each run to the ordered frames it spawned (`src/ledger.ts`'s `SessionRegistry`). No message content of its own — just enough to reconstruct which frames belong to which session/run. |

The old separate "Session JSONL" run log under `~/.local/share/argo/logs/{workspace}/` (a minimal
`start`/`warning`/`error`/`message` event stream) has been removed — the UI (`GET /logs`) now
reconstructs the same information straight from the ledger and session registry above
(`reconstructSessionEvents` in `src/server.ts`).
