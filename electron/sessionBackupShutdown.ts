import type { SessionQueries } from './sessionStorage/public/ports'
import type { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
import { readExportPageAfterPreparation } from './sessionStorage/public/readMessages'

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
    const queries = storage.queries
    const session = queries.readSession(sessionId)
    if (!session) return null
    return {
      session,
      readPage: async (fromSequence: number, pageSize: number) => {
        const page = await readExportPageAfterPreparation(storage, { sessionId, fromSequence, pageSize })
        return { messages: page.rows.map(({ message }) => message), nextSequence: page.nextSequence }
      }
    }
  })
}
