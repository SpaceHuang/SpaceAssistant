/**
 * 桌面链路 fail-open-to-user（§4.4 四维判定）：
 *   可回退 = lane === 'desktop'
 *     && channelOutcome.answererKind === 'agent'      // ② 普通 ask 卡超时不得误回退（评审 v3 B1）
 *     && cause ∈ { unavailable, timeout }             // ③ §4 矩阵可回退两格
 *     && !chatSignal.aborted                          // ④ 中止守卫（评审 v3 B2）
 *     && !sharedApprovalRecoveryFailed                // ④ 中止守卫
 * §4 矩阵：unavailable / timeout → 转人工；unparsable / config-error / recursion-blocked → 保持 deny；
 * agent-deny 永不回退（§4.3）。
 */
import { describe, expect, it } from 'vitest'
import { FALLBACK_ELIGIBLE_CAUSES, shouldFallbackToUser } from './fallbackToUser'
import type { ConfirmOutcome, ExecutionLane } from '../../src/shared/confirmation/types'

function agentFailure(cause: ConfirmOutcome['cause']): ConfirmOutcome {
  return { kind: 'rejected', answererKind: 'agent', cause }
}

describe('shouldFallbackToUser（§4.4 四维判定）', () => {
  describe('维度③：§4 矩阵逐格（desktop + agent 回答者）', () => {
    const base = { lane: 'desktop' as const, chatAborted: false, sharedApprovalRecoveryFailed: false }

    it('unavailable → 转人工（环境问题）', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: agentFailure('unavailable') })).toBe(true)
    })

    it('timeout → 转人工（桌面有人在场，挂卡片优于替人拒绝，§4.1）', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: agentFailure('timeout') })).toBe(true)
    })

    it('unparsable → 保持 deny（契约问题，转人工会掩盖缺陷信号，§4.2）', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: agentFailure('unparsable') })).toBe(false)
    })

    it('config-error → 保持 deny（配置损坏仍走 DenyChannel + 既有告警，§5.2）', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: agentFailure('config-error') })).toBe(false)
    })

    it('recursion-blocked → 保持 deny（结构性问题）', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: agentFailure('recursion-blocked') })).toBe(false)
    })

    it('agent-deny → 永不回退（被拒再问人 = 绕过裁决，§4.3）', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: agentFailure('agent-deny') })).toBe(false)
    })

    it('agent-approved（有效裁决）→ 不回退', () => {
      expect(shouldFallbackToUser({
        ...base,
        channelOutcome: { kind: 'approved', answererKind: 'agent', cause: 'agent-approved' }
      })).toBe(false)
    })
  })

  describe('维度①：回退仅装配在桌面链路', () => {
    const outcome = agentFailure('unavailable')
    const base = { chatAborted: false, sharedApprovalRecoveryFailed: false }

    it.each<ExecutionLane>(['automation', 'wechat', 'feishu'])('%s：即使 answererKind=agent 也不回退', (lane) => {
      expect(shouldFallbackToUser({ lane, channelOutcome: outcome, ...base })).toBe(false)
    })
  })

  describe('维度②：主回答者确为 agent（评审 v3 B1）', () => {
    const base = { lane: 'desktop' as const, chatAborted: false, sharedApprovalRecoveryFailed: false }

    it('普通 ask 卡超时（DesktopChannel 映射，无 answererKind）→ 不回退，不弹第二张卡', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: { kind: 'timeout', cause: 'timeout' } })).toBe(false)
    })

    it('普通 ask 卡不可用（DesktopChannel 映射 rejected/unavailable，无 answererKind）→ 不回退', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: { kind: 'rejected', cause: 'unavailable' } })).toBe(false)
    })

    it('用户批准/拒绝的正常 outcome（user-approved / user-denied）→ 不回退', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: { kind: 'approved', cause: 'user-approved' } })).toBe(false)
      expect(shouldFallbackToUser({ ...base, channelOutcome: { kind: 'rejected', cause: 'user-denied' } })).toBe(false)
    })
  })

  describe('维度④：中止守卫（评审 v3 B2）', () => {
    const outcome = agentFailure('unavailable')
    const base = { lane: 'desktop' as const }

    it('chatSignal.aborted（用户点停止，cancel 以 unavailable settle）→ 不回退、不弹卡、无孤儿 waiter', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: outcome, chatAborted: true, sharedApprovalRecoveryFailed: false })).toBe(false)
    })

    it('sharedApprovalRecoveryFailed（failApprovalGroup 首句置位，覆盖全部中止来源）→ 不回退', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: outcome, chatAborted: false, sharedApprovalRecoveryFailed: true })).toBe(false)
    })

    it('两守卫同时成立 → 不回退', () => {
      expect(shouldFallbackToUser({ ...base, channelOutcome: outcome, chatAborted: true, sharedApprovalRecoveryFailed: true })).toBe(false)
    })
  })

  it('FALLBACK_ELIGIBLE_CAUSES 与 §4 矩阵可回退两格一致（数据化判定表）', () => {
    expect([...FALLBACK_ELIGIBLE_CAUSES].sort()).toEqual(['timeout', 'unavailable'])
  })
})
