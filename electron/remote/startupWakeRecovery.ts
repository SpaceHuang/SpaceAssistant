import { listRecoverableWakeSessionIds } from '../database/wakeEvents'
import type { AppDatabase } from '../database/sqliteStore'
import type { WakeEventDispatcher } from './wakeEventDispatcher'

/** Replays durable wake work owned by one IM channel after its transport starts. */
export async function scheduleStartupWakeRecovery(
  db: AppDatabase,
  channel: 'feishu' | 'wechat',
  dispatcher: Pick<WakeEventDispatcher, 'dispatchSession'>,
  now: () => number = Date.now,
  onError: (sessionId: string, error: unknown) => void = (sessionId, error) => {
    console.error(`[${channel}] startup wake recovery failed for session ${sessionId}`, error)
  }
): Promise<string[]> {
  const sessionIds = listRecoverableWakeSessionIds(db, now(), channel)
  await Promise.all(sessionIds.map(async (sessionId) => {
    try {
      await dispatcher.dispatchSession(sessionId, { retryExhausted: true })
    } catch (error) {
      onError(sessionId, error)
    }
  }))
  return sessionIds
}
