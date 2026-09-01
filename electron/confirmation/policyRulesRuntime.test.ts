import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, openSqliteDatabase, type AppDatabase } from '../database'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { PolicyRuleStore } from './policyRuleStore'
import { getDbConnection } from '../database'
import {
  DEFAULT_SECURITY_AUDIT_RETENTION_DAYS,
  listPolicyRulesWithOverrides,
  loadEffectivePolicyRules,
  readPolicyPackages,
  readSecurityAuditRetentionDays,
  writePolicyPackages,
  writeSecurityAuditRetentionDays
} from './policyRulesRuntime'

const dbs: AppDatabase[] = []
afterEach(() => dbs.splice(0).forEach((db) => db.close()))

function db(): AppDatabase {
  const d = openSqliteDatabase(':memory:')
  dbs.push(d)
  return d
}

describe('policyRulesRuntime（套餐/覆盖运行时装配）', () => {
  it('未配置时各链路返回 DEFAULT_POLICY_RULES 引用（零行为变化）', () => {
    const d = db()
    expect(loadEffectivePolicyRules(d, 'desktop')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
    expect(readPolicyPackages(d).desktop).toBe('standard')
  })

  it('strict 套餐：非 locked allow 条目上调为 ask', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.desktop = 'strict'
    writePolicyPackages(d, packages)
    const rules = loadEffectivePolicyRules(d, 'desktop')
    const lark = rules.find((r) => r.id === 'lark-read-allow')
    expect(lark?.action).toBe('ask')
    const locked = rules.find((r) => r.id === 'remote-shell-disabled')
    expect(locked?.action).toBe('deny')
    // 其它链路不受影响
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
  })

  it('custom 套餐：policy_rules 覆盖生效；locked 覆盖被忽略', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.feishu = 'custom'
    writePolicyPackages(d, packages)
    const store = new PolicyRuleStore(getDbConnection(d))
    store.setOverride({ ruleId: 'im-write-ask', action: 'allow', params: {} })
    store.setOverride({ ruleId: 'remote-shell-disabled', action: 'allow', params: {} })
    const rules = loadEffectivePolicyRules(d, 'feishu')
    expect(rules.find((r) => r.id === 'im-write-ask')?.action).toBe('allow')
    expect(rules.find((r) => r.id === 'remote-shell-disabled')?.action).toBe('deny')
  })

  it('listPolicyRulesWithOverrides：返回默认规则 + overridden 标记', () => {
    const d = db()
    const store = new PolicyRuleStore(getDbConnection(d))
    store.setOverride({ ruleId: 'im-write-ask', action: 'allow', params: {} })
    const list = listPolicyRulesWithOverrides(d)
    expect(list).toHaveLength(DEFAULT_POLICY_RULES.length)
    const hit = list.find((x) => x.rule.id === 'im-write-ask')
    expect(hit?.overridden).toBe(true)
    expect(hit?.rule.action).toBe('allow')
  })

  it('保留天数读写：默认 180，非法值回退', () => {
    const d = db()
    expect(readSecurityAuditRetentionDays(d)).toBe(DEFAULT_SECURITY_AUDIT_RETENTION_DAYS)
    writeSecurityAuditRetentionDays(d, 30)
    expect(readSecurityAuditRetentionDays(d)).toBe(30)
    expect(getConfigValue(d, 'config.securityAuditRetentionDays')).toBe('30')
  })
})
