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
  approvedExposure?: ExposureApprovalPermit
}

const exposurePermitBrand: unique symbol = Symbol('exposure-approval-permit')
export interface ExposureApprovalPermit {
  readonly ruleId: string
  readonly toolName: string
  readonly lane: ExecutionLane
  readonly [exposurePermitBrand]: true
}
const issuedExposurePermits = new WeakSet<object>()

/** Minted only after the local owner approves this exact target during the current exposure attempt. */
export function issueExposureApprovalPermit(input: { ruleId: string; toolName: string; lane: ExecutionLane }): ExposureApprovalPermit {
  const permit = Object.freeze({ ...input, [exposurePermitBrand]: true as const })
  issuedExposurePermits.add(permit)
  return permit
}

export interface ExposureResult {
  allowed: boolean
  action?: 'allow' | 'deny' | 'ask' | 'auto-evaluator'
  policyAction?: 'allow' | 'deny' | 'ask' | 'auto-evaluator'
  approvalRequired?: true
  ruleId?: string
  reason?: string
}

/**
 * 曝光（exposure）时机：评估某工具是否对某链路可见（§3.5 / §5.2）。
 * 只消费 `when === 'exposure'` 的规则；冲突按 deny > ask > auto-evaluator > allow，平级按 ruleId 固定。
 * 主进程唯一评估者，渲染进程消费主进程下发的清单（备：工具开关/deniedTools 由调用方前置）。
 */
export function evaluateExposure(args: EvaluateExposureArgs): ExposureResult {
  const rules = args.rules ?? DEFAULT_POLICY_RULES
  const matches = rules.filter((rule) => {
    if (rule.when !== 'exposure') return false
    const m = rule.match
    if (m?.lane && !m.lane.includes(args.lane)) return false
    if (m?.toolName) {
      const names = Array.isArray(m.toolName) ? m.toolName : [m.toolName]
      if (!names.includes(args.toolName)) return false
    }
    if (m?.actionClass && args.actionClass !== m.actionClass) return false
    return true
  }).sort((a, b) => a.id.localeCompare(b.id))
  const actionFor = (rule: PolicyRule): 'deny' | 'ask' | 'allow' | 'auto-evaluator' =>
    rule.userOverride ? (rule.action === 'auto-evaluator' ? 'auto-evaluator' : rule.action === 'deny' ? 'deny' : rule.action === 'ask' ? 'ask' : 'allow')
      : rule.action === 'confirm-every-time' || rule.humanRequired ? 'ask'
        : rule.action === 'auto-evaluator' ? 'auto-evaluator' : rule.action
  const byPriority = (priority: 'deny' | 'ask' | 'auto-evaluator') => matches.find((rule) => actionFor(rule) === priority)
  const deny = byPriority('deny')
  if (deny) return { allowed: false, action: 'deny', ruleId: deny.id, reason: deny.reason }
  const ask = byPriority('ask')
  if (ask) {
    const permit = args.approvedExposure
    const approved = !!permit && issuedExposurePermits.has(permit) && permit.ruleId === ask.id && permit.toolName === args.toolName && permit.lane === args.lane
    return approved ? { allowed: true, action: 'ask', ruleId: ask.id, reason: ask.reason }
      : { allowed: false, action: 'ask', approvalRequired: true, ruleId: ask.id, reason: ask.reason }
  }
  const automatic = byPriority('auto-evaluator')
  // Existing automatic review routes are invocation/tool-fact based. An exposure target has no
  // compatible reviewer route, so its evaluator result is a deterministic reject, never a human fallback.
  if (automatic) return { allowed: false, action: 'deny', policyAction: 'auto-evaluator', ruleId: automatic.id, reason: 'exposure-auto-evaluator-unavailable' }
  const allow = matches[0]
  return allow ? { allowed: true, action: 'allow', ruleId: allow.id, reason: allow.reason } : { allowed: true }
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
