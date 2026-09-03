import type { ExecutionLane, OriginInfo } from '../../src/shared/confirmation/types'
import type { AuditSink } from './channels'

/**
 * 设置变更审计（§5.6-6）：安全配置的每一次放松/收紧都有据可查。
 * settings.policy-change（套餐切换/规则动作参数修改/链路硬约束开关）与
 * settings.tool-toggle（deniedTools 变更）均记录新旧值。
 */
export function recordSettingsChange(
  audit: AuditSink,
  args: {
    kind: 'policy-change' | 'tool-toggle'
    lane: ExecutionLane
    sessionId: string
    origin?: OriginInfo
    key: string
    before: unknown
    after: unknown
    reason?: string
  }
): void {
  audit.record({
    ts: Date.now(),
    event: args.kind === 'policy-change' ? 'settings.policy-change' : 'settings.tool-toggle',
    lane: args.lane,
    sessionId: args.sessionId,
    origin: args.origin,
    reason: args.reason,
    cacheKey: args.key,
    // 新旧值以 JSON 文本落审计（§5.6-6：配置变更必记，含新旧值）
    before: stringifyAuditValue(args.before),
    after: stringifyAuditValue(args.after),
    actor: 'user'
  })
}

/** 新旧值序列化：失败降级为 String()，不落对象引用。 */
function stringifyAuditValue(value: unknown): string | undefined {
  if (value === undefined) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
