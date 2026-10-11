import { randomUUID } from 'node:crypto'
import type { RemoteTrackContext } from '../../src/shared/remoteTrack'
import { appendRemoteTrackEvent, mapRemoteTrackMessage } from '../database/remoteTrackStore'
import { getDbConnection, type AppDatabase } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'

export type RemoteTrackOutboundAttempt = Readonly<{
  attemptId: string
  attemptEventId: string
  resultEventId: string
  boundEventId: string
}>

export type RemoteTrackOutboundDeliveryContext = Readonly<{
  db: AppDatabase
  track: RemoteTrackContext
  requestId?: string
  turnId?: string
}>

export function recordRemoteTrackOutboundAttempt(
  db: AppDatabase,
  input: { track: RemoteTrackContext; requestId?: string; turnId?: string; now: number; attemptId?: string }
): RemoteTrackOutboundAttempt {
  const attemptId = input.attemptId ?? randomUUID()
  const attemptEventId = `track-outbound:${attemptId}:attempt`
  const resultEventId = `track-outbound:${attemptId}:result`
  const boundEventId = `track-outbound:${attemptId}:bound`
  appendRemoteTrackEvent(db, {
    eventId: attemptEventId,
    trackId: input.track.trackId,
    eventKind: 'track.outbound.attempt_started',
    idempotencyKey: attemptEventId,
    parentEventId: input.track.attributionEventId,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    occurredAt: input.now,
    payload: { attemptId, channel: input.track.channel }
  })
  return { attemptId, attemptEventId, resultEventId, boundEventId }
}

export function settleRemoteTrackOutboundAttempt(
  db: AppDatabase,
  input: {
    track: RemoteTrackContext
    attempt: RemoteTrackOutboundAttempt
    outcome: 'fulfilled' | 'rejected' | 'outcome-unknown'
    platformMessageId?: string
    now: number
  }
): void {
  const platformMessageId = input.platformMessageId?.trim() || undefined
  const payload = {
    attemptId: input.attempt.attemptId,
    outcome: input.outcome,
    bindingState: platformMessageId ? 'available' : 'unavailable',
    platformMessageId: platformMessageId ?? null
  }
  const conn = getDbConnection(db)
  runInTransaction(conn, () => {
    const prior = conn.prepare('SELECT track_id,payload_json FROM remote_track_events WHERE event_id=?')
      .get(input.attempt.resultEventId) as { track_id: string; payload_json: string } | undefined
    if (prior && (prior.track_id !== input.track.trackId || prior.payload_json !== JSON.stringify(payload))) {
      throw new Error('REMOTE_TRACK_OUTBOUND_ATTEMPT_ALREADY_SETTLED')
    }
    appendRemoteTrackEvent(db, {
      eventId: input.attempt.resultEventId,
      trackId: input.track.trackId,
      eventKind: 'track.outbound.send_result',
      idempotencyKey: input.attempt.resultEventId,
      parentEventId: input.attempt.attemptEventId,
      ...(platformMessageId ? { messageId: platformMessageId } : {}),
      occurredAt: input.now,
      payload
    })
    if (platformMessageId) {
      appendRemoteTrackEvent(db, {
        eventId: input.attempt.boundEventId,
        trackId: input.track.trackId,
        eventKind: 'track.outbound.message_bound',
        idempotencyKey: input.attempt.boundEventId,
        parentEventId: input.attempt.resultEventId,
        messageId: platformMessageId,
        occurredAt: input.now,
        payload: { attemptId: input.attempt.attemptId, bindingSource: 'send-acknowledgement', platformMessageId }
      })
      mapRemoteTrackMessage(db, {
        channel: input.track.channel,
        platformMessageId,
        trackId: input.track.trackId,
        eventId: input.attempt.boundEventId,
        direction: 'outbound'
      })
    }
  })
}

/** Tracks one send without treating SDK acknowledgement as proof of message binding. */
export async function sendRemoteTrackOutbound<T>(input: {
  delivery: RemoteTrackOutboundDeliveryContext
  send: () => Promise<T>
  readPlatformMessageId: (result: T) => string | undefined
  now?: () => number
}): Promise<T> {
  const now = input.now ?? Date.now
  const attempt = recordRemoteTrackOutboundAttempt(input.delivery.db, {
    track: input.delivery.track,
    requestId: input.delivery.requestId,
    turnId: input.delivery.turnId,
    now: now()
  })
  let result: T
  try {
    result = await input.send()
  } catch (error) {
    try {
      settleRemoteTrackOutboundAttempt(input.delivery.db, {
        track: input.delivery.track, attempt, outcome: 'outcome-unknown', now: now()
      })
    } catch (recordError) {
      console.error('[remote-track] failed to persist unknown outbound result', recordError)
    }
    throw error
  }
  try {
    settleRemoteTrackOutboundAttempt(input.delivery.db, {
      track: input.delivery.track, attempt, outcome: 'fulfilled',
      platformMessageId: input.readPlatformMessageId(result), now: now()
    })
  } catch (error) {
    console.error('[remote-track] failed to persist fulfilled outbound result', error)
  }
  return result
}
