import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openDatabase } from './index'
import { getDbConnection } from './sqliteStore'
import { createSession, setConfigValue } from './operations'
import { collectSessionStorageCleanupEstimate } from './sessionStorageCleanupEstimate'
import { appendSqliteAgentHistoryBatchInTransaction } from './agentHistoryStorage'
import type { HistoryEvent } from '../../packages/agent-sdk/src/history'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

describe('collectSessionStorageCleanupEstimate', () => {
  it('weighs retention candidates, protected data and spill policy without deleting anything', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-estimate-'))
    roots.push(root)
    const dbPath = path.join(root, 'user-data', 'spaceassistant-data.db')
    const workDir = path.join(root, 'workspace')
    fs.mkdirSync(path.join(workDir, 'sessions'), { recursive: true })
    const db = openDatabase(dbPath)
    setConfigValue(db, 'config.workDir', workDir)
    setConfigValue(db, 'retention.sessionEvent.maxSessions', '2')
    setConfigValue(db, 'retention.spill.degradableDays', '30')
    const sessions = Array.from({ length: 3 }, (_, index) => createSession(db, { name: `synthetic ${index}` }))
    db.flushSave()

    for (let index = 0; index < 3; index += 1) {
      const dir = path.join(workDir, 'sessions', `session-${index}`)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'events.index.json'), JSON.stringify({ lastAt: index + 1 }))
      fs.writeFileSync(path.join(dir, 'events.jsonl'), 'e'.repeat((index + 1) * 10))
    }
    const unindexedDir = path.join(workDir, 'sessions', 'backup-without-index')
    fs.mkdirSync(unindexedDir)
    fs.writeFileSync(path.join(unindexedDir, 'backup.jsonl'), 'u'.repeat(13))

    const spillRoot = path.join(root, 'user-data', 'spill')
    fs.mkdirSync(spillRoot)
    const expired = { version: 1, kind: 'degradable', locator: '00000000-0000-4000-8000-000000000001.spill', byteLength: 4, sha256: 'a'.repeat(64), createdAt: 1, head: '', tail: '' }
    const source = { version: 1, kind: 'source-of-truth', locator: '00000000-0000-4000-8000-000000000002.spill', byteLength: 6, sha256: 'b'.repeat(64), createdAt: 1, head: '', tail: '' }
    fs.writeFileSync(path.join(spillRoot, expired.locator), 'old!')
    fs.writeFileSync(path.join(spillRoot, source.locator), 'source')
    const conn = getDbConnection(db)
    conn.prepare(`INSERT INTO session_transcript_entries(session_id,turn_id,base_version,version,outcome,messages_json,created_at)
      VALUES(?,?,0,1,'completed',?,1)`).run(sessions[0]!.id, 'fixture-turn', JSON.stringify({ expired, source }))
    const before = fs.statSync(dbPath).size
    db.close()

    const estimate = collectSessionStorageCleanupEstimate(dbPath, 10_000 * 24 * 60 * 60 * 1000) as any

    expect(estimate.candidates.sessionEventDirectories).toMatchObject({ indexedDirectories: 3, retainedByCount: 2,
      beyondCountCandidateDirectories: 1, beyondCountCandidateBytes: 22, unindexedDirectories: 1,
      unindexedDirectoryBytes: 13, deletionAuthorized: false, requiresProjectionDependencyCheck: true })
    expect(estimate.candidates.degradableSpill).toMatchObject({ referencedBytes: 4, expiredByConfiguredPolicyBytes: 4,
      retentionDays: 30, deletionAuthorized: false })
    expect(estimate.mustRetain.sourceOfTruthSpillBytes).toBe(6)
    expect(estimate.candidates.transcriptSnapshots).toMatchObject({ rows: 1, deletionAuthorized: false })
    expect(estimate.physicalSpaceEstimate.maximumPotentialLogicalPayloadBytes).toBe(0)
    expect(estimate.physicalSpaceEstimate.dbFileBytesAfterHypotheticalMessageCleanup.lowerBoundBytes)
      .toBeLessThanOrEqual(estimate.physicalSpaceEstimate.dbFileBytesAfterHypotheticalMessageCleanup.upperBoundBytes)
    expect(estimate.physicalSpaceEstimate.estimatedDatabaseShrinkBytes.lowerBound).toBe(0)
    expect(estimate.physicalSpaceEstimate.estimatedDatabaseShrinkBytes.upperBound)
      .toBeLessThanOrEqual(estimate.measured.currentDatabaseObjects.find((item: { name: string }) => item.name === 'messages')?.bytes ?? 0)
    expect(fs.statSync(dbPath).size).toBe(before)
    expect(fs.readFileSync(path.join(workDir, 'sessions', 'session-0', 'events.jsonl'), 'utf8')).toBe('e'.repeat(10))
  })

  it('bounds theoretical SQLite reclamation by message-table pages, not only raw body bytes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-estimate-pages-'))
    roots.push(root)
    const dbPath = path.join(root, 'user-data', 'spaceassistant-data.db')
    const db = openDatabase(dbPath)
    const session = createSession(db, { name: 'synthetic page bound' })
    const body = 'large-identity-body-'.repeat(700)
    const conn = getDbConnection(db)
    const event: HistoryEvent = {
      invocationId: 'estimate-page-bound-invocation', turnId: 'estimate-page-bound-turn', sequence: 1, schemaVersion: 1,
      eventId: 'estimate-page-bound-event', idempotencyKey: 'estimate-page-bound-event', kind: 'invocation-context-committed',
      payload: { messages: [{ id: 'estimate-page-bound-message', role: 'assistant', content: body, timestamp: 1 }] }
    }
    appendSqliteAgentHistoryBatchInTransaction(conn, [event], 0, { sessionId: session.id })
    conn.prepare(`INSERT INTO messages(id,session_id,role,content,status,schema_version,timestamp,sequence)
      VALUES(?,?,? ,?,'completed',1,1,1)`).run('estimate-page-bound-message', session.id, 'assistant', body)
    db.flushSave()
    db.close()

    const estimate = collectSessionStorageCleanupEstimate(dbPath) as any
    const messageTableBytes = estimate.measured.currentDatabaseObjects.find((item: { name: string }) => item.name === 'messages').bytes
    expect(estimate.candidates.duplicateMessageBodies).toMatchObject({ exactIdentityRows: 1, rawContentBytes: Buffer.byteLength(body) })
    expect(estimate.physicalSpaceEstimate.estimatedDatabaseShrinkBytes.upperBound).toBe(messageTableBytes)
    expect(estimate.physicalSpaceEstimate.estimatedDatabaseShrinkBytes.upperBound).toBeGreaterThan(Buffer.byteLength(body))
  })

  it('does not report spill size estimates as complete when canonical reference scanning fails', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-storage-estimate-spill-error-'))
    roots.push(root)
    const dbPath = path.join(root, 'user-data', 'spaceassistant-data.db')
    const db = openDatabase(dbPath)
    const conn = getDbConnection(db)
    conn.prepare('INSERT INTO agent_history_events(invocation_id,sequence,event_id,idempotency_key,turn_id,schema_version,kind,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('bad-spill-scan', 1, 'bad-spill-scan-event', 'bad-spill-scan-event', 'bad-spill-scan-turn', 1, 'model-response-committed', '{broken-json', 1)
    const spillRoot = path.join(root, 'user-data', 'spill')
    fs.mkdirSync(spillRoot)
    fs.writeFileSync(path.join(spillRoot, 'unclassified.spill'), 'known bytes')
    db.flushSave()
    db.close()

    const estimate = collectSessionStorageCleanupEstimate(dbPath) as any

    expect(estimate.completeness).toMatchObject({ spillInventoryComplete: false, spillReferenceScanComplete: false,
      spillScanErrorCodes: expect.arrayContaining(['CANONICAL_SPILL_REFERENCE_SCAN_FAILED', 'ESTIMATE_SPILL_REFERENCE_SCAN_FAILED']) })
    expect(estimate.candidates.degradableSpill.referencedBytes).toBeNull()
    expect(estimate.candidates.unreferencedSpill.bytes).toBeNull()
    expect(estimate.mustRetain.sourceOfTruthSpillBytes).toBeNull()
    expect(estimate.physicalSpaceEstimate.maximumPotentialSpillBytesOutsideDatabase).toBeNull()
  })
})
