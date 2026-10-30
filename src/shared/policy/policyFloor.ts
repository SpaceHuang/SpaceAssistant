import type { PolicyAction, PolicyRule } from '../confirmation/types'

/**
 * 受信任的用户自定义动作不受默认 locked action width 限制；保留规则结构检查与嵌套授权交集。
 *
 * - 系统安全 invariant 与用户策略动作分开；只校验默认规则的身份与 when/match 结构。
 * - 嵌套交集：子调用放行集合只能取交集（授权不继承：替换 + 上界）。
 */

const ACTION_WIDTH: Record<PolicyAction, number> = {
  deny: 0,
  'confirm-every-time': 1,
  ask: 2,
  'auto-evaluator': 3,
  allow: 4
}

export function isActionWider(action: PolicyAction, than: PolicyAction): boolean {
  return ACTION_WIDTH[action] > ACTION_WIDTH[than]
}

/** 触发条件规范化比较：locked 条目的 when + match 必须原样保留（防「条件掏空」绕过底线）。 */
function conditionSignature(rule: PolicyRule): string {
  return JSON.stringify({ when: rule.when, match: rule.match ?? null })
}

/**
 * 校验规则集相对 locked 底线「可收紧不可放宽」（基线 §7.1：Core 侧不可覆盖的校验）。
 * locked 条目约束：action 只能收紧、when + match 原样保留；缺席默认违规，管理员显式停用的
 * locked deny 除外。只比对 action 宽度会被「条件掏空」绕过（保持动作但改 match 使规则永不命中）。
 */
export function validatePolicyRulesFloor(
  rules: readonly PolicyRule[],
  floor: readonly PolicyRule[] = DEFAULT_FLOOR,
  disabledDenyRuleIds: readonly string[] = []
): { ok: true } | { ok: false; violations: string[] } {
  const byId = new Map(rules.map((r) => [r.id, r]))
  const explicitlyDisabled = new Set(disabledDenyRuleIds)
  const userOverrides = new Set(rules.filter((rule) => rule.userOverride === true).map((rule) => rule.id))
  const violations: string[] = []
  for (const base of floor) {
    if (!base.locked) continue
    const incoming = byId.get(base.id)
    if (!incoming) {
      // Locked deny rules have an explicit administrator-controlled enable switch.
      // Their absence is permitted only when the trusted runtime supplies that setting.
      if (base.action === 'deny' && explicitlyDisabled.has(base.id)) continue
      violations.push(base.id)
      continue
    }
    if (!userOverrides.has(base.id) && isActionWider(incoming.action, base.action)) violations.push(base.id)
    if (conditionSignature(incoming) !== conditionSignature(base)) violations.push(base.id)
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true }
}

import { DEFAULT_POLICY_RULES } from './defaultRules'

/** 底线集默认取内置默认规则的 locked 条目。 */
export const DEFAULT_FLOOR: readonly PolicyRule[] = DEFAULT_POLICY_RULES

/** Frozen floor for an isolated candidate behavior; production loaders do not activate this version yet. */
export function resolveImPolicyFloorForVersion(version: unknown, pkg: 'standard' | 'strict' | 'loose' | 'custom' = 'standard'): readonly PolicyRule[] {
  if (version === 'im-standard-v3') {
    if (pkg !== 'standard') return DEFAULT_FLOOR
    const unverifiedTargetFloors: PolicyRule[] = (['missing', 'symlink', 'special', 'unknown'] as const).map((targetKind) => ({
      id: `remote-outside-read-${targetKind}-deny`, when: 'invocation',
      match: { lane: ['wechat', 'feishu'], toolName: ['read_file', 'grep', 'list_directory'], actionClass: 'read',
        signals: ['path-target:outside-workdir', `read-target-kind:${targetKind}`] },
      action: 'deny', locked: true, denyClass: 'forbidden', reason: 'Unverified external read targets remain denied'
    }))
    const nonstandardWechatMediaDeny: PolicyRule = {
      id: 'remote-wechat-media-outside-nonstandard-deny', when: 'invocation',
      match: { lane: ['wechat'], toolName: ['wechat_send', 'wechat_reply'], signals: ['wechat-media-target:outside-workdir'], excludeSignals: ['policy-tier:standard'] },
      action: 'deny', locked: true, denyClass: 'forbidden', reason: 'Only complete standard attachment candidates can be reviewed'
    }
    const incompleteWechatReplyMediaDeny: PolicyRule = {
      id: 'remote-wechat-media-outside-reply-deny', when: 'invocation',
      match: { lane: ['wechat'], toolName: 'wechat_reply', signals: ['wechat-media-target:outside-workdir', 'policy-tier:standard'], excludeSignals: ['wechat-media-review-materials:complete'] },
      action: 'deny', locked: true, denyClass: 'forbidden', reason: 'Incomplete external attachment reviews remain denied'
    }
    return [...DEFAULT_FLOOR.map((rule) => rule.id === 'remote-shell-disabled'
      ? { ...rule, match: { ...rule.match!, excludeSignals: ['im-shell-review-candidate:git-status', 'im-shell-review-candidate:git-log'] } }
      : rule.id === 'remote-outside-read-deny'
      ? { ...rule, match: { ...rule.match!, signals: ['path-target:outside-workdir', 'read-target-scope:subtree'] } }
      : rule.id === 'remote-outside-write-deny'
        ? { ...rule, match: { ...rule.match!, signals: ['write-target-scope:outside-workdir', 'write-target-unsupported'] } }
      : rule.id === 'remote-wechat-media-outside-deny'
        ? { ...rule, match: { ...rule.match!, toolName: 'wechat_send', signals: ['wechat-media-target:outside-workdir', 'policy-tier:standard'] } }
      : rule.id === 'script-network-deny-remote' || rule.id === 'script-uncertified-ask-remote'
        ? { ...rule, match: { ...rule.match!, excludeSignals: ['im-script-network-review-candidate:complete'] } }
        : rule), ...unverifiedTargetFloors, nonstandardWechatMediaDeny, incompleteWechatReplyMediaDeny]
  }
  return DEFAULT_FLOOR
}

/**
 * 嵌套交集：内层规则相对父调用规则取交集（放行集合只收窄）。
 * 同 id 条目动作取更严者；floor 特有条目（含 locked 保护）并入结果，防止内层缺失保护。
 */
export function intersectPolicyRulesWithFloor(
  rules: readonly PolicyRule[],
  floor: readonly PolicyRule[]
): PolicyRule[] {
  const floorById = new Map(floor.map((r) => [r.id, r]))
  const narrowed = rules.map((r) => {
    const f = floorById.get(r.id)
    if (f && isActionWider(r.action, f.action)) return { ...r, action: f.action }
    return r
  })
  const ids = new Set(rules.map((r) => r.id))
  const extras = floor.filter((f) => !ids.has(f.id))
  return [...narrowed, ...extras]
}
