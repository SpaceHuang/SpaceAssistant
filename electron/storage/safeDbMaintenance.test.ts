import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { isSafeDbMaintenanceRequested, runSafeDbMaintenance, SAFE_DB_MAINTENANCE_FLAG } from './safeDbMaintenance'
import { encodeProjectionScopeKey } from '../sessionStorage/domain/scopeKey'

describe('safe database maintenance startup mode', () => {
  it('recognizes only the explicit command-line flag', () => {
    expect(isSafeDbMaintenanceRequested(['app', SAFE_DB_MAINTENANCE_FLAG])).toBe(true)
    expect(isSafeDbMaintenanceRequested(['app', '--safe-db-maintenance=false'])).toBe(false)
    expect(isSafeDbMaintenanceRequested(['app'])).toBe(false)
  })

  it('archives rebuildable projection rows, then clears them before database compaction', async () => {
    const temp = createTempDatabase('safe-db-maintenance-')
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('s','s','m',0.7,1,1,1,'{}','{}',1,'g')`).run()
    conn.exec(`INSERT INTO canonical_session_projection_cache(session_id,cache_key,cache_version,session_generation,session_seq,commit_order,watermark_event_id,watermark_invocation_id,event_count,value,updated_at)
      VALUES('s','transcript',1,'g',-1,-1,NULL,NULL,0,'[]',1);`)
    const scopeKey = encodeProjectionScopeKey({ scope: 'transcriptParityV1', specVersion: 1 })
    conn.prepare(`INSERT INTO session_projection_state(session_id,scope_key,session_generation,status,history_watermark_json,
      message_revision,payload_generation,payload_digest,validated_range_json,updated_at)
      VALUES('s',?,'g','valid','{}',0,'payload','digest','{}',1)`).run(scopeKey)
    temp.db.save()
    const before = conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()

    await runSafeDbMaintenance(temp.db, require('node:path').dirname(temp.dbPath))

    expect(before).toEqual({ count: 1 })
    // 压缩换入临界区重建了底层连接，须重取后再断言。
    const reopenedConn = getDbConnection(temp.db)
    expect(reopenedConn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()).toEqual({ count: 0 })
    expect(reopenedConn.prepare('SELECT status FROM session_projection_state WHERE session_id=? AND scope_key=?').get('s', scopeKey))
      .toEqual({ status: 'invalid' })
    const archives = require('node:fs').readdirSync(require('node:path').join(require('node:path').dirname(temp.dbPath), 'session-archives'))
    expect(archives).toHaveLength(1)
    const archiveDb = new (require('node:sqlite').DatabaseSync)(require('node:path').join(require('node:path').dirname(temp.dbPath), 'session-archives', archives[0], require('node:path').basename(temp.dbPath)), { readOnly: true })
    expect(archiveDb.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()).toEqual({ count: 1 })
    archiveDb.close()
    temp.cleanup()
  })
})
