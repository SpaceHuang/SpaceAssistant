import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { runSessionMaintenanceWorker, spawnSessionMaintenanceSourceWorker } from './sessionStorageMaintenanceWorkerClient'

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  const { createReadStream } = await import('node:fs')
  const stream = createReadStream(filePath)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

describe('session storage maintenance worker', () => {
  it('copies the archive, vacuums into staging and reports progress at a bounded rate', async () => {
    const temp = createTempDatabase('maintenance-worker-')
    const userDataDir = path.dirname(temp.dbPath)
    const conn = getDbConnection(temp.db)
    conn.exec(`CREATE TABLE maintenance_payload(value BLOB NOT NULL);
      INSERT INTO maintenance_payload VALUES(zeroblob(2000000));
      INSERT INTO maintenance_payload VALUES(zeroblob(300000));
      DELETE FROM maintenance_payload WHERE length(value)=300000;`)
    const spillRoot = path.join(userDataDir, 'spill')
    await fs.mkdir(spillRoot)
    await fs.writeFile(path.join(spillRoot, 'a.spill'), Buffer.alloc(4000, 1))
    temp.db.flushSave()
    const archivePath = path.join(userDataDir, 'session-archives', 'worker-fixture')
    const stagingPath = path.join(userDataDir, 'worker-staging.db')
    const progress: Array<{ at: number }> = []

    const result = await runSessionMaintenanceWorker(
      { dbPath: temp.dbPath, archivePath, spillRoot, degradedSpillRoot: path.join(userDataDir, 'spill-degraded'), stagingPath },
      { onProgress: () => progress.push({ at: Date.now() }) }
    )

    expect(result.type).toBe('result')
    expect(result.dataVersionBefore).toBe(result.dataVersionAfter)
    expect(result.dbSourceSha256).toBe(await sha256File(temp.dbPath))
    expect(result.dbDestSha256).toBe(result.dbSourceSha256)
    expect(result.spillSourceManifest).toHaveLength(1)
    expect(result.spillDegradedSourceManifest).toEqual([])
    expect(result.stagingBytes).toBeGreaterThan(0)
    expect(result.stagingBytes).toBeLessThan(result.archiveBytes)
    const staging = new DatabaseSync(stagingPath, { readOnly: true })
    expect(staging.prepare('PRAGMA freelist_count').get()).toEqual({ freelist_count: 0 })
    expect(staging.prepare('SELECT COUNT(*) AS c FROM maintenance_payload WHERE length(value)=2000000').get()).toEqual({ c: 1 })
    staging.close()
    // 进度节流：任意 1 秒窗口内不超过 10 条（≥100ms 间隔或 ≥8MB 步进）。
    progress.sort((left, right) => left.at - right.at)
    for (let start = 0; start < progress.length; start += 1) {
      const windowEnd = progress[start].at + 1000
      const inWindow = progress.filter((event) => event.at >= progress[start].at && event.at <= windowEnd)
      expect(inWindow.length).toBeLessThanOrEqual(10)
    }
    temp.cleanup()
  }, 30_000)

  it('reports a worker error when the archived copy fails quick_check', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maintenance-worker-bad-'))
    const dbPath = path.join(dir, 'not-a.db')
    await fs.writeFile(dbPath, 'definitely not a database')
    const archivePath = path.join(dir, 'archive')
    const stagingPath = path.join(dir, 'staging.db')

    await expect(runSessionMaintenanceWorker(
      { dbPath, archivePath, spillRoot: path.join(dir, 'spill'), degradedSpillRoot: path.join(dir, 'spill-degraded'), stagingPath },
      {}
    )).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_FAILED' })

    await fs.rm(dir, { recursive: true, force: true })
  }, 30_000)

  it('reports a worker error when VACUUM INTO cannot create the staging file', async () => {
    const temp = createTempDatabase('maintenance-worker-staging-fail-')
    temp.db.flushSave()
    const archivePath = path.join(path.dirname(temp.dbPath), 'archive')
    const stagingPath = path.join(path.dirname(temp.dbPath), 'missing-dir', 'staging.db')

    await expect(runSessionMaintenanceWorker(
      { dbPath: temp.dbPath, archivePath, spillRoot: path.join(path.dirname(temp.dbPath), 'spill'),
        degradedSpillRoot: path.join(path.dirname(temp.dbPath), 'spill-degraded'), stagingPath },
      {}
    )).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_FAILED' })

    temp.cleanup()
  }, 30_000)

  it('reports entry-unavailable when the worker source cannot be loaded', async () => {
    const temp = createTempDatabase('maintenance-worker-fallback-')
    const missingSourcePath = path.join(os.tmpdir(), 'missing-compaction-worker.ts')

    await expect(runSessionMaintenanceWorker(
      { dbPath: temp.dbPath, archivePath: temp.dbPath, spillRoot: '', degradedSpillRoot: '', stagingPath: '' },
      { workerPath: missingSourcePath }
    )).rejects.toMatchObject({ code: 'STORAGE_MAINTENANCE_FAILED' })
    temp.cleanup()
  })

  it('boots the source worker through the shared tsx bootstrap', async () => {
    // 与 profile worker 同一条锚定引导路径：能构造出 worker 即证明 tsx 解析可用。
    const workerPath = path.join(process.cwd(), 'electron/storage/sessionStorageMaintenanceWorker.ts')
    const worker = spawnSessionMaintenanceSourceWorker(workerPath)
    const exited = new Promise<number>((resolve) => worker.once('exit', (code) => resolve(code)))
    const exitCode = await worker.terminate()
    expect(await exited).toBe(exitCode)
  })
})
