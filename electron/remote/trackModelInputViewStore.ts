import { createHash } from 'node:crypto'
import { getDbConnection, type AppDatabase } from '../database'
import { appendRemoteTrackEvent } from '../database/remoteTrackStore'
import type { TrackModelInputViewRef } from '../../src/shared/remoteTrack'
import type { SessionQueries } from '../sessionStorage/public/ports'

export function recordTrackModelMessage(
  db: AppDatabase,
  input: { trackId: string; eventId: string; idempotencyKey: string; sessionId: string; messageId: string; invocationId: string; occurredAt: number; parentEventId?: string },
  sessionQueries: Pick<SessionQueries, 'readMessageSkeleton'>
): { created: boolean } {
  const conn = getDbConnection(db)
  const row = sessionQueries.readMessageSkeleton({ sessionId: input.sessionId, messageId: input.messageId })
  if (!row) throw new Error('TRACK_MODEL_MESSAGE_SESSION_MISMATCH')
  if (row.role !== 'user' && row.role !== 'assistant') throw new Error('TRACK_MODEL_MESSAGE_ROLE_INVALID')
  const track = conn.prepare('SELECT state FROM remote_tracks WHERE track_id=?').get(input.trackId) as { state: string } | undefined
  if (!track || ['completed', 'cancelled', 'expired', 'failed'].includes(track.state)) throw new Error('TRACK_MODEL_MESSAGE_TRACK_NOT_ACTIVE')
  return appendRemoteTrackEvent(db, {
    eventId: input.eventId, trackId: input.trackId, eventKind: 'track.model.message', idempotencyKey: input.idempotencyKey,
    parentEventId: input.parentEventId, messageId: input.messageId, turnId: input.invocationId, occurredAt: input.occurredAt,
    payload: { sessionId: input.sessionId, role: row.role }
  })
}

