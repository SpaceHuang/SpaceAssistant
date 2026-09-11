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
})
