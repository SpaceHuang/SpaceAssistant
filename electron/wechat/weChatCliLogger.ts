import { createImCliLogger } from '../remote/imCliLogger'
import { preprocessWeChatCliFields } from './weChatCliLogFields'

export type WeChatCliLogLevel = 'info' | 'warn' | 'error'

export type WeChatCliLoggerDeps = {
  getWorkDir: () => string
  isPackaged: boolean
  mainDirname?: string
}

const logger = createImCliLogger({
  channel: 'wechat',
  logFileNamePrefix: 'WeChatCli',
  preprocessFields: preprocessWeChatCliFields,
  consoleLabel: 'WeChatCliLogger'
})

export function initWeChatCliLogger(loggerDeps: WeChatCliLoggerDeps): void {
  logger.init(loggerDeps)
}

export function getWeChatCliLogDir(): string | null {
  return logger.getLogDir()
}

export function resetWeChatCliLoggerForTests(): void {
  logger.resetForTests()
}

export function logWeChatCliEvent(
  level: WeChatCliLogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  logger.logEvent(level, event, fields)
}

export async function flushWeChatCliLogger(): Promise<void> {
  await logger.flush()
}

export function logWeChatAuditMirror(event: { type: string } & Record<string, unknown>): void {
  logger.logAuditMirror(event)
}
