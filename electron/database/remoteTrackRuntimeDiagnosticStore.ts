import type { RemoteTrackChannel } from '../../src/shared/remoteTrack'
import type { AppDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'

export type RemoteTrackRuntimeDiagnosticKind = 'untracked-runtime-invocation' | 'track-owner-epoch-mismatch' | 'track-association-write-failed'
export type RemoteTrackRuntimeDiagnosticReason = 'track-context-missing' | 'authorization-scope-mismatch' | 'turn-association-write-failed'
export type RemoteTrackRuntimeDiagnostic = Readonly<{
  channel: RemoteTrackChannel
  platformMessageId: string
  eventKind: RemoteTrackRuntimeDiagnosticKind
  reasonCode: RemoteTrackRuntimeDiagnosticReason
  occurredAt: number
}>

const KINDS = new Set<RemoteTrackRuntimeDiagnosticKind>([
  'untracked-runtime-invocation', 'track-owner-epoch-mismatch', 'track-association-write-failed'
])
const REASONS = new Set<RemoteTrackRuntimeDiagnosticReason>([
  'track-context-missing', 'authorization-scope-mismatch', 'turn-association-write-failed'
])

function validate(input: RemoteTrackRuntimeDiagnostic): void {
  if ((input.channel !== 'wechat' && input.channel !== 'feishu') || !KINDS.has(input.eventKind) || !REASONS.has(input.reasonCode) ||
    !input.platformMessageId.trim() || input.platformMessageId.length > 512 || !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw new Error('REMOTE_TRACK_RUNTIME_DIAGNOSTIC_INVALID')
  }
}

/** Stores closed runtime failure facts without user identity, message text, or exception text. */
export function recordRemoteTrackRuntimeDiagnostic(db: AppDatabase, input: RemoteTrackRuntimeDiagnostic): boolean {
  validate(input)
  const id = `${input.channel}:${input.platformMessageId}:${input.eventKind}`
  const result = getDbConnection(db).prepare(`INSERT OR IGNORE INTO remote_track_runtime_diagnostics(
    diagnostic_id,channel,platform_message_id,event_kind,reason_code,occurred_at
  ) VALUES(?,?,?,?,?,?)`).run(id, input.channel, input.platformMessageId, input.eventKind, input.reasonCode, input.occurredAt)
  if (Number(result.changes) === 0) {
    const prior = getDbConnection(db).prepare(`SELECT reason_code,occurred_at FROM remote_track_runtime_diagnostics WHERE diagnostic_id=?`)
      .get(id) as { reason_code: string; occurred_at: number } | undefined
    if (prior && (prior.reason_code !== input.reasonCode || prior.occurred_at !== input.occurredAt)) {
      throw new Error('REMOTE_TRACK_RUNTIME_DIAGNOSTIC_CONFLICT')
    }
    return false
  }
  return true
}

export function readRemoteTrackRuntimeDiagnostics(db: AppDatabase, input: { from: number; to: number }): RemoteTrackRuntimeDiagnostic[] {
  if (!Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.to) || input.from < 0 || input.to <= input.from) {
    throw new Error('REMOTE_TRACK_RUNTIME_DIAGNOSTIC_RANGE_INVALID')
  }
  const rows = getDbConnection(db).prepare(`SELECT channel,platform_message_id,event_kind,reason_code,occurred_at
    FROM remote_track_runtime_diagnostics WHERE occurred_at>=? AND occurred_at<? ORDER BY occurred_at,diagnostic_id`)
    .all(input.from, input.to) as Array<{ channel: RemoteTrackChannel; platform_message_id: string;
      event_kind: RemoteTrackRuntimeDiagnosticKind; reason_code: RemoteTrackRuntimeDiagnosticReason; occurred_at: number }>
  return rows.map((row) => ({ channel: row.channel, platformMessageId: row.platform_message_id,
    eventKind: row.event_kind, reasonCode: row.reason_code, occurredAt: row.occurred_at }))
}
