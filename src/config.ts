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
}
