import fs from 'fs'
import os from 'os'
import path from 'path'
import { setConfigValue } from './operations'
import { openDatabase, type AppDatabase } from './index'
import { openSqliteDatabase } from './sqliteStore'
import { getDbConnection } from './sqliteStore'
import { encodeProjectionScopeKey, type ProjectionScopeKeyKind } from '../sessionStorage/domain/scopeKey'

export function createMemoryAppDb(locale: 'zh-CN' | 'en-US' = 'zh-CN'): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  setConfigValue(db, 'config.locale', locale)
  return db
}

/** Seed a valid scope proof for mutation/invalidation boundary tests. */
export function seedValidProjectionScope(db: AppDatabase, sessionId: string,
  scope: ProjectionScopeKeyKind = 'transcriptParityV1'): string {
  const conn = getDbConnection(db)
  const session = conn.prepare(`SELECT sessions.generation,cutover.message_revision
    FROM sessions LEFT JOIN session_message_content_cutover cutover ON cutover.session_id=sessions.id WHERE sessions.id=?`)
    .get(sessionId) as { generation: string; message_revision: number | null } | undefined
  if (!session) throw new Error(`projection test session not found: ${sessionId}`)
  const scopeKey = encodeProjectionScopeKey({ scope, specVersion: 1 })
  conn.prepare(`INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,history_watermark_json,
    message_revision,payload_generation,payload_digest,validated_range_json,updated_at)
    VALUES(?,?,?,'valid','{}',?,'test-generation','test-digest','{}',1)
    ON CONFLICT(session_id,scope_key) DO UPDATE SET session_generation=excluded.session_generation,status='valid',
      history_watermark_json=excluded.history_watermark_json,message_revision=excluded.message_revision,
      payload_generation=excluded.payload_generation,payload_digest=excluded.payload_digest,
      validated_range_json=excluded.validated_range_json,updated_at=excluded.updated_at`)
    .run(sessionId, scopeKey, session.generation, session.message_revision ?? 0)
  return scopeKey
}

export function createTempDatabase(prefix: string): { db: AppDatabase; dbPath: string; cleanup: (db?: AppDatabase) => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dbPath = path.join(dir, 'test.db')
  const db = openDatabase(dbPath)
  return {
    db,
    dbPath,
    cleanup: (database = db) => {
      try {
        database.close()
      } catch {
        /* ignore */
      }
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${dbPath}${suffix}`)
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export function openMemoryDatabase(): AppDatabase {
  return openDatabase(':memory:')
}
