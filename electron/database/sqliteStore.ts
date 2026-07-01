import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { createDebouncedDbSave } from '../dbSaveScheduler'
import { CREATE_TABLES_SQL, DB_SCHEMA_VERSION, SCHEMA_META_KEYS } from './schema'

export type AppDatabase = {
  readonly filePath: string
  /** 防抖 WAL checkpoint（兼容旧 save API） */
  save: () => void
  /** 立即 checkpoint + 确保落盘 */
  flushSave: () => void
  close: () => void
}

const connMap = new WeakMap<AppDatabase, Database.Database>()

export function getDbConnection(db: AppDatabase): Database.Database {
  const conn = connMap.get(db)
  if (!conn) throw new Error('Database connection is closed')
  return conn
}

function getBetterSqlite3Root(): string {
  try {
    return path.dirname(require.resolve('better-sqlite3/package.json'))
  } catch {
    return path.join(__dirname, '../../node_modules/better-sqlite3')
  }
}

/** asar 打包后原生模块在 app.asar.unpacked，需映射到真实路径 */
function resolveAsarUnpacked(filePath: string): string {
  if (fs.existsSync(filePath)) return filePath
  const unpacked = filePath.replace(/app\.asar([/\\])/g, 'app.asar.unpacked$1')
  if (unpacked !== filePath && fs.existsSync(unpacked)) return unpacked
  return filePath
}

/**
 * Node 与 Electron ABI 不同，需加载对应预编译 .node。
 * nativeBinding 路径必须以 .node 结尾，否则 better-sqlite3 会再追加 .node。
 */
function resolveNativeBinding(): string | undefined {
  const release = path.join(getBetterSqlite3Root(), 'build/Release')
  const isElectron = Boolean(process.versions.electron)
  const candidates = isElectron
    ? ['electron/better_sqlite3.node', 'better_sqlite3.node']
    : ['node/better_sqlite3.node', 'better_sqlite3.node']

  for (const rel of candidates) {
    const resolved = resolveAsarUnpacked(path.join(release, rel))
    if (fs.existsSync(resolved)) return resolved
  }
  return undefined
}

function openDatabaseConnection(dbPath: string): Database.Database {
  const nativeBinding = resolveNativeBinding()
  if (nativeBinding) {
    return new Database(dbPath, { nativeBinding })
  }
  return new Database(dbPath)
}

function configureConnection(conn: Database.Database): void {
  conn.pragma('journal_mode = WAL')
  conn.pragma('foreign_keys = ON')
  conn.pragma('synchronous = NORMAL')
}

function initSchema(conn: Database.Database): void {
  conn.exec(CREATE_TABLES_SQL)
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(SCHEMA_META_KEYS.schemaVersion) as
    | { value: string }
    | undefined
  if (!row) {
    conn.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)').run(
      SCHEMA_META_KEYS.schemaVersion,
      String(DB_SCHEMA_VERSION)
    )
  }
}

function walCheckpoint(conn: Database.Database, truncate = false): void {
  conn.pragma(truncate ? 'wal_checkpoint(TRUNCATE)' : 'wal_checkpoint(PASSIVE)')
}

export function openSqliteDatabase(dbPath: string): AppDatabase {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const conn = openDatabaseConnection(dbPath)
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

export function isDatabaseEmpty(conn: Database.Database): boolean {
  const sessionCount = (conn.prepare('SELECT COUNT(*) AS c FROM sessions').get() as { c: number }).c
  const configCount = (conn.prepare('SELECT COUNT(*) AS c FROM configs').get() as { c: number }).c
  return sessionCount === 0 && configCount === 0
}

export function getSchemaMeta(conn: Database.Database, key: string): string | undefined {
  const row = conn.prepare('SELECT value FROM schema_meta WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value
}

export function setSchemaMeta(conn: Database.Database, key: string, value: string): void {
  conn.prepare('INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)').run(key, value)
}
