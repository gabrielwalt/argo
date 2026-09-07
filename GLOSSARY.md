# Argo Glossary

Standardized terminology for the Argo trace/harness codebase. Use these terms
consistently in code comments, logs, and documentation — several of these
replace older, inconsistent names still found in parts of the codebase and
its history (e.g. "run" instead of "Conversation").

## Core Concepts

### Session
A persistent connection for a workspace. A session groups everything a user
does against one workspace over time — it outlives any single request and is
the unit the UI's session dropdown/history is built around.

### Conversation
One user request through to its complete resolution. Previously called a
"run" in code and comments; "Conversation" is the preferred term going
forward. A Conversation may involve a single quick answer or a full
Dispatch across multiple agent Frames.

### Dispatch
The orchestration of a Conversation into one or more agent Frames —
classifying the request, planning it if needed, and running the Implementer
frame(s) that do the actual work. Implemented by `runDispatchLoop` in
`dispatch.ts`.

### Frame
A single scoped agent execution — one Dispatcher, Planner, or Implementer running
against one self-contained Assignment. A Frame has its own iteration budget,
its own tool allowlist, and its own conversation history (isolated by
`frameId`/`sessionId`). A Dispatch is composed of one or more Frames.

### Iteration
One round trip to Ollama within a Frame: send messages, receive a response,
execute any requested tool calls. A Frame's progress is measured in
iterations, and role-specific iteration caps/progress checks are defined
against this unit.

### Tool Call
A single tool invocation within an Iteration (e.g. one `bash` call, one
`read_file` call). An Iteration's response may contain zero or more Tool
Calls.

## Agent Roles

### Agent Roles: Dispatcher, Planner, Implementer
- **Dispatcher** — the classifier. Runs at the start of a Conversation to route
  the request (answer directly, hand to a single Implementer, or hand to a
  Planner) and, at the end, to summarize the whole Dispatch.
- **Planner** — the decomposer. Breaks an objective into a sequence of
  self-contained Implementer assignments, one at a time, informed by each
  prior Implementer's conclusion.
- **Implementer** — the executor. Does the actual work (reading/writing
  files, running commands) against one self-contained Assignment and
  concludes with a verifiable result.

## Context Management

### Eviction
Deterministic, harness-owned removal of old tool results from a Frame's
context when it is near-full. Distinct from any LLM-based summarization —
eviction is a fixed, predictable rule, not a model call.

### Tool Result Collapse
A per-request, non-destructive shortening of older tool results before they
are sent to the model. The full result stays in the Frame's own history;
only the copy sent to Ollama for that one request is shortened. Distinct
from Eviction, which permanently removes content from history.

## Frame Lifecycle

### Assignment
The self-contained prompt given to an agent Frame — everything that Frame
needs to do its job without further context from the harness or from other
Frames.

### Conclude
The only way for an agent Frame to end its run. A Frame calls the
`conclude` tool with a status and a message; there is no other exit path
for a Frame that is still within its iteration budget.

## Observability

### Ledger
The append-only record of agent activity — delegations and conclusions —
written by `ledger.ts`. Distinct from the per-frame JSONL trace and the
Markdown trace: the Ledger is the authoritative, structural record of what
was delegated to which Frame and how it concluded.

### Progress Check
A harness-injected warning shown to an agent at defined iteration
thresholds, reminding it of its budget and nudging it toward concluding
rather than drifting.

### Loop Steer
Automatic, harness-level correction applied when an agent repeats an
identical tool call — a rung on the loop-recovery ladder that intervenes
before a Frame burns its iteration budget looping.

---

**Note:** the full agent suite — including the Tester, Critic, LLM-based
compaction, and the task ledger — has been preserved on branch
`feature/full-agent-suite`. The current mainline is a reduced set (Dispatcher,
Planner, Implementer plus deterministic Eviction) documented above.
