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
  // ACTOR-CRITIC (Phase 4, step 2). OFF by default so the baseline loop path is
  // BYTE-IDENTICAL unless explicitly enabled — required for a clean A/B and zero
  // regression risk. When on, a qwen3.6 self-critique runs at a FEW checkpoints
  // (post-plan / on-stall / pre-done), never every turn. See docs/actor-critic.md.
  critic:           ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_CRITIC ?? '').trim().toLowerCase()),
  // The critic is qwen3.6 itself (self-critique) — the only model that reliably
  // flags oracle-gaming (supervisor eval, 3/3) and ZERO extra resident memory
  // since it's already loaded. Reuses the existing Ollama client / ollamaHost.
  criticModel:      process.env.ARGO_CRITIC_MODEL ?? 'qwen3.6:latest',
}
