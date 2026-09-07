import { bash } from './bash.js'
import { webSearch } from './web-search.js'
import { readFile, readFiles, writeFile, editFile } from './file-ops.js'
import { fetchUrl } from './fetch-url.js'
import { browserFetch } from './browser-fetch.js'
import * as ledger from '../ledger.js'
import { config } from '../config.js'
import type { ToolName, ToolResult } from '../types.js'

// MULTI-AGENT LEDGER TOOL. Query-only from a model's perspective — the harness-automatic
// writers (recordDelegation, recordConclusion, ...) are called directly from
// dispatch.ts/frames.ts, never through this tool, so they can never be forgotten. Root
// is config.workspacePath, NOT a literal '/workspace' — that literal only exists on the
// filesystem in-container; standalone dev mode runs this process directly on the host
// (see dispatch.ts's root() for the full rationale). Never throws — errors go in the
// `error` field, matching every other tool in this module.
async function runLedgerTool(args: Record<string, unknown>): Promise<ToolResult> {
  const root = config.workspacePath || '/workspace'
  const action = typeof args.action === 'string' ? args.action : ''
  try {
    switch (action) {
      case 'get_goal': {
        const obj = await ledger.getObjective(root)
        return { output: obj ?? '(no objective set yet)' }
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
        return { output: '', error: `Unknown ledger action: ${action}. Valid: get_goal, get_recent, get_conclusion, get_frame_trail, expand.` }
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
      description: 'Execute a Bash command in the sandbox container. /workspace is the user\'s git-tracked project. Only write there for intentional project changes or deliverables; use /tmp for temporary scripts, screenshots, diagnostics, downloads, experiments, and other disposable files. Commands time out after 30s by default, or 120s for Playwright/Chromium commands. Timeouts are reported explicitly. If a command genuinely needs longer, set timeout_ms instead of adding sleeps or unnecessary waits.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
          cwd: { type: 'string', description: 'Working directory, any absolute path. Default cwd is /workspace.' },
          timeout_ms: { type: 'number', description: 'Override the default kill timeout in milliseconds, for a command you know legitimately needs more time. Capped at 180000 (3 minutes).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read or search files in the container. Use path to read one file, or paths to read several files in one call. For large files, use offset/limit to read the relevant line range instead of relying on truncated whole-file output. If you do not know where relevant content is, use pattern to search the entire file for an exact literal substring and get matching line numbers, then read around those lines with offset/limit. Any absolute path works; project files are under /workspace. Whole-file reads are capped at 8000 characters per file and may omit the middle.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to one file, e.g. /workspace/src/app.ts or /tmp/output.txt.' },
          paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to multiple files. Each file is returned in a labeled section; missing files produce inline errors without failing the whole call. When set, path, offset, limit, and pattern are ignored.' },
          offset: { type: 'number', description: '1-based first line to return. Use with limit to page through a large file. Ignored when pattern is set.' },
          limit: { type: 'number', description: 'Number of lines to return from offset. If omitted, reads to the end, subject to the 8000-character cap. Ignored when pattern is set.' },
          pattern: { type: 'string', description: 'Search the entire file for this exact literal substring and return matching line numbers instead of file content. Not a regex. When set, offset and limit are ignored.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'write_file',
      description: 'Write the complete contents of a file, replacing any existing contents. Creates parent directories as needed. Any absolute path in the container works; write under /workspace only for intentional project changes or deliverables, and use /tmp for temporary files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute file path, e.g. /workspace/src/app.ts or /tmp/output.txt.' },
          content: { type: 'string', description: 'Complete file contents to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'edit_file',
      description: 'Edit an existing file by replacing exact text. old_string must match verbatim, including whitespace. By default it must occur exactly once; if it is missing or ambiguous, the edit fails without changing the file. Set replace_all to replace every occurrence. Returns the changed region with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the existing file, e.g. /workspace/src/app.ts.' },
          old_string: { type: 'string', description: 'Exact existing text to replace. Must be unique unless replace_all is true.' },
          new_string: { type: 'string', description: 'Replacement text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string. Default false.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'fetch_url',
      description: 'Fetch a URL and return its page content as plain text. Does not execute JavaScript; use browser_fetch when the page requires client-side rendering.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to fetch.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'web_search',
      description: 'Search the web for current or external information and return relevant results.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'number', description: 'Maximum number of results to return. Default 5, maximum 10.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_fetch',
      description: 'Open a webpage in Chromium with Playwright, execute JavaScript, and return the rendered page text. Use this when client-side rendering or browser execution is required; otherwise prefer fetch_url.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to open.' },
          wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting the rendered text.' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'conclude',
      description: 'End your session and return its structured result. This is the only way to finish; a response without a conclude call does not end the session.',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Outcome status. Use only a status allowed by your current role and assignment.' },
          message: { type: 'string', description: 'Final result, answer, summary, assignment, or explanation for this session.' },
        },
        required: ['status', 'message'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ledger',
      description: 'Query Argo\'s persistent multi-agent record for prior objectives, agent results, and task history. Use it to recover or verify prior work instead of guessing from memory or incomplete context.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get_goal', 'get_recent', 'get_conclusion', 'get_frame_trail', 'expand'],
            description: 'What to retrieve: get_goal = immutable objective; get_recent = recent ledger entries; get_conclusion = one frame\'s final result; get_frame_trail = one frame\'s full recorded history; expand = full content of an evicted episode.',
          },
          frame_id: { type: 'string', description: 'Frame ID for get_conclusion or get_frame_trail.' },
          episode_id: { type: 'string', description: 'Episode ID for expand.' },
          n: { type: 'number', description: 'Number of entries to return for get_recent.' },
          scope: { type: 'string', enum: ['frame', 'task'], description: 'Optional get_recent filter: restrict standup entries to frame- or task-level records.' },
        },
        required: ['action'],
      },
    },
  },
]

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name as ToolName) {
    case 'bash':
      return bash(args.command as string, args.cwd as string | undefined, args.timeout_ms as number | undefined)
    case 'web_search':
      return webSearch(args.query as string, args.max_results as number | undefined)
    case 'read_file': {
      // Multi-file read: paths array takes precedence over single path
      const paths = Array.isArray(args.paths) ? args.paths as string[] : null
      if (paths && paths.length > 0) {
        return readFiles(paths)
      }
      if (!args.path || typeof args.path !== 'string') {
        return { output: '', error: 'read_file requires either a "path" string or a "paths" array.' }
      }
      return readFile(args.path as string, args.offset as number | undefined, args.limit as number | undefined, args.pattern as string | undefined)
    }
    case 'write_file':
      return writeFile(args.path as string, args.content as string)
    case 'edit_file':
      return editFile(args.path as string, args.old_string as string, args.new_string as string, args.replace_all as boolean | undefined)
    case 'fetch_url':
      return fetchUrl(args.url as string)
    case 'browser_fetch':
      return browserFetch(args.url as string, args.wait_for as string | undefined)
    case 'conclude':
      // Handled in the agent loop (terminates the session); never dispatched here.
      return { output: '', error: 'conclude is handled by the agent loop' }
    case 'ledger':
      return runLedgerTool(args)
    default:
      return { output: '', error: `Unknown tool: ${name}` }
  }
}
