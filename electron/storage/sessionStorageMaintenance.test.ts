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
import { cancelQueuedSessionExecution, claimSessionExecution, commitSessionTranscript, releaseSessionExecution } from '../database/sessionTranscript'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import type { Worker } from 'node:worker_threads'
import { COMPACT_SNAPSHOT_RETRY_LIMIT, reconcileInterruptedCompaction } from './sessionStorageMaintenance'
import { spawnSessionMaintenanceSourceWorker } from './sessionStorageMaintenanceWorkerClient'
import { activeSessionTurnCount, compactSessionDatabase, FULL_VACUUM_FREELIST_RATIO, verifySessionMaintenanceArchive } from './sessionStorageMaintenance'
import type { StorageMaintenanceProgress } from './sessionStorageMaintenance'
import { clearSessionProjectionCaches } from './sessionProjectionCacheMaintenance'
import { readSessionTranscriptProjection } from '../runtime/sessionTranscriptProjection'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSpillStore } from './spillStore'
import type { SpillDescriptor } from './spillProtocol'


describe('session storage maintenance', () => {
  afterEach(() => { vi.unstubAllEnvs() })
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

  it('refuses the swap when an archived spill copy has same-size but different content', async () => {
    const temp = createTempDatabase('storage-maintenance-spill-tamper-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE archive_payload(value TEXT NOT NULL); INSERT INTO archive_payload VALUES('must remain');")
    const spillRoot = path.join(userDataDir, 'spill')
    await fs.mkdir(spillRoot)
    await fs.writeFile(path.join(spillRoot, 'source.spill'), 'same')
    temp.db.flushSave()
    const progress: string[] = []

    // worker 线程不受本文件 vi.mock 影响；归档复制完成（vacuum 进度代表归档 quick_check 已过）后
    // 篡改归档 spill 副本，编排器换入前的证据复核必须拒绝。
    await expect(compactSessionDatabase(temp.db, userDataDir, (step) => {
      progress.push(step.phase)
      if (step.phase === 'vacuum') {
        const archiveRoot = path.join(userDataDir, 'session-archives')
        const archive = fsSync.readdirSync(archiveRoot).sort().at(-1)!
        fsSync.writeFileSync(path.join(archiveRoot, archive, 'spill', 'source.spill'), 'evil')
      }
    })).rejects.toThrow('database/spill archive verification failed')

    expect(progress).toContain('archive')
    expect(conn.prepare('SELECT value FROM archive_payload').get()).toEqual({ value: 'must remain' })
    expect(conn.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
    // 校验失败走「未过校验」路径：归档被清理，不进入换入。
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
    expect(result.vacuumMode).toBe('full')
    const report = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))
    expect(report).toMatchObject({ status: 'complete', formatVersion: 2, vacuumMode: 'full', executionTarget: 'worker',
      pageCountBefore: result.pageCountBefore, pageCountAfter: result.pageCountAfter,
      bytesBefore: result.bytesBefore, bytesAfter: result.bytesAfter,
      stageDurationsMs: { archive: expect.any(Number), verify: expect.any(Number), vacuum: expect.any(Number), swap: expect.any(Number), total: expect.any(Number) },
      stageBytes: { archive: expect.any(Number), staging: expect.any(Number) } })
    expect(report.stageDurationsMs.total).toBeGreaterThanOrEqual(report.stageDurationsMs.archive)
    // worker 路径换入的 staging 继承源库 auto_vacuum（freelist 恒为 0，无需 incremental 舞蹈）
    expect(result.freelistCountAfter).toBe(0)
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

  it('keeps the main process responsive during worker compaction and never swaps in a stale snapshot', async () => {
    const temp = createTempDatabase('storage-maintenance-responsive-')
    const userDataDir = path.dirname(temp.dbPath)
    const session = createSession(temp.db, { name: 'maintenance responsive', model: 'test' })
    const conn = getDbConnection(temp.db)
    conn.exec('CREATE TABLE maintenance_payload(value BLOB NOT NULL); INSERT INTO maintenance_payload VALUES(zeroblob(12000000));')
    temp.db.flushSave()
    let writeQueued = false
    const progress: string[] = []

    const result = await compactSessionDatabase(temp.db, userDataDir, (step) => {
      progress.push(step.phase)
      // worker 拉起后主进程仍可写：首个进度事件到达时排队一次写入（P5 快照一致性防线负责正确性）。
      if (!writeQueued) {
        writeQueued = true
        appendMessage(temp.db, { id: 'during-maintenance-message', sessionId: session.id, role: 'user',
          content: 'write while worker compaction runs', timestamp: 2, status: 'sent' })
      }
    })

    expect(result.executionTarget).toBe('worker')
    expect(progress).toContain('swap')
    expect(progress.at(-1)).toBe('complete')
    // 换入后的库必须包含压缩期间提交的写入（快照过期则重做；写入在探针前落库则直接进入 staging）。
    // 换入临界区重建了底层连接，须重新从 WeakMap 取新连接。
    const reopenedConn = getDbConnection(temp.db)
    expect(reopenedConn.prepare('SELECT COUNT(*) AS count FROM messages WHERE id=?').get('during-maintenance-message'))
      .toEqual({ count: 1 })
    const archived = new (await import('node:sqlite')).DatabaseSync(path.join(result.archivePath, path.basename(temp.dbPath)), { readOnly: true })
    expect(archived.prepare('PRAGMA quick_check').get()).toEqual({ quick_check: 'ok' })
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

  it('treats a released idle claim row (status queued with empty turn) as compactable', async () => {
    const temp = createTempDatabase('storage-maintenance-idle-claim-')
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO session_execution_claims(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES('idle-s','','',1,'queued',1,1)`).run()

    const result = await compactSessionDatabase(temp.db, path.dirname(temp.dbPath))

    expect(JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))).toMatchObject({ status: 'complete' })
    temp.cleanup()
  })

  it('refuses compaction for a queued turn in session_execution_queue', async () => {
    const temp = createTempDatabase('storage-maintenance-queued-queue-')
    const conn = getDbConnection(temp.db)
    conn.prepare(`INSERT INTO session_execution_queue(session_id,turn_id,owner_id,generation,status,enqueued_at,updated_at)
      VALUES('queued-s','queued-t','owner',1,'queued',1,1)`).run()

    await expect(compactSessionDatabase(temp.db, path.dirname(temp.dbPath))).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_BUSY' })
    temp.cleanup()
  })

  it('allows compaction after every claim has been released', async () => {
    const temp = createTempDatabase('storage-maintenance-released-')
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES(zeroblob(1000000)); DELETE FROM maintenance_payload;")
    temp.db.flushSave()
    const claim = claimSessionExecution(temp.db, { sessionId: 'released-s', turnId: 'released-t', ownerId: 'released-owner' })
    if (!claim.acquired) throw new Error('expected to acquire the session execution claim')
    expect(releaseSessionExecution(temp.db, { sessionId: 'released-s', turnId: 'released-t', ownerId: 'released-owner', generation: claim.generation })).toBe(true)
    const idleClaim = conn.prepare("SELECT status, turn_id, owner_id FROM session_execution_claims WHERE session_id='released-s'").get() as { status: string; turn_id: string; owner_id: string }
    expect(idleClaim).toEqual({ status: 'queued', turn_id: '', owner_id: '' })

    const result = await compactSessionDatabase(temp.db, path.dirname(temp.dbPath))

    expect(result.freelistCountAfter).toBe(0)
    expect(JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))).toMatchObject({ status: 'complete' })
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

  it('rejects verification when the archived db is structurally corrupt despite byte-identical hashes', async () => {
    const temp = createTempDatabase('storage-maintenance-quick-check-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE archive_payload(value TEXT NOT NULL); INSERT INTO archive_payload VALUES('durable');")
    temp.db.flushSave()
    temp.db.close()
    const archivePath = path.join(userDataDir, 'archive-corrupt-fixture')
    await fs.mkdir(archivePath)
    fsSync.copyFileSync(temp.dbPath, path.join(archivePath, path.basename(temp.dbPath)))
    const flipHeaderByte = async (filePath: string) => {
      const handle = await fs.open(filePath, 'r+')
      try {
        const byte = Buffer.alloc(1)
        await handle.read(byte, 0, 1, 0)
        byte[0] ^= 0xff
        await handle.write(byte, 0, 1, 0)
      } finally { await handle.close() }
    }
    await flipHeaderByte(temp.dbPath)
    await flipHeaderByte(path.join(archivePath, path.basename(temp.dbPath)))

    expect(verifySessionMaintenanceArchive(temp.dbPath, archivePath, userDataDir)).toBe(false)
    temp.cleanup()
  })

  it('runs a full VACUUM on the first compaction of a fragmented legacy database (L2)', async () => {
    vi.stubEnv('SPACEASSISTANT_IN_PROCESS_COMPACT', '1')
    const temp = createTempDatabase('storage-maintenance-vacuum-l2-')
    const conn = getDbConnection(temp.db)
    conn.exec('CREATE TABLE maintenance_payload(value BLOB NOT NULL); INSERT INTO maintenance_payload VALUES(zeroblob(2000000)); DELETE FROM maintenance_payload;')
    temp.db.flushSave()
    const result = await compactSessionDatabase(temp.db, path.dirname(temp.dbPath))
    expect(result.vacuumMode).toBe('full')
    expect(result.freelistCountAfter).toBe(0)
    temp.cleanup()
  })

  it('takes the incremental fast path for a small freelist ratio once auto_vacuum is incremental (L1)', async () => {
    vi.stubEnv('SPACEASSISTANT_IN_PROCESS_COMPACT', '1')
    const temp = createTempDatabase('storage-maintenance-vacuum-l1-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TABLE maintenance_payload(value BLOB NOT NULL);
      INSERT INTO maintenance_payload VALUES(zeroblob(1000000));
      INSERT INTO maintenance_payload VALUES(zeroblob(1000000));
      DELETE FROM maintenance_payload WHERE length(value)=1000000 AND rowid=(SELECT MIN(rowid) FROM maintenance_payload);`)
    temp.db.flushSave()
    const first = await compactSessionDatabase(temp.db, userDataDir)
    expect(first.vacuumMode).toBe('full')
    conn.exec('INSERT INTO maintenance_payload VALUES(zeroblob(200000)); DELETE FROM maintenance_payload WHERE length(value)=200000;')
    temp.db.flushSave()
    const ratioBefore = Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count) /
      Number((conn.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    expect(ratioBefore).toBeLessThanOrEqual(FULL_VACUUM_FREELIST_RATIO)

    const second = await compactSessionDatabase(temp.db, userDataDir)

    expect(second.vacuumMode).toBe('incremental')
    expect(second.freelistCountAfter).toBe(0)
    temp.cleanup()
  })

  it('skips reorganization entirely when the freelist is empty (L0)', async () => {
    vi.stubEnv('SPACEASSISTANT_IN_PROCESS_COMPACT', '1')
    const temp = createTempDatabase('storage-maintenance-vacuum-l0-')
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('compact');")
    temp.db.flushSave()
    await compactSessionDatabase(temp.db, path.dirname(temp.dbPath))
    expect(Number((conn.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count)).toBe(0)

    const second = await compactSessionDatabase(temp.db, path.dirname(temp.dbPath))

    expect(second.vacuumMode).toBe('none')
    expect(second.reclaimedPages).toBe(0)
    expect(second.freelistCountAfter).toBe(0)
    temp.cleanup()
  })

  it('compacts twice in a row with the second run on a fast tier and shorter duration', async () => {
    vi.stubEnv('SPACEASSISTANT_IN_PROCESS_COMPACT', '1')
    const temp = createTempDatabase('storage-maintenance-vacuum-twice-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TABLE maintenance_payload(value BLOB NOT NULL);
      INSERT INTO maintenance_payload VALUES(zeroblob(8000000));
      INSERT INTO maintenance_payload VALUES(zeroblob(1000000));
      DELETE FROM maintenance_payload WHERE length(value)=1000000;`)
    temp.db.flushSave()
    const first = await compactSessionDatabase(temp.db, userDataDir)
    expect(first.vacuumMode).toBe('full')
    conn.exec('INSERT INTO maintenance_payload VALUES(zeroblob(1000000)); DELETE FROM maintenance_payload WHERE length(value)=1000000;')
    temp.db.flushSave()

    const second = await compactSessionDatabase(temp.db, userDataDir)

    expect(['none', 'incremental']).toContain(second.vacuumMode)
    expect(second.freelistCountAfter).toBe(0)
    expect(second.durationMs).toBeLessThan(first.durationMs)
    temp.cleanup()
  })

  it('emits byte-accurate monotonic progress across the archive stage', async () => {
    const temp = createTempDatabase('storage-maintenance-progress-bytes-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec('CREATE TABLE maintenance_payload(value BLOB NOT NULL); INSERT INTO maintenance_payload VALUES(zeroblob(1000000)); DELETE FROM maintenance_payload;')
    const spillDir = path.join(userDataDir, 'spill')
    const degradedDir = path.join(userDataDir, 'spill-degraded')
    await fs.mkdir(spillDir, { recursive: true })
    await fs.mkdir(degradedDir, { recursive: true })
    await fs.writeFile(path.join(spillDir, 'a.spill'), Buffer.alloc(5000, 7))
    await fs.writeFile(path.join(degradedDir, 'b.spill'), Buffer.alloc(3000, 9))
    temp.db.flushSave()
    const dbBytesBefore = (await fs.stat(temp.dbPath)).size
    const events: StorageMaintenanceProgress[] = []

    await compactSessionDatabase(temp.db, userDataDir, (progress) => events.push({ ...progress }))

    // archive 事件共享同一 totalBytes；vacuum 事件的 totalBytes 为 staging 口径（源库字节），单独断言存在。
    const archiveByteEvents = events.filter((event) => event.phase === 'archive' && event.totalBytes != null)
    expect(archiveByteEvents.length).toBeGreaterThan(0)
    const totalBytes = archiveByteEvents[0]!.totalBytes!
    expect(totalBytes).toBe(dbBytesBefore + 5000 + 3000)
    let previous = 0
    for (const event of archiveByteEvents) {
      expect(event.totalBytes).toBe(totalBytes)
      expect(event.completedBytes!).toBeGreaterThanOrEqual(previous)
      previous = event.completedBytes!
    }
    expect(previous).toBe(totalBytes)
    expect(events.some((event) => event.phase === 'vacuum' || event.phase === 'swap')).toBe(true)
    temp.cleanup()
  })

  it('preserves the verified archive and allows retry after a swap-stage failure', async () => {
    const temp = createTempDatabase('storage-maintenance-swap-fault-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec('CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES(zeroblob(1000000)); DELETE FROM maintenance_payload;')
    temp.db.flushSave()
    const beforeBytes = (await fs.stat(temp.dbPath)).size

    await expect(compactSessionDatabase(temp.db, userDataDir, (step) => {
      if (step.phase === 'swap') throw new Error('injected swap-stage failure')
    })).rejects.toMatchObject({ message: 'injected swap-stage failure', archivePreserved: true, phase: 'swap' })

    const archiveRoot = path.join(userDataDir, 'session-archives')
    const archives = await fs.readdir(archiveRoot)
    expect(archives).toHaveLength(1)
    const failedArchivePath = path.join(archiveRoot, archives[0]!)
    await expect(fs.stat(path.join(failedArchivePath, path.basename(temp.dbPath))).then(({ size }) => size)).resolves.toBe(beforeBytes)
    expect(JSON.parse(await fs.readFile(path.join(failedArchivePath, 'maintenance.json'), 'utf8')))
      .toMatchObject({ status: 'failed', phase: 'swap' })
    expect(conn.prepare('SELECT COUNT(*) AS count FROM maintenance_payload').get()).toEqual({ count: 0 })
    expect((await fs.stat(temp.dbPath)).size).toBeLessThanOrEqual(beforeBytes)
    const retry = await compactSessionDatabase(temp.db, userDataDir)
    expect(retry.bytesAfter).toBeLessThan(beforeBytes)
    expect(await fs.readdir(archiveRoot)).toHaveLength(2)
    temp.cleanup()
  })

  // 独立 30s 超时：Windows Defender 对刚被 checkpoint 触碰过的 db 文件重扫可能拖慢 readFile 断言 10s+。
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
  }, 30_000)

  it('cancels before the archive is verified and leaves no recovery archive behind', async () => {
    const temp = createTempDatabase('storage-maintenance-cancel-early-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('must remain');")
    temp.db.flushSave()
    const before = await fs.readFile(temp.dbPath)
    const controller = new AbortController()
    await expect(compactSessionDatabase(temp.db, userDataDir, (progress) => {
      if (progress.phase === 'archive') controller.abort()
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_CANCELLED' })
    expect(await fs.readFile(temp.dbPath)).toEqual(before)
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'must remain' })
    expect(await fs.readdir(path.join(userDataDir, 'session-archives'))).toEqual([])
    temp.cleanup()
  })

  it('cancels after a verified archive and preserves it without changing the source database', async () => {
    const temp = createTempDatabase('storage-maintenance-cancel-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('must remain');")
    temp.db.flushSave()
    const before = await fs.readFile(temp.dbPath)
    const controller = new AbortController()
    await expect(compactSessionDatabase(temp.db, userDataDir, (progress) => {
      // 归档 quick_check 通过后 worker 才发 vacuum 进度；此处取消 → 归档保留为恢复副本。
      if (progress.phase === 'vacuum') controller.abort()
    }, { signal: controller.signal })).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_CANCELLED', archivePreserved: true, phase: 'vacuum' })
    expect(await fs.readFile(temp.dbPath)).toEqual(before)
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'must remain' })
    const archiveRoot = path.join(userDataDir, 'session-archives')
    const archives = await fs.readdir(archiveRoot)
    expect(archives).toHaveLength(1)
    expect(JSON.parse(await fs.readFile(path.join(archiveRoot, archives[0]!, 'maintenance.json'), 'utf8')))
      .toMatchObject({ status: 'failed', failureCode: 'STORAGE_MAINTENANCE_CANCELLED', phase: 'vacuum' })
    temp.cleanup()
  }, 30_000)

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
  }, 30_000)

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
    // 重试走 worker 换入临界区，底层连接已重建，须重取。
    expect(getDbConnection(temp.db).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
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
    expect(getDbConnection(reopened).prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
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

/** mulberry32(AGENTS.md 不变量测试纪律:确定性伪随机)。 */
function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state |= 0
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('activeSessionTurnCount 不变量(mulberry32 随机操作序列 + 跨函数成对性)', () => {
  it('忙碌计数 ⇔ 存在活跃票据；全部票据释放后必为 0', () => {
    const temp = createTempDatabase('storage-maintenance-invariant-')
    const db = temp.db
    const conn = getDbConnection(temp.db)
    const random = mulberry32(20261013)
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!
    const sessionIds = ['inv-s1', 'inv-s2', 'inv-s3', 'inv-s4']
    type Holder = { turnId: string; ownerId: string; generation: number; committed: boolean }
    type Waiter = { turnId: string; ownerId: string }
    const holders = new Map<string, Holder>()
    const waiters = new Map<string, Waiter[]>(sessionIds.map((id) => [id, []]))
    const versions = new Map<string, number>(sessionIds.map((id) => [id, 0]))
    const activeRows = () => ({
      claims: Number((conn.prepare(`SELECT COUNT(*) AS c FROM session_execution_claims
        WHERE status IN ('claimed','executing','transcript_committed','commit_uncertain')`).get() as { c: number }).c),
      queue: Number((conn.prepare('SELECT COUNT(*) AS c FROM session_execution_queue').get() as { c: number }).c),
      turns: Number((conn.prepare(`SELECT COUNT(*) AS c FROM turns
        WHERE state IN ('configuring','prepared','executing','waiting-confirm')`).get() as { c: number }).c),
      messages: Number((conn.prepare(`SELECT COUNT(*) AS c FROM messages WHERE status IN ('queued','streaming')`).get() as { c: number }).c)
    })
    const expectInvariants = () => {
      const busy = activeSessionTurnCount(db)
      const rows = activeRows()
      const activeExists = rows.claims > 0 || rows.queue > 0 || rows.turns > 0 || rows.messages > 0
      expect(busy > 0, `busy=${busy} 但活跃票据=${JSON.stringify(rows)}`).toBe(activeExists)
      expect(busy).toBe(rows.claims + rows.queue + rows.turns + rows.messages)
    }

    expect(activeSessionTurnCount(db)).toBe(0)
    let turnSeq = 0
    for (let step = 0; step < 160; step += 1) {
      const sessionId = pick(sessionIds)
      const holder = holders.get(sessionId)
      const pending = waiters.get(sessionId)!
      const roll = random()
      if (!holder && roll < 0.45) {
        const turnId = `inv-t${turnSeq += 1}`
        const ownerId = `inv-owner${turnSeq}`
        const claim = claimSessionExecution(db, { sessionId, turnId, ownerId })
        if (claim.acquired) holders.set(sessionId, { turnId, ownerId, generation: claim.generation, committed: false })
        else if (claim.reason === 'owned') pending.push({ turnId, ownerId }) // FIFO 头部被更早的等待者占据
      } else if (holder && roll < 0.6) {
        const turnId = `inv-q${turnSeq += 1}`
        const ownerId = `inv-waiter${turnSeq}`
        const claim = claimSessionExecution(db, { sessionId, turnId, ownerId })
        expect(claim).toEqual({ acquired: false, reason: 'owned' })
        pending.push({ turnId, ownerId })
      } else if (holder && !holder.committed && roll < 0.78) {
        const commit = commitSessionTranscript(db, { sessionId, turnId: holder.turnId, baseVersion: versions.get(sessionId)!,
          outcome: 'completed', messages: [] })
        if (commit.committed) {
          versions.set(sessionId, commit.version)
          holder.committed = true
        }
      } else if (holder && roll < 0.9) {
        expect(releaseSessionExecution(db, { sessionId, turnId: holder.turnId, ownerId: holder.ownerId, generation: holder.generation })).toBe(true)
        holders.delete(sessionId)
      } else if (pending.length > 0) {
        const target = pending.splice(Math.floor(random() * pending.length), 1)[0]!
        expect(cancelQueuedSessionExecution(db, { sessionId, turnId: target.turnId, ownerId: target.ownerId })).toBe(true)
      }
      expectInvariants()
    }

    // 终局排干:claims 全部释放、queue 全部撤销后,忙碌计数必须归零(回退 P1 谓词修复该断言转红)。
    for (const [sessionId, holder] of holders) {
      expect(releaseSessionExecution(db, { sessionId, turnId: holder.turnId, ownerId: holder.ownerId, generation: holder.generation })).toBe(true)
    }
    for (const [sessionId, pending] of waiters) {
      for (const waiter of pending) expect(cancelQueuedSessionExecution(db, { sessionId, turnId: waiter.turnId, ownerId: waiter.ownerId })).toBe(true)
    }
    expect(holders.size > 0 || [...waiters.values()].some((pending) => pending.length > 0)).toBe(true)
    expect(activeSessionTurnCount(db)).toBe(0)
    temp.cleanup()
  })
})

/** 测试用 worker 替身：满足 client 所需的最小表面（on/once/emit/postMessage/terminate）。 */
class StubCompactionWorker extends EventEmitter {
  postMessage: (value: unknown) => void = () => undefined
  terminate: () => Promise<number> = async () => 0
}

function snapshotMismatchResult(before: number, after: number) {
  return { type: 'result', dbSourceSha256: 'stub', dbDestSha256: 'stub', spillSourceManifest: [], spillDegradedSourceManifest: [],
    archiveBytes: 0, stagingBytes: 0, dataVersionBefore: before, dataVersionAfter: after,
    stageDurationsMs: { archive: 0, verify: 0, vacuum: 0 } }
}

describe('worker compaction orchestration', () => {
  it('retries on snapshot change and reports busy after three changing attempts', async () => {
    const temp = createTempDatabase('storage-maintenance-snapshot-busy-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('stable');")
    temp.db.flushSave()
    let spawnCount = 0
    const createWorker = () => {
      spawnCount += 1
      const stub = new StubCompactionWorker()
      stub.postMessage = () => { queueMicrotask(() => stub.emit('message', snapshotMismatchResult(1, 2))) }
      return stub as unknown as Worker
    }

    await expect(compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker }))
      .rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_BUSY' })

    expect(spawnCount).toBe(COMPACT_SNAPSHOT_RETRY_LIMIT)
    expect(await fs.readdir(path.join(userDataDir, 'session-archives'))).toEqual([])
    expect(fsSync.readdirSync(path.dirname(temp.dbPath)).filter((name) => name.includes('.compact-staging-'))).toEqual([])
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'stable' })
    temp.cleanup()
  })

  it('redoes compaction when the snapshot changed and swaps in the fresh snapshot', async () => {
    const temp = createTempDatabase('storage-maintenance-snapshot-redo-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('snapshot-content');")
    temp.db.flushSave()
    let attempts = 0
    const createWorker = (workerPath: string) => {
      attempts += 1
      if (attempts === 1) {
        const stub = new StubCompactionWorker()
        stub.postMessage = () => { queueMicrotask(() => stub.emit('message', snapshotMismatchResult(1, 2))) }
        return stub as unknown as Worker
      }
      const real = spawnSessionMaintenanceSourceWorker(workerPath)
      const proxy = new StubCompactionWorker()
      proxy.postMessage = (value: unknown) => real.postMessage(value)
      proxy.terminate = () => real.terminate()
      real.on('message', (message) => proxy.emit('message', message))
      real.once('error', (error) => proxy.emit('error', error))
      real.once('exit', (code) => proxy.emit('exit', code))
      return proxy as unknown as Worker
    }

    const result = await compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker })

    expect(result.snapshotAttempts).toBe(2)
    expect(result.executionTarget).toBe('worker')
    expect(result.freelistCountAfter).toBe(0)
    // 换入临界区重建了底层连接，须重取后再断言内容。
    expect(getDbConnection(temp.db).prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'snapshot-content' })
    expect(JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))).toMatchObject({ status: 'complete', vacuumMode: 'full' })
    temp.cleanup()
  })

  it('terminates a stalled compaction worker and reports a timeout with staging cleaned up', async () => {
    const temp = createTempDatabase('storage-maintenance-stalled-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('stable');")
    temp.db.flushSave()
    const terminate = vi.fn(async () => 0)
    const createWorker = () => {
      const stub = new StubCompactionWorker()
      stub.terminate = terminate
      return stub as unknown as Worker
    }

    await expect(compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker, watchdogTimeoutMs: 300 }))
      .rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_TIMEOUT' })

    expect(terminate).toHaveBeenCalled()
    expect(await fs.readdir(path.join(userDataDir, 'session-archives'))).toEqual([])
    expect(fsSync.readdirSync(path.dirname(temp.dbPath)).filter((name) => name.includes('.compact-staging-'))).toEqual([])
    expect(conn.prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'stable' })
    temp.cleanup()
  })

  it('cleans the archive between snapshot retries so a real worker can run the second attempt', async () => {
    const temp = createTempDatabase('storage-maintenance-retry-archive-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('retry-content');")
    temp.db.flushSave()
    let attempts = 0
    const createWorker = (workerPath: string) => {
      attempts += 1
      if (attempts === 1) {
        const stub = new StubCompactionWorker()
        // 复刻真实 worker 的文件形态（B1）：归档复制以 'wx' 独占创建落盘，然后才上报快照失配。
        stub.postMessage = (value: unknown) => {
          const request = value as { dbPath: string; archivePath: string }
          queueMicrotask(() => {
            fsSync.mkdirSync(request.archivePath, { recursive: true })
            fsSync.copyFileSync(request.dbPath, path.join(request.archivePath, path.basename(request.dbPath)))
            stub.emit('message', snapshotMismatchResult(1, 2))
          })
        }
        return stub as unknown as Worker
      }
      const real = spawnSessionMaintenanceSourceWorker(workerPath)
      const proxy = new StubCompactionWorker()
      proxy.postMessage = (value: unknown) => real.postMessage(value)
      proxy.terminate = () => real.terminate()
      real.on('message', (message) => proxy.emit('message', message))
      real.once('error', (error) => proxy.emit('error', error))
      real.once('exit', (code) => proxy.emit('exit', code))
      return proxy as unknown as Worker
    }

    const result = await compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker })

    expect(result.snapshotAttempts).toBe(2)
    expect(result.executionTarget).toBe('worker')
    expect(getDbConnection(temp.db).prepare('SELECT value FROM maintenance_payload').get()).toEqual({ value: 'retry-content' })
    temp.cleanup()
  }, 30_000)

  it('times out when the staging file exists but stops growing during VACUUM INTO', async () => {
    const temp = createTempDatabase('storage-maintenance-staged-stall-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('stable');")
    temp.db.flushSave()
    const createWorker = () => {
      const stub = new StubCompactionWorker()
      // 复刻真实卡死形态（B2）：staging 已创建、字节停止增长、worker 阻塞后再无任何消息。
      stub.postMessage = (value: unknown) => {
        const request = value as { stagingPath: string }
        queueMicrotask(() => {
          fsSync.writeFileSync(request.stagingPath, Buffer.alloc(8192, 1))
        })
      }
      return stub as unknown as Worker
    }

    await expect(compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker, watchdogTimeoutMs: 600 }))
      .rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_TIMEOUT' })

    expect(fsSync.readdirSync(path.dirname(temp.dbPath)).filter((name) => name.includes('.compact-staging-'))).toEqual([])
    temp.cleanup()
  }, 30_000)

  it('redoes the compaction when a write lands between the worker result and the swap', async () => {
    const temp = createTempDatabase('storage-maintenance-window-write-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('base-content');")
    temp.db.flushSave()
    let attempts = 0
    const createWorker = (workerPath: string) => {
      attempts += 1
      if (attempts === 1) {
        const stub = new StubCompactionWorker()
        // 复刻换入窗口写入（B3）：worker 返回前后，同连接落一条忙碌谓词拦不住的写入；
        // worker 内部 data_version 探针特意报匹配，只能靠换入前的文件快照复核兜住。
        stub.postMessage = (value: unknown) => {
          queueMicrotask(() => {
            conn.exec("INSERT INTO maintenance_payload VALUES('window-write')")
            stub.emit('message', snapshotMismatchResult(1, 1))
          })
        }
        return stub as unknown as Worker
      }
      const real = spawnSessionMaintenanceSourceWorker(workerPath)
      const proxy = new StubCompactionWorker()
      proxy.postMessage = (value: unknown) => real.postMessage(value)
      proxy.terminate = () => real.terminate()
      real.on('message', (message) => proxy.emit('message', message))
      real.once('error', (error) => proxy.emit('error', error))
      real.once('exit', (code) => proxy.emit('exit', code))
      return proxy as unknown as Worker
    }

    const result = await compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker })

    expect(result.snapshotAttempts).toBe(2)
    // 窗口写入必须随重做进入换入后的库（「永不换入过期 staging」）。
    const values = (getDbConnection(temp.db).prepare('SELECT value FROM maintenance_payload ORDER BY rowid').all() as Array<{ value: string }>)
      .map((row) => row.value)
    expect(values).toEqual(['base-content', 'window-write'])
    temp.cleanup()
  }, 30_000)

  it('honors the in-process fallback switch and the worker default', async () => {
    const temp = createTempDatabase('storage-maintenance-execution-target-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec("CREATE TABLE maintenance_payload(value TEXT NOT NULL); INSERT INTO maintenance_payload VALUES('compact-me');")
    temp.db.flushSave()
    const unusedWorker = vi.fn(() => { throw new Error('worker must not fork') })

    vi.stubEnv('SPACEASSISTANT_IN_PROCESS_COMPACT', '1')
    const inProcess = await compactSessionDatabase(temp.db, userDataDir, undefined, { createWorker: unusedWorker as never })
    expect(inProcess.executionTarget).toBe('in-process')
    expect(inProcess.vacuumMode).toBe('none')
    expect(unusedWorker).not.toHaveBeenCalled()
    vi.unstubAllEnvs()

    const viaWorker = await compactSessionDatabase(temp.db, userDataDir)
    expect(viaWorker.executionTarget).toBe('worker')
    expect(JSON.parse(await fs.readFile(viaWorker.manifestPath, 'utf8'))).toMatchObject({ status: 'complete', executionTarget: 'worker' })
    temp.cleanup()
  })
})

describe('interrupted compaction reconciliation', () => {
  it('removes stale staging artifacts when the live database survived', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-reconcile-live-'))
    const livePath = path.join(dir, 'test.db')
    await fs.writeFile(livePath, 'live-bytes')
    await fs.writeFile(livePath + '.compact-staging-1-a', 'stale')
    await fs.writeFile(livePath + '.compact-staging-1-a-wal', 'stale-wal')

    expect(reconcileInterruptedCompaction(livePath)).toEqual({ recoveredAtSwap: false, removedStaleStaging: 2 })

    expect(await fs.readFile(livePath, 'utf8')).toBe('live-bytes')
    expect(fsSync.readdirSync(dir).filter((name) => name.includes('.compact-staging-'))).toEqual([])
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('completes the swap when the live database is missing and a staging snapshot remains', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compact-reconcile-swap-'))
    const livePath = path.join(dir, 'test.db')
    // 先写较旧的快照再写较新的：对账按 mtime（平局按名字）取最新，名称与时间需同向。
    await fs.writeFile(livePath + '.compact-staging-1-old', 'older-orphan')
    await fs.writeFile(livePath + '.compact-staging-2-b', 'compacted-bytes')

    const recovery = reconcileInterruptedCompaction(livePath)

    expect(recovery).toEqual({ recoveredAtSwap: true, removedStaleStaging: 1 })
    expect(await fs.readFile(livePath, 'utf8')).toBe('compacted-bytes')
    expect(JSON.parse(await fs.readFile(livePath + '.compact-recovery.json', 'utf8'))).toMatchObject({ recoveredAtSwap: true })
    expect(fsSync.readdirSync(dir).filter((name) => name.includes('.compact-staging-'))).toEqual([])
    await fs.rm(dir, { recursive: true, force: true })
  })
})
