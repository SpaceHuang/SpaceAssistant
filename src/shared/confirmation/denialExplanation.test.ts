import { describe, expect, it } from 'vitest'
import { explainPolicyDenial } from './denialExplanation'

describe('explainPolicyDenial', () => {
  it('maps a known missing write parent to an actionable coarse explanation', () => {
    expect(explainPolicyDenial('write-parent-directory-missing')).toBe('[path-target-unavailable] 目标目录不存在，无法创建该文件；请改写到一个已存在的目录，或告知用户需要先建立该目录')
  })

  it('preserves the legacy fallback for unknown reason codes', () => {
    expect(explainPolicyDenial('POLICY_DENY')).toBe('')
  })

  it('does not expose untrusted path-bearing messages for unknown reasons', () => {
    expect(explainPolicyDenial('unknown', '/Users/alice/private/file')).toBe('')
  })

  it('handles invalid reason-code inputs without throwing or returning untrusted text', () => {
    expect(explainPolicyDenial('')).toBe('')
    expect(explainPolicyDenial('write-parent-directory-missing', '/Users/alice/private/file')).not.toContain('/Users/alice')
  })
})
