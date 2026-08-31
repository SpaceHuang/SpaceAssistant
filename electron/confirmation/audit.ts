import { getAgentLogDir } from '../agentLogger/agentLogger'
import { SecurityAuditLog } from './securityAuditLog'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'

export interface AuditSink {
  record(event: SecurityAuditEvent): void
}

const NOOP: AuditSink = { record: () => undefined }

let singleton: SecurityAuditLog | null = null

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
  if (!singleton) singleton = new SecurityAuditLog({ logDir })
  return singleton
}

/** 仅供测试重置单例。 */
export function resetSecurityAuditLogForTests(): void {
  singleton = null
}
