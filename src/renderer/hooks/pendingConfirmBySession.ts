import type { Session } from '../../shared/domainTypes'
import type { PendingConfirmItem } from '../services/pendingConfirmStore'

export type PendingConfirmSessionState = { count: number; firstToolUseId: string; firstCreatedAt: number }

export function pendingConfirmBySession(
  items: PendingConfirmItem[],
  sessions: Pick<Session, 'id'>[],
  runningSessions: Record<string, { requestId: string }>
): Map<string, PendingConfirmSessionState> {
  const sessionIds = new Set(sessions.map((session) => session.id))
  const result = new Map<string, PendingConfirmSessionState>()
  for (const item of items) {
    if (!sessionIds.has(item.sessionId) || runningSessions[item.sessionId]?.requestId !== item.requestId) continue
    const current = result.get(item.sessionId)
    if (!current) result.set(item.sessionId, { count: 1, firstToolUseId: item.toolUseId, firstCreatedAt: item.createdAt })
    else {
      current.count += 1
      if (item.createdAt < current.firstCreatedAt) {
        current.firstCreatedAt = item.createdAt
        current.firstToolUseId = item.toolUseId
      }
    }
  }
  return result
}
