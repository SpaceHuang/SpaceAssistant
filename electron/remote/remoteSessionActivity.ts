import type { AppDatabase } from '../database'
import { getSession, updateSession } from '../database'

export function touchRemoteSessionActivity(
  db: AppDatabase,
  sessionId: string,
  at: number = Date.now()
): void {
  const session = getSession(db, sessionId)
  if (!session) return
  const prev =
    (session.metadata as { remoteSessionLastActivityAt?: number }).remoteSessionLastActivityAt ?? 0
  const next = Math.max(prev, at)
  if (next === prev) return
  updateSession(db, sessionId, {
    metadata: { ...session.metadata, remoteSessionLastActivityAt: next }
  })
}
