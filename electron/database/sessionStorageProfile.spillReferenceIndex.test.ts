import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTempDatabase } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { appendSqliteAgentHistoryBatchInTransaction } from './agentHistoryStorage'
import { runSpillReferenceReconciliationBatch } from '../storage/spillReferenceReconciliation'
import { collectSessionStorageProfile } from './sessionStorageProfile'

const descriptor = (locator: string) => ({ version: 1, kind: 'source-of-truth', locator, byteLength: 4, sha256: 'd'.repeat(64), createdAt: 1, head: '', tail: '' })

describe('session storage profile spill index adapter', () => {
  const cleanups: Array<() => void> = []
  afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

  it('reads trusted state and index in one SQLite snapshot and preserves the public spill statistics', async () => {
    const temp = createTempDatabase('profile-spill-index-')
    cleanups.push(temp.cleanup)
    const locator = '00000000-0000-4000-8000-000000000021.spill'
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, locator), 'body')
    const conn = getDbConnection(temp.db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'profile-index', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'profile-index-event', idempotencyKey: 'profile-index-event', kind: 'invocation-context-committed',
      payload: { body: { __spaceassistant_spill_v1: descriptor(locator) } }
    }], 0)
    let reconciliation = await runSpillReferenceReconciliationBatch(conn)
    for (let attempt = 0; reconciliation.status === 'running' && attempt < 10; attempt += 1) {
      reconciliation = await runSpillReferenceReconciliationBatch(conn)
    }
    expect(reconciliation.status).toBe('complete')
    temp.db.close()

    const trusted = collectSessionStorageProfile(temp.dbPath) as Record<string, any>
    const invalidate = new (await import('node:sqlite')).DatabaseSync(temp.dbPath)
    invalidate.prepare("UPDATE spill_reference_backfill_state SET status='untrusted' WHERE owner_table='agent_history_events'").run()
    invalidate.close()
    const fallback = collectSessionStorageProfile(temp.dbPath) as Record<string, any>

    expect(trusted.spillFiles).toMatchObject({ files: 1, sourceOfTruthBytes: 4, degradableBytes: 0, orphanBytes: 0, complete: true })
    expect(fallback.spillFiles).toEqual(trusted.spillFiles)
    expect(Object.keys(trusted.spillFiles)).toEqual(Object.keys(fallback.spillFiles))
  })
})
