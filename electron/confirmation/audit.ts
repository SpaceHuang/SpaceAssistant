import { getAgentLogDir } from '../agentLogger/agentLogger'
import { SecurityAuditLog } from './securityAuditLog'
import { getDefaultAgentRuntime } from '../runtime/agentRuntimeDefaults'
import type { SecurityAuditEvent } from '../../src/shared/confirmation/types'
import { auditFactId } from './auditFactId'

export interface AuditSink {
  record(event: SecurityAuditEvent): void
}

/**
 * 审计出口(A2,偏差 18):状态(SecurityAuditLog 实例)随 runtime 实例走;
 * 本模块只保留纯工厂与目录解析,旧全局函数为兼容转发(经默认 runtime)。
 */
export function createSecurityAuditLog(options: { logDir: string; retentionDays?: number }): SecurityAuditLog {
  return new SecurityAuditLog(options)
}

/** 审计日志目录解析:复用 agentLogger 目录(开发 `{项目根}/logs/`、打包 `{workDir}/.agent/logs/`);未初始化返回 null。 */
export function resolveSecurityAuditLogDir(): string | null {
  try {
    const candidate = getAgentLogDir()
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
  } catch {
    // agentLogger 未初始化或被测试 mock:降级,审计不阻断主流程
    return null
  }
}

/**
 * @deprecated 兼容转发(偏差 18,一个发布周期,P8 评估删除)。
 * 主循环审计出口:经默认 runtime 的 audit 实例(runtime 内惰性构造、目录未就绪时 NOOP,§5.6)。
 */
export function getSecurityAuditLog(): AuditSink {
  return getDefaultAgentRuntime().audit
}

/** @deprecated 兼容转发(偏差 18)。仅供测试重置;未装配时无需重置(幂等)。 */
export function resetSecurityAuditLogForTests(): void {
  try {
    getDefaultAgentRuntime().resetAuditForTests()
  } catch {
    // 未装配:没有可重置的审计实例
  }
}

/** @deprecated 兼容转发(偏差 18)。设置页调整保留天数(§5.6-1)。 */
export function setSecurityAuditRetentionDays(days: number): void {
  getDefaultAgentRuntime().setAuditRetentionDays(days)
}

/** @deprecated 兼容转发(偏差 18)。当前生效的保留天数。 */
export function getSecurityAuditRetentionDays(fallback = 180): number {
  return getDefaultAgentRuntime().getAuditRetentionDays(fallback)
}

/** 审计日志目录(供只读查询);agentLogger 未初始化时返回 null。 */
export function getSecurityAuditLogDir(): string | null {
  return resolveSecurityAuditLogDir()
}


export function recordPolicyExecutionVeto(input: {
  audit?: AuditSink
  lane: import('../../src/shared/confirmation/types').ExecutionLane
  sessionId: string
  requestId?: string
  toolUseId?: string
  toolName: string
  decisionRuleId?: string
  factId?: string
  pathZone?: import('../../src/shared/confirmation/types').PathZone
  failureClass: 'input' | 'mechanism' | 'environment' | 'integration-violation'
  caseId: string
}): void {
  ;(input.audit ?? getSecurityAuditLog()).record({
    ts: Date.now(), event: 'policy.execution-veto', lane: input.lane, sessionId: input.sessionId,
    requestId: input.requestId, toolUseId: input.toolUseId, toolName: input.toolName,
    decisionRuleId: input.decisionRuleId, pathZone: input.pathZone,
    ...(input.factId ? { factId: auditFactId(input.factId) } : {}),
    failureClass: input.failureClass, caseId: input.caseId, reason: input.caseId, actor: 'system'
  })
}
