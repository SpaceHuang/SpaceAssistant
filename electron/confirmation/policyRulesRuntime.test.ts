import { afterEach, describe, expect, it } from 'vitest'
import { getConfigValue, openSqliteDatabase, setConfigValue, type AppDatabase } from '../database'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'
import { PolicyRuleStore } from './policyRuleStore'
import { getDbConnection } from '../database'
import { commitDesktopPolicySnapshot, commitImPolicySnapshot } from './imPolicyStore'
import { ensureImPolicySnapshotAtStartup } from './legacyImConfigBoundary'
import {
  DEFAULT_SECURITY_AUDIT_RETENTION_DAYS,
  DISABLED_POLICY_RULE_IDS_CONFIG_KEY,
  listPolicyRulesWithOverrides,
  loadEffectivePolicyRules,
  resolveEffectivePolicyRulesWithOrigin,
  readDisabledPolicyRuleIds,
  readDesktopMigratedLegacyDisabledRuleIds,
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
  it('marks only validated persisted MCP actions as user overrides, leaving legacy defaults unmarked', () => {
    const legacyDb = db()
    commitImPolicySnapshot(getDbConnection(legacyDb), {
      policyBehaviorVersion: 'im-v1.6', snapshot: { selectedPackage: 'standard' }, updatedAt: 1, eventId: 'legacy-default-mcp'
    })
    const legacyRule = resolveEffectivePolicyRulesWithOrigin(legacyDb, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')
    expect(legacyRule).toMatchObject({ action: 'ask' })
    expect(legacyRule?.userOverride).toBeUndefined()

    const overriddenDb = db()
    commitImPolicySnapshot(getDbConnection(overriddenDb), {
      policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard', ruleOverrides: { 'mcp-tool-ask': 'ask' } },
      updatedAt: 1, eventId: 'explicit-mcp-ask'
    })
    const explicitRule = resolveEffectivePolicyRulesWithOrigin(overriddenDb, 'wechat').rules.find((rule) => rule.id === 'mcp-tool-ask')
    expect(explicitRule).toMatchObject({ action: 'ask', userOverride: true })
  })

  it('未配置时各 lane 规则集恒等返回 DEFAULT_POLICY_RULES 引用（「自动」在引擎产出层变换）', () => {
    const d = db()
    expect(loadEffectivePolicyRules(d, 'desktop')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'feishu')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'automation')).toBe(DEFAULT_POLICY_RULES)
    expect(readPolicyPackages(d).desktop).toBe('standard')
  })

  it('没有 IM snapshot 时 runtime 不再消费旧 disabled 列表', () => {
    const d = db()
    writeDisabledPolicyRuleIds(d, ['remote-shell-disabled'])
    expect(loadEffectivePolicyRules(d, 'wechat').find((rule) => rule.id === 'remote-shell-disabled'))
      .toMatchObject({ action: 'deny' })
    expect(resolveEffectivePolicyRulesWithOrigin(d, 'wechat').disabledRuleIds).toEqual([])
  })

  it('新版 IM 标准将 im-write-ask 解析为审核 Agent 候选，但敏感路径仍是人工确认底线', () => {
    const d = db()
    commitImPolicySnapshot(getDbConnection(d), {
      policyBehaviorVersion: 'im-standard-v2', snapshot: { selectedPackage: 'standard' },
      updatedAt: 1, eventId: 'standard-im-write-auto-review'
    })
    const rules = resolveEffectivePolicyRulesWithOrigin(d, 'wechat').rules
    expect(rules.find((rule) => rule.id === 'im-write-ask')?.action).toBe('auto-evaluator')
    expect(rules.find((rule) => rule.id === 'im-write-sensitive-path-confirm'))
      .toMatchObject({ action: 'confirm-every-time', locked: true, humanRequired: true })
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

  it('disabled 存储仅供 migration 使用，不再直接改变任何 lane 的 runtime 规则', () => {
    const d = db()
    // 未禁用：标准套餐返回 DEFAULT_POLICY_RULES 引用（快路径）
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
    expect(readDisabledPolicyRuleIds(d)).toEqual([])
    writeDisabledPolicyRuleIds(d, ['im-write-ask'])
    expect(loadEffectivePolicyRules(d, 'wechat')).toBe(DEFAULT_POLICY_RULES)
    expect(loadEffectivePolicyRules(d, 'wechat').find((r) => r.id === 'im-write-ask')).toBeTruthy()
    writeDisabledPolicyRuleIds(d, ['a', 'b', 'a', 'automation-sensitive-path-deny', 'automation-default-confirm'])
    expect(readDisabledPolicyRuleIds(d)).toEqual(['a', 'b', 'automation-sensitive-path-deny'])
    expect(loadEffectivePolicyRules(d, 'automation').find((rule) => rule.id === 'automation-sensitive-path-deny'))
      .toMatchObject({ action: 'deny' })
  })

  it('runtime 读取不会清理 legacy disabled IDs，也不会按其剔除规则', () => {
    const d = db()
    setConfigValue(d, DISABLED_POLICY_RULE_IDS_CONFIG_KEY, JSON.stringify(['automation-default-confirm', 'im-write-ask']))
    const rules = loadEffectivePolicyRules(d, 'feishu')
    expect(loadEffectivePolicyRules(d, 'automation').find((r) => r.id === 'automation-default-confirm')).toBeTruthy()
    expect(rules.find((rule) => rule.id === 'im-write-ask')).toBeTruthy()
    expect(readDisabledPolicyRuleIds(d)).toEqual(['automation-default-confirm', 'im-write-ask'])
  })

  it('custom 套餐：policy_rules 覆盖生效；locked override 仅在 custom 下生效', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.feishu = 'custom'
    writePolicyPackages(d, packages)
    const store = new PolicyRuleStore(getDbConnection(d))
    store.setOverride({ ruleId: 'im-write-ask', action: 'allow', params: {} })
    store.setOverride({ ruleId: 'remote-shell-disabled', action: 'allow', params: {} })
    const rules = loadEffectivePolicyRules(d, 'feishu')
    expect(rules.find((r) => r.id === 'im-write-ask')?.action).toBe('allow')
    expect(rules.find((r) => r.id === 'remote-shell-disabled')).toMatchObject({ action: 'allow', userOverride: true })
  })

  it('custom 套餐允许验证后的 locked ingress/exposure override 生效', () => {
    const d = db()
    const packages = readPolicyPackages(d)
    packages.wechat = 'custom'
    writePolicyPackages(d, packages)
    const store = new PolicyRuleStore(getDbConnection(d))
    store.setOverride({ ruleId: 'im-no-wechat-send', action: 'allow', params: {} })
    store.setOverride({ ruleId: 'ingress-feishu-group-deny', action: 'ask', params: {} })
    const rules = loadEffectivePolicyRules(d, 'wechat')
    expect(rules.find((rule) => rule.id === 'im-no-wechat-send')).toMatchObject({ action: 'allow', userOverride: true })
    expect(rules.find((rule) => rule.id === 'ingress-feishu-group-deny')).toMatchObject({ action: 'ask', userOverride: true })
  })

  it('desktop snapshot 是 package 与 override 的统一真源，并随提交递增 revision/epoch', () => {
    const d = db()
    const conn = getDbConnection(d)
    const seed = commitDesktopPolicySnapshot(conn, {
      expectedRevision: 0, policyBehaviorVersion: 'desktop-v1',
      snapshot: { selectedPackage: 'custom', ruleOverrides: { 'remote-shell-disabled': 'allow' } },
      updatedAt: 1, eventId: 'desktop-seed'
    })
    expect(seed).toEqual({ status: 'committed', revision: 1 })
    expect(readPolicyPackages(d).desktop).toBe('custom')
    expect(loadEffectivePolicyRules(d, 'desktop').find((rule) => rule.id === 'remote-shell-disabled'))
      .toMatchObject({ action: 'allow', userOverride: true })
    expect(conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='desktop'").get()).toEqual({ epoch: 1 })
    expect(commitDesktopPolicySnapshot(conn, {
      expectedRevision: 0, policyBehaviorVersion: 'desktop-v1', snapshot: {}, updatedAt: 2, eventId: 'desktop-stale'
    })).toEqual({ status: 'conflict', currentRevision: 1 })
    expect(conn.prepare("SELECT epoch FROM policy_authorization_epochs WHERE domain='desktop'").get()).toEqual({ epoch: 1 })
  })

  it('desktop rule view exposes known migration source IDs from the snapshot', () => {
    const d = db()
    commitDesktopPolicySnapshot(getDbConnection(d), { policyBehaviorVersion: 'desktop-v1', snapshot: {
      selectedPackage: 'custom', ruleOverrides: { 'remote-shell-disabled': 'allow' },
      migratedLegacyDisabledRuleIds: ['remote-shell-disabled', 'unknown-future-rule']
    }, updatedAt: 1, eventId: 'desktop-migration-source' })
    expect(readDesktopMigratedLegacyDisabledRuleIds(d)).toEqual(['remote-shell-disabled'])
  })

  it('桌面快照启用后仍保留旧配置中的 IM package，直至 IM 自身快照迁移完成', () => {
    const d = db()
    setConfigValue(d, 'config.policyPackages', JSON.stringify({ ...readPolicyPackages(d), feishu: 'custom' }))
    commitDesktopPolicySnapshot(getDbConnection(d), {
      expectedRevision: 0, policyBehaviorVersion: 'desktop-v1', snapshot: { selectedPackage: 'custom', ruleOverrides: {} },
      updatedAt: 1, eventId: 'desktop-package-preserve-im'
    })
    expect(readPolicyPackages(d)).toMatchObject({ desktop: 'custom', feishu: 'custom' })
  })

  it('启动迁移后 desktop snapshot 以 allow override 表达旧 disabled 并清空旧值', () => {
    const d = db()
    const disabledId = 'script-network-ask-desktop'
    writeDisabledPolicyRuleIds(d, [disabledId])
    commitDesktopPolicySnapshot(getDbConnection(d), {
      expectedRevision: 0, policyBehaviorVersion: 'desktop-v1', snapshot: { selectedPackage: 'custom', ruleOverrides: {} },
      updatedAt: 1, eventId: 'desktop-retain-legacy-disabled'
    })
    ensureImPolicySnapshotAtStartup(d)
    expect(readDisabledPolicyRuleIds(d)).toEqual([])
    expect(loadEffectivePolicyRules(d, 'desktop').find((rule) => rule.id === disabledId))
      .toMatchObject({ action: 'allow', userOverride: true })
    expect(resolveEffectivePolicyRulesWithOrigin(d, 'desktop').disabledRuleIds).toEqual([])
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
