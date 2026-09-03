import { getAgentLogDir } from '../agentLogger/agentLogger'
import { SecurityAuditLog } from './securityAuditLog'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

export interface AuditSink {
  record(event: SecurityAuditEvent): void
}

const NOOP: AuditSink = { record: () => undefined }

let singleton: SecurityAuditLog | null = null
/** 单例创建前先行配置的保留天数（启动时从 DB 注入），创建时一并应用。 */
let configuredRetentionDays: number | null = null

/**
 * 主循环审计出口：惰性构造 SecurityAuditLog，目录复用 agentLogger 的日志目录
 * （开发 `{项目根}/logs/`、打包 `{workDir}/.agent/logs/`）。agentLogger 未初始化时降级为 no-op，
 * 保证审计记录不阻断主流程（§5.6）。
 */
export function getSecurityAuditLog(): AuditSink {
  let logDir: string | null = null
  try {
    const candidate = getAgentLogDir()
    logDir = typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch {
    // agentLogger 未初始化或被测试 mock：降级 no-op，审计不阻断主流程
  }
  if (!logDir) return NOOP
  if (!singleton) {
    singleton = new SecurityAuditLog({
      logDir,
      ...(configuredRetentionDays != null ? { retentionDays: configuredRetentionDays } : {})
    })
  }
  return singleton
}

/** 仅供测试重置单例。 */
export function resetSecurityAuditLogForTests(): void {
  singleton = null
  configuredRetentionDays = null
}

/** 设置页调整保留天数（§5.6-1）：记录配置并转发到真实单例（未创建时创建时应用）。 */
export function setSecurityAuditRetentionDays(days: number): void {
  if (Number.isFinite(days) && days > 0) configuredRetentionDays = Math.floor(days)
  if (singleton) singleton.setRetentionDays(days)
}

/** 当前生效的保留天数（单例未创建时回落到已配置值/默认值）。 */
export function getSecurityAuditRetentionDays(fallback = 180): number {
  if (singleton) return singleton.getRetentionDays()
  return configuredRetentionDays ?? fallback
}

/** 审计日志目录（供只读查询）；agentLogger 未初始化时返回 null。 */
export function getSecurityAuditLogDir(): string | null {
  try {
    const candidate = getAgentLogDir()
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch {
    return null
  }
}
