import { describe, expect, it } from 'vitest'
import { filterTrackModelInputMessages } from './trackModelInputView'
import type { Message } from '../../src/shared/domainTypes'
import type { TrackModelInputViewRef } from '../../src/shared/remoteTrack'

const view: TrackModelInputViewRef = {
  trackId: 'track-a', sessionId: 'session-1', viewVersion: 'view-1', completeness: 'complete',
  includedEventIds: ['event-a1', 'event-a2'], includedMessageIds: ['user-a1', 'assistant-a1', 'user-a2'],
  includedInvocationIds: ['turn-a1', 'turn-a2'], includedSessionIds: ['session-1'],
  messageSessionMap: { 'user-a1': 'session-1', 'assistant-a1': 'session-1', 'user-a2': 'session-1' },
  invocationSessionMap: { 'turn-a1': 'session-1', 'turn-a2': 'session-1' }, permittedParentTrackIds: [], contentHash: '0'.repeat(64)
}

function message(id: string, role: Message['role'] = 'user'): Message {
  return { id, sessionId: 'session-1', role, content: id, status: 'completed', timestamp: 1 } as Message
}

describe('Track-scoped provider model input', () => {
  it('filters same-session messages to the frozen Track allowlist while preserving order', () => {
    expect(filterTrackModelInputMessages([
      message('user-a1'), message('user-b1'), message('assistant-a1', 'assistant'), message('user-a2'), message('assistant-b1', 'assistant')
    ], view, 'user-a2').map(({ id }) => id)).toEqual(['user-a1', 'assistant-a1', 'user-a2'])
  })

  it('fails closed when view is incomplete, session mismatches, or accepted user message is absent', () => {
    expect(() => filterTrackModelInputMessages([message('user-a1')], { ...view, completeness: 'partial' }, 'user-a1'))
      .toThrow('TRACK_MODEL_INPUT_VIEW_NOT_COMPLETE')
    expect(() => filterTrackModelInputMessages([message('user-a1', 'user')], {
      ...view, sessionId: 'other', includedSessionIds: ['other'],
      messageSessionMap: { 'user-a1': 'other', 'assistant-a1': 'other', 'user-a2': 'other' }
    }, 'user-a1'))
      .toThrow('TRACK_MODEL_INPUT_SESSION_MISMATCH')
    expect(() => filterTrackModelInputMessages([message('user-a1')], view, 'missing-user'))
      .toThrow('TRACK_MODEL_INPUT_ACCEPTED_MESSAGE_MISSING')
  })

  it('rejects missing allowlisted messages and duplicate IDs rather than silently using a partial snapshot', () => {
    expect(() => filterTrackModelInputMessages([message('user-a1')], view, 'user-a1'))
      .toThrow('TRACK_MODEL_INPUT_ALLOWLIST_INCOMPLETE')
    expect(() => filterTrackModelInputMessages([message('user-a1'), message('user-a1')], view, 'user-a1'))
      .toThrow('TRACK_MODEL_INPUT_DUPLICATE_MESSAGE_ID')
  })

  it('requires an accepted user message to be a user-role message within the view', () => {
    expect(() => filterTrackModelInputMessages([message('user-a1', 'assistant')], {
      ...view, includedMessageIds: ['user-a1'], messageSessionMap: { 'user-a1': 'session-1' }
    }, 'user-a1')).toThrow('TRACK_MODEL_INPUT_ACCEPTED_MESSAGE_INVALID')
  })

  it('fails closed if the per-message session mapping is missing or points outside the view', () => {
    expect(() => filterTrackModelInputMessages([message('user-a1')], {
      ...view, messageSessionMap: { 'user-a1': 'session-1' }
    }, 'user-a1')).toThrow('TRACK_MODEL_INPUT_MESSAGE_SESSION_MAP_INVALID')
    expect(() => filterTrackModelInputMessages([message('user-a1')], {
      ...view, messageSessionMap: { ...view.messageSessionMap, 'user-a1': 'foreign-session' }
    }, 'user-a1')).toThrow('TRACK_MODEL_INPUT_MESSAGE_SESSION_MISSING')
  })

  it('allows explicitly ledgered Track messages from prior sessions but not other session messages', () => {
    const crossSessionView: TrackModelInputViewRef = { ...view, includedMessageIds: ['origin-user', 'current-user'],
      includedSessionIds: ['session-origin', 'session-1'],
      messageSessionMap: { 'origin-user': 'session-origin', 'current-user': 'session-1' },
      invocationSessionMap: { 'turn-origin': 'session-origin', 'turn-a2': 'session-1' } }
    const messages = [
      { ...message('origin-user'), sessionId: 'session-origin' }, message('current-user'),
      { ...message('other-track-user'), sessionId: 'session-origin' }
    ]
    expect(filterTrackModelInputMessages(messages, crossSessionView, 'current-user').map(({ id }) => id))
      .toEqual(['origin-user', 'current-user'])
  })
})
