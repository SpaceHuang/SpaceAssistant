import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { clearSessionProjectionCaches, compactSessionDatabase } from './sessionStorageMaintenance'

describe('session storage maintenance', () => {
  it('clears disposable projection data while preserving canonical repair obligations and turn protocol rows', () => {
    const temp = createTempDatabase('storage-maintenance-cache-')
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO sessions (id,name,model,temperature,max_tokens,created_at,updated_at,skills_state,metadata,schema_version,generation)
      VALUES('s','s','m',0.7,1,1,1,'{}','{}',1,'g')`).run()
    conn.exec(`INSERT INTO canonical_session_projection_cache(session_id,cache_key,cache_version,session_generation,session_seq,commit_order,watermark_event_id,watermark_invocation_id,event_count,value,updated_at)
      VALUES('s','transcript',1,'g',-1,-1,NULL,NULL,0,'[]',1);
      INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at) VALUES('s','g',1);
      INSERT INTO canonical_projection_repairs(repair_id,session_id,invocation_id,repair_kind,target_key,status,attempts,idempotency_key,updated_at)
      VALUES('r','s','i','invocation-projections','i','pending',0,'r',1);`)

    expect(clearSessionProjectionCaches(temp.db)).toEqual({ cacheRows: 1, eligibilityRows: 1 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_cache').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM canonical_session_projection_eligibility').get()).toEqual({ count: 0 })
    expect(conn.prepare('SELECT status FROM canonical_projection_repairs WHERE repair_id=?').get('r')).toEqual({ status: 'pending' })
    temp.cleanup()
  })

  it('archives DB and spill before vacuum, reclaims visible file space, and reports bounded progress', async () => {
    const temp = createTempDatabase('storage-maintenance-vacuum-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TABLE maintenance_payload(value TEXT NOT NULL);
      INSERT INTO maintenance_payload VALUES(zeroblob(3000000));
      DELETE FROM maintenance_payload;`)
    const spillDir = path.join(userDataDir, 'spill')
    await fs.mkdir(spillDir, { recursive: true })
    await fs.writeFile(path.join(spillDir, 'source.spill'), 'source truth remains archived')
    const degradedDir = path.join(userDataDir, 'spill-degraded')
    await fs.mkdir(degradedDir, { recursive: true })
    await fs.writeFile(path.join(degradedDir, 'copy.spill'), 'degradable copy')
    temp.db.flushSave()
    const beforeBytes = (await fs.stat(temp.dbPath)).size
    const progress: string[] = []

    const result = await compactSessionDatabase(temp.db, userDataDir, (step) => progress.push(step.phase))

    expect(result.archivePath).toContain(path.join(userDataDir, 'session-archives'))
    expect(result.bytesBefore).toBe(beforeBytes)
    expect(result.bytesAfter).toBeLessThan(beforeBytes)
    expect(conn.prepare('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 })
    await expect(fs.readFile(path.join(result.archivePath, 'spill', 'source.spill'), 'utf8')).resolves.toBe('source truth remains archived')
    await expect(fs.readFile(path.join(result.archivePath, 'spill-degraded', 'copy.spill'), 'utf8')).resolves.toBe('degradable copy')
    const archivedDb = new (await import('node:sqlite')).DatabaseSync(path.join(result.archivePath, path.basename(temp.dbPath)), { readOnly: true })
    expect(archivedDb.prepare('SELECT value FROM maintenance_payload').get()).toBeUndefined()
    archivedDb.close()
    expect(progress).toContain('archive')
    expect(progress).toContain('vacuum')
    expect(progress.at(-1)).toBe('complete')
    temp.cleanup()
  })

  it('refuses database compaction while any session execution holds the turn fence', async () => {
    const temp = createTempDatabase('storage-maintenance-busy-')
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES('s','t','owner',1,'executing',1,1)`).run()
    await expect(compactSessionDatabase(temp.db, path.dirname(temp.dbPath))).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_BUSY' })
    temp.cleanup()
  })
})
