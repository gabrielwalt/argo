import { bash } from './bash.js'
import { webSearch } from './web-search.js'
import { readFile, writeFile, editFile } from './file-ops.js'
import { fetchUrl } from './fetch-url.js'
import { browserFetch } from './browser-fetch.js'
import { viewImage } from './view-image.js'
import * as ledger from '../ledger.js'
import { config } from '../config.js'
import type { ToolName, ToolResult } from '../types.js'

// MULTI-AGENT LEDGER TOOL (config.agents / ARGO_AGENTS). Query-only from a model's
// perspective — the harness-automatic writers (recordDelegation, recordConclusion, ...)
// are called directly from dispatch.ts/frames.ts, never through this tool, so they can
// never be forgotten. Root is config.workspacePath, NOT a literal '/workspace' — that
// literal only exists on the filesystem in-container; standalone dev mode runs this
// process directly on the host (see dispatch.ts's root() for the full rationale). Never
// throws — errors go in the `error` field, matching every other tool in this module.
async function runLedgerTool(args: Record<string, unknown>): Promise<ToolResult> {
  const root = config.workspacePath || '/workspace'
  const action = typeof args.action === 'string' ? args.action : ''
  try {
    switch (action) {
      case 'get_goal': {
        const obj = await ledger.getObjective(root)
        return { output: obj ?? '(no objective set yet)' }
      }
      case 'get_plan': {
        const plan = await ledger.getPlan(root)
        return { output: plan ? JSON.stringify(plan) : '(no plan recorded yet)' }
      }
      case 'get_recent': {
        const n = typeof args.n === 'number' ? args.n : 10
        const scope = args.scope === 'frame' || args.scope === 'task' ? args.scope : undefined
        return { output: JSON.stringify(await ledger.getRecent(root, n, scope)) }
      }
      case 'get_conclusion': {
        const frameId = typeof args.frame_id === 'string' ? args.frame_id : ''
        if (!frameId) return { output: '', error: 'get_conclusion requires frame_id' }
        const c = await ledger.getConclusion(root, frameId)
        return { output: c ? JSON.stringify(c) : '(no conclusion recorded for that frame)' }
      }
      case 'get_frame_trail': {
        const frameId = typeof args.frame_id === 'string' ? args.frame_id : ''
        if (!frameId) return { output: '', error: 'get_frame_trail requires frame_id' }
        return { output: JSON.stringify(await ledger.getFrameTrail(root, frameId)) }
      }
      case 'expand': {
        const episodeId = typeof args.episode_id === 'string' ? args.episode_id : ''
        if (!episodeId) return { output: '', error: 'expand requires episode_id' }
        const content = await ledger.expand(root, episodeId)
        return { output: content ?? '(no content recorded for that episode, or it was never evicted)' }
      }
      default:
        return { output: '', error: `Unknown ledger action: ${action}. Valid: get_goal, get_plan, get_recent, get_conclusion, get_frame_trail, expand.` }
    }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}

export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: 'Execute a bash command in the sandbox container. The whole container is your working environment — /workspace is the one special directory: the user\'s project, git-tracked, auto-committed. Only write test/scratch/verification files (via redirection, heredoc, sed, etc. — not just write_file) under /workspace if they are an intentional project deliverable; anything temporary goes in /tmp or elsewhere, the same rule as write_file, regardless of which tool you use to create the file. Everything outside /workspace is ordinary, disposable filesystem, freely usable for scripts and temporary work. Do not prefix commands with "cd /workspace &&" — use cwd instead. Commands are killed after 30s by default (120s automatically for anything mentioning Playwright/Chromium) — if a command times out, that is reported explicitly as a timeout, not a generic failure; if you know a command needs more real time than that (e.g. waiting out many simulation frames), pass timeout_ms instead of adding longer waits inside the command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
          cwd: { type: 'string', description: 'Working directory, any absolute path. Default /workspace.' },
          timeout_ms: { type: 'number', description: 'Override the default kill timeout in milliseconds, for a command you know legitimately needs more time. Capped at 180000 (3 minutes).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web for current information.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'The search query' },
          max_results: { type: 'number', description: 'Number of results (default 5, max 10)' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read a file. Any absolute path in the container works; use /workspace/path for the project.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, e.g. /workspace/... or /tmp/...' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write a file. Any absolute path in the container works; use /workspace/path only for intentional project deliverables. Creates parent directories if needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, e.g. /workspace/... or /tmp/...' },
          content: { type: 'string', description: 'Content to write' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in an existing file and report exactly what changed: how many occurrences were replaced, plus the updated region shown with line numbers. Errors (and changes nothing) if old_string is not found or matches more than one place — so an edit never applies silently or to the wrong spot. old_string must match the file verbatim, including whitespace and indentation.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, e.g. /workspace/...' },
          old_string: { type: 'string', description: 'The exact existing text to replace. Must be unique in the file unless replace_all is true.' },
          new_string: { type: 'string', description: 'The replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring a unique match. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description: 'Fetch the text content of a URL by making an HTTP request (HTML stripped to plain text). Fast but does NOT execute JavaScript — use browser_fetch for JS-rendered pages.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_fetch',
      description: 'Fetch a webpage using a real Chromium browser (Playwright). Executes JavaScript and returns the fully-rendered page text. Use this for SPAs, React/Vue/Angular apps, AEM EDS pages, or any site that requires JS to render content. Slower than fetch_url (~3-5s) but handles dynamic content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The URL to fetch' },
          wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting content (e.g. ".main-content", "#results")' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'view_image',
      description: 'View an image file (screenshot, diagram, or rendered UI) and ask a question about it, answered by a local vision model. Use it to read screenshots/diagrams or to judge a rendered UI\'s layout (alignment, overflow, overlap, truncation).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path to an image file (png/jpg/jpeg/webp/gif) in the workspace, e.g. /workspace/screenshot.png' },
          prompt: { type: 'string', description: 'The question to ask about the image. Defaults to a general description + UI-layout check if omitted.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_plan',
      description: 'Record or refine your plan for a non-trivial task. Call it AFTER reading the relevant files, so the plan is grounded in this project, with ONE concrete, verifiable objective (a definition of done) plus the ordered steps to reach it. Recording a plan does NOT end your turn — keep working after calling it. Call it again to refine the plan when the work contradicts an assumption. The plan is shown to the user and kept in front of you as you work. Skip it entirely for simple questions or one-line changes.\n\nEach step may be given either as plain text, or as an object {"task": "...", "verify": "..."} when it can be checked PROGRAMMATICALLY. `verify` is a shell command, run from the workspace root, that must exit 0 EXACTLY when that step is truly complete — e.g. a test command, a build, or a grep for the change you made. The harness RUNS this command itself before letting you move to the next step; it does not just take your word for it. Provide a verify for every step where a real check is possible — it is far more reliable than a manual claim. Steps left as plain text (or with no verify) fall back to a self-check where you state how you confirmed the step is done.',
      parameters: {
        type: 'object',
        properties: {
          objective: { type: 'string', description: 'One concrete, verifiable success criterion — specific enough to tell unambiguously when the task is done.' },
          steps: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    task: { type: 'string', description: 'The step text.' },
                    verify: { type: 'string', description: 'Shell command (run from the workspace root) that exits 0 exactly when this step is genuinely done — e.g. a test command, a build, or a grep. Omit if there is no real programmatic check.' },
                  },
                  required: ['task'],
                },
              ],
            },
            description: 'Ordered steps to reach the objective. Rewrite the whole list when refining. Give each step as a plain string, or as {"task", "verify"} to attach a shell command the harness will run to confirm the step before advancing.',
          },
        },
        required: ['objective'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ledger',
      description: 'Query the multi-agent ledger — the persistent record under /workspace/.argo/ of every delegation, conclusion, standup, and injection across this task. Use it to look up prior work instead of assuming, e.g. what a dependency actually found/touched, or to recover content that was evicted from your own context.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get_goal', 'get_plan', 'get_recent', 'get_conclusion', 'get_frame_trail', 'expand'],
            description: 'get_goal: the immutable objective. get_plan: the current mutable execution plan. get_recent: sliding window over the ledger (needs n). get_conclusion/get_frame_trail: a specific frame\'s result or full story (needs frame_id). expand: recover a specific evicted episode\'s original content (needs episode_id).',
          },
          frame_id: { type: 'string', description: 'Required for get_conclusion and get_frame_trail.' },
          episode_id: { type: 'string', description: 'Required for expand.' },
          n: { type: 'number', description: 'Required for get_recent — how many recent entries to return.' },
          scope: { type: 'string', enum: ['frame', 'task'], description: 'Optional filter for get_recent, restricting standup entries to one granularity.' },
        },
        required: ['action'],
      },
    },
  },
]

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  // 'view_image' isn't (yet) part of the ToolName union in types.ts — widen the
  // switch discriminant locally rather than touch that file for this addition.
  switch (name as ToolName | 'view_image') {
    case 'bash':
      return bash(args.command as string, args.cwd as string | undefined, args.timeout_ms as number | undefined)
    case 'web_search':
      return webSearch(args.query as string, args.max_results as number | undefined)
    case 'read_file':
      return readFile(args.path as string)
    case 'write_file':
      return writeFile(args.path as string, args.content as string)
    case 'edit_file':
      return editFile(args.path as string, args.old_string as string, args.new_string as string, args.replace_all as boolean | undefined)
    case 'fetch_url':
      return fetchUrl(args.url as string)
    case 'browser_fetch':
      return browserFetch(args.url as string, args.wait_for as string | undefined)
    case 'view_image':
      return viewImage(args.path as string, args.prompt as string | undefined)
    case 'update_plan':
      // Handled in the agent loop (needs agent state); never dispatched here.
      return { output: '', error: 'update_plan is handled by the agent loop' }
    case 'ledger':
      return runLedgerTool(args)
    default:
      return { output: '', error: `Unknown tool: ${name}` }
  }
}
