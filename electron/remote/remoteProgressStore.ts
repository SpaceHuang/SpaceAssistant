import type { RemoteProgressSnapshot } from '../../src/shared/remoteProgressTypes'
import { shouldUpdateLastPublishable } from '../../src/shared/resolveRemoteProgressSnapshot'

export type RemoteProgressSessionState = {
  current?: RemoteProgressSnapshot
  lastPublishable?: RemoteProgressSnapshot
  lastSentText?: string
  lastReplyAt?: number
}

const sessions = new Map<string, RemoteProgressSessionState>()

export function getRemoteProgressSession(sessionId: string): RemoteProgressSessionState | undefined {
  return sessions.get(sessionId)
}

export function ensureRemoteProgressSession(sessionId: string): RemoteProgressSessionState {
  let state = sessions.get(sessionId)
  if (!state) {
    state = {}
    sessions.set(sessionId, state)
  }
  return state
}

export function updateRemoteProgressSnapshot(sessionId: string, snapshot: RemoteProgressSnapshot): void {
  const state = ensureRemoteProgressSession(sessionId)
  state.current = snapshot
  if (shouldUpdateLastPublishable(snapshot)) {
    state.lastPublishable = snapshot
  }
}

export function getLastPublishableSnapshot(sessionId: string): RemoteProgressSnapshot | undefined {
  return sessions.get(sessionId)?.lastPublishable
}

export function getCurrentRemoteProgressSnapshot(sessionId: string): RemoteProgressSnapshot | undefined {
  return sessions.get(sessionId)?.current
}

export function markRemoteProgressReplySent(sessionId: string, text: string): void {
  const state = ensureRemoteProgressSession(sessionId)
  state.lastSentText = text
  state.lastReplyAt = Date.now()
}

export function getLastRemoteProgressReply(sessionId: string): { text?: string; at?: number } {
  const state = sessions.get(sessionId)
  return { text: state?.lastSentText, at: state?.lastReplyAt }
}

export function clearRemoteProgressSession(sessionId: string): void {
  sessions.delete(sessionId)
}

export function clearAllRemoteProgressSessions(): void {
  sessions.clear()
}