export function buildTrackModelInputViewRef(
  db: AppDatabase,
  input: { trackId: string; sessionId: string; acceptedUserMessageId: string; currentInvocationId: string; channel: 'wechat' | 'feishu'; identityKey: string; ownerId: string; authorizationEpoch: number; rootMessageId: string; attributionEventId: string },
  sessionQueries: Pick<SessionQueries, 'readMessage' | 'readMessageSkeleton'>
): TrackModelInputViewRef {
  const conn = getDbConnection(db)
  const track = conn.prepare('SELECT origin_session_id,parent_track_id,channel,identity_key,owner_id,authorization_epoch,root_message_id FROM remote_tracks WHERE track_id=?').get(input.trackId) as
    | { origin_session_id: string | null; parent_track_id: string | null; channel: string; identity_key: string; owner_id: string; authorization_epoch: number; root_message_id: string }
    | undefined
  if (!track) throw new Error('TRACK_MODEL_INPUT_TRACK_MISSING')
  if (track.channel !== input.channel || track.identity_key !== input.identityKey || track.owner_id !== input.ownerId || track.authorization_epoch !== input.authorizationEpoch) {
    throw new Error('TRACK_MODEL_INPUT_AUTH_SCOPE_MISMATCH')
  }
  if (track.root_message_id !== input.rootMessageId || !conn.prepare('SELECT 1 FROM remote_track_events WHERE event_id=? AND track_id=?').get(input.attributionEventId, input.trackId)) {
    throw new Error('TRACK_MODEL_INPUT_ATTRIBUTION_MISMATCH')
  }
  // A Track may continue in a new session after idle expiry. The ledger remains the scope boundary;
  // origin_session_id identifies where it began and is not a requirement that later turns reuse it.
  let hasPartial = false
  let permittedParentTrackIds: string[] = []
  const sourceTrackIds = [input.trackId]
  if (track.parent_track_id) {
    const parent = conn.prepare(`SELECT state,channel,identity_key,owner_id,authorization_epoch FROM remote_tracks WHERE track_id=?`)
      .get(track.parent_track_id) as { state: string; channel: string; identity_key: string; owner_id: string; authorization_epoch: number } | undefined
    if (!parent || parent.state !== 'completed' || parent.channel !== input.channel || parent.identity_key !== input.identityKey ||
      parent.owner_id !== input.ownerId || parent.authorization_epoch !== input.authorizationEpoch) {
      hasPartial = true
    } else {
      permittedParentTrackIds = [track.parent_track_id]
      sourceTrackIds.push(track.parent_track_id)
    }
  }
  const events = conn.prepare(`SELECT event_id,message_id,turn_id,payload_json FROM remote_track_events
    WHERE track_id IN (${sourceTrackIds.map(() => '?').join(',')}) AND event_kind='track.model.message' ORDER BY occurred_at,event_id`)
    .all(...sourceTrackIds) as
    Array<{ event_id: string; message_id: string | null; turn_id: string | null; payload_json: string }>
  const eventIds: string[] = []
  const messageIds: string[] = []
  const invocationIds: string[] = []
  const sessionIds: string[] = []
  // A reused accepted message may legitimately be linked to both its original and
  // async-completion invocation. Preserve each ledger event, but validate repeated
  // references against the same persisted message identity and content.
  const messageSessionMap: Record<string, string> = {}
  const messageContentMap: Record<string, { role: string; content: string }> = {}
  const invocationSessionMap: Record<string, string> = {}
  const contentParts: unknown[] = []
  for (const event of events) {
    let payload: { sessionId?: unknown } = {}
    try { payload = JSON.parse(event.payload_json) as { sessionId?: unknown } } catch { hasPartial = true; continue }
    if (typeof payload.sessionId !== 'string' || !event.message_id || !event.turn_id) { hasPartial = true; continue }
    const message = sessionQueries.readMessage({ sessionId: payload.sessionId, messageId: event.message_id })
    if (!message) { hasPartial = true; continue }
    eventIds.push(event.event_id)
    messageIds.push(event.message_id)
    invocationIds.push(event.turn_id)
    sessionIds.push(payload.sessionId)
    const priorMessageSession = messageSessionMap[event.message_id]
    if (priorMessageSession && priorMessageSession !== payload.sessionId) { hasPartial = true; continue }
    const priorMessageContent = messageContentMap[event.message_id]
    if (priorMessageContent && (priorMessageContent.role !== message.role || priorMessageContent.content !== message.content)) { hasPartial = true; continue }
    messageSessionMap[event.message_id] = payload.sessionId
    messageContentMap[event.message_id] = { role: message.role, content: message.content }
    const priorSession = invocationSessionMap[event.turn_id]
    if (priorSession && priorSession !== payload.sessionId) { hasPartial = true; continue }
    invocationSessionMap[event.turn_id] = payload.sessionId
    contentParts.push([event.event_id, payload.sessionId, event.turn_id, event.message_id, message.role, message.content])
  }
  const uniqueMessageIds = [...new Set(messageIds)]
  const uniqueInvocationIds = [...new Set(invocationIds)]
  const acceptedUserMessage = sessionQueries.readMessageSkeleton({ sessionId: input.sessionId, messageId: input.acceptedUserMessageId })
  const hasAcceptedUserMessage = uniqueMessageIds.includes(input.acceptedUserMessageId) && acceptedUserMessage?.role === 'user'
  const hasCurrentInvocation = uniqueInvocationIds.includes(input.currentInvocationId)
  const completeness: TrackModelInputViewRef['completeness'] = !hasAcceptedUserMessage || !hasCurrentInvocation
    ? 'unavailable'
    : hasPartial ? 'partial' : 'complete'
  const contentHash = createHash('sha256').update(JSON.stringify(contentParts)).digest('hex')
  return {
    trackId: input.trackId,
    sessionId: input.sessionId,
    viewVersion: `view-${contentHash.slice(0, 20)}`,
    completeness,
    includedEventIds: eventIds,
    includedMessageIds: uniqueMessageIds,
    includedInvocationIds: uniqueInvocationIds,
    includedSessionIds: [...new Set(sessionIds)].sort(),
    messageSessionMap,
    invocationSessionMap,
    permittedParentTrackIds,
    contentHash
  }
}
