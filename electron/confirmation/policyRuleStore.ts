import type Database from 'better-sqlite3'
import type { PolicyAction, PolicyRule } from '../../src/shared/confirmation/types'

export interface PolicyRuleOverride {
  ruleId: string
  action: PolicyAction
  params: Record<string, unknown>
}

interface Row {
  rule_id: string
  action: string
  params: string
}

/**
 * `policy_rules` 表读写：用户对默认规则的覆盖（动作/参数，规则不可增删、顺序不可改）。
 * `applyOverrides` 把覆盖合并回默认规则，供策略引擎按 `when` 过滤后评估。
 */
export class PolicyRuleStore {
  constructor(private readonly db: Database.Database) {}

  listOverrides(): PolicyRuleOverride[] {
    const rows = this.db.prepare('SELECT rule_id, action, params FROM policy_rules').all() as Row[]
    return rows.map((r) => ({
      ruleId: r.rule_id,
      action: r.action as PolicyAction,
      params: this.parseParams(r.params)
    }))
  }

  getOverride(ruleId: string): PolicyRuleOverride | null {
    const row = this.db.prepare('SELECT rule_id, action, params FROM policy_rules WHERE rule_id = ?').get(ruleId) as
      | Row
      | undefined
    if (!row) return null
    return { ruleId: row.rule_id, action: row.action as PolicyAction, params: this.parseParams(row.params) }
  }

  /** 幂等 upsert（按 rule_id）。 */
  setOverride(override: PolicyRuleOverride): void {
    const now = Date.now()
    this.db
      .prepare(
        `INSERT INTO policy_rules (rule_id, action, params, created_at, updated_at)
         VALUES (@rule_id, @action, @params, @now, @now)
         ON CONFLICT(rule_id) DO UPDATE SET action = excluded.action, params = excluded.params, updated_at = excluded.updated_at`
      )
      .run({
        rule_id: override.ruleId,
        action: override.action,
        params: JSON.stringify(override.params ?? {}),
        now
      })
  }

  removeOverride(ruleId: string): number {
    return this.db.prepare('DELETE FROM policy_rules WHERE rule_id = ?').run(ruleId).changes
  }

  /** 把覆盖合并回默认规则（覆盖 action/params；locked 条目不得被覆盖由调用方前置校验）。 */
  applyOverrides(rules: PolicyRule[]): PolicyRule[] {
    const overrides = this.listOverrides()
    const byId = new Map(overrides.map((o) => [o.ruleId, o]))
    return rules.map((rule) => {
      const o = byId.get(rule.id)
      if (!o) return rule
      return { ...rule, action: o.action }
    })
  }

  private parseParams(params: string): Record<string, unknown> {
    try {
      return JSON.parse(params) as Record<string, unknown>
    } catch {
      return {}
    }
  }
}
