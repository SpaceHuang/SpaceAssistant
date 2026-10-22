import type { AppDatabase } from '../../../database/sqliteStore'
import type { DatabaseSync } from 'node:sqlite'
import { getDbConnection } from '../../../database/sqliteStore'
import { encodeProjectionScopeKey } from '../../domain/scopeKey'
import { createSqliteProjectionStateStore } from './sessionProjectionStateStore'

/** Current transcript parity rejection fence for append-side fast-cache advancement. */
export function hasRejectedTranscriptParityState(db: AppDatabase, sessionId: string): boolean {
  return hasRejectedTranscriptParityStateInConnection(getDbConnection(db), sessionId)
}

/** Connection-level adapter for an existing SQLite History owner. */
export function hasRejectedTranscriptParityStateInConnection(conn: DatabaseSync, sessionId: string): boolean {
  const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
  return conn.prepare(`SELECT 1 FROM session_projection_state WHERE session_id=? AND scope_key=? AND status='rejected'`)
    .get(sessionId, scopeKey) !== undefined
}
