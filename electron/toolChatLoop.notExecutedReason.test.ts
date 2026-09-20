import { describe, expect, it } from 'vitest'
import { notExecutedReasonForConfirmation } from './toolChatLoop'

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

  it("审批通道超时 → 'confirm_timeout'；机器侧 fail-closed 拒绝 → 'policy_denied'", () => {
    expect(notExecutedReasonForConfirmation({ cause: 'timeout' })).toBe('confirm_timeout')
    for (const cause of ['recursion-blocked', 'unavailable', 'unparsable', 'config-error', 'no-answerer', 'gate-materials-missing', 'rules-violated'] as const) {
      expect(notExecutedReasonForConfirmation({ cause })).toBe('policy_denied')
    }
  })

  it("无 cause（未走通道的既有拒绝路径）保底 'user_rejected'，不回归", () => {
    expect(notExecutedReasonForConfirmation({})).toBe('user_rejected')
    expect(notExecutedReasonForConfirmation({ cause: 'user-approved' })).toBe('user_rejected')
  })
})
