import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from './testHelpers'
import { getDbConnection } from './sqliteStore'
import { appendSqliteAgentHistoryBatchInTransaction } from './agentHistoryStorage'
import { runSpillReferenceReconciliationBatch } from '../storage/spillReferenceReconciliation'
import { collectSessionStorageAudit, collectSessionStorageProfile } from './sessionStorageProfile'
import * as spillStore from '../storage/spillStore'

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
    expect(fallback.spillFiles).toMatchObject({ files: trusted.spillFiles.files, observedBytes: trusted.spillFiles.observedBytes,
      sourceOfTruthBytes: trusted.spillFiles.sourceOfTruthBytes, degradableBytes: trusted.spillFiles.degradableBytes,
      orphanBytes: trusted.spillFiles.orphanBytes, complete: trusted.spillFiles.complete, errorCodes: trusted.spillFiles.errorCodes })
    expect(Object.keys(trusted.spillFiles)).toEqual(Object.keys(fallback.spillFiles))
  })

  it('uses the strict JSON fallback when the trusted index is unavailable, while overview never does', async () => {
    const temp = createTempDatabase('profile-spill-fallback-')
    cleanups.push(temp.cleanup)
    const locator = '00000000-0000-4000-8000-000000000022.spill'
    const spillRoot = path.join(path.dirname(temp.dbPath), 'spill')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, locator), 'body')
    const conn = getDbConnection(temp.db)
    appendSqliteAgentHistoryBatchInTransaction(conn, [{
      invocationId: 'profile-fallback', turnId: 'turn', sequence: 1, schemaVersion: 1,
      eventId: 'profile-fallback-event', idempotencyKey: 'profile-fallback-event', kind: 'model-response-committed',
      payload: { message: { content: { __spaceassistant_spill_v1: descriptor(locator) }, privateText: 'never return body' } }
    }], 0)
    let reconciliation = await runSpillReferenceReconciliationBatch(conn)
    for (let attempt = 0; reconciliation.status === 'running' && attempt < 10; attempt += 1) reconciliation = await runSpillReferenceReconciliationBatch(conn)
    temp.db.close()
    const update = new (await import('node:sqlite')).DatabaseSync(temp.dbPath)
    update.prepare("UPDATE spill_reference_backfill_state SET status='untrusted' WHERE owner_table='agent_history_events'").run()
    update.close()
    const strictScan = vi.spyOn(spillStore, 'readCanonicalSpillReferences')

    const profile = collectSessionStorageProfile(temp.dbPath) as Record<string, any>
    const audit = collectSessionStorageAudit(temp.dbPath)
    expect(strictScan.mock.calls.length).toBe(2)
    expect(profile.spillFiles).toMatchObject({ files: 1, sourceOfTruthBytes: 4, complete: true })
    expect(JSON.stringify(profile)).not.toContain('never return body')
    expect(audit.strictSpillReferences).toMatchObject({ complete: true, descriptors: 1, uniqueLocators: 1 })

    strictScan.mockClear()
    const { collectSessionStorageOverview } = await import('./sessionStorageProfile')
    const overview = collectSessionStorageOverview(temp.dbPath)
    expect(strictScan.mock.calls.length).toBe(0)
    expect(overview.spill.classification).toBe('unknown')
  })

  it('keeps strict fallback incomplete on malformed payload JSON and tolerates missing owner tables', () => {
    const temp = createTempDatabase('profile-spill-malformed-')
    cleanups.push(temp.cleanup)
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at)
      VALUES('malformed',1,'malformed-event','malformed-event','turn',1,'model-response-committed',?,1)`).run('{bad json')
    temp.db.close()

    const profile = collectSessionStorageProfile(temp.dbPath) as Record<string, any>

    expect(profile.spillFiles).toMatchObject({ complete: false, sourceOfTruthBytes: null, degradableBytes: null, orphanBytes: null,
      errorCodes: expect.arrayContaining(['CANONICAL_SPILL_REFERENCE_SCAN_FAILED']) })
    expect(profile.messageBodyCoverage.malformedPayloads).toBe(1)
  })
})
