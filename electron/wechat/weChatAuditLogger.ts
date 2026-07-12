import fs from 'fs/promises'
import path from 'path'
import type { WeChatAuditEvent, WeChatAuditQueryResult } from '../../src/shared/wechatTypes'
import { logWeChatAuditMirror } from './weChatCliLogger'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_BACKUPS = 3
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

export class WeChatAuditLogger {
  private logPath: string
  private logDir: string

  constructor(userDataDir: string) {
    this.logDir = path.join(userDataDir, 'logs')
    this.logPath = path.join(this.logDir, 'wechat-audit.log')
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true })
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    const cutoff = now - RETENTION_MS
    try {
      const raw = await fs.readFile(this.logPath, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      const kept = lines.filter((l) => {
        try {
          const e = JSON.parse(l) as { ts?: number }
          return (e.ts ?? 0) >= cutoff
        } catch {
          return false
        }
      })
      if (kept.length < lines.length) {
        await fs.writeFile(this.logPath, kept.length ? `${kept.join('\n')}\n` : '', 'utf8')
      }
    } catch {
      /* no file */
    }
  }

  async append(event: { type: string; ts?: number } & Record<string, unknown>): Promise<void> {
    await this.ensureDir()
    try {
      const stat = await fs.stat(this.logPath)
      if (stat.size >= MAX_FILE_BYTES) await this.rotate()
    } catch {
      /* new file */
    }
    const entry: WeChatAuditEvent = { ...event, ts: event.ts ?? Date.now() } as WeChatAuditEvent
    await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8')
    logWeChatAuditMirror(entry as { type: string } & Record<string, unknown>)
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

  async tail(limit = 50, types?: string[]): Promise<WeChatAuditEvent[]> {
    try {
      const raw = await fs.readFile(this.logPath, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      let entries = lines
        .map((l) => {
          try {
            return JSON.parse(l) as WeChatAuditEvent
          } catch {
            return null
          }
        })
        .filter((e): e is WeChatAuditEvent => e !== null)
      if (types?.length) entries = entries.filter((e) => types.includes(e.type))
      return entries.slice(-limit)
    } catch {
      return []
    }
  }

  async query(opts: { since?: number; types?: string[]; limit?: number }): Promise<WeChatAuditQueryResult> {
    const limit = opts.limit ?? 500
    let entries = await this.tail(10_000, opts.types)
    if (opts.since) entries = entries.filter((e) => e.ts >= opts.since!)
    return { events: entries.slice(-limit), total: entries.length }
  }
}
