import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import { createDebouncedDbSave } from '../dbSaveScheduler'
import { CREATE_TABLES_SQL } from './schema'
import { runMigrations } from './migrations'

/**
 * 生产默认 busy timeout（ms），与旧 better-sqlite3 构造器默认 timeout=5000 对齐；
 * node:sqlite 默认 busy_timeout=0（锁争用立即抛错），必须显式设置（评审阻断 1）。
 */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000

export type OpenSqliteDatabaseOptions = {
  /** busy timeout（ms），默认 DEFAULT_BUSY_TIMEOUT_MS；测试可注入短超时验证等待行为 */
  busyTimeoutMs?: number
}

export type AppDatabase = {
  readonly filePath: string
  /** 防抖 WAL checkpoint（兼容旧 save API） */
  save: () => void
  /** 立即 checkpoint + 确保落盘 */
  flushSave: () => void
  close: () => void
}

const connMap = new WeakMap<AppDatabase, DatabaseSync>()

export function getDbConnection(db: AppDatabase): DatabaseSync {
  const conn = connMap.get(db)
  if (!conn) throw new Error('Database connection is closed')
  return conn
}

function configureConnection(conn: DatabaseSync): void {
  conn.exec('PRAGMA journal_mode = WAL')
  conn.exec('PRAGMA foreign_keys = ON')
  conn.exec('PRAGMA synchronous = NORMAL')
}

function initSchema(conn: DatabaseSync): void {
  conn.exec(CREATE_TABLES_SQL)
  runMigrations(conn)
}

function walCheckpoint(conn: DatabaseSync, truncate = false): void {
  conn.exec(truncate ? 'PRAGMA wal_checkpoint(TRUNCATE)' : 'PRAGMA wal_checkpoint(PASSIVE)')
}

export function openSqliteDatabase(dbPath: string, options?: OpenSqliteDatabaseOptions): AppDatabase {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const conn = new DatabaseSync(dbPath, { timeout: options?.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS })
  configureConnection(conn)
  initSchema(conn)

  const checkpoint = (truncate: boolean) => walCheckpoint(conn, truncate)
  const { schedule, flushNow } = createDebouncedDbSave(() => checkpoint(false))

  const db: AppDatabase = {
    filePath: dbPath,
    save: schedule,
    flushSave: () => {
      flushNow()
      checkpoint(true)
    },
    close: () => {
      flushNow()
      checkpoint(true)
      conn.close()
      connMap.delete(db)
    }
  }

  connMap.set(db, conn)
  return db
}

export function isDatabaseEmpty(conn: DatabaseSync): boolean {
  const sessionCount = (conn.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c
  const configCount = (conn.prepare('SELECT COUNT(*) AS c FROM configs').get() as { c: number }).c
  return sessionCount === 0 && configCount === 0
}

export function getSchemaMeta(conn: DatabaseSync, key: string): string | undefined {
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSchemaMeta(conn: DatabaseSync, key: string, value: string): void {
  conn.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(key, value)
}
