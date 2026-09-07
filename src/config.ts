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
  // Eviction-based context management reserves this many tokens of headroom out of
  // num_ctx before deterministically evicting older episodes from the live window
  // (see eviction.ts). Replaces the old LLM-summarization compaction threshold.
  compactReserveTokens:    parseInt(process.env.COMPACT_RESERVE_TOKENS ?? '13107', 10),
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
  // AUTO-COMMIT. OFF by default — the agent used to ALWAYS commit after every run; this
  // makes it opt-in (per-run overridable via agent.setAutoCommit(), mirroring the other
  // flags above) so uncommitted changes stay visible in the Changes view until the user
  // (or an explicit toggle) decides to commit them. See Agent.autoCommit() in agent.ts.
  autoCommit:       ['1', 'true', 'yes', 'on'].includes((process.env.ARGO_AUTOCOMMIT ?? '').trim().toLowerCase()),
  // Local vision model, kept for tools that may still read/judge images.
  visionModel:      process.env.ARGO_VISION_MODEL ?? 'qwen2.5vl:7b',
  // VERBATIM REQUEST THREADING (frames.ts buildAssignment, dispatch.ts spawnFrame). ON
  // by default (env ARGO_VERBATIM_REQUEST=0/false/off to disable). When on, the run's
  // raw user message threads, verbatim and capped (4000 chars, head-and-tail), into
  // EVERY spawned frame's assignment, alongside (never replacing) the Boss's OBJECTIVE
  // paraphrase — see frames.ts's renderVerbatimRequestBlock for the full rationale
  // (traced eval failures where the paraphrase alone dropped load-bearing detail).
  verbatimRequest:  !['0', 'false', 'no', 'off'].includes((process.env.ARGO_VERBATIM_REQUEST ?? '').trim().toLowerCase()),
}
