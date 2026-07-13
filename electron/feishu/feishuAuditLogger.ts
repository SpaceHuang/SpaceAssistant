import type { FeishuAuditEvent } from '../../src/shared/feishuTypes'
import { ImAuditLogger } from '../remote/imAuditLogger'
import { logFeishuAuditMirror } from './feishuCliLogger'

export class FeishuAuditLogger {
  private inner: ImAuditLogger<FeishuAuditEvent>

  constructor(userDataDir: string) {
    this.inner = new ImAuditLogger<FeishuAuditEvent>({
      channel: 'feishu',
      userDataDir,
      maxFileBytes: 5 * 1024 * 1024,
      maxBackups: 5,
      logMirror: logFeishuAuditMirror,
      logFileName: 'feishu-audit.log'
    })
  }

  async append(event: { type: string; ts?: number } & Record<string, unknown>): Promise<void> {
    await this.inner.append(event)
  }

  async tail(limit = 50, types?: string[]): Promise<FeishuAuditEvent[]> {
    return this.inner.tail(limit, types)
  }

  async query(opts: {
    since?: number
    types?: string[]
    limit?: number
  }): Promise<{ entries: FeishuAuditEvent[]; truncated: boolean }> {
    const { entries, truncated } = await this.inner.query(opts)
    return { entries, truncated }
  }

  contentHash(text: string): string {
    return this.inner.contentHash(text)
  }
}
