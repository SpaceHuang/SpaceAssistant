import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { listRemoteTrackAttributionReviewSamples, recordRemoteTrackAttributionObservation,
  reviewRemoteTrackAttributionObservation } from './remoteTrackAttributionObservationStore'

describe('remote Track attribution shadow observations', () => {
  it('persists a redacted deterministic observation once per authenticated inbound identity', () => {
    const db = createMemoryAppDb()
    try {
      const input = { channel: 'wechat' as const, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'shadow-message', classifierVersion: 'intent-v1', decisionKind: 'ambiguous' as const,
        reasonCode: 'confidence-margin-too-small', candidateTrackIds: ['track-a', 'track-b'], scores: [{ trackId: 'track-a', score: 0.8 }, { trackId: 'track-b', score: 0.76 }],
        latencyMs: 320, classifierInvoked: true, metering: { providerCallMade: true, inputTokens: 120, outputTokens: 15,
          cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0.00042,
          pricingEvidence: { sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' } }, occurredAt: 10 }
      expect(recordRemoteTrackAttributionObservation(db, input)).toEqual({ created: true })
      expect(recordRemoteTrackAttributionObservation(db, input)).toEqual({ created: false })
      const row = getDbConnection(db).prepare(`SELECT decision_kind,reason_code,candidate_snapshot_json,latency_ms,input_tokens,output_tokens,
        estimated_cost_usd,pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by FROM remote_track_attribution_observations`).get() as {
        decision_kind: string; reason_code: string; candidate_snapshot_json: string; latency_ms: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number
        pricing_source_url: string; pricing_effective_at: string; pricing_verified_at: string; pricing_verified_by: string
      }
      expect(row.decision_kind).toBe('ambiguous')
      expect(row.reason_code).toBe('confidence-margin-too-small')
      expect(row).toMatchObject({ input_tokens: 120, output_tokens: 15, estimated_cost_usd: 0.00042,
        pricing_source_url: 'https://provider.example.test/pricing', pricing_effective_at: '2026-10-01',
        pricing_verified_at: '2026-10-10', pricing_verified_by: 'operator-1' })
      expect(JSON.parse(row.candidate_snapshot_json)).toEqual({ trackIds: ['track-a', 'track-b'], scores: [{ trackId: 'track-a', score: 0.8 }, { trackId: 'track-b', score: 0.76 }] })
      expect(JSON.stringify(row)).not.toContain('shadow-message text')
    } finally { db.close() }
  })

  it('rejects identity collisions and invalid classifier metrics instead of overwriting evidence', () => {
    const db = createMemoryAppDb()
    try {
      const input = { channel: 'feishu' as const, identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'shadow-message', classifierVersion: 'intent-v1', decisionKind: 'new-track' as const,
        reasonCode: 'no-eligible-candidates', candidateTrackIds: [], scores: [], latencyMs: 10, classifierInvoked: false, occurredAt: 10 }
      recordRemoteTrackAttributionObservation(db, input)
      expect(() => recordRemoteTrackAttributionObservation(db, { ...input, ownerId: 'different-owner' })).toThrow('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_COLLISION')
      expect(() => recordRemoteTrackAttributionObservation(db, { ...input, latencyMs: -1 })).toThrow('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_INVALID')
      expect(() => recordRemoteTrackAttributionObservation(db, { ...input, platformMessageId: 'another-message',
        scores: [{ trackId: 'foreign-track', score: 0.95 }] })).toThrow('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_INVALID')
      expect(() => recordRemoteTrackAttributionObservation(db, { ...input, platformMessageId: 'bad-pricing-evidence', classifierInvoked: true,
        metering: { providerCallMade: true, inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
          estimatedCostUsd: 0, pricingEvidence: { sourceUrl: 'http://unverified.test', effectiveAt: '2026-01-01', verifiedAt: '2026-01-02', verifiedBy: 'x' } } }))
        .toThrow('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_INVALID')
    } finally { db.close() }
  })

  it('records one independent review label and rejects contradictory replacement', () => {
    const db = createMemoryAppDb()
    try {
      recordRemoteTrackAttributionObservation(db, { channel: 'wechat', identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'reviewed-message', classifierVersion: 'intent-v1', decisionKind: 'continuation', reasonCode: 'semantic-unique-above-threshold',
        candidateTrackIds: ['track-a'], scores: [{ trackId: 'track-a', score: 0.95 }], latencyMs: 200, classifierInvoked: true,
        metering: { providerCallMade: true, inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0, estimatedCostUsd: 0.001,
          pricingEvidence: { sourceUrl: 'https://provider.example.test/pricing', effectiveAt: '2026-10-01', verifiedAt: '2026-10-10', verifiedBy: 'operator-1' } }, occurredAt: 10 })
      const observationId = (getDbConnection(db).prepare('SELECT observation_id FROM remote_track_attribution_observations').get() as { observation_id: string }).observation_id
      expect(reviewRemoteTrackAttributionObservation(db, { observationId, outcome: 'correct', reviewedAt: 20 })).toBe('recorded')
      expect(reviewRemoteTrackAttributionObservation(db, { observationId, outcome: 'correct', reviewedAt: 21 })).toBe('already-reviewed')
      expect(() => reviewRemoteTrackAttributionObservation(db, { observationId, outcome: 'wrong', reviewedAt: 22 }))
        .toThrow('REMOTE_TRACK_ATTRIBUTION_REVIEW_CONFLICT')
      const samples = listRemoteTrackAttributionReviewSamples(db, { from: 0, to: 30, includeReviewed: true })
      expect(samples).toMatchObject([{ observationId, channel: 'wechat', platformMessageId: 'reviewed-message',
        candidateSnapshot: { trackIds: ['track-a'] }, reviewOutcome: 'correct', reviewedAt: 20 }])
      expect(JSON.stringify(samples)).not.toContain('identityKey')
    } finally { db.close() }
  })
})
