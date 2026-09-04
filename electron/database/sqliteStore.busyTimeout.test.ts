import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_BUSY_TIMEOUT_MS, getDbConnection, openSqliteDatabase, type AppDatabase } from './sqliteStore'

/**
 * 回归：迁移到 node:sqlite 后不得丢失 busy timeout（评审阻断 1）。
 * 旧 better-sqlite3 默认 timeout=5000；node:sqlite 默认 0（锁争用立即抛错）。
 */

describe('openSqliteDatabase busy timeout（评审阻断 1）', () => {
  const dirs: string[] = []
  const dbs: AppDatabase[] = []

  afterEach(() => {
    for (const db of dbs.splice(0)) {
      try {
        db.close()
      } catch {
        /* best effort */
      }
    }
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  function open(dbPath: string, busyTimeoutMs?: number): AppDatabase {
    const db = openSqliteDatabase(dbPath, busyTimeoutMs === undefined ? undefined : { busyTimeoutMs })
    dbs.push(db)
    return db
  }
  it('生产默认 busy timeout 为 5000ms（与旧 better-sqlite3 对齐）', () => {
    expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(5000)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-busy-default-'))
    dirs.push(dir)
    const db = open(path.join(dir, 'test.db'))
    const row = getDbConnection(db).prepare('PRAGMA busy_timeout').get() as { timeout: number }
    expect(row.timeout).toBe(5000)
  })

  it('锁争用时等待 busy timeout 而非立即抛错；锁释放后写入成功', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-busy-wait-'))
    dirs.push(dir)
    const dbPath = path.join(dir, 'test.db')
    const dbA = open(dbPath)
    const dbB = open(dbPath, 300)
    const connA = getDbConnection(dbA)
    const connB = getDbConnection(dbB)

    connA.exec('BEGIN IMMEDIATE')
    connA.prepare('INSERT INTO configs (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run('k', 'a', 1, 1)

    const started = Date.now()
    expect(() =>
      connB.prepare('INSERT INTO configs (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run('k2', 'b', 1, 1)
    ).toThrow(/database is locked/i)
    const elapsed = Date.now() - started
    // busy timeout=0 时约 1ms 即抛错；等待实现后应接近 300ms 才抛
    expect(elapsed).toBeGreaterThanOrEqual(200)

    connA.exec('COMMIT')
    expect(() =>
      connB.prepare('INSERT INTO configs (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)').run('k2', 'b', 1, 1)
    ).not.toThrow()
  })
})
