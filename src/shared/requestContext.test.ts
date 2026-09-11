import { describe, expect, it } from 'vitest'
import { buildRequestContextPayload, buildRequestHeaderPayload } from './requestContext'

describe('request context payload', () => {
  it('records the effective output reserve and shared-window accounting', () => {
    expect(buildRequestContextPayload({ requestId: 'r1', provider: 'anthropic', model: 'claude', contextWindow: 10000, maxTokensEffective: 2000 })).toMatchObject({
      requestId: 'r1', contextWindow: { tokens: 10000, source: 'config' }, maxTokensEffective: 2000,
      outputReserveTokens: 2000, outputAccounting: 'shared'
    })
  })
  it('uses separate accounting when the provider window excludes output', () => {
    expect(buildRequestContextPayload({ requestId: 'r1', provider: 'x', model: 'm', contextWindow: 100, maxTokensEffective: 20, outputAccounting: 'separate' }).outputReserveTokens).toBe(0)
  })
  it('persists a protocol-neutral surface snapshot with stable fingerprints', () => {
    const header = buildRequestHeaderPayload({ requestId: 'r1', system: 'system', tools: [{ name: 'z' }], messages: [{ role: 'user', content: 'hello' }] })
    expect(header.schemaVersion).toBe(1)
    expect(header.surfaceSnapshot).toMatchObject({ surfaceTokens: expect.any(Number), systemTokens: expect.any(Number), toolsTokens: expect.any(Number), messageTokens: expect.any(Number) })
    expect(header.surfaceSnapshot.systemFingerprint).not.toBe(header.stablePrefixFingerprint)
    expect(buildRequestHeaderPayload({ requestId: 'r1', system: 'system', tools: [{ name: 'z' }], messages: [{ role: 'user', content: 'hello' }] }).surfaceSnapshot.fingerprint).toBe(header.surfaceSnapshot.fingerprint)
  })
  it('records one budget object and an unanchored preflight context usage', () => {
    const header = buildRequestHeaderPayload({ requestId: 'r1', system: 'sys', tools: [], messages: [{ role: 'user', content: 'hi' }] })
    const payload = buildRequestContextPayload({ requestId: 'r1', provider: 'anthropic', model: 'm', contextWindow: 1000, maxTokensEffective: 100, surfaceSnapshot: header.surfaceSnapshot })
    expect(payload.budget).toMatchObject({ totalInputBudget: 855, bodyBudget: 855 - header.surfaceSnapshot.systemTokens - header.surfaceSnapshot.toolsTokens, inputBudget: 855 - header.surfaceSnapshot.systemTokens - header.surfaceSnapshot.toolsTokens })
    expect(payload.contextUsage).toMatchObject({ projectedTokens: null, surfaceTokens: header.surfaceSnapshot.surfaceTokens, hardFit: true })
  })
  it('counts tools as part of the stable prefix', () => {
    const header = buildRequestHeaderPayload({ requestId: 'r1', system: 'sys', tools: [{ name: 'tool', description: 'x'.repeat(100) }], messages: [] })
    const payload = buildRequestContextPayload({ requestId: 'r1', provider: 'a', model: 'm', contextWindow: 1000, maxTokensEffective: 100, surfaceSnapshot: header.surfaceSnapshot })
    expect(payload.budget.prefixTokens).toBe(header.surfaceSnapshot.systemTokens + header.surfaceSnapshot.toolsTokens)
  })
  it('creates a stable fingerprint for the decision cycle', () => {
    const a = buildRequestContextPayload({ requestId: 'r', provider: 'p', model: 'm', maxTokensEffective: 1, decision: { decisionId: 'd', phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'v1' } })
    const b = buildRequestContextPayload({ requestId: 'r', provider: 'p', model: 'm', maxTokensEffective: 1, decision: { decisionId: 'd', phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'v1' } })
    expect(a.decisionFingerprint).toBe(b.decisionFingerprint)
    expect(a.decisionFingerprint).toMatch(/^[0-9a-f]+$/)
  })
  it('changes the decision fingerprint when the projected surface changes', () => {
    const base = { requestId: 'r', provider: 'p', model: 'm', contextWindow: 1000, maxTokensEffective: 100, surfaceSnapshot: { surfaceTokens: 20, systemTokens: 2, toolsTokens: 2 }, decision: { decisionId: 'd', phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'v1' } }
    const a = buildRequestContextPayload(base)
    const b = buildRequestContextPayload({ ...base, surfaceSnapshot: { ...base.surfaceSnapshot, surfaceTokens: 21 } })
    expect(a.decisionFingerprint).not.toBe(b.decisionFingerprint)
  })
  it('accepts a replayable anchored context usage update', () => {
    const payload = buildRequestContextPayload({ requestId: 'r', provider: 'p', model: 'm', contextWindow: 100, maxTokensEffective: 10, contextUsage: { pressureTokens: 20, projectedTokens: 22, surfaceTokens: 22, hardFit: true, bodyFit: true } })
    expect(payload.contextUsage).toMatchObject({ pressureTokens: 20, projectedTokens: 22 })
  })
  it('isolates decision fingerprints by window', () => {
    const base = { requestId: 'r', provider: 'p', model: 'm', maxTokensEffective: 1, decision: { decisionId: 'd', phase: 'turn_boundary', reason: 'proactive', ruleVersion: 'v1' } }
    expect(buildRequestContextPayload({ ...base, windowId: 'w1' }).decisionFingerprint).not.toBe(buildRequestContextPayload({ ...base, windowId: 'w2' }).decisionFingerprint)
  })
})
