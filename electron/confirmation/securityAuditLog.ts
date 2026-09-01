import fs from 'fs/promises'
import path from 'path'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { logAgentError } from '../agentLogger/agentLogger'

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
    'sessionId',
    'before',
    'after'
  ] as const) {
    const v = out[k]
    if (typeof v === 'string') out[k] = sanitizeAuditField(v) as never
  }
  return out
}

export function auditLine(event: SecurityAuditEvent): string {
  return JSON.stringify(sanitizeAuditEvent(event))
}

/** 缓冲上限：超过则丢弃最旧事件并计数，避免持续写失败时缓冲无限增长（B3）。 */
export const MAX_AUDIT_BUFFER = 2000
/** 失败重试次数上限：超过后停止定时重试，等待下一次 record() 触发（避免无界循环）。 */
export const MAX_AUDIT_RETRY = 8

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
  private retentionDays: number
  private buffer: SecurityAuditEvent[] = []
  private flushTimer: NodeJS.Timeout | null = null
  private today = new Date()
  private pendingDelay = 50
  private retryCount = 0
  private droppedCount = 0
  /** 上次执行过期清理的日期（仅按日变化时跑一次，§5.6-1）。 */
  private lastCleanupDay = ''

  constructor(deps: SecurityAuditLogDeps) {
    this.deps = deps
    this.retentionDays = deps.retentionDays ?? 180
  }

  /** 设置页可调保留天数（§5.6-1）；立即生效于下一次过期清理。 */
  setRetentionDays(days: number): void {
    if (Number.isFinite(days) && days > 0) this.retentionDays = Math.floor(days)
  }

  getRetentionDays(): number {
    return this.retentionDays
  }

  /** 记录事件（同步入缓冲、异步落盘，不阻断调用方）。 */
  record(event: SecurityAuditEvent): void {
    if (this.buffer.length >= MAX_AUDIT_BUFFER) {
      this.buffer.shift()
      this.droppedCount++
    }
    this.buffer.push(event)
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    const delay = this.pendingDelay
    this.pendingDelay = 50
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, delay)
    this.flushTimer.unref?.()
  }

  /** 立即落盘（供测试/退出前调用）。 */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) return
    const events = this.buffer.splice(0, this.buffer.length)
    try {
      const file = path.join(this.deps.logDir, `SecurityAudit-${dateStamp(this.today)}.log`)
      await fs.mkdir(this.deps.logDir, { recursive: true })
      await fs.appendFile(file, events.map(auditLine).join('\n') + '\n', 'utf8')
      this.retryCount = 0
      this.rotateIfDateChanged()
    } catch (e) {
      // 故障不阻断：把事件退回缓冲，降级记 agentLogger 错误，并指数退避重试调度（B3）。
      this.buffer.unshift(...events)
      if (this.buffer.length > MAX_AUDIT_BUFFER) {
        this.buffer.splice(0, this.buffer.length - MAX_AUDIT_BUFFER)
      }
      this.retryCount++
      this.pendingDelay = Math.min(50 * 2 ** Math.min(this.retryCount, 7), 5000)
      logAgentError(
        'security.audit.write_failed',
        { message: e instanceof Error ? e.message : String(e) },
        e,
        '安全审计日志写入失败，已延迟重试'
      )
      if (this.retryCount < MAX_AUDIT_RETRY) {
        this.scheduleFlush()
      }
    }
  }

  private rotateIfDateChanged(): void {
    const now = new Date()
    // 用 dateStamp 比较（避免跨月同日不轮转，M6）
    const stamp = dateStamp(now)
    if (stamp !== dateStamp(this.today)) {
      this.today = now
      void this.cleanupExpired()
    } else if (this.lastCleanupDay !== stamp) {
      // 首次写入当前日期文件时顺带清理一次过期文件
      this.lastCleanupDay = stamp
      void this.cleanupExpired()
    }
  }

  /** 清理超过保留天数的审计文件（启动时或每日首次写入时由调用方/rotate 触发）。 */
  private async cleanupExpired(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000
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
