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
  const logDir = getAgentLogDir()
  if (!logDir) return NOOP
  if (!singleton) singleton = new SecurityAuditLog({ logDir })
  return singleton
}

/** 仅供测试重置单例。 */
export function resetSecurityAuditLogForTests(): void {
  singleton = null
}
