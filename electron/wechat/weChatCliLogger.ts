import fs from 'fs/promises'
import path from 'path'
import { sanitizeForLog } from '../logSanitize'
import { formatAgentLogDateKey } from '../agentLogger/agentLogPaths'
import { formatWeChatCliLogFileName, resolveWeChatCliLogDir } from './weChatCliLogPaths'
import { preprocessWeChatCliFields } from './weChatCliLogFields'

export type WeChatCliLogLevel = 'info' | 'warn' | 'error'

export type WeChatCliLoggerDeps = {
  getWorkDir: () => string
  isPackaged: boolean
  mainDirname?: string
}

let deps: WeChatCliLoggerDeps | null = null
let currentDateKey = ''
let writeChain: Promise<void> = Promise.resolve()

export function initWeChatCliLogger(loggerDeps: WeChatCliLoggerDeps): void {
  deps = {
    ...loggerDeps,
    mainDirname: loggerDeps.mainDirname ?? path.resolve(__dirname, '..')
  }
  currentDateKey = ''

  const logDir = getWeChatCliLogDir()
  logWeChatCliEvent('info', 'wechat.logger.startup', {
    logDir,
    isPackaged: loggerDeps.isPackaged,
    workDir: loggerDeps.getWorkDir()
  })

  if (!loggerDeps.isPackaged && logDir) {
    console.info('[WeChatCliLogger] 开发模式日志目录:', logDir)
  }
}

export function getWeChatCliLogDir(): string | null {
  if (!deps) return null
  return resolveWeChatCliLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
}

export function resetWeChatCliLoggerForTests(): void {
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
  const logDir = resolveWeChatCliLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
  await fs.mkdir(logDir, { recursive: true })

  if (dateKey !== currentDateKey) {
    currentDateKey = dateKey
  }

  const filePath = path.join(logDir, formatWeChatCliLogFileName(now))
  await fs.appendFile(filePath, line + '\n', 'utf8')
}

export function logWeChatCliEvent(
  level: WeChatCliLogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  if (!deps) return

  const preprocessed = preprocessWeChatCliFields(fields)
  const payload = sanitizeForLog({
    ts: new Date().toISOString(),
    level,
    event,
    ...preprocessed
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
      /* swallow IO errors */
    })
}

export async function flushWeChatCliLogger(): Promise<void> {
  await writeChain
}

/** Maps WeChatAuditEvent.type to wechat.audit.* file log event. */
export function logWeChatAuditMirror(event: { type: string } & Record<string, unknown>): void {
  const { type, ...rest } = event
  logWeChatCliEvent('info', `wechat.audit.${type}`, rest)
}
