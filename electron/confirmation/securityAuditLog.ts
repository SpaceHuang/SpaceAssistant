import fs from 'fs/promises'
import path from 'path'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

/** 脱敏：命中敏感形态的字段值统一替换，不落用户正文/token/secret/API Key。 */
const SENSITIVE_PATTERN = /(sk-[A-Za-z0-9_-]+|Bearer\s+\S+|secret\s*=\s*[^\s,;]+|api[_-]?key\s*=\s*[^\s,;]+)/gi

export function sanitizeAuditField(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(SENSITIVE_PATTERN, '[REDACTED]')
  return value
}

export function sanitizeAuditEvent(event: SecurityAuditEvent): SecurityAuditEvent {
  const out: SecurityAuditEvent = { ...event }
  for (const k of [
    'factsSummary',
    'reason',
    'memoryTier',
    'cacheKey',
    'requestId',
    'ruleId',
    'sessionId'
  ] as const) {
    const v = out[k]
    if (typeof v === 'string') out[k] = sanitizeAuditField(v) as never
  }
  return out
}

export function auditLine(event: SecurityAuditEvent): string {
  return JSON.stringify(sanitizeAuditEvent(event))
}

export interface SecurityAuditLogDeps {
  /** 日志目录：开发 `{项目根}/logs/`，打包 `{workDir}/.agent/logs/`，由调用方解析。 */
  logDir: string
  /** 保留天数，默认 180。 */
  retentionDays?: number
}

/**
 * 安全审计日志：独立文件 `SecurityAudit-{YYYYMMDD}.log`（JSON Lines），异步缓冲批量落盘。
 * - 独立文件、物理隔离，绝不混入功能日志；
 * - 落事实不落内容（events 由调用方构造为事实摘要，写入前再脱敏）；
 * - 记录不阻断执行：写失败降级记录并重试，绝不因日志故障改变工具判定；
 * - 按日切分，切分时顺带清理过期文件。
 */
export class SecurityAuditLog {
  private readonly deps: SecurityAuditLogDeps
  private buffer: SecurityAuditEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private today = new Date()

  constructor(deps: SecurityAuditLogDeps) {
    this.deps = deps
  }

  /** 记录事件（同步入缓冲、异步落盘，不阻断调用方）。 */
  record(event: SecurityAuditEvent): void {
    this.buffer.push(event)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 50)
  }

  /** 立即落盘（供测试/退出前调用）。 */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const events = this.buffer.splice(0, this.buffer.length)
    try {
      const file = path.join(this.deps.logDir, `SecurityAudit-${dateStamp(this.today)}.log`)
      await fs.mkdir(this.deps.logDir, { recursive: true })
      await fs.appendFile(file, events.map(auditLine).join('\n') + '\n', 'utf8')
      this.rotateIfDateChanged()
      await this.cleanupExpired()
    } catch (e) {
      // 故障不阻断：把事件退回缓冲以便重试，并降级记 agentLogger 错误
      this.buffer.unshift(...events)
      // eslint-disable-next-line no-console
      console.error('[SecurityAuditLog] write failed', e)
    }
  }

  private rotateIfDateChanged(): void {
    const now = new Date()
    if (now.getDate() !== this.today.getDate()) {
      this.today = now
    }
  }

  private async cleanupExpired(): Promise<void> {
    const retentionDays = this.deps.retentionDays ?? 180
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
    try {
      const files = (await fs.readdir(this.deps.logDir)).filter((f) => f.startsWith('SecurityAudit-') && f.endsWith('.log'))
      for (const f of files) {
        const full = path.join(this.deps.logDir, f)
        const stat = await fs.stat(full)
        if (stat.mtimeMs < cutoff) {
          await fs.unlink(full)
        }
      }
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

function dateStamp(d: Date): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}
