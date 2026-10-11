import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'

type Metric<T> = Readonly<{ available: boolean; missingReason?: string; value: T }>
type Counts = Record<string, number>

export type RemoteTrackOperationalMetricsReport = Readonly<{
  window: Readonly<{ from: number; to: number }>
  metrics: Readonly<{
    remote_track_attribution_total: Metric<{ total: number; byChannel: Record<RemoteTrackChannel, number>; byKind: Counts; byReason: Counts }>
    remote_track_wrong_attribution_report_total: Metric<{ total: number; byChannel: Record<RemoteTrackChannel, number>; byVersion: Counts; semanticContinuationMustPause: boolean }>
    remote_track_join_completeness: Metric<{ totalEvents: number; completeEvents: number; missingRequiredRefs: number; missingByEventKind: Counts; missingByField: Counts }>
    remote_clarification_delivery_total: Metric<{ totalAttempts: number; byResult: Counts; pendingAttempts: number }>
    remote_clarification_resolution_latency: Metric<{ byChannel: Record<string, { count: number; p50Ms: number | null; p95Ms: number | null }> }>
    remote_clarification_stale_reply_total: Metric<{ total: number; byReason: Counts; unknownReasonCount: number }>
    remote_track_work_recovery_total: Metric<{ total: number; observation: 'latest-work-state-updated-in-window'; byState: Counts; attempts: number; expiredLeases: number; needsReconciliation: number }>
    remote_track_context_completeness: Readonly<{ available: false; missingReason: 'view-snapshots-not-persisted'; value: {
      source: 'track-model-message-event-reference-proxy'; total: number; byStatus: Record<'complete' | 'partial' | 'unavailable', number>; missingByField: Counts
    } }>
    remote_track_terminal_transition_rejected_total: Metric<{ total: number; byFromTo: Counts; byReason: Counts }>
    remote_track_runtime_diagnostic_total: Metric<{ total: number; byKind: Counts; byReason: Counts }>
  }>
  alerts: readonly Readonly<{ code: string; severity: 'warning' | 'critical'; count: number; action: string }>[]
}>

function countBy(rows: readonly Record<string, unknown>[], field: string): Counts {
  const counts: Counts = {}
  for (const row of rows) {
    const value = String(row[field] ?? 'missing')
    counts[value] = (counts[value] ?? 0) + 1
  }
  return counts
}

function percentile(values: number[], percentileValue: number): number | null {
  if (!values.length) return null
  values.sort((a, b) => a - b)
  return values[Math.max(0, Math.ceil(values.length * percentileValue) - 1)] ?? null
}

const JOIN_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  'track.inbound.accepted': ['message_id'], 'track.inbound.attributed': ['message_id'], 'track.inbound.consumed': ['message_id'],
  'track.turn.bound': ['turn_id'], 'track.turn.started': ['turn_id'], 'track.confirmation.created': ['request_id', 'turn_id', 'tool_use_id', 'confirmation_id'],
  'track.confirmation.settled': ['request_id', 'turn_id', 'tool_use_id', 'confirmation_id'], 'track.model.message': ['message_id', 'turn_id'],
  'track.outbound.attempt_started': ['request_id', 'turn_id'], 'track.outbound.send_result': ['message_id'],
  'track.outbound.message_bound': ['message_id'], 'track.execution_work.completed': ['turn_id']
}

function requiredJoinFields(eventKind: string): readonly string[] | null {
  if (eventKind.startsWith('track.outbound.') || eventKind.startsWith('track.confirmation.')) return JOIN_REQUIRED_FIELDS[eventKind] ?? ['request_id', 'turn_id']
  return JOIN_REQUIRED_FIELDS[eventKind] ?? null
}

