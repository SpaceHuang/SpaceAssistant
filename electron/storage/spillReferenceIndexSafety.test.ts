import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { runSourceTruthSpillGcMaintenance } from './spillStore'

describe('spill reference index safety boundary', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

  it('never lets a trusted but incomplete index authorize unlink when strict scan sees a shared canonical owner', async () => {
    const temp = createTempDatabase('spill-index-safety-')
    cleanups.push(temp.cleanup)
    const conn = getDbConnection(temp.db)
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    await fs.mkdir(spillRoot, { recursive: true })
    const locator = '00000000-0000-4000-8000-000000000031.spill'
    const filePath = path.join(spillRoot, locator)
    await fs.writeFile(filePath, 'safe')
    const descriptor = { version: 1, kind: 'source-of-truth', locator, byteLength: 4, sha256: 'e'.repeat(64), createdAt: 1, head: '', tail: '' }
    conn.prepare(`INSERT INTO agent_history_streams(invocation_id,version,schema_version,session_id) VALUES('owner',1,1,'survivor')`).run()
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at,session_id)
      VALUES('owner',1,'owner-event','owner-key','turn',1,'invocation-context-committed',?,1,'survivor')`)
      .run(JSON.stringify({ file: { __spaceassistant_spill_v1: descriptor } }))
    conn.prepare(`DELETE FROM spill_reference_index`).run()
    conn.prepare(`INSERT INTO spill_reference_backfill_state(owner_table,status,source_table,updated_at,protocol_version,verified_generation,verified_at)
      VALUES('agent_history_events','complete','agent_history_events',1,1,?,1)
      ON CONFLICT(owner_table) DO UPDATE SET status='complete',verified_generation=excluded.verified_generation`)
      .run(conn.prepare("SELECT meta_value FROM spill_reference_meta WHERE meta_key='canonical_change_generation'").get()!.meta_value)
    conn.prepare(`INSERT INTO source_truth_spill_gc_queue(locator,session_id,generation,status,attempts,created_at,updated_at)
      VALUES(?,'deleted-session','old','pending',0,1,1)`).run(locator)

    await expect(runSourceTruthSpillGcMaintenance(temp.db, spillRoot)).resolves.toMatchObject({ shared: 1, completed: 0 })
    await expect(fs.access(filePath)).resolves.toBeUndefined()
  })
})
