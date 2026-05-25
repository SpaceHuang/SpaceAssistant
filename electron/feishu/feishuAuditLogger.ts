import fs from 'fs/promises'
import path from 'path'
import type { FeishuAuditEvent } from '../../src/shared/feishuTypes'

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_BACKUPS = 5

export class FeishuAuditLogger {
  private logPath: string
  private logDir: string

  constructor(userDataDir: string) {
    this.logDir = path.join(userDataDir, 'logs')
    this.logPath = path.join(this.logDir, 'feishu-audit.log')
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true })
  }

  private hashPreview(text: string): string {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
    return Math.abs(h).toString(16).slice(0, 8)
  }

  async append(event: { type: string; ts?: number } & Record<string, unknown>): Promise<void> {
    await this.ensureDir()
    try {
      const stat = await fs.stat(this.logPath)
      if (stat.size >= MAX_FILE_BYTES) await this.rotate()
    } catch {
      /* new file */
    }
    const entry: FeishuAuditEvent = { ...event, ts: event.ts ?? Date.now() } as FeishuAuditEvent
  await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8')
  }

  private async rotate(): Promise<void> {
    for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
      const from = `${this.logPath}.${i}`
      const to = `${this.logPath}.${i + 1}`
      try {
        await fs.rename(from, to)
      } catch {
        /* skip */
      }
    }
    try {
      await fs.rename(this.logPath, `${this.logPath}.1`)
    } catch {
      /* skip */
    }
  }

  async tail(limit = 50, types?: string[]): Promise<FeishuAuditEvent[]> {
    try {
      const raw = await fs.readFile(this.logPath, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      let entries = lines
        .map((l) => {
          try {
            return JSON.parse(l) as FeishuAuditEvent
          } catch {
            return null
          }
        })
        .filter((e): e is FeishuAuditEvent => e !== null)
      if (types?.length) entries = entries.filter((e) => types.includes(e.type))
      return entries.slice(-limit)
    } catch {
      return []
    }
  }

  async query(opts: { since?: number; types?: string[]; limit?: number }): Promise<{ entries: FeishuAuditEvent[]; truncated: boolean }> {
    const limit = opts.limit ?? 500
    let entries = await this.tail(10_000, opts.types)
    if (opts.since) entries = entries.filter((e) => e.ts >= opts.since!)
    const truncated = entries.length > limit
    return { entries: entries.slice(-limit), truncated }
  }

  contentHash(text: string): string {
    return this.hashPreview(text)
  }
}
