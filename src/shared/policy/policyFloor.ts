import type { PolicyAction, PolicyRule } from '../confirmation/types'

/**
 * P3（偏差 3 语义收口）：locked 底线与嵌套交集的纯函数实现。
 *
 * - 「可收紧不可放宽」：动作宽度序 deny < confirm-every-time < ask < auto-evaluator < allow；
 *   相对底线放宽任何 locked 条目（改宽或移除）= 违规。
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
 * locked 条目三重约束：不可缺失、action 只能收紧、when + match 原样保留——
 * 只比对 action 宽度会被「条件掏空」绕过（保持动作但改 match 使规则永不命中）。
 */
export function validatePolicyRulesFloor(
  rules: readonly PolicyRule[],
  floor: readonly PolicyRule[] = DEFAULT_FLOOR
): { ok: true } | { ok: false; violations: string[] } {
  const byId = new Map(rules.map((r) => [r.id, r]))
  const violations: string[] = []
  for (const base of floor) {
    if (!base.locked) continue
    const incoming = byId.get(base.id)
    if (!incoming) {
      violations.push(base.id)
      continue
    }
    if (isActionWider(incoming.action, base.action)) violations.push(base.id)
    if (conditionSignature(incoming) !== conditionSignature(base)) violations.push(base.id)
  }
  return violations.length > 0 ? { ok: false, violations } : { ok: true }
}

import { DEFAULT_POLICY_RULES } from './defaultRules'

/** 底线集默认取内置默认规则的 locked 条目。 */
export const DEFAULT_FLOOR: readonly PolicyRule[] = DEFAULT_POLICY_RULES

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
