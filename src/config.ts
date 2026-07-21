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
}
