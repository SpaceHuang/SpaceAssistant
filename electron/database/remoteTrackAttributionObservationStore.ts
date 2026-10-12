import { randomUUID } from 'node:crypto'
import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import { runInTransaction } from './transaction'
import type { IntentAttributorMetering } from '../remote/trackAttribution'
import { isRemoteTrackPricingEvidence } from '../../src/shared/remoteTrackPricingEvidence'

export type RemoteTrackAttributionObservationInput = {
  channel: RemoteTrackChannel
  identityKey: string
  ownerId: string
  authorizationEpoch: number
  platformMessageId: string
  classifierVersion: string
  decisionKind: 'new-track' | 'continuation' | 'successor' | 'ambiguous' | 'rejected'
  reasonCode: string
  candidateTrackIds: string[]
  scores: Array<{ trackId: string; score: number }>
  latencyMs: number
  classifierInvoked: boolean
  metering?: IntentAttributorMetering
  occurredAt: number
}

export function recordRemoteTrackAttributionObservation(
  db: AppDatabase,
  input: RemoteTrackAttributionObservationInput
): { created: boolean } {
  if (!input.identityKey.trim() || !input.ownerId.trim() || !input.platformMessageId.trim() || !input.classifierVersion.trim() ||
    !/^[a-z0-9-]{1,80}$/i.test(input.reasonCode) || !Number.isSafeInteger(input.authorizationEpoch) || input.authorizationEpoch <= 0 ||
    !Number.isSafeInteger(input.latencyMs) || input.latencyMs < 0 || !Number.isSafeInteger(input.occurredAt) ||
    input.candidateTrackIds.length > 10 || input.candidateTrackIds.some((id) => !id.trim()) ||
    new Set(input.candidateTrackIds).size !== input.candidateTrackIds.length || input.scores.length > 10 ||
    input.scores.some(({ trackId, score }) => !input.candidateTrackIds.includes(trackId) || !Number.isFinite(score) || score < 0 || score > 1) ||
    new Set(input.scores.map(({ trackId }) => trackId)).size !== input.scores.length ||
    (input.metering?.estimatedCostUsd !== null && input.metering?.estimatedCostUsd !== undefined &&
      (!Number.isFinite(input.metering.estimatedCostUsd) || input.metering.estimatedCostUsd < 0)) ||
    (input.metering?.pricingEvidence !== undefined && !isRemoteTrackPricingEvidence(input.metering.pricingEvidence))) {
    throw new Error('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_INVALID')
  }
  const candidateSnapshotJson = JSON.stringify({ trackIds: input.candidateTrackIds, scores: input.scores })
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const prior = conn.prepare(`SELECT owner_id,classifier_version,decision_kind,reason_code,candidate_snapshot_json,latency_ms,classifier_invoked,
      provider_call_made,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,estimated_cost_usd,
      pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by
      FROM remote_track_attribution_observations WHERE channel=? AND identity_key=? AND authorization_epoch=? AND platform_message_id=?`)
      .get(input.channel, input.identityKey, input.authorizationEpoch, input.platformMessageId) as
      | { owner_id: string; classifier_version: string; decision_kind: string; reason_code: string; candidate_snapshot_json: string; latency_ms: number;
        classifier_invoked: number | null; provider_call_made: number | null; input_tokens: number | null; output_tokens: number | null;
        cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; estimated_cost_usd: number | null;
        pricing_source_url: string | null; pricing_effective_at: string | null; pricing_verified_at: string | null; pricing_verified_by: string | null }
      | undefined
    if (prior) {
      const metering = input.metering
      if (prior.owner_id !== input.ownerId || prior.classifier_version !== input.classifierVersion || prior.decision_kind !== input.decisionKind ||
        prior.reason_code !== input.reasonCode || prior.candidate_snapshot_json !== candidateSnapshotJson || prior.latency_ms !== input.latencyMs ||
        prior.classifier_invoked !== Number(input.classifierInvoked) || prior.provider_call_made !== (metering ? Number(metering.providerCallMade) : null) ||
        prior.input_tokens !== (metering?.inputTokens ?? null) || prior.output_tokens !== (metering?.outputTokens ?? null) ||
        prior.cache_read_input_tokens !== (metering?.cacheReadInputTokens ?? null) ||
        prior.cache_creation_input_tokens !== (metering?.cacheCreationInputTokens ?? null) || prior.estimated_cost_usd !== (metering?.estimatedCostUsd ?? null) ||
        prior.pricing_source_url !== (metering?.pricingEvidence?.sourceUrl ?? null) ||
        prior.pricing_effective_at !== (metering?.pricingEvidence?.effectiveAt ?? null) ||
        prior.pricing_verified_at !== (metering?.pricingEvidence?.verifiedAt ?? null) ||
        prior.pricing_verified_by !== (metering?.pricingEvidence?.verifiedBy ?? null)) {
        throw new Error('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_COLLISION')
      }
      return { created: false }
    }
    conn.prepare(`INSERT INTO remote_track_attribution_observations(
      observation_id,channel,identity_key,owner_id,authorization_epoch,platform_message_id,classifier_version,decision_kind,reason_code,candidate_snapshot_json,latency_ms,created_at,
      classifier_invoked,provider_call_made,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,estimated_cost_usd,
      pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), input.channel, input.identityKey, input.ownerId, input.authorizationEpoch,
      input.platformMessageId, input.classifierVersion, input.decisionKind, input.reasonCode, candidateSnapshotJson, input.latencyMs, input.occurredAt,
      Number(input.classifierInvoked), input.metering ? Number(input.metering.providerCallMade) : null,
      input.metering?.inputTokens ?? null, input.metering?.outputTokens ?? null, input.metering?.cacheReadInputTokens ?? null,
      input.metering?.cacheCreationInputTokens ?? null, input.metering?.estimatedCostUsd ?? null,
      input.metering?.pricingEvidence?.sourceUrl ?? null, input.metering?.pricingEvidence?.effectiveAt ?? null,
      input.metering?.pricingEvidence?.verifiedAt ?? null, input.metering?.pricingEvidence?.verifiedBy ?? null)
    return { created: true }
  })
}

/** Records an operator's independent shadow-sample label exactly once. */
export function reviewRemoteTrackAttributionObservation(db: AppDatabase, input: {
  observationId: string
  outcome: 'correct' | 'wrong' | 'uncertain'
  reviewedAt: number
}): 'recorded' | 'already-reviewed' {
  if (!input.observationId.trim() || !['correct', 'wrong', 'uncertain'].includes(input.outcome) ||
    !Number.isSafeInteger(input.reviewedAt) || input.reviewedAt < 0) throw new Error('REMOTE_TRACK_ATTRIBUTION_REVIEW_INVALID')
  const conn = getDbConnection(db)
  return runInTransaction(conn, () => {
    const existing = conn.prepare('SELECT review_outcome FROM remote_track_attribution_observations WHERE observation_id=?')
      .get(input.observationId) as { review_outcome: string | null } | undefined
    if (!existing) throw new Error('REMOTE_TRACK_ATTRIBUTION_OBSERVATION_NOT_FOUND')
    if (existing.review_outcome !== null) {
      if (existing.review_outcome !== input.outcome) throw new Error('REMOTE_TRACK_ATTRIBUTION_REVIEW_CONFLICT')
      return 'already-reviewed'
    }
    const changed = conn.prepare(`UPDATE remote_track_attribution_observations SET review_outcome=?,reviewed_at=?
      WHERE observation_id=? AND review_outcome IS NULL`).run(input.outcome, input.reviewedAt, input.observationId)
    if (Number(changed.changes) !== 1) throw new Error('REMOTE_TRACK_ATTRIBUTION_REVIEW_RACE')
    return 'recorded'
  })
}

/** Returns only redacted audit fields needed to independently label the persisted shadow sample. */
export function listRemoteTrackAttributionReviewSamples(db: AppDatabase, input: {
  from: number
  to: number
  limit?: number
  includeReviewed?: boolean
}): Array<{
  observationId: string
  channel: RemoteTrackChannel
  platformMessageId: string
  classifierVersion: string
  decisionKind: RemoteTrackAttributionObservationInput['decisionKind']
  reasonCode: string
  candidateSnapshot: { trackIds: string[]; scores: Array<{ trackId: string; score: number }> }
  latencyMs: number
  estimatedCostUsd: number | null
  reviewOutcome: 'correct' | 'wrong' | 'uncertain' | null
  reviewedAt: number | null
  pricingEvidence: NonNullable<IntentAttributorMetering['pricingEvidence']> | null
  occurredAt: number
}> {
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.to <= input.from) {
    throw new Error('REMOTE_TRACK_ATTRIBUTION_REVIEW_RANGE_INVALID')
  }
  const limit = Math.min(1_000, Math.max(1, Math.floor(input.limit ?? 100)))
  const rows = getDbConnection(db).prepare(`SELECT observation_id,channel,platform_message_id,classifier_version,decision_kind,reason_code,
      candidate_snapshot_json,latency_ms,estimated_cost_usd,review_outcome,reviewed_at,created_at,
      pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by
    FROM remote_track_attribution_observations WHERE created_at>=? AND created_at<?${input.includeReviewed ? '' : ' AND review_outcome IS NULL'}
    ORDER BY created_at,observation_id LIMIT ?`).all(input.from, input.to, limit) as Array<{
      observation_id: string; channel: RemoteTrackChannel; platform_message_id: string; classifier_version: string;
      decision_kind: RemoteTrackAttributionObservationInput['decisionKind']; reason_code: string; candidate_snapshot_json: string;
      latency_ms: number; estimated_cost_usd: number | null; review_outcome: 'correct' | 'wrong' | 'uncertain' | null;
      reviewed_at: number | null; created_at: number; pricing_source_url: string | null; pricing_effective_at: string | null;
      pricing_verified_at: string | null; pricing_verified_by: string | null
    }>
  return rows.map((row) => {
    let snapshot: unknown
    try { snapshot = JSON.parse(row.candidate_snapshot_json) } catch { throw new Error('REMOTE_TRACK_ATTRIBUTION_REVIEW_SNAPSHOT_CORRUPT') }
    if (typeof snapshot !== 'object' || snapshot === null || !('trackIds' in snapshot) || !Array.isArray(snapshot.trackIds) ||
      !('scores' in snapshot) || !Array.isArray(snapshot.scores)) throw new Error('REMOTE_TRACK_ATTRIBUTION_REVIEW_SNAPSHOT_CORRUPT')
    return { observationId: row.observation_id, channel: row.channel, platformMessageId: row.platform_message_id,
      classifierVersion: row.classifier_version, decisionKind: row.decision_kind, reasonCode: row.reason_code,
      candidateSnapshot: snapshot as { trackIds: string[]; scores: Array<{ trackId: string; score: number }> },
      latencyMs: row.latency_ms, estimatedCostUsd: row.estimated_cost_usd, reviewOutcome: row.review_outcome,
      reviewedAt: row.reviewed_at, occurredAt: row.created_at,
      pricingEvidence: row.pricing_source_url && row.pricing_effective_at && row.pricing_verified_at && row.pricing_verified_by
        ? { sourceUrl: row.pricing_source_url, effectiveAt: row.pricing_effective_at, verifiedAt: row.pricing_verified_at, verifiedBy: row.pricing_verified_by }
        : null }
  })
}
