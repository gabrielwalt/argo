// Head-only truncation silently drops the end of long output — for verbose
// reproduction scripts and test runs, the decisive line (final tally,
// pass/fail count, the actual error) is almost always at the end, not the
// start. Keep a small head for context plus a larger verbatim tail, with an
// explicit marker showing how much was cut.
export function truncateOutput(text: string, max: number): string {
  if (text.length <= max) return text
  const headSize = Math.min(500, Math.floor(max / 4))
  const markerBudget = 60
  const tailSize = Math.max(0, max - headSize - markerBudget)
  if (tailSize === 0) return text.slice(-max)
  const omitted = text.length - headSize - tailSize
  const marker = `\n[... ${omitted} chars omitted ...]\n`
  return text.slice(0, headSize) + marker + text.slice(text.length - tailSize)
}
