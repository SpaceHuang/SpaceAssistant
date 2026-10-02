import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { isSafeDbMaintenanceRequested, runSafeDbMaintenance, SAFE_DB_MAINTENANCE_FLAG } from './safeDbMaintenance'

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
      VALUES('s','transcript',1,'g',-1,-1,NULL,NULL,0,'[]',1);
      INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES('s','g',1);`)
    temp.db.save()
    const before = conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()

    await runSafeDbMaintenance(temp.db, require('node:path').dirname(temp.dbPath))

    expect(before).toEqual({ count: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_eligibility').get()).toEqual({ count: 0 })
    const archives = require('node:fs').readdirSync(require('node:path').join(require('node:path').dirname(temp.dbPath), 'session-archives'))
    expect(archives).toHaveLength(1)
    const archiveDb = new (require('node:sqlite').DatabaseSync)(require('node:path').join(require('node:path').dirname(temp.dbPath), 'session-archives', archives[0], require('node:path').basename(temp.dbPath)), { readOnly: true })
    expect(archiveDb.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()).toEqual({ count: 1 })
    archiveDb.close()
    temp.cleanup()
  })
})
