import { parse } from 'node-html-parser'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

const MAX_OUTPUT = 3000

export async function fetchUrl(url: string): Promise<ToolResult> {
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; local-agent/1.0)' },
      signal: AbortSignal.timeout(15_000),
    })

    if (!resp.ok) {
      return { output: '', error: `HTTP ${resp.status}: ${resp.statusText}` }
    }

    const contentType = resp.headers.get('content-type') ?? ''
    const text = await resp.text()

    // External, uncontrolled-size content (a fetched page has no relationship
    // to anything the agent authored) — truncateOutput's head+tail shape
    // beats a bare head-only slice here specifically because the relevant
    // part of a long page is routinely near the end, not the start (nav/
    // boilerplate text tends to front-load a page).
    if (contentType.includes('text/html')) {
      const root = parse(text)
      root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove())
      const plain = root.text.replace(/\s+/g, ' ').trim()
      return { output: truncateOutput(plain, MAX_OUTPUT) }
    }

    return { output: truncateOutput(text, MAX_OUTPUT) }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
