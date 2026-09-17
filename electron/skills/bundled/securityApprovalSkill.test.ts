import { describe, expect, it } from 'vitest'
import { getBundledSecurityApprovalSkill, SECURITY_APPROVAL_SKILL_NAME } from './securityApprovalSkill'

describe('securityApprovalSkill（I2：裁决标准唯一）', () => {
  it('loads bundled skill，name=security-approval', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.meta.name).toBe(SECURITY_APPROVAL_SKILL_NAME)
    expect(skill.scope).toBe('builtin')
  })

  it('裁决标准写死「用户不盯着也不会出问题」，输出限定两态 JSON', () => {
    const skill = getBundledSecurityApprovalSkill()
    expect(skill.content).toMatch(/不盯着/)
    expect(skill.content).toMatch(/approve/)
    expect(skill.content).toMatch(/deny/)
    // 无中间态：禁止「需要更多信息」类输出
    expect(skill.content).toMatch(/只有两种输出|没有第三种|不允许/)
  })

  it('多次获取返回同一实例（标准唯一）', () => {
    expect(getBundledSecurityApprovalSkill()).toBe(getBundledSecurityApprovalSkill())
  })
})
