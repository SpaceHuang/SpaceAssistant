import { decideIngress } from '../../src/shared/policy/policyEngine'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import type { IngressFacts, OriginInfo, PolicyRule } from '../../src/shared/confirmation/types'

/**
 * 指令来源分类器：把 IM 入站消息的发送者 + 会话类型映射为 origin 分类（§5.2a）。
 *
 * 白名单由分类器吸收（名单内 → direct-owner，名单外 → direct-other）；规则只按 origin.kind 匹配。
 * 微信无群聊维度，飞书按实际会话类型区分单聊/群聊。
 */
export function classifyImOrigin(args: {
  senderId: string
  allowlist: string[]
  isGroup?: boolean
}): OriginInfo {
  if (args.isGroup) return { kind: 'group', senderId: args.senderId }
  if (args.allowlist.includes(args.senderId)) {
    return { kind: 'direct-owner', senderId: args.senderId }
  }
  return { kind: 'direct-other', senderId: args.senderId }
}

/** 消息入口准入：产出事实 → decideIngress。返回放行/拦截 + 命中规则。 */
export function evaluateIngress(
  facts: IngressFacts,
  rules: PolicyRule[] = DEFAULT_POLICY_RULES
): { allow: boolean; ruleId: string; reason: string } {
  const r = decideIngress(facts, rules)
  return { allow: r.action === 'allow', ruleId: r.ruleId, reason: r.reason }
}
