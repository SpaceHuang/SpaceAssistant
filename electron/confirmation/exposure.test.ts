import { describe, expect, it } from 'vitest'
import { evaluateExposure, filterToolsForLane, issueExposureApprovalPermit } from './exposure'

describe('evaluateExposure（工具曝光过滤规则）', () => {
  it('自定义 exposure ask 在绑定的一次性对象批准前不暴露', () => {
    const rules = [{ id: 'ask-tool', when: 'exposure' as const, match: { lane: ['wechat'], toolName: 'tool-x' }, action: 'ask' as const, userOverride: true as const, reason: 'r' }]
    expect(evaluateExposure({ toolName: 'tool-x', lane: 'wechat', rules })).toMatchObject({ allowed: false, action: 'ask', approvalRequired: true })
    const permit = issueExposureApprovalPermit({ ruleId: 'ask-tool', toolName: 'tool-x', lane: 'wechat' })
    expect(evaluateExposure({ toolName: 'tool-x', lane: 'wechat', rules, approvedExposure: permit }))
      .toMatchObject({ allowed: true, action: 'ask' })
    expect(evaluateExposure({ toolName: 'tool-x', lane: 'wechat', rules, approvedExposure: { ruleId: 'ask-tool', toolName: 'tool-x', lane: 'wechat' } as never }).allowed).toBe(false)
  })
  it('exposure deny dominates ask regardless of rule order', () => {
    const ask = { id: 'ask', when: 'exposure' as const, match: { lane: ['wechat'], toolName: 'tool-x' }, action: 'ask' as const, reason: 'ask' }
    const deny = { id: 'deny', when: 'exposure' as const, match: { lane: ['wechat'], toolName: 'tool-x' }, action: 'deny' as const, reason: 'deny' }
    expect(evaluateExposure({ toolName: 'tool-x', lane: 'wechat', rules: [ask, deny] })).toMatchObject({ allowed: false, action: 'deny', ruleId: 'deny' })
    expect(evaluateExposure({ toolName: 'tool-x', lane: 'wechat', rules: [deny, ask] })).toMatchObject({ allowed: false, action: 'deny', ruleId: 'deny' })
  })
  it('does not reinterpret desktop exposure auto-evaluator as a human approval or direct allow', () => {
    const rules = [{ id: 'automatic-exposure', when: 'exposure' as const, match: { lane: ['desktop'], toolName: 'tool-x' },
      action: 'auto-evaluator' as const, userOverride: true as const, reason: 'automatic' }]
    expect(evaluateExposure({ toolName: 'tool-x', lane: 'desktop', rules }))
      .toMatchObject({ allowed: false, action: 'deny', policyAction: 'auto-evaluator', ruleId: 'automatic-exposure', reason: 'exposure-auto-evaluator-unavailable' })
  })
  it('wechat_send 在 wechat/feishu 链路被 exposure 规则拒绝（im-no-wechat-send）', () => {
    const r = evaluateExposure({ toolName: 'wechat_send', actionClass: 'outbound', lane: 'wechat' })
    expect(r.allowed).toBe(false)
    expect(r.ruleId).toBe('im-no-wechat-send')
    expect(evaluateExposure({ toolName: 'wechat_send', actionClass: 'outbound', lane: 'feishu' }).allowed).toBe(false)
  })

  it('wechat_send 在 desktop 链路不被 exposure 规则拒绝（链路不匹配）', () => {
    const r = evaluateExposure({ toolName: 'wechat_send', actionClass: 'outbound', lane: 'desktop' })
    expect(r.allowed).toBe(true)
  })

  it('wechat_reply / run_shell 等无 exposure 规则的默认放行', () => {
    expect(evaluateExposure({ toolName: 'wechat_reply', actionClass: 'outbound', lane: 'wechat' }).allowed).toBe(true)
    expect(evaluateExposure({ toolName: 'run_shell', actionClass: 'execute', lane: 'desktop' }).allowed).toBe(true)
  })

  it('自定义 exposure 规则：允许条目同样生效', () => {
    const rules = [
      { id: 'allow-tool-x', when: 'exposure', match: { lane: ['desktop'], toolName: 'x' }, action: 'allow', reason: 'r' }
    ]
    expect(evaluateExposure({ toolName: 'x', lane: 'desktop', rules }).allowed).toBe(true)
  })

  it('filterToolsForLane 合并 deniedTools + exposure 规则过滤', () => {
    const tools = ['wechat_send', 'wechat_reply', 'run_shell', 'write_file']
    // wechat_send 被 exposure 规则（im-no-wechat-send）过滤；write_file 被 deniedTools 过滤
    const visible = filterToolsForLane({ tools, lane: 'wechat', deniedTools: ['write_file'] })
    expect(visible).toEqual(['wechat_reply', 'run_shell'])
    // desktop 不受 im-no-wechat-send exposure 规则影响
    expect(filterToolsForLane({ tools, lane: 'desktop', deniedTools: [] })).toContain('wechat_send')
  })
})
