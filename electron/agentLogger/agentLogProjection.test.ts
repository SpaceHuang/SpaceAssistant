import { describe, expect, it } from 'vitest'
import { projectAgentLogFields } from './agentLogProjection'

describe('projectAgentLogFields', () => {
  it('retains cutover and transcript reconciliation counters without message content', () => {
    expect(projectAgentLogFields('history.cutover', {
      requestId: 'request-1', turnId: 'turn-1', sessionId: 'session-1', stage: 'match-current-message',
      reasonCode: 'matched', historyStreamId: 'legacy-stream', previousTurnId: 'previous-turn', snapshotVersion: 7,
      message: 'must not be retained'
    })).toEqual({
      requestId: 'request-1', turnId: 'turn-1', sessionId: 'session-1', stage: 'match-current-message',
      reasonCode: 'matched', historyStreamId: 'legacy-stream', previousTurnId: 'previous-turn', snapshotVersion: 7
    })
    expect(projectAgentLogFields('session.transcript.reconciliation', {
      sessionId: 'session-1', turnId: 'turn-1', outcome: 'commit_uncertain', reasonCode: 'version-conflict', transcriptVersion: 4, reconciledCount: 1
    })).toMatchObject({ outcome: 'commit_uncertain', transcriptVersion: 4, reconciledCount: 1 })
    expect(projectAgentLogFields('session.transcript.reconciliation', {
      outcome: 'startup-scan', releasedUnstarted: 2, markedUncertain: 1, repairedCheckpoints: 1, reconciledCount: 1,
      message: 'must not be retained'
    })).toEqual({ outcome: 'startup-scan', releasedUnstarted: 2, markedUncertain: 1, repairedCheckpoints: 1, reconciledCount: 1 })
  })

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
})
