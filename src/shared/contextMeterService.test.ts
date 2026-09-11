import { describe, expect, it } from 'vitest'
import { ContextMeter } from './contextMeterService'

describe('ContextMeter service', () => {
  it('replays events on every measure and does not use a process-only anchor', () => {
    const meter = new ContextMeter(() => [
      { seq: 1, type: 'request_header', payload: { schemaVersion: 1, requestId: 'r', surfaceSnapshot: { schemaVersion: 1, fingerprint: 's', systemFingerprint: 'sys', toolsFingerprint: 'tools', surfaceTokens: 10, systemTokens: 2, toolsTokens: 2, messageTokens: 6 } } },
      { seq: 2, type: 'request_context', payload: { schemaVersion: 1, requestId: 'r', provider: 'p', model: 'm', contextWindow: { tokens: 100, source: 'config' }, estimatorVersion: 'v', serializationVersion: 's' } },
      { seq: 3, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'r', usage: { input_tokens: 10 } } }
    ])
    const result = meter.measure({ currentSurface: { schemaVersion: 1, fingerprint: 'now', systemFingerprint: 'sys', toolsFingerprint: 'tools', surfaceTokens: 12, systemTokens: 2, toolsTokens: 2, messageTokens: 8 }, budget: { totalInputBudget: 90, bodyBudget: 86, inputBudget: 86, prefixTokens: 4, requiredTokens: 1, outputReserveTokens: 0, safetyReserveTokens: 0, triggerRatio: .9, targetBodyRatio: .8, estimatorVersion: 'v', serializationVersion: 's' }, decision: { decisionId: 'd', phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'r' }, contextWindow: { tokens: 100, source: 'config' } })
    expect(result.projectedTokens).toBe(12)
  })
})
