import { describe, expect, it } from 'vitest'
import { agentDenyHowToApproveGuidance, notExecutedReasonForConfirmation } from './toolChatLoop'

// ===== P1-D：agent-deny 不再误标为 user_rejected（回归 D4，§7.1 #8）=====
// 无人档位下 run_shell 被 agent-deny 后，token 统计 / UI / 错误归因曾全部误判为"用户拒绝"。

describe('notExecutedReasonForConfirmation（确认拒绝归因映射）', () => {
  it('errorCode 优先：REMOTE_READ_ONLY / AUTHORIZATION_REVOKED 维持既有归类', () => {
    expect(notExecutedReasonForConfirmation({ cause: 'agent-deny', errorCode: 'REMOTE_READ_ONLY' })).toBe('remote_read_only')
    expect(notExecutedReasonForConfirmation({ cause: 'agent-deny', errorCode: 'AUTHORIZATION_REVOKED' })).toBe('authorization_revoked')
  })

  it("cause='agent-deny' → 'agent_denied'（核心回归）", () => {
    expect(notExecutedReasonForConfirmation({ cause: 'agent-deny' })).toBe('agent_denied')
  })

  it("用户主动拒绝 → 'user_rejected'", () => {
    expect(notExecutedReasonForConfirmation({ cause: 'user-denied' })).toBe('user_rejected')
  })

  it("审批通道终态按超时、不可用、取消分别归类", () => {
    expect(notExecutedReasonForConfirmation({ cause: 'timeout' })).toBe('confirm_timeout')
    expect(notExecutedReasonForConfirmation({ cause: 'unavailable' })).toBe('confirm_unavailable')
    expect(notExecutedReasonForConfirmation({ cause: 'cancelled' })).toBe('confirm_cancelled')
    for (const cause of ['unparsable', 'config-error', 'no-answerer', 'gate-materials-missing', 'rules-violated'] as const) {
      expect(notExecutedReasonForConfirmation({ cause })).toBe('policy_denied')
    }
  })

  it("无 cause（未走通道的既有拒绝路径）保底 'user_rejected'，不回归", () => {
    expect(notExecutedReasonForConfirmation({})).toBe('user_rejected')
    expect(notExecutedReasonForConfirmation({ cause: 'user-approved' })).toBe('user_rejected')
  })
})

// ===== P2-F F3：拒绝必须可解释、可操作——agent-deny 理由含「如何获批」指引（§7.2 反例保护）=====
describe('agentDenyHowToApproveGuidance（F3 落地标志）', () => {
  it('指引包含可操作的获批途径（信任列表 / 用户确认 / 拆分低风险步骤）', () => {
    const guidance = agentDenyHowToApproveGuidance()
    expect(guidance).toContain('信任')
    expect(guidance).toContain('确认')
    expect(guidance).toContain('低风险')
  })

  it('指引不预设放行结论（安全策略不变，只补可操作性）', () => {
    const guidance = agentDenyHowToApproveGuidance()
    expect(guidance).not.toContain('直接放行')
    expect(guidance).not.toContain('绕过')
  })
})
