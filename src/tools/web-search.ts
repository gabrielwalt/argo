import { config } from '../config.js'
import type { ToolResult } from '../types.js'

interface TavilyResult {
  title: string
  url: string
  content: string
}

export async function webSearch(query: string, maxResults = 5): Promise<ToolResult> {
  if (!config.tavilyKey) {
    return { output: '', error: 'TAVILY_API_KEY not set' }
  }

  try {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: config.tavilyKey, query, max_results: maxResults }),
    })

    if (!resp.ok) {
      return { output: '', error: `Tavily error: ${resp.status} ${resp.statusText}` }
    }

    const data = await resp.json() as { results?: TavilyResult[] }
    const results = data.results ?? []

    if (results.length === 0) {
      return { output: 'No results found.' }
    }

    const formatted = results.map((r, i) =>
      `[${i}] ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 300)}`
    ).join('\n\n')

    return { output: formatted }
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
