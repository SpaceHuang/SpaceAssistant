import { describe, expect, it } from 'vitest'
import { buildRequestContextPayload } from './requestContext'

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
})
