import fs from 'fs/promises'
import path from 'path'
import { sanitizeForLog } from '../logSanitize'
import { formatAgentLogDateKey } from '../agentLogger/agentLogPaths'
import { formatFeishuCliLogFileName, resolveFeishuCliLogDir } from './feishuCliLogPaths'
import { preprocessFeishuCliFields } from './feishuCliLogFields'

export type FeishuCliLogLevel = 'info' | 'warn' | 'error'

export type FeishuCliLoggerDeps = {
  getWorkDir: () => string
  isPackaged: boolean
  mainDirname?: string
}

let deps: FeishuCliLoggerDeps | null = null
let currentDateKey = ''
let writeChain: Promise<void> = Promise.resolve()

export function initFeishuCliLogger(loggerDeps: FeishuCliLoggerDeps): void {
  deps = {
    ...loggerDeps,
    mainDirname: loggerDeps.mainDirname ?? path.resolve(__dirname, '..')
  }
  currentDateKey = ''

  const logDir = getFeishuCliLogDir()
  logFeishuCliEvent('info', 'feishu.logger.startup', {
    logDir,
    isPackaged: loggerDeps.isPackaged,
    workDir: loggerDeps.getWorkDir()
  })

  if (!loggerDeps.isPackaged && logDir) {
    console.info('[FeishuCliLogger] 开发模式日志目录:', logDir)
  }
}

export function getFeishuCliLogDir(): string | null {
  if (!deps) return null
  return resolveFeishuCliLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
}

export function resetFeishuCliLoggerForTests(): void {
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
  const logDir = resolveFeishuCliLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
  await fs.mkdir(logDir, { recursive: true })

  if (dateKey !== currentDateKey) {
    currentDateKey = dateKey
  }

  const filePath = path.join(logDir, formatFeishuCliLogFileName(now))
  await fs.appendFile(filePath, line + '\n', 'utf8')
}

export function logFeishuCliEvent(
  level: FeishuCliLogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  if (!deps) return

  const preprocessed = preprocessFeishuCliFields(fields)
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

export async function flushFeishuCliLogger(): Promise<void> {
  await writeChain
}

/** Maps FeishuAuditEvent.type to feishu.audit.* file log event. */
export function logFeishuAuditMirror(event: { type: string } & Record<string, unknown>): void {
  const { type, ...rest } = event
  logFeishuCliEvent('info', `feishu.audit.${type}`, rest)
}
