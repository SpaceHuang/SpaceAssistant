import type { SessionQueries } from './sessionStorage/contracts'
import type { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'

/** Flush pending debounce-window backups while the host-owned SessionQueries and database are still available. */
export async function flushPendingSessionBackups(
  manager: Pick<DebouncedSessionBackupManager, 'getPendingSessionIds' | 'flushAllWithRetry'>,
  queries: Pick<SessionQueries, 'readSession' | 'readExportPage'>
): Promise<void> {
  const sessionIds = manager.getPendingSessionIds()
  if (sessionIds.length === 0) return
  await manager.flushAllWithRetry(sessionIds, async (sessionId) => {
    const session = queries.readSession(sessionId)
    if (!session) return null
    return {
      session,
      readPage: (fromSequence: number, pageSize: number) => {
        const page = queries.readExportPage({ sessionId, fromSequence, pageSize })
        return { messages: page.rows.map(({ message }) => message), nextSequence: page.nextSequence }
      }
    }
  })
}
