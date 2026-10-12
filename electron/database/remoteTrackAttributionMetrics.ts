import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'

export type RemoteTrackAttributionMetrics = Readonly<{
  channel: RemoteTrackChannel
  classifierVersion: string
  observations: number
  decisions: Readonly<Record<string, number>>
  reasons: Readonly<Record<string, number>>
  classifierInvocations: number
  providerCalls: number
  unmeasuredInvocations: number
  p95LatencyMs: number | null
  knownCostUsd: number
  unpricedProviderCalls: number
  costUsdPerThousandCalls: number | null
}>

/** Aggregates only persisted, redacted observations; missing cost remains visible and never counts as zero. */
export function readRemoteTrackAttributionMetrics(db: AppDatabase, input: { from: number; to: number }): RemoteTrackAttributionMetrics[] {
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.to <= input.from) {
    throw new Error('REMOTE_TRACK_ATTRIBUTION_METRICS_RANGE_INVALID')
  }
  const rows = getDbConnection(db).prepare(`SELECT channel,classifier_version,decision_kind,reason_code,latency_ms,classifier_invoked,
      provider_call_made,input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,estimated_cost_usd
    FROM remote_track_attribution_observations WHERE created_at>=? AND created_at<? ORDER BY channel,classifier_version,created_at,observation_id`)
    .all(input.from, input.to) as Array<{ channel: RemoteTrackChannel; classifier_version: string; decision_kind: string; reason_code: string;
      latency_ms: number; classifier_invoked: number | null; provider_call_made: number | null; input_tokens: number | null;
      output_tokens: number | null; cache_read_input_tokens: number | null; cache_creation_input_tokens: number | null; estimated_cost_usd: number | null }>
  const groups = new Map<string, {
    channel: RemoteTrackChannel; classifierVersion: string; observations: number; decisions: Record<string, number>; reasons: Record<string, number>;
    classifierInvocations: number; providerCalls: number; unmeasuredInvocations: number; latencies: number[]; knownCostUsd: number; unpricedProviderCalls: number
  }>()
  for (const row of rows) {
    const key = `${row.channel}\0${row.classifier_version}`
    let group = groups.get(key)
    if (!group) {
      group = { channel: row.channel, classifierVersion: row.classifier_version, observations: 0, decisions: {}, reasons: {},
        classifierInvocations: 0, providerCalls: 0, unmeasuredInvocations: 0, latencies: [], knownCostUsd: 0, unpricedProviderCalls: 0 }
      groups.set(key, group)
    }
    group.observations += 1
    group.decisions[row.decision_kind] = (group.decisions[row.decision_kind] ?? 0) + 1
    group.reasons[row.reason_code] = (group.reasons[row.reason_code] ?? 0) + 1
    if (row.classifier_invoked === 1) {
      group.classifierInvocations += 1
      group.latencies.push(row.latency_ms)
      if (row.provider_call_made === 1) {
        group.providerCalls += 1
        if (row.estimated_cost_usd === null) group.unpricedProviderCalls += 1
        else group.knownCostUsd += row.estimated_cost_usd
      } else if (row.provider_call_made === null) group.unmeasuredInvocations += 1
    } else if (row.classifier_invoked === null) {
      group.unmeasuredInvocations += 1
    }
  }
  return [...groups.values()].map((group) => {
    group.latencies.sort((a, b) => a - b)
    const p95Index = group.latencies.length ? Math.ceil(group.latencies.length * 0.95) - 1 : -1
    const hasCompleteCost = group.providerCalls > 0 && group.unpricedProviderCalls === 0 && group.unmeasuredInvocations === 0
    return {
      channel: group.channel, classifierVersion: group.classifierVersion, observations: group.observations,
      decisions: group.decisions, reasons: group.reasons, classifierInvocations: group.classifierInvocations,
      providerCalls: group.providerCalls, unmeasuredInvocations: group.unmeasuredInvocations,
      p95LatencyMs: p95Index >= 0 ? group.latencies[p95Index] : null, knownCostUsd: group.knownCostUsd,
      unpricedProviderCalls: group.unpricedProviderCalls,
      costUsdPerThousandCalls: hasCompleteCost ? group.knownCostUsd / group.providerCalls * 1_000 : null
    }
  })
}
