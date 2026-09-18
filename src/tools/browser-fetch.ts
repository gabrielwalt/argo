import { spawn } from 'child_process'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'
import { truncateOutput } from './truncate.js'

// The FINAL shape the model actually sees — head+tail (truncateOutput),
// applied here in the outer function, not inside the spawned script. External,
// uncontrolled-size content (a rendered page's innerText has no relationship
// to anything the agent authored), so this must stay bounded; head+tail beats
// a bare head slice since the relevant part of a long page is routinely near
// the end, not the start.
const MAX_OUTPUT = 8000
// A coarser cap applied INSIDE the spawned script, purely to bound the size of
// the stdout payload piped back over the process boundary — several times
// MAX_OUTPUT so the outer truncateOutput below still has real head AND tail
// content to work with (a script-side head-only slice at exactly MAX_OUTPUT
// would leave nothing past that point for a "tail" to ever show).
const SCRIPT_SAFETY_CAP = 40_000

function makeScript(url: string, waitFor?: string): string {
  return `
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  try {
    await page.goto(${JSON.stringify(url)}, { waitUntil: 'networkidle', timeout: 30000 });
    ${waitFor ? `await page.waitForSelector(${JSON.stringify(waitFor)}, { timeout: 10000 });` : ''}
    const text = await page.innerText('body');
    process.stdout.write(text.slice(0, ${SCRIPT_SAFETY_CAP}));
  } catch (e) {
    process.stderr.write('Error: ' + e.message + '\\n');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
`.trim()
}

export async function browserFetch(url: string, waitFor?: string): Promise<ToolResult> {
  return new Promise((resolve) => {
    const [cmd, args] = config.inContainer
      ? ['node', ['--input-type=commonjs']]
      : ['docker', ['exec', '-i', config.sandboxContainer, 'node', '--input-type=commonjs']]

    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    const timer = setTimeout(() => {
      proc.kill()
      resolve({ output: truncateOutput(stdout, MAX_OUTPUT), error: 'Timed out after 45s' })
    }, 45_000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !stdout.trim()) {
        resolve({ output: truncateOutput(stdout, MAX_OUTPUT), error: stderr.slice(0, 500) || `Exit code ${code}` })
      } else {
        resolve({ output: truncateOutput(stdout, MAX_OUTPUT) })
      }
    })

    proc.on('error', (err) => {
      clearTimeout(timer)
      resolve({ output: '', error: err.message })
    })

    proc.stdin.write(makeScript(url, waitFor))
    proc.stdin.end()
  })
}
