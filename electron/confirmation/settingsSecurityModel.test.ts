import { describe, expect, it } from 'vitest'
import { buildSettingsSecurityModel } from './settingsSecurityModel'

describe('buildSettingsSecurityModel（P4 设置中心五区数据）', () => {
  it('装配五区（套餐/确认模式/工具开关/确认记忆/审计摘要）', () => {
    const model = buildSettingsSecurityModel({
      packages: { desktop: 'loose', wechat: 'strict', feishu: 'standard', automation: 'custom' },
      confirmMode: 'diff',
      deniedTools: ['run_shell'],
      cache: [
        {
          id: 'c1',
          key: { kind: 'shell-command', verb: 'ping baidu.com', level: 'exact' },
          decision: 'allow',
          lane: '*',
          scope: 'persistent',
          createdAt: 1,
          lastHitAt: 1,
          hitCount: 3,
          source: 'user-confirm'
        }
      ],
      rules: [],
      retentionDays: 180,
      haveAuditLog: true
    })
    expect(model.packages.desktop).toBe('loose')
    expect(model.confirmMode).toBe('diff')
    expect(model.deniedTools).toEqual(['run_shell'])
    expect(model.memoryEntries).toHaveLength(1)
    expect(model.memoryEntries[0]!.hitCount).toBe(3)
    expect(model.audit).toEqual({ retentionDays: 180, haveAuditLog: true })
  })
})

describe('toRuleViews（规则合并视图）', () => {
  it('覆盖合并动作 + overridden 标记，locked 透传', async () => {
    const { toRuleViews } = await import('./settingsSecurityModel')
    const rules = [
      { id: 'a', when: 'invocation' as const, action: 'ask' as const, reason: 'r1' },
      { id: 'b', when: 'invocation' as const, action: 'deny' as const, locked: true, reason: 'r2' }
    ]
    const views = toRuleViews(rules, [{ ruleId: 'a', action: 'allow' }])
    expect(views[0]).toMatchObject({ id: 'a', action: 'allow', defaultAction: 'ask', overridden: true, locked: false })
    expect(views[1]).toMatchObject({ id: 'b', action: 'deny', overridden: false, locked: true })
  })
})
