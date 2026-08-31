import { describe, expect, it } from 'vitest'
import { classifyImOrigin, evaluateIngress } from './ingress'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'

describe('classifyImOrigin（白名单由分类器吸收）', () => {
  it('名单内单聊 → direct-owner', () => {
    const o = classifyImOrigin({ senderId: 'u1', allowlist: ['u1', 'u2'] })
    expect(o.kind).toBe('direct-owner')
    expect(o.senderId).toBe('u1')
  })

  it('名单外单聊 → direct-other', () => {
    const o = classifyImOrigin({ senderId: 'x', allowlist: ['u1', 'u2'] })
    expect(o.kind).toBe('direct-other')
  })

  it('飞书群聊 → group（无论是否在名单）', () => {
    const o = classifyImOrigin({ senderId: 'u1', allowlist: ['u1'], isGroup: true })
    expect(o.kind).toBe('group')
  })
})

describe('evaluateIngress（decideIngress 集成）', () => {
  it('飞书群聊默认拒绝（ingress-feishu-group-deny）', () => {
    const r = evaluateIngress({ lane: 'feishu', origin: { kind: 'group', senderId: 'u1' } }, DEFAULT_POLICY_RULES)
    expect(r.allow).toBe(false)
    expect(r.ruleId).toBe('ingress-feishu-group-deny')
  })

  it('白名单内单聊默认放行', () => {
    const r = evaluateIngress({ lane: 'wechat', origin: { kind: 'direct-owner', senderId: 'u1' } }, DEFAULT_POLICY_RULES)
    expect(r.allow).toBe(true)
  })

  it('名单外者（direct-other）未被默认 deny 规则拦截（需配置规则）', () => {
    const r = evaluateIngress({ lane: 'feishu', origin: { kind: 'direct-other', senderId: 'x' } }, DEFAULT_POLICY_RULES)
    // 默认规则不含"名单外一律拒"，仅群聊拒；此处保持放行，由上游配置决定
    expect(r.allow).toBe(true)
  })
})