/** Read-only event-window report. No metric joins by session, nearest timestamp, identity, or message text. */
export function readRemoteTrackOperationalMetrics(
  db: AppDatabase,
  input: { from: number; to: number }
): RemoteTrackOperationalMetricsReport {
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.from < 0 || input.to <= input.from) {
    throw new Error('REMOTE_TRACK_OPERATIONAL_METRICS_RANGE_INVALID')
  }
  const conn = getDbConnection(db)
  const bounds = [input.from, input.to]
  const attributionRows = conn.prepare(`SELECT channel,decision_kind,reason_code FROM remote_track_attribution_observations
    WHERE created_at>=? AND created_at<? ORDER BY created_at,observation_id`).all(...bounds) as Array<Record<string, unknown>>
  const wrongRows = conn.prepare(`SELECT channel,classifier_version FROM remote_track_attribution_observations
    WHERE created_at>=? AND created_at<? AND review_outcome='wrong' ORDER BY created_at,observation_id`).all(...bounds) as Array<Record<string, unknown>>
  const events = conn.prepare(`SELECT event_kind,message_id,request_id,turn_id,tool_use_id,confirmation_id,payload_json,occurred_at
    FROM remote_track_events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,event_id`).all(...bounds) as Array<{
      event_kind: string; message_id: string | null; request_id: string | null; turn_id: string | null; tool_use_id: string | null;
      confirmation_id: string | null; payload_json: string; occurred_at: number
    }>
  let completeJoinEvents = 0
  let missingJoinEvents = 0
  const missingByEventKind: Counts = {}
  const missingByField: Counts = {}
  for (const event of events) {
    const required = requiredJoinFields(event.event_kind)
    if (!required) continue
    const missing = required.filter((field) => event[field as keyof typeof event] == null)
    if (!missing.length) completeJoinEvents += 1
    else {
      missingJoinEvents += 1
      missingByEventKind[event.event_kind] = (missingByEventKind[event.event_kind] ?? 0) + 1
      for (const field of missing) missingByField[field] = (missingByField[field] ?? 0) + 1
    }
  }
  const attempts = conn.prepare(`SELECT attempt.state FROM remote_clarification_send_attempts attempt
    JOIN remote_clarification_versions version ON version.clarification_id=attempt.clarification_id AND version.version=attempt.version
    JOIN remote_clarifications clarification ON clarification.clarification_id=version.clarification_id
    WHERE attempt.started_at>=? AND attempt.started_at<? ORDER BY attempt.started_at,attempt.send_attempt_id`).all(...bounds) as Array<{ state: string }>
  const clarifications = conn.prepare(`SELECT channel,created_at,updated_at FROM remote_clarifications
    WHERE state='resolved' AND updated_at>=? AND updated_at<? ORDER BY updated_at,clarification_id`).all(...bounds) as Array<{
      channel: string; created_at: number; updated_at: number
    }>
  const latencyGroups = new Map<string, number[]>()
  for (const row of clarifications) {
    const values = latencyGroups.get(row.channel) ?? []
    values.push(Math.max(0, row.updated_at - row.created_at))
    latencyGroups.set(row.channel, values)
  }
  const latencyByChannel: Record<string, { count: number; p50Ms: number | null; p95Ms: number | null }> = {}
  for (const [channel, values] of latencyGroups) latencyByChannel[channel] = {
    count: values.length, p50Ms: percentile([...values], 0.5), p95Ms: percentile([...values], 0.95)
  }
  const staleRows = conn.prepare(`SELECT channel,reason_code FROM remote_track_diagnostic_events
    WHERE event_kind='clarification.reply' AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,diagnostic_id`).all(...bounds) as Array<Record<string, unknown>>
  const runtimeDiagnostics = conn.prepare(`SELECT event_kind,reason_code FROM remote_track_runtime_diagnostics
    WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,diagnostic_id`).all(...bounds) as Array<Record<string, unknown>>
  const workRows = conn.prepare(`SELECT state,attempt_count,lease_expires_at FROM remote_track_work_queue
    WHERE updated_at>=? AND updated_at<? ORDER BY updated_at,work_id`).all(...bounds) as Array<{ state: string; attempt_count: number; lease_expires_at: number | null }>
  const modelEvents = conn.prepare(`SELECT message_id,turn_id,payload_json FROM remote_track_events
    WHERE event_kind='track.model.message' AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,event_id`).all(...bounds) as Array<{
      message_id: string | null; turn_id: string | null; payload_json: string
    }>
  const contextStatus: Record<'complete' | 'partial' | 'unavailable', number> = { complete: 0, partial: 0, unavailable: 0 }
  const contextMissing: Counts = {}
  for (const event of modelEvents) {
    let sessionId: unknown
    try { sessionId = (JSON.parse(event.payload_json) as { sessionId?: unknown }).sessionId } catch { sessionId = undefined }
    const missing = [!event.message_id && 'message_id', !event.turn_id && 'turn_id', typeof sessionId !== 'string' && 'session_id'].filter(Boolean) as string[]
    contextStatus[missing.length ? 'partial' : 'complete'] += 1
    for (const field of missing) contextMissing[field] = (contextMissing[field] ?? 0) + 1
  }
  const rejectedEvents = events.filter((event) => event.event_kind === 'track.lifecycle.rejected_transition')
  const pendingClarifications = conn.prepare(`SELECT clarification_id,created_at FROM remote_clarifications
    WHERE state='pending' AND created_at<=?`).all(input.to - 5 * 60_000) as Array<{ clarification_id: string; created_at: number }>
  const resolvedWithoutCompletedWork = conn.prepare(`SELECT clarification.clarification_id FROM remote_clarifications clarification
    LEFT JOIN remote_track_work_queue work ON work.clarification_id=clarification.clarification_id
    WHERE clarification.state='resolved' AND clarification.updated_at<=? AND (work.work_id IS NULL OR work.state<>'completed')`)
    .all(input.to - 5 * 60_000) as Array<{ clarification_id: string }>
  const processingTracks = conn.prepare(`SELECT track_id FROM remote_tracks WHERE state='processing' AND updated_at<=?`)
    .all(input.to - 30 * 60_000) as Array<{ track_id: string }>
  const rejectedReasons: Counts = {}
  const rejectedFromTo: Counts = {}
  for (const event of rejectedEvents) {
    try {
      const payload = JSON.parse(event.payload_json) as { event?: { type?: string; target?: string }; result?: { state?: string; rejected?: string } }
      const fromTo = `${payload.event?.type ?? 'unknown'}:${payload.event?.target ?? 'unknown'}->${payload.result?.state ?? 'unknown'}`
      rejectedFromTo[fromTo] = (rejectedFromTo[fromTo] ?? 0) + 1
      const reason = payload.result?.rejected ?? 'state-transition-rejected'
      rejectedReasons[reason] = (rejectedReasons[reason] ?? 0) + 1
    } catch { rejectedReasons['payload-unavailable'] = (rejectedReasons['payload-unavailable'] ?? 0) + 1 }
  }
  const channelAttribution = { wechat: 0, feishu: 0 }
  for (const row of attributionRows) if (row.channel === 'wechat' || row.channel === 'feishu') channelAttribution[row.channel] += 1
  const workByState = countBy(workRows as unknown as Record<string, unknown>[], 'state')
  const pendingAttempts = attempts.filter(({ state }) => state === 'attempt-started').length
  const missing = <T>(rows: number, reason: string, value: T): Metric<T> => ({ available: rows > 0, ...(rows === 0 ? { missingReason: reason } : {}), value })
  const alerts: Array<{ code: string; severity: 'warning' | 'critical'; count: number; action: string }> = []
  if (wrongRows.length) alerts.push({ code: 'wrong-attribution-reported', severity: 'critical', count: wrongRows.length,
    action: 'Pause semantic continuation and review affected Track attribution samples.' })
  if (missingJoinEvents) alerts.push({ code: 'track-join-fields-missing', severity: 'warning', count: missingJoinEvents,
    action: 'Inspect event producers for required request/turn/tool/confirmation/outbound references.' })
  if (staleRows.some((row) => row.reason_code === 'unknown')) alerts.push({ code: 'unknown-clarification-handle', severity: 'critical',
    count: staleRows.filter((row) => row.reason_code === 'unknown').length, action: 'Verify strict handle parser routing; unknown handles must never enter Agent execution.' })
  if (staleRows.some((row) => row.reason_code === 'invalid')) alerts.push({ code: 'invalid-clarification-control-reply', severity: 'warning',
    count: staleRows.filter((row) => row.reason_code === 'invalid').length,
    action: 'Review legacy or malformed control syntax; the router must consume it without creating an Agent turn.' })
  if (pendingAttempts) alerts.push({ code: 'clarification-send-attempt-pending', severity: 'warning', count: pendingAttempts,
    action: 'Inspect attempts that remain started and reconcile platform delivery outcome.' })
  const needsReconciliation = workRows.filter((row) => row.state === 'needs-reconciliation').length
  if (needsReconciliation) alerts.push({ code: 'track-work-needs-reconciliation', severity: 'warning', count: needsReconciliation,
    action: 'Reconcile the canonical turn and execution result before retrying or terminalizing the Track.' })
  const expiredLeases = workRows.filter((row) => row.state === 'claimed' && row.lease_expires_at !== null && row.lease_expires_at <= input.to).length
  if (expiredLeases) alerts.push({ code: 'track-work-lease-expired', severity: 'warning', count: expiredLeases,
    action: 'Run the recovery worker and inspect stale work owner/attempt fencing.' })
  if (pendingClarifications.length) alerts.push({ code: 'clarification-parked-over-ttl', severity: 'warning', count: pendingClarifications.length,
    action: 'Inspect clarification send attempts and expire/retry parked input; never execute it without a valid current selection.' })
  if (resolvedWithoutCompletedWork.length) alerts.push({ code: 'clarification-resolved-work-incomplete', severity: 'critical', count: resolvedWithoutCompletedWork.length,
    action: 'Recover or reconcile the mapped work and accepted turn; do not create a replacement turn.' })
  if (processingTracks.length) alerts.push({ code: 'track-processing-over-window', severity: 'warning', count: processingTracks.length,
    action: 'Inspect child work and recovery state; settle or reconcile before accepting more dependent work.' })
  for (const [eventKind, action] of [
    ['untracked-runtime-invocation', 'Stop Track execution and inspect inbound/wake attribution before allowing more IM runtime calls.'],
    ['track-owner-epoch-mismatch', 'Stop the affected Track and verify durable owner authorization epoch before retrying.'],
    ['track-association-write-failed', 'Reconcile the accepted turn and Track event mapping; do not start a replacement turn.']
  ] as const) {
    const count = runtimeDiagnostics.filter((row) => row.event_kind === eventKind).length
    if (count) alerts.push({ code: eventKind, severity: 'critical', count, action })
  }
  const attributionReasons = countBy(attributionRows, 'reason_code')
  const attributionKinds = countBy(attributionRows, 'decision_kind')
  const wrongByChannel = { wechat: 0, feishu: 0 }
  for (const row of wrongRows) if (row.channel === 'wechat' || row.channel === 'feishu') wrongByChannel[row.channel] += 1
  const attemptsByResult = countBy(attempts as unknown as Record<string, unknown>[], 'state')
  const staleReasons = countBy(staleRows, 'reason_code')
  const contextTotal = modelEvents.length
  return {
    window: { from: input.from, to: input.to },
    metrics: {
      remote_track_attribution_total: missing(attributionRows.length, 'no-attribution-observations', {
        total: attributionRows.length, byChannel: channelAttribution, byKind: attributionKinds, byReason: attributionReasons
      }),
      remote_track_wrong_attribution_report_total: missing(wrongRows.length, 'no-wrong-attribution-reports', {
        total: wrongRows.length, byChannel: wrongByChannel, byVersion: countBy(wrongRows, 'classifier_version'), semanticContinuationMustPause: wrongRows.length > 0
      }),
      remote_track_join_completeness: missing(events.length, 'no-track-events', { totalEvents: events.length,
        completeEvents: completeJoinEvents, missingRequiredRefs: missingJoinEvents, missingByEventKind, missingByField }),
      remote_clarification_delivery_total: missing(attempts.length, 'no-send-attempts', { totalAttempts: attempts.length,
        byResult: attemptsByResult, pendingAttempts }),
      remote_clarification_resolution_latency: missing(clarifications.length, 'no-resolved-clarifications', { byChannel: latencyByChannel }),
      remote_clarification_stale_reply_total: missing(staleRows.length, 'no-clarification-control-replies', { total: staleRows.length,
        byReason: staleReasons, unknownReasonCount: staleRows.filter((row) => !['invalid', 'resolved', 'already-resolved', 'stale', 'expired',
          'unauthorized', 'not-sent', 'invalid-option', 'candidate-invalidated', 'unknown', 'unavailable'].includes(String(row.reason_code))).length }),
      remote_track_work_recovery_total: missing(workRows.length, 'no-work-events', { total: workRows.length,
        observation: 'latest-work-state-updated-in-window', byState: workByState,
        attempts: workRows.reduce((sum, row) => sum + row.attempt_count, 0), expiredLeases, needsReconciliation }),
      remote_track_context_completeness: { available: false, missingReason: 'view-snapshots-not-persisted', value: {
        source: 'track-model-message-event-reference-proxy', total: contextTotal, byStatus: contextStatus, missingByField: contextMissing
      } },
      remote_track_terminal_transition_rejected_total: missing(rejectedEvents.length, 'no-rejected-terminal-transitions', {
        total: rejectedEvents.length, byFromTo: rejectedFromTo, byReason: rejectedReasons
      }),
      remote_track_runtime_diagnostic_total: missing(runtimeDiagnostics.length, 'no-runtime-diagnostics', {
        total: runtimeDiagnostics.length, byKind: countBy(runtimeDiagnostics, 'event_kind'), byReason: countBy(runtimeDiagnostics, 'reason_code')
      })
    },
    alerts
  }
}
