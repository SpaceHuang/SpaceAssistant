import type { AppDatabase } from '../../../database/sqliteStore'
import { getDbConnection } from '../../../database/sqliteStore'
import { SqliteAgentHistory } from '../../../runtime/sqliteAgentHistory'
import { readChatMessagesAfterPreparation } from '../../public/readMessages'
import path from 'node:path'
import { readSessionEvents } from '../../../sessionEvents'
import type { SessionStorage } from '../../host/ports'

/** Preload canonical dependencies and ledger-only compaction facts before retention deletes a directory. */
export function createSessionLedgerCompactionDependencyGuard(db: AppDatabase): (sessionName: string, workDir: string) => Promise<boolean> {
  const history = new SqliteAgentHistory(getDbConnection(db))
  return async (sessionName, workDir) => {
    const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1]
    if (sessionId && getDbConnection(db).prepare('SELECT 1 FROM sessions WHERE id=?').get(sessionId)) return true
    if (sessionId && history.hasCanonicalCompactionDependency(sessionId)) return true
    const events = await readSessionEvents(path.join(workDir, 'sessions', sessionName, 'events.jsonl'))
    return events.some(({ type }) => type === 'compaction_start' || type === 'compaction_summary' || type === 'compaction_end')
  }
}

/** Prepare and inspect canonical session facts for the legacy event-ledger retention owner. */
export function createCanonicalSessionProjectionRetentionPreparer(
  db: AppDatabase,
  storage: Parameters<typeof readChatMessagesAfterPreparation>[0]
): (sessionName: string, workDir: string) => Promise<void> {
  if (!storage) throw new Error('SESSION_RETENTION_PREPARED_READER_REQUIRED')
  const history = new SqliteAgentHistory(getDbConnection(db))
  return async (sessionName) => {
    const sessionId = /^(.*)-\d{8}$/.exec(sessionName)?.[1]
    if (!sessionId) return
    const messages = await readChatMessagesAfterPreparation(storage, { sessionId, limit: Number.MAX_SAFE_INTEGER, offset: 0 })
    if (messages.length === 0 || messages.some(({ role }) => role !== 'user' && role !== 'assistant')) return
    const legacyMessages = messages.map(({ id, role, content, timestamp, thinking, contentSegments, toolCalls, toolUse, attachments,
      imagesDeliveredToApi, skillHints }) => ({
      id, role: role as 'user' | 'assistant', content, timestamp,
      ...(thinking !== undefined ? { thinking } : {}),
      ...(contentSegments !== undefined ? { contentSegments } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(toolUse !== undefined ? { toolUse } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(imagesDeliveredToApi !== undefined ? { imagesDeliveredToApi } : {}),
      ...(skillHints !== undefined ? { skillHints } : {})
    }))
    const folded = history.readCanonicalSessionTranscript(sessionId, legacyMessages)
    if (folded.kind !== 'matched') return
  }
}
