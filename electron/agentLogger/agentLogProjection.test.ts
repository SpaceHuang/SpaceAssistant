import { describe, expect, it } from 'vitest'
import { projectAgentLogFields } from './agentLogProjection'

describe('projectAgentLogFields', () => {
  it('retains the structured facts needed to audit silent context overflow', () => {
    expect(projectAgentLogFields('llm.silent_overflow', {
      requestId: 'req:round:1',
      sessionId: 'session-1',
      model: 'deepseek-v4-pro',
      llmServiceId: 'service-1',
      kind: 'usage-exceeds-window',
      inputTokens: 100_001,
      contextWindow: 100_000,
      stopReason: 'end_turn',
      privateText: 'must be discarded'
    })).toEqual({
      requestId: 'req:round:1',
      sessionId: 'session-1',
      model: 'deepseek-v4-pro',
      llmServiceId: 'service-1',
      kind: 'usage-exceeds-window',
      inputTokens: 100_001,
      contextWindow: 100_000,
      stopReason: 'end_turn'
    })
  })

  // chat-abort-latency 方案 Phase 3（评审 N2）：中止审计事件纳入 TARGET_EVENTS 白名单后，
  // 审计字段必须经 COMMON_KEYS 保留、白名单外字段照常丢弃
  it('retains llm.cancel audit fields and drops non-allowlisted fields', () => {
    expect(projectAgentLogFields('llm.cancel', {
      requestId: 'req-1',
      sessionId: 'session-1',
      loopRound: 2,
      abortToCatchMs: 12,
      rawDetail: 'must be discarded'
    })).toEqual({
      requestId: 'req-1',
      sessionId: 'session-1',
      loopRound: 2,
      abortToCatchMs: 12
    })
  })

  it('retains turn.cancel audit fields and drops non-allowlisted fields', () => {
    expect(projectAgentLogFields('turn.cancel', {
      turnId: 'turn-1',
      requestId: 'req-1',
      accepted: true,
      rawDetail: 'must be discarded'
    })).toEqual({
      turnId: 'turn-1',
      requestId: 'req-1',
      accepted: true
    })
  })
})
