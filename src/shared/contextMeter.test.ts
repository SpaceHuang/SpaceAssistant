import { describe, expect, it } from 'vitest'
import { computeContextBreakdown, computeContextPressure, computeContextPressureFromEvents, shouldCompact } from './contextMeter'
import type { ContextInput } from './contextMeter'

const input = (overrides: Partial<ContextInput> = {}): ContextInput => ({
  currentSurface: {
    schemaVersion: 1,
    fingerprint: 'surface-2',
    systemFingerprint: 'system-1',
    toolsFingerprint: 'tools-1',
    surfaceTokens: 700,
    systemTokens: 100,
    toolsTokens: 100,
    messageTokens: 500
  },
  anchor: {
    requestId: 'r1', surfaceTokens: 600, surfaceFingerprint: 'surface-1', systemFingerprint: 'system-1',
    toolsFingerprint: 'tools-1', provider: 'anthropic', model: 'claude', estimatorVersion: 'v1',
    serializationVersion: 's1', realUsage: { input_tokens: 600, cache_read_input_tokens: 50 }, contextWindow: 1000
  },
  budget: { totalInputBudget: 900, bodyBudget: 800, inputBudget: 800, prefixTokens: 200, requiredTokens: 300, outputReserveTokens: 0, safetyReserveTokens: 100, triggerRatio: 0.9, targetBodyRatio: 0.8, estimatorVersion: 'v1', serializationVersion: 's1' },
  decision: { decisionId: 'd1', phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'adaptive-v1' },
  contextWindow: { tokens: 1000, source: 'config' },
  ...overrides
})

describe('ContextMeter pure projections', () => {
  it('projects anchored pressure without double counting subset cache', () => {
    const result = computeContextPressure(input())
    expect(result.pressureTokens).toBe(600)
    expect(result.projectedTokens).toBe(700)
    expect(result.anchorStatus).toBe('matched')
    expect(result.hardFit).toBe(true)
  })

  it('uses additive cache semantics and reports breakdown', () => {
    const result = computeContextPressure(input({ anchor: { ...input().anchor!, realUsage: { input_tokens: 600, cache_read_input_tokens: 50, cacheSemantics: 'additive' } } }))
    expect(result.pressureTokens).toBe(650)
    expect(computeContextBreakdown(input())).toEqual({ systemTokens: 100, toolsTokens: 100, messageTokens: 500 })
  })

  it('does not project or trigger automatically when the anchor is missing', () => {
    const result = computeContextPressure(input({ anchor: undefined }))
    expect(result.projectedTokens).toBeNull()
    expect(result.anchorStatus).toBe('missing')
    expect(shouldCompact(result, input().budget)).toBe(false)
  })

  it('uses body budget for the sole trigger and total budget for hard fit', () => {
    const result = computeContextPressure(input({ currentSurface: { ...input().currentSurface, surfaceTokens: 900, messageTokens: 700 } }))
    expect(result.bodyTokens).toBe(700)
    expect(result.bodyRatio).toBeCloseTo(0.875)
    expect(result.hardFit).toBe(true)
    expect(result.bodyFit).toBe(true)
    expect(shouldCompact({ ...result, projectedTokens: 920 }, input().budget)).toBe(true)
  })

  it('builds an anchor only from the same request event triplet', () => {
    const base = input()
    const snapshot = base.currentSurface
    const events = [
      { seq: 1, type: 'request_header', payload: { schemaVersion: 1, requestId: 'r1', surfaceSnapshot: snapshot } },
      { seq: 2, type: 'request_context', payload: { schemaVersion: 1, requestId: 'r1', provider: 'anthropic', model: 'claude', contextWindow: { tokens: 1000, source: 'config' }, estimatorVersion: 'v1', serializationVersion: 's1' } },
      { seq: 3, type: 'request_usage', payload: { schemaVersion: 1, requestId: 'r1', usage: { input_tokens: 600 } } }
    ]
    expect(computeContextPressureFromEvents(events, { ...base, anchor: undefined, currentSurface: { ...snapshot, fingerprint: 'surface-3' } }).anchorStatus).toBe('matched')
    expect(computeContextPressureFromEvents([{ ...events[2]!, payload: { ...events[2]!.payload, requestId: 'other' } }, ...events.slice(0, 2)], { ...base, anchor: undefined }).anchorStatus).toBe('missing')
  })
})
