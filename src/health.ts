import { exec } from 'child_process'
import { promisify } from 'util'
import { config } from './config.js'

const execAsync = promisify(exec)

export interface EnvCheck {
  ollama: boolean
  docker: boolean
  git: boolean
}

export async function checkOllama(): Promise<boolean> {
  return fetch(`${config.ollamaHost}/api/tags`).then(r => r.ok).catch(() => false)
}

export async function checkDocker(): Promise<boolean> {
  return execAsync('docker info').then(() => true).catch(() => false)
}

export async function checkGit(): Promise<boolean> {
  const cmd = config.inContainer
    ? 'git --version'
    : `docker exec ${config.sandboxContainer} git --version`
  return execAsync(cmd).then(() => true).catch(() => false)
}

// Full check for server.ts (standalone + worker). Worker mode is already
// inside a container, so a "docker running" check there is meaningless.
export async function checkEnvironment(): Promise<EnvCheck> {
  const [ollama, docker, git] = await Promise.all([
    checkOllama(),
    config.inContainer ? Promise.resolve(true) : checkDocker(),
    checkGit(),
  ])
  return { ollama, docker, git }
}

export function logEnvironment(label: string, env: Partial<EnvCheck>): void {
  const mark = (ok: boolean | undefined) => ok ? '✓' : '✗'
  const parts: string[] = []
  if ('ollama' in env) parts.push(`${mark(env.ollama)} Ollama`)
  if ('docker' in env) parts.push(`${mark(env.docker)} Docker`)
  if ('git' in env) parts.push(`${mark(env.git)} git`)
  const allOk = Object.values(env).every(Boolean)
  console.log(`${allOk ? '' : '⚠ '}[${label}] ${parts.join('  ')}`)
}
