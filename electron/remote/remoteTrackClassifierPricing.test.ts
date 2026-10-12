import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { setConfigValue } from '../database'
import { createRemoteTrackClassifierCostEstimator, estimateRemoteTrackClassifierCostUsd,
  parseRemoteTrackClassifierPricingConfig, readRemoteTrackClassifierRates, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY } from './remoteTrackClassifierPricing'
import { getModelIntentAttributorClassifierVersion } from './modelIntentAttributor'

describe('remote Track classifier pricing', () => {
  it('fails closed when a rate card has no auditable source, effective date, or reviewer', () => {
    expect(parseRemoteTrackClassifierPricingConfig({ version: 1, ratesByClassifierVersion: {
      'chat-0123456789abcdef': { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
        cacheReadInputUsdPerMillion: 0.1, cacheCreationInputUsdPerMillion: 0.2 }
    } })).toBeNull()
  })

  it('requires a new configuration version for the evidence-bearing rate card schema', () => {
    const evidence = { sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' }
    expect(parseRemoteTrackClassifierPricingConfig({ version: 1,
      ratesByClassifierVersion: { 'chat-0123456789abcdef': { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
        cacheReadInputUsdPerMillion: 0.1, cacheCreationInputUsdPerMillion: 0.2 } },
      evidenceByClassifierVersion: { 'chat-0123456789abcdef': evidence }
    })).toBeNull()
  })

  it('does not read the legacy v1 fee-card setting after the schema version changes', () => {
    const db = createMemoryAppDb()
    try {
      setConfigValue(db, 'remoteTrackClassifierPricingUsdPerMillionV1', JSON.stringify({ version: 1,
        ratesByClassifierVersion: { [getModelIntentAttributorClassifierVersion('https://api.example.test', 'model-x')]: {
          inputUsdPerMillion: 1, outputUsdPerMillion: 1, cacheReadInputUsdPerMillion: 0, cacheCreationInputUsdPerMillion: 0
        } }, evidenceByClassifierVersion: { [getModelIntentAttributorClassifierVersion('https://api.example.test', 'model-x')]: {
          sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1'
        } }
      }))
      expect(readRemoteTrackClassifierRates(db, { baseUrl: 'https://api.example.test', model: 'model-x' })).toBeNull()
    } finally { db.close() }
  })

  it('estimates USD from a versioned operator rate card including cache usage', () => {
    const db = createMemoryAppDb()
    try {
      const classifierVersion = getModelIntentAttributorClassifierVersion('https://api.example.test', 'model-x')
      const evidence = { sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' }
      setConfigValue(db, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY, JSON.stringify({ version: 2,
        ratesByClassifierVersion: { [classifierVersion]: { inputUsdPerMillion: 2, outputUsdPerMillion: 8,
          cacheReadInputUsdPerMillion: 0.2, cacheCreationInputUsdPerMillion: 2.5 } },
        evidenceByClassifierVersion: { [classifierVersion]: evidence }
      }))
      const estimate = createRemoteTrackClassifierCostEstimator(db, { baseUrl: 'https://api.example.test', model: 'model-x' })!
      expect(estimate.pricingEvidence).toEqual(evidence)
      expect(estimate({ inputTokens: 1_000, outputTokens: 500, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 100 }))
        .toBeCloseTo(0.00665)
    } finally { db.close() }
  })

  it('keeps missing, malformed, or other-version pricing unknown', () => {
    const db = createMemoryAppDb()
    try {
      expect(readRemoteTrackClassifierRates(db, { baseUrl: 'https://api.example.test', model: 'model-x' })).toBeNull()
      setConfigValue(db, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY, '{broken')
      expect(createRemoteTrackClassifierCostEstimator(db, { baseUrl: 'https://api.example.test', model: 'model-x' })).toBeUndefined()
      const evidence = { sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' }
      setConfigValue(db, REMOTE_TRACK_CLASSIFIER_PRICING_CONFIG_KEY, JSON.stringify({ version: 2,
        ratesByClassifierVersion: { 'chat-0000000000000000': { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
          cacheReadInputUsdPerMillion: 1, cacheCreationInputUsdPerMillion: 1 } },
        evidenceByClassifierVersion: { 'chat-0000000000000000': evidence }
      }))
      expect(readRemoteTrackClassifierRates(db, { baseUrl: 'https://api.example.test', model: 'model-x' })).toBeNull()
      expect(estimateRemoteTrackClassifierCostUsd({ inputUsdPerMillion: 1, outputUsdPerMillion: 1,
        cacheReadInputUsdPerMillion: 1, cacheCreationInputUsdPerMillion: 1 },
      { inputTokens: -1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 })).toBeNull()
      expect(parseRemoteTrackClassifierPricingConfig({ version: 2, ratesByClassifierVersion: {
        'chat-0123456789abcdef': { inputUsdPerMillion: -1, outputUsdPerMillion: 1,
          cacheReadInputUsdPerMillion: 1, cacheCreationInputUsdPerMillion: 1 }
      }, evidenceByClassifierVersion: { 'chat-0123456789abcdef': evidence } })).toBeNull()
      expect(parseRemoteTrackClassifierPricingConfig({ version: 2, ratesByClassifierVersion: {
        'chat-0123456789abcdef': { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
          cacheReadInputUsdPerMillion: 1, cacheCreationInputUsdPerMillion: 1 }
      }, evidenceByClassifierVersion: { 'chat-0123456789abcdef': { ...evidence, sourceUrl: 'http://insecure.test/pricing' } } })).toBeNull()
      expect(parseRemoteTrackClassifierPricingConfig({ version: 2, ratesByClassifierVersion: {
        'chat-0123456789abcdef': { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
          cacheReadInputUsdPerMillion: 1, cacheCreationInputUsdPerMillion: 1 }
      }, evidenceByClassifierVersion: { 'chat-0123456789abcdef': { ...evidence, sourceUrl: 'https://provider.example.test/pricing?token=secret' } } })).toBeNull()
      expect(parseRemoteTrackClassifierPricingConfig({ version: 2, ratesByClassifierVersion: {
        'chat-0123456789abcdef': { inputUsdPerMillion: 1, outputUsdPerMillion: 1,
          cacheReadInputUsdPerMillion: 1, cacheCreationInputUsdPerMillion: 1 }
      }, evidenceByClassifierVersion: { 'chat-0123456789abcdef': { ...evidence, effectiveAt: '2026-02-30' } } })).toBeNull()
    } finally { db.close() }
  })
})
