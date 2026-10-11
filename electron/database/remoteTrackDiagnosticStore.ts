import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import type { ClarificationControlResultKind } from '../remote/clarificationInbound'

export type RemoteTrackDiagnosticKind = 'clarification.reply'
export type RemoteTrackDiagnosticReason = ClarificationControlResultKind

export type RemoteTrackDiagnosticEvent = Readonly<{
  channel: RemoteTrackChannel
  platformMessageId: string
  eventKind: RemoteTrackDiagnosticKind
  reasonCode: RemoteTrackDiagnosticReason
  occurredAt: number
}>

const EVENT_KINDS = new Set<RemoteTrackDiagnosticKind>(['clarification.reply'])
const REASONS = new Set<RemoteTrackDiagnosticReason>([
  'invalid', 'resolved', 'already-resolved', 'stale', 'expired', 'unauthorized', 'not-sent', 'invalid-option',
  'candidate-invalidated', 'unknown', 'unavailable'
])

function validate(input: RemoteTrackDiagnosticEvent): void {
  if ((input.channel !== 'wechat' && input.channel !== 'feishu') || !EVENT_KINDS.has(input.eventKind) ||
    !REASONS.has(input.reasonCode) || !input.platformMessageId.trim() || input.platformMessageId.length > 512 ||
    !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new Error('REMOTE_TRACK_DIAGNOSTIC_EVENT_INVALID')
  }
}

/** Stores only closed diagnostic codes and platform message identity; never accepts message text or user identity. */
export function recordRemoteTrackDiagnosticEvent(db: AppDatabase, input: RemoteTrackDiagnosticEvent): boolean {
  validate(input)
  const id = `${input.channel}:${input.platformMessageId}:${input.eventKind}`
  const result = getDbConnection(db).prepare(`INSERT OR IGNORE INTO remote_track_diagnostic_events(
      diagnostic_id,channel,platform_message_id,event_kind,reason_code,occurred_at
    ) VALUES(?,?,?,?,?,?)`).run(id, input.channel, input.platformMessageId, input.eventKind, input.reasonCode, input.occurredAt)
  if (Number(result.changes) === 0) {
    const prior = getDbConnection(db).prepare(`SELECT reason_code,occurred_at FROM remote_track_diagnostic_events WHERE diagnostic_id=?`)
      .get(id) as { reason_code: string; occurred_at: number } | undefined
    if (prior && (prior.reason_code !== input.reasonCode || prior.occurred_at !== input.occurredAt)) {
      throw new Error('REMOTE_TRACK_DIAGNOSTIC_EVENT_CONFLICT')
    }
    return false
  }
  return true
}

export function readRemoteTrackDiagnosticEvents(db: AppDatabase, input: { from: number; to: number }): RemoteTrackDiagnosticEvent[] {
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.from < 0 || input.to <= input.from) {
    throw new Error('REMOTE_TRACK_DIAGNOSTIC_RANGE_INVALID')
  }
  const rows = getDbConnection(db).prepare(`SELECT channel,platform_message_id,event_kind,reason_code,occurred_at
    FROM remote_track_diagnostic_events WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,diagnostic_id`).all(input.from, input.to) as
    Array<{ channel: RemoteTrackChannel; platform_message_id: string; event_kind: RemoteTrackDiagnosticKind;
      reason_code: RemoteTrackDiagnosticReason; occurred_at: number }>
  return rows.map((row) => ({ channel: row.channel, platformMessageId: row.platform_message_id,
    eventKind: row.event_kind, reasonCode: row.reason_code, occurredAt: row.occurred_at }))
}
