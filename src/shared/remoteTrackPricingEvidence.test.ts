import { describe, expect, it } from 'vitest'
import { isRemoteTrackPricingEvidence } from './remoteTrackPricingEvidence'

describe('remote Track pricing evidence', () => {
  const evidence = { sourceUrl: 'https://provider.example/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' }

  it('accepts a public HTTPS source and an ordered effective/review date pair', () => {
    expect(isRemoteTrackPricingEvidence(evidence)).toBe(true)
  })

  it.each([
    { ...evidence, sourceUrl: 'http://provider.example/pricing' },
    { ...evidence, sourceUrl: 'https://user:secret@provider.example/pricing' },
    { ...evidence, sourceUrl: 'https://provider.example/pricing?token=secret' },
    { ...evidence, sourceUrl: 'https://provider.example/pricing#secret' },
    { ...evidence, effectiveAt: '2026-02-30' },
    { ...evidence, effectiveAt: '2026-10-11', verifiedAt: '2026-10-10' },
    { ...evidence, verifiedBy: '  ' },
    { ...evidence, extra: 'not-versioned' }
  ])('rejects malformed or secret-bearing pricing evidence %#', (value) => {
    expect(isRemoteTrackPricingEvidence(value)).toBe(false)
  })
})
