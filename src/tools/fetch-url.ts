import { parse } from 'node-html-parser'
import type { ToolResult } from '../types.js'

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

    if (contentType.includes('text/html')) {
      const root = parse(text)
      root.querySelectorAll('script, style, nav, footer, header').forEach(el => el.remove())
      const plain = root.text.replace(/\s+/g, ' ').trim().slice(0, 3000)
      return { output: plain }
    }

    return { output: text.slice(0, 3000) }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
