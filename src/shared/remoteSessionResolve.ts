import type { Session } from './domainTypes'

export const DEFAULT_REMOTE_SESSION_IDLE_MINUTES = 10

export type RemoteSessionIdleConfig = {
  remoteSessionIdleMinutes?: number
  remoteSessionMergeMinutes?: number
}

export function readRemoteSessionIdleMinutes(config: RemoteSessionIdleConfig): number {
  return (
    config.remoteSessionIdleMinutes ??
    config.remoteSessionMergeMinutes ??
    DEFAULT_REMOTE_SESSION_IDLE_MINUTES
  )
}

export function resolveActivityAt(session: Session): number {
  return (
    (session.metadata as { remoteSessionLastActivityAt?: number }).remoteSessionLastActivityAt ??
    session.updatedAt
  )
}

export function pickRemoteSessionCandidate(
  sessions: Session[],
  source: 'feishu' | 'wechat',
  identityKey: string,
  getIdentity: (s: Session) => string | undefined
): Session | undefined {
  const candidates = sessions
    .filter((s) => {
      const m = s.metadata as Record<string, unknown>
      return m?.source === source && getIdentity(s) === identityKey
    })
    .sort((a, b) => {
      const da = resolveActivityAt(a)
      const db = resolveActivityAt(b)
      if (db !== da) return db - da
      return b.createdAt - a.createdAt
    })
  return candidates[0]
}
