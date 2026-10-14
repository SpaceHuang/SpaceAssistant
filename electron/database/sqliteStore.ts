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
type DbSaveHandle = { schedule: () => void; flushNow: () => void; setSuspended: (value: boolean) => void }
const saveHandleMap = new WeakMap<AppDatabase, DbSaveHandle>()

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
  const saveHandle = createDebouncedDbSave(() => checkpoint(false))

  const db: AppDatabase = {
    filePath: dbPath,
    save: saveHandle.schedule,
    flushSave: () => {
      saveHandle.flushNow()
      checkpoint(true)
    },
    close: () => {
      saveHandle.flushNow()
      checkpoint(true)
      conn.close()
      connMap.delete(db)
      saveHandleMap.delete(db)
    }
  }

  connMap.set(db, conn)
  saveHandleMap.set(db, { schedule: saveHandle.schedule, flushNow: saveHandle.flushNow, setSuspended: saveHandle.setSuspended })
  return db
}

/**
 * 挂起/恢复防抖 checkpoint（压缩换入窗口专用）：挂起期间 save() 只记脏标记，
 * 不再写主库文件，worker 归档复制得以读到稳定快照；显式 flushSave 不受影响。
 */
export function setDatabaseSaveSuspended(db: AppDatabase, suspended: boolean): void {
  saveHandleMap.get(db)?.setSuspended(suspended)
}

/**
 * 为既有 AppDatabase 换入全新底层连接（压缩换入临界区专用）。
 * 必须保持对象身份不变——主进程各持有方（IPC ctx、history、调度器）都捕获了同一个 AppDatabase 引用。
 * 调用方必须持有维护 fence，保证窗口内无并发访问；schema 初始化由换入前的校验承担，此处不做。
 */
export function reopenDatabaseConnection(db: AppDatabase): AppDatabase {
  const conn = new DatabaseSync(db.filePath, { timeout: DEFAULT_BUSY_TIMEOUT_MS })
  configureConnection(conn)
  const saveHandle = createDebouncedDbSave(() => walCheckpoint(conn, false))
  Object.assign(db, {
    save: saveHandle.schedule,
    flushSave: () => {
      saveHandle.flushNow()
      walCheckpoint(conn, true)
    },
    close: () => {
      saveHandle.flushNow()
      walCheckpoint(conn, true)
      conn.close()
      connMap.delete(db)
      saveHandleMap.delete(db)
    }
  })
  connMap.set(db, conn)
  saveHandleMap.set(db, { schedule: saveHandle.schedule, flushNow: saveHandle.flushNow, setSuspended: saveHandle.setSuspended })
  return db
}

/** Open an existing database without schema initialization, migration, WAL configuration, or write capability. */
export function openSqliteDatabaseReadOnly(dbPath: string): AppDatabase {
  const conn = new DatabaseSync(dbPath, { readOnly: true })
  const db: AppDatabase = {
    filePath: dbPath,
    save: () => undefined,
    flushSave: () => undefined,
    close: () => {
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
