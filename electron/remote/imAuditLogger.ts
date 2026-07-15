import fs from 'fs/promises'
import path from 'path'

export interface ImAuditLoggerOpts {
  channel: 'feishu' | 'wechat'
  userDataDir: string
  maxFileBytes: number
  maxBackups: number
  retentionMs?: number
  logMirror: (event: { type: string } & Record<string, unknown>) => void
  logFileName: string
}

export interface ImAuditQueryResult<T> {
  entries: T[]
  truncated: boolean
  total: number
}

export class ImAuditLogger<T extends { type: string; ts?: number }> {
  private logPath: string
  private logDir: string

  constructor(private opts: ImAuditLoggerOpts) {
    this.logDir = path.join(opts.userDataDir, 'logs')
    this.logPath = path.join(this.logDir, opts.logFileName)
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.logDir, { recursive: true })
  }

  contentHash(text: string): string {
    let h = 0
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
    return Math.abs(h).toString(16).padStart(8, '0').slice(0, 8)
  }

  async purgeExpired(now = Date.now()): Promise<void> {
    if (!this.opts.retentionMs) return
    const cutoff = now - this.opts.retentionMs
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
      if (stat.size >= this.opts.maxFileBytes) await this.rotate()
    } catch {
      /* new file */
    }
    const {
      sanitizeRemoteSecurityAuditFields,
      sanitizeRemoteSecurityAuditValue,
      REMOTE_SECURITY_AUDIT_EVENT_TYPES
    } = await import('../../src/shared/remoteSecurityAudit')

    let payload: Record<string, unknown>
    if (REMOTE_SECURITY_AUDIT_EVENT_TYPES.has(event.type)) {
      // Strict allowlist for remote-security events (pairing codes / secrets must never land).
      payload = sanitizeRemoteSecurityAuditFields(event as Record<string, unknown>)
    } else {
      // General IM audit: keep fields but redact secret-like string values.
      payload = {}
      for (const [k, v] of Object.entries(event)) {
        if (/^(code|pairingCode|cookie|password|token|secret|script)$/i.test(k)) continue
        payload[k] = sanitizeRemoteSecurityAuditValue(v)
      }
    }
    const entry = {
      ...payload,
      type: event.type,
      ts: event.ts ?? Date.now()
    } as T
    await fs.appendFile(this.logPath, `${JSON.stringify(entry)}\n`, 'utf8')
    this.opts.logMirror(entry as { type: string } & Record<string, unknown>)
  }

  /** Export sanitized JSON lines (remote-security events still allowlisted). */
  async exportSanitizedJson(limit = 500): Promise<string> {
    const entries = await this.tail(limit)
    return `${entries.map((e) => JSON.stringify(e)).join('\n')}${entries.length ? '\n' : ''}`
  }

  /** Clear remote activity log only — does not touch config/trust/owner. */
  async clearRemoteActivity(): Promise<void> {
    await this.ensureDir()
    await fs.writeFile(this.logPath, '', 'utf8')
  }

  private async rotate(): Promise<void> {
    for (let i = this.opts.maxBackups - 1; i >= 1; i--) {
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

  async tail(limit = 50, types?: string[]): Promise<T[]> {
    try {
      const raw = await fs.readFile(this.logPath, 'utf8')
      const lines = raw.trim().split('\n').filter(Boolean)
      let entries = lines
        .map((l) => {
          try {
            return JSON.parse(l) as T
          } catch {
            return null
          }
        })
        .filter((e): e is T => e !== null)
      if (types?.length) entries = entries.filter((e) => types.includes(e.type))
      return entries.slice(-limit)
    } catch {
      return []
    }
  }

  async query(opts: {
    since?: number
    types?: string[]
    limit?: number
  }): Promise<ImAuditQueryResult<T>> {
    const limit = opts.limit ?? 500
    let entries = await this.tail(10_000, opts.types)
    if (opts.since) entries = entries.filter((e) => (e.ts ?? 0) >= opts.since!)
    const total = entries.length
    const truncated = entries.length > limit
    return { entries: entries.slice(-limit), truncated, total }
  }
}
