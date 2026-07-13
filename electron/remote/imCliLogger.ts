import fs from 'fs/promises'
import path from 'path'
import { sanitizeForLog } from '../logSanitize'
import { formatAgentLogDateKey } from '../agentLogger/agentLogPaths'
import { resolveAgentLogDir } from '../agentLogger/agentLogPaths'

export type ImCliLogLevel = 'info' | 'warn' | 'error'

export type ImCliLoggerDeps = {
  getWorkDir: () => string
  isPackaged: boolean
  mainDirname?: string
}

export interface ImCliLoggerConfig {
  channel: 'feishu' | 'wechat'
  logFileNamePrefix: string
  preprocessFields: (fields: Record<string, unknown>) => Record<string, unknown>
  consoleLabel?: string
}

export interface ImCliLogger {
  init(deps: ImCliLoggerDeps): void
  getLogDir(): string | null
  resetForTests(): void
  logEvent(level: ImCliLogLevel, event: string, fields?: Record<string, unknown>): void
  flush(): Promise<void>
  logAuditMirror(event: { type: string } & Record<string, unknown>): void
}

function formatImCliLogFileName(prefix: string, date: Date): string {
  return `${prefix}-${formatAgentLogDateKey(date)}.log`
}

export function createImCliLogger(config: ImCliLoggerConfig): ImCliLogger {
  let deps: ImCliLoggerDeps | null = null
  let currentDateKey = ''
  let writeChain: Promise<void> = Promise.resolve()

  function getMainDirname(): string {
    return deps?.mainDirname ?? path.join(__dirname, '..')
  }

  function getLogDir(): string | null {
    if (!deps) return null
    return resolveAgentLogDir(deps.isPackaged, deps.getWorkDir(), getMainDirname())
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

    const filePath = path.join(logDir, formatImCliLogFileName(config.logFileNamePrefix, now))
    await fs.appendFile(filePath, line + '\n', 'utf8')
  }

  return {
    init(loggerDeps: ImCliLoggerDeps): void {
      deps = {
        ...loggerDeps,
        mainDirname: loggerDeps.mainDirname ?? path.resolve(__dirname, '..')
      }
      currentDateKey = ''

      const logDir = getLogDir()
      this.logEvent('info', `${config.channel}.logger.startup`, {
        logDir,
        isPackaged: loggerDeps.isPackaged,
        workDir: loggerDeps.getWorkDir()
      })

      if (!loggerDeps.isPackaged && logDir && config.consoleLabel) {
        console.info(`[${config.consoleLabel}] 开发模式日志目录:`, logDir)
      }
    },

    getLogDir,

    resetForTests(): void {
      deps = null
      currentDateKey = ''
      writeChain = Promise.resolve()
    },

    logEvent(level: ImCliLogLevel, event: string, fields: Record<string, unknown> = {}): void {
      if (!deps) return

      const preprocessed = config.preprocessFields(fields)
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
    },

    async flush(): Promise<void> {
      await writeChain
    },

    logAuditMirror(event: { type: string } & Record<string, unknown>): void {
      const { type, ...rest } = event
      this.logEvent('info', `${config.channel}.audit.${type}`, rest)
    }
  }
}
