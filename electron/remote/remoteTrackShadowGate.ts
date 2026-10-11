import type { AppDatabase } from '../database/sqliteStore'
import { getDbConnection } from '../database/sqliteStore'
import { isRemoteTrackPricingEvidence } from '../../src/shared/remoteTrackPricingEvidence'

export const REMOTE_TRACK_SHADOW_WINDOW_MS = 14 * 24 * 60 * 60_000
const MAX_CLASSIFIER_OBSERVATION_GAP_MS = 24 * 60 * 60_000
const MIN_TOTAL_OBSERVATIONS = 500
const MIN_CHANNEL_OBSERVATIONS = 200
const MAX_CLASSIFIER_P95_MS = 2_000
const MAX_COST_USD_PER_THOUSAND = 1

export type RemoteTrackShadowGateReport = Readonly<{
  ready: boolean
  blockers: readonly string[]
  observations: number
  channelObservations: Readonly<Record<'wechat' | 'feishu', number>>
  evaluatedObservations: number
  evaluatedChannelObservations: Readonly<Record<'wechat' | 'feishu', number>>
  reviewedObservations: number
  wrongAttributions: number
  classifierInvocations: number
  p95LatencyMs: number | null
  providerCalls: number
  unpricedProviderCalls: number
  costUsdPerThousandCalls: number | null
  windowStart: number
  windowEnd: number
}>

/** Re-evaluates rollout evidence from persisted shadow observations; missing cost/labels always fail closed. */
export function readRemoteTrackShadowGateReport(db: AppDatabase, now = Date.now()): RemoteTrackShadowGateReport {
  if (!Number.isSafeInteger(now) || now < REMOTE_TRACK_SHADOW_WINDOW_MS) throw new Error('REMOTE_TRACK_SHADOW_GATE_TIME_INVALID')
  const windowStart = now - REMOTE_TRACK_SHADOW_WINDOW_MS
  const rows = getDbConnection(db).prepare(`SELECT channel,created_at,review_outcome,classifier_invoked,latency_ms,
      provider_call_made,estimated_cost_usd,pricing_source_url,pricing_effective_at,pricing_verified_at,pricing_verified_by
    FROM remote_track_attribution_observations WHERE created_at>=? AND created_at<=?
    ORDER BY created_at,observation_id`).all(windowStart, now) as Array<{
      channel: 'wechat' | 'feishu'; created_at: number; review_outcome: 'correct' | 'wrong' | 'uncertain' | null
      classifier_invoked: number | null; latency_ms: number; provider_call_made: number | null; estimated_cost_usd: number | null
      pricing_source_url: string | null; pricing_effective_at: string | null; pricing_verified_at: string | null; pricing_verified_by: string | null
    }>

  const channelObservations = { wechat: 0, feishu: 0 }
  const evaluatedChannelObservations = { wechat: 0, feishu: 0 }
  const evaluatedRows = rows.filter((row) => row.classifier_invoked === 1 && row.provider_call_made === 1)
  const latencies: number[] = []
  let reviewedObservations = 0
  let wrongAttributions = 0
  let classifierInvocations = 0
  let providerCalls = 0
  let unpricedProviderCalls = 0
  let knownCostUsd = 0
  let hasUnknownProviderOutcome = false
  for (const row of rows) {
    channelObservations[row.channel] += 1
    if (row.classifier_invoked === 1 && row.provider_call_made === 1) evaluatedChannelObservations[row.channel] += 1
    if (row.review_outcome === 'correct' || row.review_outcome === 'wrong') reviewedObservations += 1
    if (row.review_outcome === 'wrong') wrongAttributions += 1
    if (row.classifier_invoked === 1) {
      classifierInvocations += 1
      if (row.provider_call_made === 1) {
        latencies.push(row.latency_ms)
        providerCalls += 1
        if (row.estimated_cost_usd === null || !hasVerifiedPricingEvidence(row)) unpricedProviderCalls += 1
        else knownCostUsd += row.estimated_cost_usd
      } else if (row.provider_call_made === null) hasUnknownProviderOutcome = true
    } else if (row.classifier_invoked === null) hasUnknownProviderOutcome = true
  }
  latencies.sort((a, b) => a - b)
  const p95LatencyMs = latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1]! : null
  const costUsdPerThousandCalls = providerCalls > 0 && unpricedProviderCalls === 0 && !hasUnknownProviderOutcome
    ? knownCostUsd / providerCalls * 1_000 : null
  const blockers: string[] = []
  if (evaluatedRows.length < MIN_TOTAL_OBSERVATIONS) blockers.push('evaluable-sample-count-insufficient')
  if (evaluatedChannelObservations.wechat < MIN_CHANNEL_OBSERVATIONS) blockers.push('evaluable-wechat-sample-count-insufficient')
  if (evaluatedChannelObservations.feishu < MIN_CHANNEL_OBSERVATIONS) blockers.push('evaluable-feishu-sample-count-insufficient')
  if (evaluatedRows.length === 0 || evaluatedRows[0]!.created_at > windowStart + MAX_CLASSIFIER_OBSERVATION_GAP_MS ||
    now - evaluatedRows.at(-1)!.created_at > MAX_CLASSIFIER_OBSERVATION_GAP_MS ||
    evaluatedRows.some((row, index) => index > 0 && row.created_at - evaluatedRows[index - 1]!.created_at > MAX_CLASSIFIER_OBSERVATION_GAP_MS)) {
    blockers.push('classifier-window-coverage-insufficient')
  }
  if (reviewedObservations !== rows.length || rows.some((row) => row.review_outcome === 'uncertain')) blockers.push('independent-review-incomplete')
  if (wrongAttributions > 0) blockers.push('wrong-attribution-reported')
  if (p95LatencyMs === null || p95LatencyMs > MAX_CLASSIFIER_P95_MS) blockers.push('classifier-p95-unavailable-or-over-limit')
  if (costUsdPerThousandCalls === null || costUsdPerThousandCalls > MAX_COST_USD_PER_THOUSAND) blockers.push('classifier-cost-unavailable-or-over-limit')
  return {
    ready: blockers.length === 0, blockers, observations: rows.length, channelObservations,
    evaluatedObservations: evaluatedRows.length, evaluatedChannelObservations, reviewedObservations,
    wrongAttributions, classifierInvocations, p95LatencyMs, providerCalls, unpricedProviderCalls,
    costUsdPerThousandCalls, windowStart, windowEnd: now
  }
}

function hasVerifiedPricingEvidence(row: {
  pricing_source_url: string | null
  pricing_effective_at: string | null
  pricing_verified_at: string | null
  pricing_verified_by: string | null
}): boolean {
  return isRemoteTrackPricingEvidence({ sourceUrl: row.pricing_source_url, effectiveAt: row.pricing_effective_at,
    verifiedAt: row.pricing_verified_at, verifiedBy: row.pricing_verified_by })
}
