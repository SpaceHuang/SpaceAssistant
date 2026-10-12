import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './testHelpers'
import { readRemoteTrackAttributionMetrics } from './remoteTrackAttributionMetrics'
import { recordRemoteTrackAttributionObservation } from './remoteTrackAttributionObservationStore'

describe('remote Track attribution metrics', () => {
  it('aggregates channel/version decisions, latency, and only reports cost when every provider call is priced', () => {
    const db = createMemoryAppDb()
    try {
      const base = { channel: 'wechat' as const, identityKey: 'user', ownerId: 'owner', authorizationEpoch: 1,
        classifierVersion: 'chat-a', candidateTrackIds: ['track-a'], scores: [{ trackId: 'track-a', score: 0.91 }],
        classifierInvoked: true, occurredAt: 10 }
      recordRemoteTrackAttributionObservation(db, { ...base, platformMessageId: 'm1', decisionKind: 'continuation', reasonCode: 'semantic-unique', latencyMs: 100,
        metering: { providerCallMade: true, inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: 0.001 } })
      recordRemoteTrackAttributionObservation(db, { ...base, platformMessageId: 'm2', decisionKind: 'ambiguous', reasonCode: 'low-confidence', latencyMs: 300,
        metering: { providerCallMade: true, inputTokens: 10, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, estimatedCostUsd: null } })

      const metrics = readRemoteTrackAttributionMetrics(db, { from: 10, to: 11 })
      expect(metrics).toEqual([{ channel: 'wechat', classifierVersion: 'chat-a', observations: 2,
        decisions: { continuation: 1, ambiguous: 1 }, reasons: { 'semantic-unique': 1, 'low-confidence': 1 },
        classifierInvocations: 2, providerCalls: 2, unmeasuredInvocations: 0, p95LatencyMs: 300,
        knownCostUsd: 0.001, unpricedProviderCalls: 1, costUsdPerThousandCalls: null }])
    } finally { db.close() }
  })

  it('keeps historical and unknown metering as unmeasured instead of turning it into zero-cost data', () => {
    const db = createMemoryAppDb()
    try {
      recordRemoteTrackAttributionObservation(db, { channel: 'feishu', identityKey: 'chat', ownerId: 'owner', authorizationEpoch: 1,
        platformMessageId: 'm-unknown', classifierVersion: 'chat-b', decisionKind: 'ambiguous', reasonCode: 'classifier-unavailable',
        candidateTrackIds: ['track-b'], scores: [], latencyMs: 2, classifierInvoked: true, occurredAt: 10 })
      expect(readRemoteTrackAttributionMetrics(db, { from: 0, to: 20 })).toMatchObject([{
        channel: 'feishu', classifierVersion: 'chat-b', classifierInvocations: 1, providerCalls: 0,
        unmeasuredInvocations: 1, p95LatencyMs: 2, costUsdPerThousandCalls: null
      }])
    } finally { db.close() }
  })

  it('rejects invalid time windows', () => {
    const db = createMemoryAppDb()
    try { expect(() => readRemoteTrackAttributionMetrics(db, { from: 10, to: 10 })).toThrow('REMOTE_TRACK_ATTRIBUTION_METRICS_RANGE_INVALID') }
    finally { db.close() }
  })
})
