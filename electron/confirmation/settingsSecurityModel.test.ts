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
    expect(views[0]).toMatchObject({
      id: 'a',
      action: 'allow',
      defaultAction: 'ask',
      overridden: true,
      locked: false,
      enabled: true
    })
    expect(views[1]).toMatchObject({ id: 'b', action: 'deny', overridden: false, locked: true, enabled: true })
  })

  it('disabled 规则集合中的规则 enabled=false（系统保护「不启用」状态）', async () => {
    const { toRuleViews } = await import('./settingsSecurityModel')
    const rules = [
      { id: 'script-network-deny-remote', when: 'invocation' as const, action: 'deny' as const, locked: true, reason: 'r1' },
      { id: 'im-write-ask', when: 'invocation' as const, action: 'ask' as const, reason: 'r2' }
    ]
    const views = toRuleViews(rules, [], undefined, ['script-network-deny-remote'])
    expect(views[0]).toMatchObject({ id: 'script-network-deny-remote', enabled: false, locked: true })
    expect(views[1]).toMatchObject({ id: 'im-write-ask', enabled: true, locked: false })
  })

  it('lanes 透传 match.lane（无 lane 限定的规则保持缺省=全链路通用）', async () => {
    const { toRuleViews } = await import('./settingsSecurityModel')
    const rules = [
      {
        id: 'remote-deny-wechat-outbound',
        when: 'invocation' as const,
        match: { lane: ['wechat' as const], toolName: ['wechat_send', 'wechat_reply'] },
        action: 'deny' as const,
        locked: true,
        reason: 'r'
      },
      { id: 'universal', when: 'invocation' as const, action: 'ask' as const, reason: 'r2' }
    ]
    const views = toRuleViews(rules, [])
    expect(views[0]!.lanes).toEqual(['wechat'])
    expect(views[1]!.lanes).toBeUndefined()
  })
})

  it('desktop-auto-approve 无覆盖时动作由 confirmMode 派生（auto→自动，其余→询问）', async () => {
    const { toRuleViews } = await import('./settingsSecurityModel')
    const rules = [
      {
        id: 'desktop-auto-approve',
        when: 'invocation' as const,
        match: { lane: ['desktop' as const] },
        action: 'auto-evaluator' as const,
        configRequires: { config: 'confirmMode', equals: 'auto' },
        reason: 'r'
      }
    ]
    expect(toRuleViews(rules, [], 'auto')[0]!.action).toBe('auto-evaluator')
    expect(toRuleViews(rules, [], 'diff')[0]!.action).toBe('ask')
    expect(toRuleViews(rules, [], 'direct')[0]!.action).toBe('ask')
    // 有覆盖时覆盖优先
    expect(toRuleViews(rules, [{ ruleId: 'desktop-auto-approve', action: 'allow' }], 'diff')[0]!.action).toBe('allow')
  })
