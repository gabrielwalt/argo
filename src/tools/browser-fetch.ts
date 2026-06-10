import { spawn } from 'child_process'
import { config } from '../config.js'
import type { ToolResult } from '../types.js'

const MAX_OUTPUT = 8000

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
    process.stdout.write(text.slice(0, ${MAX_OUTPUT}));
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
      resolve({ output: stdout.slice(0, MAX_OUTPUT), error: 'Timed out after 45s' })
    }, 45_000)

    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !stdout.trim()) {
        resolve({ output: stdout.slice(0, MAX_OUTPUT), error: stderr.slice(0, 500) || `Exit code ${code}` })
      } else {
        resolve({ output: stdout.slice(0, MAX_OUTPUT) })
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
