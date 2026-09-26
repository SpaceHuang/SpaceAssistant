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
})
