import type {
  ActionClass,
  ExecutionLane,
  PolicyRule
} from '../../src/shared/confirmation/types'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'

export interface EvaluateExposureArgs {
  toolName: string
  actionClass?: ActionClass
  lane: ExecutionLane
  rules?: PolicyRule[]
}

export interface ExposureResult {
  allowed: boolean
  ruleId?: string
  reason?: string
}

/**
 * 曝光（exposure）时机：评估某工具是否对某链路可见（§3.5 / §5.2）。
 * 只消费 `when === 'exposure'` 的规则，首条命中即返回；未命中默认放行。
 * 主进程唯一评估者，渲染进程消费主进程下发的清单（备：工具开关/deniedTools 由调用方前置）。
 */
export function evaluateExposure(args: EvaluateExposureArgs): ExposureResult {
  const rules = args.rules ?? DEFAULT_POLICY_RULES
  for (const rule of rules) {
    if (rule.when !== 'exposure') continue
    const m = rule.match
    if (m?.lane && !m.lane.includes(args.lane)) continue
    if (m?.toolName) {
      const names = Array.isArray(m.toolName) ? m.toolName : [m.toolName]
      if (!names.includes(args.toolName)) continue
    }
    if (m?.actionClass && args.actionClass !== m.actionClass) continue
    if (rule.action === 'deny') {
      return { allowed: false, ruleId: rule.id, reason: rule.reason }
    }
    return { allowed: true, ruleId: rule.id, reason: rule.reason }
  }
  return { allowed: true }
}

/**
 * 为某链路筛出可见工具清单（主进程唯一评估者，渲染进程消费结果）。
 * 规则：deniedTools 配置 + exposure 规则（`im-no-wechat-send` 等）任一命中即过滤。
 * 工具开关（enabled/allow）由调用方在其后叠加。
 */
export function filterToolsForLane(args: {
  tools: string[]
  lane: ExecutionLane
  deniedTools?: string[]
  rules?: PolicyRule[]
}): string[] {
  const denied = new Set(args.deniedTools ?? [])
  return args.tools.filter((toolName) => {
    if (denied.has(toolName)) return false
    return evaluateExposure({ toolName, lane: args.lane, rules: args.rules }).allowed
  })
}
