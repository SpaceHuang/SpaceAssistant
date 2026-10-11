import type { RemoteTrackContext, RemoteTrackEventRef, RemoteTrackState, TrackModelInputViewRef } from '../src/shared/remoteTrack'

const context: RemoteTrackContext = {
  trackId: 'track', channel: 'wechat', identityKey: 'identity', ownerId: 'owner', authorizationEpoch: 1,
  rootMessageId: 'message', attributionEventId: 'event'
}
const event: RemoteTrackEventRef = { trackId: context.trackId, eventId: 'event', requestId: 'request', turnId: 'turn' }
const state: RemoteTrackState = 'waiting-user'
const view: TrackModelInputViewRef = {
  trackId: context.trackId, sessionId: 'session', viewVersion: 'v1', completeness: 'complete',
  includedEventIds: ['event'], includedMessageIds: ['message'], includedInvocationIds: ['invocation'],
  includedSessionIds: ['session'], messageSessionMap: { message: 'session' }, invocationSessionMap: { invocation: 'session' },
  permittedParentTrackIds: [], contentHash: 'sha256'
}

void [context, event, state, view]
