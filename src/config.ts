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
  //
  // Raised again, 180s -> 600s (2026-09-09): that 180s figure was tuned before
  // two later, independent changes quietly invalidated it. `num_predict` was
  // raised 8192 -> 16384 (commit b81ed38, "thinking-heavy tasks exhaust the
  // budget" — 8192 was truncating a thinking model mid-thought) and the default
  // model moved to qwen3.8 (`think: true`, same 16384 cap). Nobody re-checked
  // chatTimeoutMs against the new, larger budget. Reproduced live: an
  // Implementer on a genuinely hard task (dense canvas-drawing geometry) hit a
  // SINGLE generation still climbing past 2400 tokens at ~20 tok/s with no sign
  // of a tool call or stop, confirmed via Ollama's own server log (steady
  // `print_timing` output, real progress, not a hang) — at that rate, a full
  // 16384-token generation needs ~650-800s. The 180s cap (and its one retry)
  // could only ever cut the model off mid-thought, discard everything generated
  // so far (Ollama does not resume a cancelled GENERATION, only prefill), and
  // inject "your request was lost, continue" — which then produces an equally
  // long fresh thought that hits the exact same wall, forever, as a live
  // production run confirmed (three-strikes hard cap never even reached because
  // each attempt was independently re-timed-out). 600s is short of the full
  // 16384-token worst case but comfortably covers the thinking depth a hard
  // task actually needs in practice, without asking a user to wait the full
  // ~800s on every call; the existing 3-consecutive-timeouts hard stop
  // (agent.ts) remains the backstop for a genuinely pathological case.
  chatTimeoutMs:           parseInt(process.env.CHAT_TIMEOUT_MS ?? '600000', 10),
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
}

// Local-time timestamp for session IDs and trace filenames — so timestamps
// match the user's clock, not UTC (the Docker container runs in UTC but the
// user sees local time).
export function localTimestamp(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`
}
