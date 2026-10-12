import type { Message } from '../../src/shared/domainTypes'
import type { TrackModelInputViewRef } from '../../src/shared/remoteTrack'

/** Filter messages at the provider boundary; session membership alone never grants Track visibility. */
export function filterTrackModelInputMessages(
  sourceMessages: readonly Message[],
  view: TrackModelInputViewRef,
  acceptedUserMessageId: string
): Message[] {
  if (view.completeness !== 'complete') throw new Error('TRACK_MODEL_INPUT_VIEW_NOT_COMPLETE')
  if (!view.trackId.trim() || !view.sessionId.trim() || !view.viewVersion.trim()) throw new Error('TRACK_MODEL_INPUT_VIEW_IDENTITY_INVALID')
  if (!acceptedUserMessageId || !view.includedMessageIds.includes(acceptedUserMessageId)) {
    throw new Error('TRACK_MODEL_INPUT_ACCEPTED_MESSAGE_MISSING')
  }

  const allowed = new Set(view.includedMessageIds)
  if (allowed.size !== view.includedMessageIds.length) throw new Error('TRACK_MODEL_INPUT_DUPLICATE_MESSAGE_ID')
  const allowedSessions = new Set(view.includedSessionIds)
  if (!allowedSessions.has(view.sessionId) || allowedSessions.size !== view.includedSessionIds.length) throw new Error('TRACK_MODEL_INPUT_SESSION_ALLOWLIST_INVALID')
  if (Object.keys(view.messageSessionMap).length !== allowed.size) throw new Error('TRACK_MODEL_INPUT_MESSAGE_SESSION_MAP_INVALID')
  for (const messageId of view.includedMessageIds) {
    const sessionId = view.messageSessionMap[messageId]
    if (!sessionId || !allowedSessions.has(sessionId)) throw new Error('TRACK_MODEL_INPUT_MESSAGE_SESSION_MISSING')
  }
  const sourceById = new Map<string, Message>()
  for (const message of sourceMessages) {
    if (sourceById.has(message.id)) throw new Error('TRACK_MODEL_INPUT_DUPLICATE_MESSAGE_ID')
    sourceById.set(message.id, message)
  }

  const accepted = sourceById.get(acceptedUserMessageId)
  if (accepted && accepted.sessionId !== view.sessionId) throw new Error('TRACK_MODEL_INPUT_SESSION_MISMATCH')
  if (!accepted) throw new Error('TRACK_MODEL_INPUT_ACCEPTED_MESSAGE_MISSING')
  if (accepted.role !== 'user') throw new Error('TRACK_MODEL_INPUT_ACCEPTED_MESSAGE_INVALID')

  const selected: Message[] = []
  for (const messageId of view.includedMessageIds) {
    const message = sourceById.get(messageId)
    if (!message) throw new Error('TRACK_MODEL_INPUT_ALLOWLIST_INCOMPLETE')
    if (!allowedSessions.has(message.sessionId) || view.messageSessionMap[messageId] !== message.sessionId) throw new Error('TRACK_MODEL_INPUT_SESSION_MISMATCH')
    selected.push(structuredClone(message))
  }
  return selected
}
