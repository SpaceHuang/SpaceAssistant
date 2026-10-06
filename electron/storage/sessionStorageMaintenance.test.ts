import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { appendMessage, createPersistedTurn, createSession, getApiContextBaseline } from '../database/operations'
import { clearSessionProjectionCaches, compactSessionDatabase, verifySessionMaintenanceArchive } from './sessionStorageMaintenance'
import { readSessionTranscriptProjection } from '../runtime/sessionTranscriptProjection'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSpillStore } from './spillStore'
import type { SpillDescriptor } from './spillProtocol'

describe('session storage maintenance', () => {
  it('verifies archived database integrity and every spill file content hash', async () => {
    const temp = createTempDatabase('storage-maintenance-archive-content-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE archive_payload(value TEXT NOT NULL); INSERT INTO archive_payload VALUES('durable');")
    temp.db.flushSave()
    const spillRoot = path.join(userDataDir, 'spill')
    const degradedRoot = path.join(userDataDir, 'spill-degraded')
    await fs.mkdir(spillRoot)
    await fs.mkdir(degradedRoot)
    await fs.writeFile(path.join(spillRoot, 'source.spill'), 'canonical source bytes')
    await fs.writeFile(path.join(degradedRoot, 'copy.spill'), 'degraded copy bytes')
    const archivePath = path.join(userDataDir, 'archive-verification-fixture')
    await fs.mkdir(archivePath)
    fsSync.copyFileSync(temp.dbPath, path.join(archivePath, path.basename(temp.dbPath)))
    fsSync.cpSync(spillRoot, path.join(archivePath, 'spill'), { recursive: true })
    fsSync.cpSync(degradedRoot, path.join(archivePath, 'spill-degraded'), { recursive: true })

    expect(verifySessionMaintenanceArchive(temp.dbPath, archivePath, userDataDir)).toBe(true)
    await fs.writeFile(path.join(archivePath, 'spill', 'source.spill'), 'same size??')
    expect(verifySessionMaintenanceArchive(temp.dbPath, archivePath, userDataDir)).toBe(false)
    await fs.writeFile(path.join(archivePath, 'spill', 'source.spill'), 'canonical source bytes')
    await fs.writeFile(path.join(archivePath, path.basename(temp.dbPath)), 'not a database')
    expect(verifySessionMaintenanceArchive(temp.dbPath, archivePath, userDataDir)).toBe(false)
    temp.cleanup()
  })

  it('does not start VACUUM when an archived spill copy has same-size but different content', async () => {
    const temp = createTempDatabase('storage-maintenance-spill-tamper-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE archive_payload(value TEXT NOT NULL); INSERT INTO archive_payload VALUES('must remain');")
    const spillRoot = path.join(userDataDir, 'spill')
    await fs.mkdir(spillRoot)
    await fs.writeFile(path.join(spillRoot, 'source.spill'), 'same')
    temp.db.flushSave()
    const originalCopy = fsSync.cpSync.bind(fsSync)
    vi.spyOn(fsSync, 'cpSync').mockImplementation((source, destination, options) => {
      const result = originalCopy(source, destination, options)
      if (String(destination).endsWith(`${path.sep}spill`)) fsSync.writeFileSync(path.join(String(destination), 'source.spill'), 'evil')
      return result
    })
    const progress: string[] = []

    await expect(compactSessionDatabase(temp.db, userDataDir, (step) => progress.push(step.phase)))
      .rejects.toThrow('database/spill archive verification failed')

    vi.restoreAllMocks()
    expect(progress).toContain('archive')
    expect(progress).not.toContain('vacuum')
    expect(conn.prepare('SELECT value FROM archive_payload').get()).toEqual({ value: 'must remain' })
    expect(conn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(await fs.readdir(path.join(userDataDir, 'session-archives'))).toEqual([])
    temp.cleanup()
  })

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
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.pageCountAfter).toBeLessThan(result.pageCountBefore)
    expect(result.freelistCountAfter).toBe(0)
    expect(result.walBytesBefore).toBe(0)
    expect(result.walBytesAfter).toBe(0)
    expect(result.peakSpaceEstimateBytes).toBeGreaterThan(result.bytesBefore)
    expect(result.archiveBytes).toBeGreaterThanOrEqual(result.bytesBefore)
    expect(result.availableBytesBefore).toBeGreaterThan(0)
    const report = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))
    expect(report).toMatchObject({ status: 'complete', pageCountBefore: result.pageCountBefore,
      pageCountAfter: result.pageCountAfter, bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter })
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

  it('does not yield the main-process event loop between verified archive and maintenance completion', async () => {
    const temp = createTempDatabase('storage-maintenance-no-interleaved-write-')
    const userDataDir = path.dirname(temp.dbPath)
    const session = createSession(temp.db, { name: 'maintenance interleave', model: 'test' })
    const conn = getDbConnection(temp.db)
    temp.db.flushSave()
    let messageCountAtComplete = -1
    setImmediate(() => appendMessage(temp.db, { id: 'after-maintenance-message', sessionId: session.id, role: 'user',
      content: 'write queued while maintenance is synchronous', timestamp: 2, status: 'sent' }))

    const result = await compactSessionDatabase(temp.db, userDataDir, (progress) => {
      if (progress.phase === 'complete') messageCountAtComplete = Number((conn.prepare('SELECT COUNT(*) AS count FROM messages').get() as { count: number }).count)
    })

    expect(messageCountAtComplete).toBe(0)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(conn.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
    const archived = new (await import('node:sqlite')).DatabaseSync(path.join(result.archivePath, path.basename(temp.dbPath)), { readOnly: true })
    expect(archived.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    archived.close()
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

  it.each(['session_execution_claims', 'session_execution_queue'] as const)('refuses compaction for a queued turn in %s', async (table) => {
    const temp = createTempDatabase(`storage-maintenance-queued-${table}-`)
    const conn = getDbConnection(temp.db)
    if (table === 'session_execution_claims') {
      conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
        VALUES('queued-s','queued-t','owner',1,'queued',1,1)`).run()
    } else {
      conn.prepare(`INSERT INTO session_execution_queue(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
        VALUES('queued-s','queued-t','owner',1,'queued',1,1)`).run()
    }

    await expect(compactSessionDatabase(temp.db, path.dirname(temp.dbPath))).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_BUSY' })
    temp.cleanup()
  })

  it('refuses compaction when a persisted turn is active without a claim row', async () => {
    const temp = createTempDatabase('storage-maintenance-active-turn-')
    const session = createSession(temp.db, { name: 'active turn', model: 'test' })
    const assistant = appendMessage(temp.db, { id: 'active-turn-assistant', sessionId: session.id, role: 'assistant',
      content: 'streaming', timestamp: 1, status: 'streaming' })
    createPersistedTurn(temp.db, { turnId: 'active-turn', requestId: 'active-request', sessionId: session.id,
      assistantMessageId: assistant.message.id, state: 'executing' })

    await expect(compactSessionDatabase(temp.db, path.dirname(temp.dbPath))).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_BUSY' })
    temp.cleanup()
  })

  it('preserves the verified archive and allows retry after post-vacuum maintenance failure', async () => {
    const temp = createTempDatabase('storage-maintenance-vacuum-fault-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec('CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES(zeroblob(1000000)); DELETE FROM maintenance_payload;')
    temp.db.flushSave()
    const beforeBytes = (await fs.stat(temp.dbPath)).size

    await expect(compactSessionDatabase(temp.db, userDataDir, (step) => {
      if (step.phase === 'reclaim') throw new Error('injected post-vacuum failure')
    })).rejects.toMatchObject({ message: 'injected post-vacuum failure', archivePreserved: true })

    const archiveRoot = path.join(userDataDir, 'session-archives')
    const archives = await fs.readdir(archiveRoot)
    expect(archives).toHaveLength(1)
    const failedArchivePath = path.join(archiveRoot, archives[0]!)
    await expect(fs.stat(path.join(failedArchivePath, path.basename(temp.dbPath))).then(({ size }) => size)).resolves.toBe(beforeBytes)
    expect(JSON.parse(await fs.readFile(path.join(failedArchivePath, 'maintenance.json'), 'utf8')))
      .toMatchObject({ status: 'failed', phase: 'reclaim' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM maintenance_payload').get()).toEqual({ count: 0 })
    expect((await fs.stat(temp.dbPath)).size).toBeLessThanOrEqual(beforeBytes)
    const retry = await compactSessionDatabase(temp.db, userDataDir)
    expect(retry.bytesAfter).toBeLessThan(beforeBytes)
    expect(await fs.readdir(archiveRoot)).toHaveLength(2)
    temp.cleanup()
  })

  it('rejects insufficient space before creating an archive or touching the source database', async () => {
    const temp = createTempDatabase('storage-maintenance-no-space-')
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('must remain');")
    temp.db.flushSave()
    const before = await fs.readFile(temp.dbPath)
    await expect(compactSessionDatabase(temp.db, path.dirname(temp.dbPath), undefined, { availableBytes: () => 0 }))
      .rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_INSUFFICIENT_SPACE' })
    expect(await fs.readFile(temp.dbPath)).toEqual(before)
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'must remain' })
    await expect(fs.readdir(path.join(path.dirname(temp.dbPath), 'session-archives'))).rejects.toMatchObject({ code: 'ENOENT' })
    temp.cleanup()
  })

  it('cancels after a verified archive and before vacuum without changing the source database', async () => {
    const temp = createTempDatabase('storage-maintenance-cancel-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('must remain');")
    temp.db.flushSave()
    const before = await fs.readFile(temp.dbPath)
    const controller = new AbortController()
    await expect(compactSessionDatabase(temp.db, userDataDir, (progress) => {
      if (progress.phase === 'archive') controller.abort()
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_CANCELLED', archivePreserved: true, phase: 'archive' })
    expect(await fs.readFile(temp.dbPath)).toEqual(before)
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'must remain' })
    const archiveRoot = path.join(userDataDir, 'session-archives')
    const archives = await fs.readdir(archiveRoot)
    expect(archives).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(archiveRoot, archives[0]!, 'maintenance.json'), 'utf8')))
      .toMatchObject({ status: 'failed', failureCode: 'STORAGE_MAINTENANCE_CANCELLED', phase: 'archive' })
    temp.cleanup()
  })

  it('detects space loss after archiving but before vacuum and preserves both source and recovery archive', async () => {
    const temp = createTempDatabase('storage-maintenance-space-race-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('must remain');")
    temp.db.flushSave()
    const before = await fs.readFile(temp.dbPath)
    let checks = 0
    await expect(compactSessionDatabase(temp.db, userDataDir, undefined, {
      availableBytes: () => ++checks === 1 ? Number.MAX_SAFE_INTEGER : 0
    })).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_INSUFFICIENT_SPACE', archivePreserved: true })
    expect(await fs.readFile(temp.dbPath)).toEqual(before)
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'must remain' })
    const archiveRoot = path.join(userDataDir, 'session-archives')
    const archives = await fs.readdir(archiveRoot)
    expect(archives).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(archiveRoot, archives[0]!, 'maintenance.json'), 'utf8')))
      .toMatchObject({ status: 'failed', failureCode: 'STORAGE_MAINTENANCE_INSUFFICIENT_SPACE', phase: 'archive' })
    temp.cleanup()
  })

  it('preserves the verified archive and retries when VACUUM phase fails', async () => {
    const temp = createTempDatabase('storage-maintenance-vacuum-phase-failure-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('must remain');")
    temp.db.flushSave()
    await expect(compactSessionDatabase(temp.db, userDataDir, (progress) => {
      if (progress.phase === 'vacuum') throw new Error('injected VACUUM phase failure')
    })).rejects.toMatchObject({ message: 'injected VACUUM phase failure', archivePreserved: true, phase: 'vacuum' })
    expect(conn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'must remain' })
    const archiveRoot = path.join(userDataDir, 'session-archives')
    const firstArchive = (await fs.readdir(archiveRoot))[0]!
    expect(JSON.parse(await fs.readFile(path.join(archiveRoot, firstArchive, 'maintenance.json'), 'utf8')))
      .toMatchObject({ status: 'failed', phase: 'vacuum', failureCode: 'Error' })
    const retry = await compactSessionDatabase(temp.db, userDataDir)
    expect(JSON.parse(await fs.readFile(retry.manifestPath, 'utf8'))).toMatchObject({ status: 'complete' })
    expect(conn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    temp.cleanup()
  })

  it('recovers from a hard process kill during VACUUM and permits a verified retry', async () => {
    const temp = createTempDatabase('storage-maintenance-hard-kill-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TABLE maintenance_payload(value BLOB NOT NULL);
      INSERT INTO maintenance_payload VALUES(zeroblob(24000000)); DELETE FROM maintenance_payload;`)
    temp.db.flushSave()
    temp.db.close()
    const helperPath = path.join(userDataDir, 'maintenance-vacuum-child.mjs')
    const markerPath = path.join(userDataDir, 'maintenance-vacuum-started')
    const databaseModule = pathToFileURL(path.resolve(process.cwd(), 'electron/database/index.ts')).href
    const maintenanceModule = pathToFileURL(path.resolve(process.cwd(), 'electron/storage/sessionStorageMaintenance.ts')).href
    await fs.writeFile(helperPath, `import fs from 'node:fs'\n` +
      `import { openDatabase } from ${JSON.stringify(databaseModule)}\n` +
      `import { compactSessionDatabase } from ${JSON.stringify(maintenanceModule)}\n` +
      `const db = openDatabase(process.argv[2])\n` +
      `await compactSessionDatabase(db, process.argv[3], (progress) => { if (progress.phase === 'vacuum') fs.writeFileSync(process.argv[4], 'started') })\n` +
      `db.close()\n`)
    const child = spawn(process.execPath, ['--import', 'tsx', helperPath, temp.dbPath, userDataDir, markerPath], { stdio: 'ignore' })
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && !(await fs.stat(markerPath).then(() => true, () => false))) await delay(2)
    expect(await fs.stat(markerPath).then(() => true, () => false)).toBe(true)
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('close', () => resolve()))

    const reopened = (await import('../database')).openDatabase(temp.dbPath)
    const reopenedConn = getDbConnection(reopened)
    expect(reopenedConn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    expect(reopenedConn.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(reopenedConn.prepare('SELECT COUNT(*) AS count FROM maintenance_payload').get()).toEqual({ count: 0 })
    const archiveRoot = path.join(userDataDir, 'session-archives')
    const archives = await fs.readdir(archiveRoot)
    expect(archives).toHaveLength(1)
    const interruptedArchive = new (await import('node:sqlite')).DatabaseSync(path.join(archiveRoot, archives[0]!, path.basename(temp.dbPath)), { readOnly: true })
    expect(interruptedArchive.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    interruptedArchive.close()
    const retry = await compactSessionDatabase(reopened, userDataDir)
    expect(JSON.parse(await fs.readFile(retry.manifestPath, 'utf8'))).toMatchObject({ status: 'complete' })
    expect(reopenedConn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    reopened.close()
    temp.cleanup()
  })

  it('preserves canonical transcript, API context, and source-truth spill through cache clear and compaction', async () => {
    const temp = createTempDatabase('storage-maintenance-canonical-')
    const userDataDir = path.dirname(temp.dbPath)
    const session = createSession(temp.db, { name: 'maintenance canonical sample', model: 'test' })
    const body = 'canonical message body preserved across maintenance'
    const user = appendMessage(temp.db, { id: 'maintenance-canonical-user', sessionId: session.id, role: 'user', content: body, timestamp: 1, status: 'sent' })
    const spillRoot = path.join(userDataDir, 'spill')
    const spillStore = createSpillStore(spillRoot)
    const sourceBody = 'source truth spill payload preserved across maintenance'
    const spill = await spillStore.commitSourceTruthUnderFence(sourceBody)
    const history = new SqliteAgentHistory(getDbConnection(temp.db), 1, Date.now, session.id, spillStore)
    await history.appendBatch([{
      invocationId: 'maintenance-canonical-invocation', turnId: 'maintenance-canonical-turn', sequence: 1, schemaVersion: 1,
      eventId: 'maintenance-canonical-context', idempotencyKey: 'maintenance-canonical-context', kind: 'invocation-context-committed',
      payload: { messages: [{ id: user.message.id, role: 'user', content: body, timestamp: 1 }], spill }
    }], 0)
    const conn = getDbConnection(temp.db)
    const beforeProjection = readSessionTranscriptProjection(temp.db, session.id)
    const beforeContext = getApiContextBaseline(temp.db, session.id).entries.map(({ message }) => [message.id, message.content])
    const beforeSourceSpill = await spillStore.readSourceTruth(spill)
    conn.exec('CREATE TABLE maintenance_reclaim(value BLOB NOT NULL); INSERT INTO maintenance_reclaim VALUES(zeroblob(2500000)); DELETE FROM maintenance_reclaim;')
    temp.db.flushSave()

    const compacted = await compactSessionDatabase(temp.db, userDataDir, undefined, { clearProjectionCachesAfterArchive: true })
    temp.db.close()
    const reopened = (await import('../database')).openDatabase(temp.dbPath)
    try {
      const afterProjection = readSessionTranscriptProjection(reopened, session.id)
      const afterContext = getApiContextBaseline(reopened, session.id).entries.map(({ message }) => [message.id, message.content])
      const reopenedSpill = createSpillStore(spillRoot)
      expect(afterProjection.messages).toEqual(beforeProjection.messages)
      expect(afterContext).toEqual(beforeContext)
      await expect(afterSourceTruth(reopenedSpill, spill)).resolves.toBe(beforeSourceSpill)
      await expect(fs.readFile(path.join(compacted.archivePath, 'spill', spill.locator))).resolves.toEqual(
        await fs.readFile(path.join(spillRoot, spill.locator)))
      expect(getDbConnection(reopened).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
      expect(getDbConnection(reopened).prepare('PRAGMA foreign_key_check').all()).toEqual([])
    } finally {
      reopened.close()
      temp.cleanup()
    }
  })
})

function afterSourceTruth(store: ReturnType<typeof createSpillStore>, descriptor: SpillDescriptor): Promise<string> {
  return store.readSourceTruth(descriptor)
}
