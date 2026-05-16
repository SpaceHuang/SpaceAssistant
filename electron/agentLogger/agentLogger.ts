import fs from 'fs/promises'
import path from 'path'
import type { AgentLogEventName, AgentLogFields, AgentLogLevel } from './types'
import { formatAgentLogDateKey, formatAgentLogFileName, resolveAgentLogDir } from './agentLogPaths'
import { sanitizeForLog } from './sanitize'

export type AgentLoggerDeps = {
  getWorkDir: () => string
  isPackaged: boolean
  mainDirname?: string
}

let deps: AgentLoggerDeps | null = null
let currentDateKey = ''
let writeChain: Promise<void> = Promise.resolve()

export function initAgentLogger(loggerDeps: AgentLoggerDeps): void {
  // agentLogger 位于 electron/agentLogger/，默认应使用上级 electron/ 目录（即 main.js 所在目录）
  deps = {
    ...loggerDeps,
    mainDirname: loggerDeps.mainDirname ?? path.resolve(__dirname, '..')
  }
  currentDateKey = ''
}

export function getAgentLogDir(): string | null {
  if (!deps) return null
  return resolveAgentLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
}

export function resetAgentLoggerForTests(): void {
  deps = null
  currentDateKey = ''
  writeChain = Promise.resolve()
}

function getMainDirname(): string {
  return deps?.mainDirname ?? path.join(__dirname)
}

async function appendLine(line: string): Promise<void> {
  if (!deps) return

  const now = new Date()
  const dateKey = formatAgentLogDateKey(now)
  const logDir = resolveAgentLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
  await fs.mkdir(logDir, { recursive: true })

  if (dateKey !== currentDateKey) {
    currentDateKey = dateKey
  }

  const filePath = path.join(logDir, formatAgentLogFileName(now))
  await fs.appendFile(filePath, line + '\n', 'utf8')
}

export function logAgentEvent(level: AgentLogLevel, event: AgentLogEventName, fields: AgentLogFields = {}): void {
  if (!deps) return

  const payload = sanitizeForLog({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields
  }) as Record<string, unknown>

  let line: string
  try {
    line = JSON.stringify(payload)
  } catch {
    line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      error: 'Failed to serialize log payload'
    })
  }

  writeChain = writeChain
    .then(() => appendLine(line))
    .catch(() => {
      // Swallow write errors to avoid breaking agent flow
    })
}

export async function flushAgentLogger(): Promise<void> {
  await writeChain
}
