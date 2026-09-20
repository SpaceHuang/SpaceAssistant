import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, openSqliteDatabase, setConfigValue, type AppDatabase } from '../database'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { PolicyRuleStore } from './policyRuleStore'
import { getDbConnection } from '../database'
import {
  DEFAULT_SECURITY_AUDIT_RETENTION_DAYS,
  DISABLED_POLICY_RULE_IDS_CONFIG_KEY,
  listPolicyRulesWithOverrides,
  loadEffectivePolicyRules,
  readDisabledPolicyRuleIds,
  readPolicyPackages,
  readSecurityAuditRetentionDays,
  writeDisabledPolicyRuleIds,
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
  it('未配置时各 lane 规则集恒等返回 DEFAULT_POLICY_RULES 引用（「自动」在引擎产出层变换）', () => {
    const d = db()
    expect(loadEffectivePolicyRules(d, 'desktop')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'feishu')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'automation')).toBe(DEFAULT_POLICY_RULES)
    expect(readPolicyPackages(d).desktop).toBe('standard')
  })

  it('strict 范围档：lark-read-allow 被 scope-strict ask 条目取代（S1，偏差 15）；locked 不动', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.desktop = 'strict'
    writePolicyPackages(d, packages)
    const rules = loadEffectivePolicyRules(d, 'desktop')
    expect(rules.find((r) => r.id === 'lark-read-allow')).toBeUndefined()
    const scope = rules.find((r) => r.id === 'scope-strict-lark-read-allow')
    expect(scope?.action).toBe('ask')
    const locked = rules.find((r) => r.id === 'remote-shell-disabled')
    expect(locked?.action).toBe('deny')
    // 其它链路不受影响
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
  })

  it('普通规则可被禁用；locked 规则不允许进入 disabled 集合', () => {
    const d = db()
    // 未禁用：标准套餐返回 DEFAULT_POLICY_RULES 引用（快路径）
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
    expect(readDisabledPolicyRuleIds(d)).toEqual([])
    // 禁用普通规则：该规则被剔除，返回新数组（不是引用）
    writeDisabledPolicyRuleIds(d, ['im-write-ask'])
    const rules = loadEffectivePolicyRules(d, 'wechat')
    expect(rules).not.toBe(DEFAULT_POLICY_RULES)
    expect(rules.find((r) => r.id === 'im-write-ask')).toBeUndefined()
    expect(rules.find((r) => r.id === 'script-network-ask-desktop')).toBeTruthy()
    // disabled 集合读写往返
    writeDisabledPolicyRuleIds(d, ['a', 'b', 'a'])
    expect(readDisabledPolicyRuleIds(d)).toEqual(['a', 'b'])
  })

  it('历史 disabled locked id 会被 fail-safe 清理且 locked 规则继续生效', () => {
    const d = db()
    setConfigValue(d, DISABLED_POLICY_RULE_IDS_CONFIG_KEY, JSON.stringify(['remote-shell-disabled', 'im-write-ask']))
    const rules = loadEffectivePolicyRules(d, 'feishu')
    expect(rules.find((r) => r.id === 'remote-shell-disabled')).toBeTruthy()
    expect(readDisabledPolicyRuleIds(d)).toEqual(['im-write-ask'])
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

describe('policyRulesRuntime：P1 desktop「自动」生效与 lane 收敛', () => {
  it('loadLanePolicyContext 返回当前档位与规则集（供 gate 注入 deps.transform）', async () => {
    const { loadLanePolicyContext } = await import('./policyRulesRuntime')
    const d = db()
    const ctx = loadLanePolicyContext(d, 'desktop')
    expect(ctx.pkg).toBe('standard')
    expect(ctx.rules).toBe(DEFAULT_POLICY_RULES)
  })

  it('DB 中伪造 automation: loose → 读回收敛为 standard 且规则恒等（M2）', () => {
    const d = db()
    setConfigValue(d, 'config.policyPackages', JSON.stringify({ automation: 'loose' }))
    expect(readPolicyPackages(d).automation).toBe('standard')
    expect(loadEffectivePolicyRules(d, 'automation')).toBe(DEFAULT_POLICY_RULES)
  })

  it('wechat custom 下 auto-evaluator 覆盖被引擎丢弃（B2 引擎层防线）', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.wechat = 'custom'
    writePolicyPackages(d, packages)
    const store = new PolicyRuleStore(getDbConnection(d))
    store.setOverride({ ruleId: 'im-write-ask', action: 'auto-evaluator', params: {} })
    const rules = loadEffectivePolicyRules(d, 'wechat')
    // 动作域过滤：auto-evaluator 不在 wechat availableActions → 覆盖不生效
    expect(rules.find((r) => r.id === 'im-write-ask')?.action).toBe('ask')
  })

  it('desktop custom 下 auto-evaluator 覆盖生效（B2，desktop 4 态动作域）', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.desktop = 'custom'
    writePolicyPackages(d, packages)
    const store = new PolicyRuleStore(getDbConnection(d))
    store.setOverride({ ruleId: 'mcp-tool-ask', action: 'auto-evaluator', params: {} })
    const rules = loadEffectivePolicyRules(d, 'desktop')
    expect(rules.find((r) => r.id === 'mcp-tool-ask')?.action).toBe('auto-evaluator')
  })
})
