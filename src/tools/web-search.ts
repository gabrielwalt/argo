import { config } from '../config.js'
import type { ToolResult } from '../types.js'

interface TavilyResult {
  title: string
  url: string
  content: string
}

async function tavilySearch(query: string, maxResults: number): Promise<ToolResult> {
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: config.tavilyKey, query, max_results: maxResults }),
  })
  if (!resp.ok) return { output: '', error: `Tavily error: ${resp.status} ${resp.statusText}` }
  const data = await resp.json() as { results?: TavilyResult[] }
  const results = data.results ?? []
  if (results.length === 0) return { output: 'No results found.' }
  return {
    output: results.map((r, i) =>
      `[${i}] ${r.title}\n    ${r.url}\n    ${r.content.slice(0, 300)}`
    ).join('\n\n')
  }
}

async function ddgSearch(query: string, maxResults: number): Promise<ToolResult> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' },
  })
  if (!resp.ok) return { output: '', error: `DDG error: ${resp.status}` }
  const html = await resp.text()

  // Extract results from DDG HTML via regex — avoids a cheerio dep in the server
  const results: { title: string; url: string; snippet: string }[] = []
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const links: { title: string; url: string }[] = []
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(html)) !== null && links.length < maxResults) {
    const href = m[1].startsWith('/') ? `https://duckduckgo.com${m[1]}` : m[1]
    // DDG wraps links — extract uddg= param if present
    try {
      const u = new URL(href)
      const real = u.searchParams.get('uddg') ?? href
      links.push({ url: decodeURIComponent(real), title: m[2].trim() })
    } catch { links.push({ url: href, title: m[2].trim() }) }
  }
  const snippets: string[] = []
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').trim())
  }
  for (let i = 0; i < links.length; i++) {
    results.push({ ...links[i], snippet: snippets[i] ?? '' })
  }
  if (results.length === 0) return { output: 'No results found.' }
  return {
    output: results.map((r, i) =>
      `[${i}] ${r.title}\n    ${r.url}\n    ${r.snippet.slice(0, 300)}`
    ).join('\n\n')
  }
}

export async function webSearch(query: string, maxResults = 5): Promise<ToolResult> {
  try {
    if (config.tavilyKey) return await tavilySearch(query, maxResults)
    return await ddgSearch(query, maxResults)
  } catch (err) {
    return { output: '', error: String(err) }
  }
}
