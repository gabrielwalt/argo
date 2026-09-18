# Argo Glossary

## Core Concepts

### Session
A persistent connection for a workspace. Groups everything a user does against one workspace over time — the unit the UI's session dropdown is built around.

### Conversation
One user request through to its complete resolution. May involve a direct answer or a full Dispatch across multiple agent Frames.

### Dispatch
The orchestration of a Conversation into one or more agent Frames — classifying the request, planning it if needed, and running the Implementer frame(s). Implemented by `runDispatchLoop` in `dispatch.ts`.

### Frame
A single scoped agent execution — one Dispatcher, Planner, or Implementer running against one self-contained Assignment. Has its own iteration budget, tool allowlist, and conversation history.

### Iteration
One round trip to Ollama within a Frame: send messages, receive a response, execute any requested tool calls.

### Tool Call
A single tool invocation within an Iteration (e.g. one `bash` call, one `read_file` call).

## Agent Roles

### Dispatcher
The classifier. Runs at the start of a Conversation to route the request (ANSWER, SIMPLE, or OBJECTIVE) and at the end to summarize the run.

### Planner
The decomposer. Breaks an objective into sequential Implementer assignments, producing one at a time, informed by each prior Implementer's result.

### Implementer
The executor. Does the actual work (reading/writing files, running commands) against one self-contained Assignment and concludes with a verifiable result.

## Context Management

### Three-Tier Context Memory
Each role has a different context lifetime. Dispatcher: entire conversation (all user prompts in a session) — one persistent Frame per session, whose ledger history is reloaded into a fresh Agent on every subsequent prompt. Planner: one user interaction (spawn to final answer). Implementer: one task (spawn to conclude).

### Context Management
`agent.ts`'s `manageContext` — a single unified pass (no model call) that, once a Frame's context crosses a trigger threshold, splits its assistant/tool messages into three tiers by estimated token cost: newest kept VERBATIM, the next slice COLLAPSED (a shortened head+tail preview), and everything older EVICTED (a bare recovery marker, no preview). Purely in-memory — the ledger file itself is never rewritten, so the full original content always survives there and is recoverable via `expand`/`get_msg_id`. Replaced an earlier two-mechanism design (a separate always-on "tool result collapse" pass plus a distinct eviction trigger) once they were found to disagree about what to shorten first.

### Reasoning Artifact
A model turn's own scratch output (`thinking`, or a no-tool-call turn's own `content`) reinjected as an explicit `[Reasoning]`-prefixed message, since attaching it only via a message's own `thinking` field does not reliably survive into the next turn. Single-slotted — at most one lives in a Frame's context at a time, superseded (no stub) by the next one.

## Frame Lifecycle

### Assignment
The self-contained prompt given to an agent Frame.

### Conclude
The only way a Frame ends. Calls the `conclude` tool with a status and message.

## Observability

### Ledger
Per-frame append-only JSONL files under `.argo/frames/`. Records every message each agent sees, plus UI metadata (thinking, tool args, timing). Agents query their own frame's ledger via the `ledger` tool (`messages` to browse, `expand` with a `msg_id` to recover evicted content). No cross-agent visibility.

### Progress Check
Harness-injected warning at defined iteration thresholds, nudging toward concluding.

### Loop Steer
Automatic correction when an agent repeats an identical tool call — escalates L0 → L1 → L2 → Halt. Only the FIRST no-progress repeat is served a cached result without re-running; every later repeat actually re-runs the call for real (nothing about a duplicate has failed) plus an ephemeral one-turn warning, rather than being skipped.
