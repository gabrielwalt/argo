import { bash } from './bash.js'
import { webSearch } from './web-search.js'
import { readFile, writeFile } from './file-ops.js'
import { fetchUrl } from './fetch-url.js'
import { browserFetch } from './browser-fetch.js'
import type { ToolName, ToolResult } from '../types.js'

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
]

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name as ToolName) {
    case 'bash':
      return bash(args.command as string, args.cwd as string | undefined, args.timeout_ms as number | undefined)
    case 'web_search':
      return webSearch(args.query as string, args.max_results as number | undefined)
    case 'read_file':
      return readFile(args.path as string)
    case 'write_file':
      return writeFile(args.path as string, args.content as string)
    case 'fetch_url':
      return fetchUrl(args.url as string)
    case 'browser_fetch':
      return browserFetch(args.url as string, args.wait_for as string | undefined)
    default:
      return { output: '', error: `Unknown tool: ${name}` }
  }
}
