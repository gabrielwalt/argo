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
  chatTimeoutMs:           parseInt(process.env.CHAT_TIMEOUT_MS ?? '180000', 10),
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
  // repeat detector REPLACES the count-based REPEAT_THRESHOLD steer: it blocks the 2nd
  // identical tool call when nothing changed since it last ran, and escalates
  // L0 steer -> L1 compaction -> L2 stop-and-reframe (forced re-plan). See src/loop.ts.
  loopRecovery:     !['0', 'false', 'no', 'off'].includes((process.env.ARGO_LOOP ?? '').trim().toLowerCase()),
  // AUTO-COMMIT. OFF by default — the agent used to ALWAYS commit after every run; this
  // makes it opt-in (per-run overridable via agent.setAutoCommit(), mirroring the other
  // flags above) so uncommitted changes stay visible in the Changes view until the user
  // (or an explicit toggle) decides to commit them. See Agent.autoCommit() in agent.ts.
  autoCommit:       ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_AUTOCOMMIT ?? '').trim().toLowerCase()),
  // Local vision model used by the view_image tool to read/judge images (screenshots,
  // diagrams, rendered layouts). See src/tools/view-image.ts.
  visionModel:      process.env.ARGO_VISION_MODEL ?? 'qwen2.5vl:7b',
}
