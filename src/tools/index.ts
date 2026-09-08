import { bash } from './bash.js'
import { webSearch } from './web-search.js'
import { readFile, writeFile, editFile } from './file-ops.js'
import { fetchUrl } from './fetch-url.js'
import { browserFetch } from './browser-fetch.js'
import * as ledger from '../ledger.js'
import { config } from '../config.js'
import type { ToolName, ToolResult } from '../types.js'

// PER-FRAME LEDGER TOOL. Query-only from a model's perspective — the
// harness-automatic writer (ledger.recordMessage) is called directly from
// agent.ts's pushCtx, never through this tool, so it can never be forgotten. Root
// is config.workspacePath, NOT a literal '/workspace' — that literal only exists on
// the filesystem in-container; standalone dev mode runs this process directly on
// the host (see dispatch.ts's root() for the full rationale). Never throws —
// errors go in the `error` field, matching every other tool in this module.
//
// Each frame sees ONLY ITS OWN messages, scoped by `ctx.frameId` — never something
// the model itself supplies as a tool argument (a model could otherwise ask to see
// through another frame's eyes). There is no cross-agent visibility any more: the
// old dispatcher-sees-all/planner-sees-implementer rules are gone, since the frame
// identity now IS the file, and a frame only ever reads its own file. `ctx` stays
// optional only so callers/tests that invoke executeTool directly (outside a
// frame) don't need to fabricate one.
export interface LedgerToolContext {
  frameId: string
}

async function runLedgerTool(args: Record<string, unknown>, ctx?: LedgerToolContext): Promise<ToolResult> {
  if (!ctx) return { output: '(ledger is only available inside a dispatch)' }
  const root = config.workspacePath || '/workspace'
  const action = typeof args.action === 'string' ? args.action : ''
  try {
    switch (action) {
      case 'get_objective': {
        // The objective is the first user-role message in this frame's ledger
        const msgs = await ledger.readFrame(root, ctx.frameId)
        const objective = msgs.find(m => m.role === 'user')
        return { output: objective?.content ?? '(no objective found)' }
      }
      case 'get_recent': {
        const n = typeof args.n === 'number' ? args.n : 20
        const msgs = await ledger.readFrame(root, ctx.frameId)
        const stripped = msgs.slice(-n).map(m => ({ id: m.id, role: m.role, content: m.content }))
        return { output: JSON.stringify(stripped) }
      }
      case 'get_msg_id': {
        const msgId = typeof args.msg_id === 'string' ? args.msg_id : ''
        if (!msgId) return { output: '', error: 'get_msg_id requires msg_id' }
        const content = await ledger.expand(root, msgId, ctx.frameId)
        return { output: content ?? '(no content found for that msg_id)' }
      }
      default:
        return { output: '', error: `Unknown ledger action: ${action}. Valid: get_objective, get_recent, get_msg_id.` }
    }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}

// Default (read-write) bash description — used for every role unless agent.ts's
// chatCall patches it to BASH_DESCRIPTION_READONLY (frames.ts's
// patchBashForReadOnly) for a read-only role (Dispatcher/Planner). Exported so
// agent.ts/tests can reference the exact default string rather than re-deriving it.
export const BASH_DESCRIPTION_READWRITE = 'Execute a Bash command in the sandbox container. /workspace is the user\'s git-tracked project. Only write there for intentional project changes or deliverables; use /tmp for temporary scripts, screenshots, diagnostics, downloads, experiments, and other disposable files. Commands time out after 30s by default, or 120s for Playwright/Chromium commands. Timeouts are reported explicitly. If a command genuinely needs longer, set timeout_ms instead of adding sleeps or unnecessary waits.'

// READ-ONLY bash description — for Dispatcher/Planner, whose own ROLE_INSTRUCTIONS
// state the project is read-only for them. Deliberately omits any mention of
// writing to /workspace (the read-write description's whole first half) so the
// TOOL SCHEMA itself never suggests that path, matching the role's own prompt
// framing instead of contradicting it. Still mentions /tmp for temporary files,
// since investigation (e.g. downloading something to inspect, saving a scratch
// script) is still a legitimate read-only-role use of bash.
export const BASH_DESCRIPTION_READONLY = 'Execute a Bash command in the sandbox container for investigation. /workspace is the user\'s project (read-only for this role). Use commands like ls, find, grep, cat, head, tail, wc, tree, rg to explore the project structure and content. Use /tmp for any temporary files.'

export const toolDefinitions = [
  {
    type: 'function' as const,
    function: {
      name: 'bash',
      description: BASH_DESCRIPTION_READWRITE,
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run' },
          cwd: { type: 'string', description: 'Working directory, any absolute path. Default cwd is /workspace.' },
          timeout_ms: { type: 'integer', minimum: 1, maximum: 300000, description: 'Override the default kill timeout in milliseconds, for a command you know legitimately needs more time. Capped at 300000 (5 minutes).' },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'read_file',
      description: 'Read or search a file. For large files, use offset/limit to read a specific line range. Use pattern to search for an exact literal substring and get matching line numbers with optional context lines. Whole-file reads are capped at 8000 characters and may omit the middle.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the file, e.g. /workspace/src/app.ts.' },
          offset: { type: 'integer', minimum: 1, description: '1-based first line to return. Ignored when pattern is set.' },
          limit: { type: 'integer', minimum: 1, description: 'Number of lines from offset. Ignored when pattern is set.' },
          pattern: { type: 'string', description: 'Search for this exact literal substring (not a regex). Returns matching line numbers.' },
          context: { type: 'integer', minimum: 0, maximum: 20, description: 'Lines of context around each pattern match (default 0).' },
        },
        required: ['path'],
        additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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
        additionalProperties: false,
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
          max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results (default 5, max 10)' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'browser_fetch',
      description: 'Open a webpage in Chromium with Playwright, execute JavaScript, and return its rendered text only. Does not provide visual inspection, screenshots, or interaction — use bash with Playwright scripts for those. Use for client-rendered content that fetch_url cannot handle.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Absolute URL to open.' },
          wait_for: { type: 'string', description: 'Optional CSS selector to wait for before extracting the rendered text.' },
        },
        required: ['url'],
        additionalProperties: false,
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
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ledger',
      description: 'Recover information that has been collapsed or evicted from your current context.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['get_objective', 'get_recent', 'get_msg_id'],
            description: 'What to retrieve: get_objective = your original assignment; get_recent = recent context entries; get_msg_id = restore the full content referenced by an evicted/collapsed stub.',
          },
          n: { type: 'number', description: 'Number of entries to return for get_recent. Default 20.' },
          msg_id: { type: 'string', description: 'Message ID to recover with get_msg_id, taken verbatim from the collapsed/evicted stub.' },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
]

export async function executeTool(name: string, args: Record<string, unknown>, ctx?: LedgerToolContext): Promise<ToolResult> {
  switch (name as ToolName) {
    case 'bash':
      return bash(args.command as string, args.cwd as string | undefined, args.timeout_ms as number | undefined)
    case 'web_search':
      return webSearch(args.query as string, args.max_results as number | undefined)
    case 'read_file': {
      if (!args.path || typeof args.path !== 'string') {
        return { output: '', error: 'read_file requires a "path" string.' }
      }
      return readFile(args.path as string, args.offset as number | undefined, args.limit as number | undefined, args.pattern as string | undefined, args.context as number | undefined)
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
      return runLedgerTool(args, ctx)
    default:
      return { output: '', error: `Unknown tool: ${name}` }
  }
}
