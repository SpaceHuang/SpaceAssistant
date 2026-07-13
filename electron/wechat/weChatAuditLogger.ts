import type { WeChatAuditEvent, WeChatAuditQueryResult } from '../../src/shared/wechatTypes'
import { ImAuditLogger } from '../remote/imAuditLogger'
import { logWeChatAuditMirror } from './weChatCliLogger'

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class WeChatAuditLogger {
  private inner: ImAuditLogger<WeChatAuditEvent>

  constructor(userDataDir: string) {
    this.inner = new ImAuditLogger<WeChatAuditEvent>({
      channel: 'wechat',
      userDataDir,
      maxFileBytes: 10 * 1024 * 1024,
      maxBackups: 3,
      retentionMs: RETENTION_MS,
      logMirror: logWeChatAuditMirror,
      logFileName: 'wechat-audit.log'
    })
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    await this.inner.purgeExpired(now)
  }

  async append(event: { type: string; ts?: number } & Record<string, unknown>): Promise<void> {
    await this.inner.append(event)
  }

  async tail(limit = 50, types?: string[]): Promise<WeChatAuditEvent[]> {
    return this.inner.tail(limit, types)
  }

  async query(opts: {
    since?: number
    types?: string[]
    limit?: number
  }): Promise<WeChatAuditQueryResult> {
    const { entries, total } = await this.inner.query(opts)
    return { events: entries, total }
  }
}
