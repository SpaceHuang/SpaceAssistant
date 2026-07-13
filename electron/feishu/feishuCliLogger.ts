import { createImCliLogger } from '../remote/imCliLogger'
import { preprocessFeishuCliFields } from './feishuCliLogFields'

export type FeishuCliLogLevel = 'info' | 'warn' | 'error'

export type FeishuCliLoggerDeps = {
  getWorkDir: () => string
  isPackaged: boolean
  mainDirname?: string
}

const logger = createImCliLogger({
  channel: 'feishu',
  logFileNamePrefix: 'FeishuCli',
  preprocessFields: preprocessFeishuCliFields,
  consoleLabel: 'FeishuCliLogger'
})

export function initFeishuCliLogger(loggerDeps: FeishuCliLoggerDeps): void {
  logger.init(loggerDeps)
}

export function getFeishuCliLogDir(): string | null {
  return logger.getLogDir()
}

export function resetFeishuCliLoggerForTests(): void {
  logger.resetForTests()
}

export function logFeishuCliEvent(
  level: FeishuCliLogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  logger.logEvent(level, event, fields)
}

export async function flushFeishuCliLogger(): Promise<void> {
  await logger.flush()
}

export function logFeishuAuditMirror(event: { type: string } & Record<string, unknown>): void {
  logger.logAuditMirror(event)
}
