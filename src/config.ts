import 'dotenv/config'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const inContainer = process.env.RUNNING_IN_CONTAINER === '1'

export const config = {
  model:            process.env.MODEL ?? 'qwen3.6:latest',
  ollamaHost:       process.env.OLLAMA_HOST ?? 'http://localhost:11434',
  tavilyKey:        process.env.TAVILY_API_KEY ?? '',
  maxIterations:    parseInt(process.env.MAX_ITERATIONS ?? '1000', 10),
  port:             parseInt(process.env.PORT ?? '3000', 10),
  workspacePath:    inContainer ? '/workspace' : (process.env.WORKSPACE_PATH ? path.resolve(__dirname, '..', process.env.WORKSPACE_PATH) : ''),
  sandboxContainer: process.env.SANDBOX_CONTAINER ?? 'argo-sandbox',
  workerMode:       process.env.WORKER_MODE === '1',
  inContainer,
  password:         process.env.ARGO_PASSWORD ?? 'unacroquetta',
  centralUrl:       process.env.ARGO_CENTRAL_URL ?? '',
  internalToken:    process.env.ARGO_INTERNAL_TOKEN ?? '',
  // Compaction: trigger before the *next* generation could overflow num_ctx,
  // not just when the input alone is already close to full.
  compactThreshold:        parseFloat(process.env.COMPACT_THRESHOLD ?? '0.667'),
  // Compact when only about this many tokens of headroom remain (trigger near-full rather
  // than at a fixed 2/3 fraction) — lets the context fill more before compacting. The donut
  // draws its threshold tick from this + the run's num_ctx.
  compactReserveTokens:    parseInt(process.env.COMPACT_RESERVE_TOKENS ?? '4096', 10),
  compactGenerationReserve: parseInt(process.env.COMPACT_GENERATION_RESERVE ?? '2048', 10),
  // 180s (raised from an original 60s) was sized against num_ctx=32768. Since
  // then num_ctx's default doubled to 65536 — compaction's threshold is still
  // 66.7% of that budget, so the "prior" work log it summarizes roughly
  // doubled in size too, and 180s is now confirmed too short again: a real
  // run (188 messages, num_ctx=65536) timed out at exactly 180s on
  // updateCompactionState, fell through to "continue with full history" as
  // designed (not a crash), and immediately re-triggered another compaction
  // on an even larger backlog. If num_ctx's default changes again, this
  // should be re-checked rather than assumed still correct.
  compactTimeoutMs:        parseInt(process.env.COMPACT_TIMEOUT_MS ?? '300000', 10),
  // The main per-iteration chat call reads the *entire* running history (often
  // larger than what a single compaction sub-call processes), so it deserves
  // the same headroom, not less. Confirmed too short in production at the old
  // 120s default: a real run with 104 messages and num_ctx=65536 timed out at
  // exactly 120.010s — genuinely still working, not stuck (the process didn't
  // crash, thanks to the catch in chat(); the user just got a clean error and
  // had to retry, and the retry answered normally).
  // Raised from 60s to 180s: with streaming enabled, a 3-hour production run
  // still produced 162 timeouts at the old 60s value — 79 single timeouts where
  // the retry succeeded (so the call genuinely needed 60-120s), 45 double
  // timeouts where the retry also failed (>120s), and 18 three-consecutive
  // kills (>180s total). Timeouts occurred at both small (9-11 message) and
  // large (84-95 message) contexts; at larger contexts Ollama genuinely needs
  // more than 60s for prefill on the target hardware (Apple M5 Max, 48GB,
  // qwen3.6:latest loaded at 24GB, num_ctx=65536). 60s was never a safe margin
  // for this model/hardware/context-size combination — 180s is.
  chatTimeoutMs:           parseInt(process.env.CHAT_TIMEOUT_MS ?? '180000', 10),
  // Originally sized as a bigger budget specifically for a frame's FIRST Ollama
  // call (cold-prefill: paying for the entire system prompt + tool definitions +
  // assignment against an empty KV cache, measured as the single most expensive
  // call in a frame) versus chatTimeoutMs for warm-cache calls later in the same
  // frame. Now that chatTimeoutMs itself is 180s, the two are equal by default —
  // this key is effectively redundant as a distinct "first call" budget. Left in
  // place (not removed) because it's still a meaningful independent override via
  // FIRST_REQUEST_TIMEOUT_MS if a future change lowers chatTimeoutMs again while
  // cold-prefill cost stays high, but there is currently no reason to set it
  // differently from the default.
  firstRequestTimeoutMs:   parseInt(process.env.FIRST_REQUEST_TIMEOUT_MS ?? '180000', 10),
  // Delay before the single automatic retry of a failed main per-iteration chat
  // call (see chatWithRetry in agent.ts). Two real incidents ended a whole run
  // with no retry: a 180s timeout, and Ollama's Go backend rejecting a malformed
  // qwen3.6 tool-call ("XML syntax error ... <function> closed by </parameter>").
  // Since temperature is > 0, re-issuing the identical request has a real chance
  // of succeeding. This is a brief settle before one retry, not a backoff — only
  // a single retry is ever attempted, then the existing outer catch takes over.
  chatRetryDelayMs:        parseInt(process.env.CHAT_RETRY_DELAY_MS ?? '2000', 10),
  // ACTOR-CRITIC (Phase 4, step 2). OFF by default (env ARGO_CRITIC=1 to enable) — value was
  // inconclusive at n=1 and it adds per-checkpoint latency; executable per-task verification
  // (tasks) is the preferred verification lever. When on, When on, a qwen3.6 self-critique runs at a FEW checkpoints
  // (post-plan / on-stall / pre-done), never every turn. See docs/actor-critic.md.
  critic:           ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_CRITIC ?? '').trim().toLowerCase()),
  // The critic is qwen3.6 itself (self-critique) — the only model that reliably
  // flags oracle-gaming (supervisor eval, 3/3) and ZERO extra resident memory
  // since it's already loaded. Reuses the existing Ollama client / ollamaHost.
  criticModel:      process.env.ARGO_CRITIC_MODEL ?? 'qwen3.6:latest',
  // GROUNDING & SELF-CONSISTENCY guard (Phase 4). This is the DEFAULT for the agent's
  // per-run flag (agent.grounding); the web UI's "Grounding check" toggle (default ON)
  // overrides it per session via /chat. Default ON — set env ARGO_GROUNDING to a falsey
  // value (0/false/no/off) to force it OFF for headless/eval runs that don't pass the
  // flag. When on, a PRE-DONE check on WRITING/RESEARCH tasks (a document artifact was
  // produced) verifies specifics against the fetched sources and reconciles restated
  // numbers, blocking "done" until revised. Reuses the critic model. See docs/grounding.md.
  grounding:        !['0', 'false', 'no', 'off'].includes((process.env.ARGO_GROUNDING ?? '').trim().toLowerCase()),
  // LAYOUT JUDGE (visual-layout guard, the GROUNDING guard's analogue for viewable HTML
  // artifacts). UNPROVEN — OFF by default; set env ARGO_LAYOUT to a truthy value
  // (1/true/yes/on) to enable. When on, a PRE-DONE check renders the run's most
  // recently edited .html/.htm artifact (if any) in headless chromium, screenshots it,
  // and asks the local vision model (visionModel below) whether the RENDERED layout
  // has a clear problem (overflow, overlap, truncation, broken structure), blocking
  // "done" until fixed. See src/layout.ts.
  layout:           ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_LAYOUT ?? '').trim().toLowerCase()),
  // HARNESS-OWNED TASK SEQUENCING (Stage 3). ON by default (env ARGO_TASKS=0/false/off forces OFF). When on, the LLM's plan (update_plan) becomes an ordered task
  // ledger the harness recites at the tail of context every step and drives ONE task
  // at a time (per-task verify nudge → advance), and a later update_plan RE-PLANS by
  // reconciling into the ledger with completed tasks frozen. LLM decomposes + refines;
  // harness sequences + verifies. See docs/harness-planning-memory.md + src/tasks.ts.
  tasks:            !['0', 'false', 'no', 'off'].includes((process.env.ARGO_TASKS ?? '').trim().toLowerCase()),
  // HARNESS-OWNED MEMORY (Stages 1/2/4). ON by default (env ARGO_MEMORY=0/false/off forces OFF). When
  // on: AGENTS.md is section-selected when large (whole when small), MEMORY.md entries
  // are retrieved for the current task/objective, a recall pointer is OFFERED (never
  // required), and durable ledger items (verified facts + decisions) persist to the
  // workspace MEMORY.md at compaction so they survive across runs. See src/memory.ts.
  memory:           !['0', 'false', 'no', 'off'].includes((process.env.ARGO_MEMORY ?? '').trim().toLowerCase()),
  // LOOP-RECOVERY LADDER (docs/harness-planning-memory.md "Loop detection & recovery
  // ladder"). ON by default (env ARGO_LOOP=0/false/off forces OFF). When on, a mutation-aware
  // repeat detector REPLACES the count-based REPEAT_THRESHOLD steer: it keys on a
  // NORMALISED call (same tool + a cosmetically-insensitive form of its args — see
  // loop.ts's normalizeCallKey for exactly what that collapses/refuses to), and on
  // the 2nd such call with nothing changed since, serves back the CACHED result of
  // the earlier call (labeled as a repeat) rather than a bare block, before
  // escalating L0 replay/steer -> L1 compaction -> L2 stop-and-reframe (forced
  // re-plan). See src/loop.ts. (2026-09 redesign, H19/H20: the previous raw-args key
  // was evaded by a cosmetic re-issue in 46 of 143 observed blocks, and the separate
  // near-duplicate "same tool, any args" guard this flag used to also gate — 180
  // firings, 0 with any observed effect — was deleted outright, not folded in here.)
  loopRecovery:     !['0', 'false', 'no', 'off'].includes((process.env.ARGO_LOOP ?? '').trim().toLowerCase()),
  // AUTO-COMMIT. OFF by default — the agent used to ALWAYS commit after every run; this
  // makes it opt-in (per-run overridable via agent.setAutoCommit(), mirroring the other
  // flags above) so uncommitted changes stay visible in the Changes view until the user
  // (or an explicit toggle) decides to commit them. See Agent.autoCommit() in agent.ts.
  autoCommit:       ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_AUTOCOMMIT ?? '').trim().toLowerCase()),
  // Local vision model used by the view_image tool to read/judge images (screenshots,
  // diagrams, rendered layouts). See src/tools/view-image.ts.
  visionModel:      process.env.ARGO_VISION_MODEL ?? 'qwen2.5vl:7b',
  // MULTI-AGENT ARCHITECTURE (docs/subagents-plan.md). OFF by default (env ARGO_AGENTS=1
  // to enable) — the existing single-loop path stays the default until this is proven.
  // When on: the dispatch loop (src/dispatch.ts) drives Planner/Implementer/Tester/Boss
  // as scoped Agent instances, the ledger (src/ledger.ts) records every delegation/
  // conclusion/standup/injection/episode under /workspace/.argo/, and context management
  // switches from LLM-summarization compaction to deterministic episode eviction
  // (src/eviction.ts). No two LLM calls ever run concurrently, for any role.
  agents:           ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_AGENTS ?? '').trim().toLowerCase()),
  // SCHEMA-CONSTRAINED CONTROL PLANE (src/schema.ts). OFF by default (env
  // ARGO_SCHEMA_CONTROL_PLANE=1 to enable) — new and unmeasured, so the pipeline stays
  // byte-identical to today until an eval says otherwise. When on, a control-plane
  // decision the cheap regex parsers could NOT read (the Planner's task graph, the Boss's
  // task-start classification, the Tester's verdict, the Boss's stand-up verdict) gets ONE
  // bounded no-tools call with Ollama `format` set to a full JSON Schema and `think: false`,
  // which RESTATES the frame's own already-made decision in the shape the harness needs —
  // it never decides anything itself. Never fails open: schema.ts returns null on any
  // structural doubt and the caller keeps its existing hard stop (PlanningFailed) or
  // conservative default, because a fail-open default here would recreate the H13 defect
  // (84 of 85 executed graphs were a silently-invented one-step plan). Verified on the host
  // 2026-09-03: `format` + `tools` + `think:false` compose, content is schema-conformant,
  // no <think> wrapper, 0.37s warm eval. See docs/research/09-small-model-scaffolding.md §1.
  schemaControlPlane: ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_SCHEMA_CONTROL_PLANE ?? '').trim().toLowerCase()),
  // VERBATIM REQUEST THREADING (frames.ts buildAssignment, dispatch.ts spawnFrame). OFF
  // by default (env ARGO_VERBATIM_REQUEST=1 to enable) — new, unmeasured. When on, the
  // run's raw user message threads, verbatim and capped (4000 chars, head-and-tail), into
  // EVERY spawned frame's assignment, alongside (never replacing) the Boss's OBJECTIVE
  // paraphrase. Motivated by docs/research/10-hermes-differential.md finding 1: the
  // paraphrase was previously the ONLY statement of the request any downstream frame saw
  // (userMessage was never referenced again after the task-start checkpoint), and it dropped
  // load-bearing detail in both traced eval failures — bigproj-observability's seeded-test-
  // file pointer, and commander-count-option's "do NOT modify existing tests" constraint,
  // which sat at the very end of the message (hence head-AND-tail truncation, not head-only).
  // Placed FIRST in the assignment: it is the one part byte-identical across every sibling
  // frame of a run, and Ollama prefix-caching measured on this machine is 34ms warm vs
  // 1445ms cold, with a mutated leading token costing the full 1416ms.
  verbatimRequest:  ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_VERBATIM_REQUEST ?? '').trim().toLowerCase()),
}
