
import { approvalFallbackReasonFor } from './fallbackReason'

describe('N3（评审 v2）：agent-undetermined 的用户可见文案不坍缩为「服务不可用」', () => {
  it('approvalFallbackReasonFor(agent-undetermined) 返回 undetermined 专用文案', () => {
    const undetermined = approvalFallbackReasonFor('agent-undetermined', 'zh-CN')
    const unavailable = approvalFallbackReasonFor('unavailable', 'zh-CN')
    expect(undetermined).toContain('无法判定')
    expect(undetermined).not.toBe(unavailable)
  })

  it('三种可回退 cause 的短文案互不相同', () => {
    const keys = new Set(
      (['unavailable', 'timeout', 'agent-undetermined'] as const).map((c) => approvalFallbackReasonFor(c, 'zh-CN'))
    )
    expect(keys.size).toBe(3)
  })
})
