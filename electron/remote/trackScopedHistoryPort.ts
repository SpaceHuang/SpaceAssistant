import type { HistorySnapshot } from '../../packages/agent-sdk/src/history'
import type { SessionHistoryPort } from '../sessionStorage/contracts'

/** Adds Track invocation ownership on top of the existing session-scoped History capability. */
export function createTrackScopedHistoryPort(
  history: SessionHistoryPort,
  scope: Readonly<{ sessionId: string; allowedInvocationIds: readonly string[] }>
): SessionHistoryPort {
  const allowed = new Set(scope.allowedInvocationIds)
  if (!scope.sessionId.trim() || allowed.size === 0 || allowed.size !== scope.allowedInvocationIds.length || [...allowed].some((id) => !id.trim())) {
    throw new Error('TRACK_HISTORY_SCOPE_INVALID')
  }
  const requireInvocation = (invocationId: string) => {
    if (!allowed.has(invocationId)) throw new Error('TRACK_HISTORY_INVOCATION_OUT_OF_SCOPE')
  }
  return {
    read: async (invocationId) => {
      requireInvocation(invocationId)
      const snapshot = await history.read(invocationId)
      if (snapshot.invocationId !== invocationId) throw new Error('TRACK_HISTORY_INVOCATION_MISMATCH')
      return snapshot
    },
    appendBatch: async (events, expectedVersion, transcriptCommit) => {
      if (transcriptCommit && transcriptCommit.sessionId !== scope.sessionId) throw new Error('TRACK_HISTORY_SESSION_MISMATCH')
      if (!events.length) throw new Error('TRACK_HISTORY_EMPTY_APPEND')
      for (const event of events) requireInvocation(event.invocationId)
      return history.appendBatch(events, expectedVersion, transcriptCommit)
    },
    readLatestInvocationForSession: async (sessionId, options) => {
      if (sessionId !== scope.sessionId) throw new Error('TRACK_HISTORY_SESSION_MISMATCH')
      const latest = await history.readLatestInvocationForSession(sessionId, options)
      if (latest.kind === 'none') return latest
      if (latest.kind === 'unavailable') return allowed.has(latest.invocationId) ? latest : { kind: 'none' }
      const snapshot: HistorySnapshot = latest.snapshot
      if (!allowed.has(snapshot.invocationId)) return { kind: 'none' }
      return { ...latest, snapshot }
    }
  }
}

/** Track view across sessions; each invocation is routed to the exact session recorded in the immutable view. */
export function createCrossSessionTrackScopedHistoryPort(
  historyForSession: (sessionId: string) => SessionHistoryPort,
  scope: Readonly<{ currentSessionId: string; allowedInvocationIds: readonly string[]; invocationSessionMap: Readonly<Record<string, string>> }>
): SessionHistoryPort {
  const allowed = new Set(scope.allowedInvocationIds)
  if (!scope.currentSessionId.trim() || allowed.size === 0 || allowed.size !== scope.allowedInvocationIds.length ||
    [...allowed].some((id) => !id.trim() || !scope.invocationSessionMap[id]?.trim())) throw new Error('TRACK_HISTORY_SCOPE_INVALID')
  const portForInvocation = (invocationId: string) => {
    if (!allowed.has(invocationId)) throw new Error('TRACK_HISTORY_INVOCATION_OUT_OF_SCOPE')
    return historyForSession(scope.invocationSessionMap[invocationId])
  }
  return {
    read: async (invocationId) => {
      const snapshot = await portForInvocation(invocationId).read(invocationId)
      if (snapshot.invocationId !== invocationId) throw new Error('TRACK_HISTORY_INVOCATION_MISMATCH')
      return snapshot
    },
    appendBatch: async (events, expectedVersion, transcriptCommit) => {
      if (!events.length) throw new Error('TRACK_HISTORY_EMPTY_APPEND')
      const sessionIds = new Set(events.map(({ invocationId }) => {
        if (!allowed.has(invocationId)) throw new Error('TRACK_HISTORY_INVOCATION_OUT_OF_SCOPE')
        return scope.invocationSessionMap[invocationId]
      }))
      if (sessionIds.size !== 1) throw new Error('TRACK_HISTORY_APPEND_CROSSES_SESSIONS')
      const sessionId = [...sessionIds][0]
      if (transcriptCommit && transcriptCommit.sessionId !== sessionId) throw new Error('TRACK_HISTORY_SESSION_MISMATCH')
      return historyForSession(sessionId).appendBatch(events, expectedVersion, transcriptCommit)
    },
    readLatestInvocationForSession: async (sessionId, options) => {
      if (sessionId !== scope.currentSessionId) throw new Error('TRACK_HISTORY_SESSION_MISMATCH')
      const latest = await historyForSession(sessionId).readLatestInvocationForSession(sessionId, options)
      if (latest.kind === 'none') return latest
      if (latest.kind === 'unavailable') return allowed.has(latest.invocationId) ? latest : { kind: 'none' }
      if (!allowed.has(latest.snapshot.invocationId)) return { kind: 'none' }
      return latest
    }
  }
}
