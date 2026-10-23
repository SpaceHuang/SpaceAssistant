import type { SessionQueries } from './sessionStorage/public/ports'
import type { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
import { prepareChatBodyForRead } from './sessionStorage/public/readPreparation'

/** Flush pending debounce-window backups while the host-owned SessionQueries and database are still available. */
export async function flushPendingSessionBackups(
  manager: Pick<DebouncedSessionBackupManager, 'getPendingSessionIds' | 'flushAllWithRetry'>,
  storage: Readonly<{
    queries: Pick<SessionQueries, 'readSession' | 'readExportPage'>
    ensureChatBodyV1?: (input: { sessionId: string }) => Promise<unknown>
  }>
): Promise<void> {
  const sessionIds = manager.getPendingSessionIds()
  if (sessionIds.length === 0) return
  await manager.flushAllWithRetry(sessionIds, async (sessionId) => {
    await prepareChatBodyForRead(storage.ensureChatBodyV1, sessionId)
    const queries = storage.queries
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
