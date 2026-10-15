import { describe, expect, it } from 'vitest'
import { Worker } from 'node:worker_threads'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * P3-① (plan §5): before locking the worker_threads execution model for canonical rebuilds,
 * probe that the target Node runtime loads node:sqlite inside a worker and can read a WAL
 * database opened by the main thread (plan review 4.3 — probe first, then commit).
 */

const workerCode = `
const { parentPort, workerData } = require('node:worker_threads')
try {
  const { DatabaseSync } = require('node:sqlite')
  const conn = new DatabaseSync(workerData.databasePath, { readOnly: true })
  const row = conn.prepare('SELECT value FROM probe WHERE key=\\'answer\\'').get()
  const { createHash } = require('node:crypto')
  parentPort.postMessage({ ok: true, value: row.value, sha256: createHash('sha256').update(row.value).digest('hex') })
  conn.close()
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) })
}
`

describe('worker_threads node:sqlite probe (P3-①)', () => {
  it('loads node:sqlite in a worker and reads a WAL database opened by the main thread', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-sqlite-probe-'))
    const databasePath = path.join(dir, 'probe.sqlite')
    const { DatabaseSync } = await import('node:sqlite')
    const writer = new DatabaseSync(databasePath)
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE probe(key TEXT PRIMARY KEY, value TEXT NOT NULL);')
    writer.prepare('INSERT INTO probe(key, value) VALUES(?, ?)').run('answer', 'worker-sqlite-ok')

    const result = await new Promise<{ ok: boolean; value?: string; sha256?: string; message?: string }>((resolve, reject) => {
      const worker = new Worker(workerCode, { eval: true, workerData: { databasePath } })
      worker.once('message', (message) => { void worker.terminate(); resolve(message) })
      worker.once('error', (error) => { void worker.terminate(); reject(error) })
    })

    writer.close()
    fs.rmSync(dir, { recursive: true, force: true })
    expect(result).toMatchObject({ ok: true, value: 'worker-sqlite-ok' })
    expect(result.sha256).toBe(createHash('sha256').update('worker-sqlite-ok').digest('hex'))
  }, 30_000)
})
