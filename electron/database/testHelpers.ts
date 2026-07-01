import fs from 'fs'
import os from 'os'
import path from 'path'
import { setConfigValue } from './operations'
import { openDatabase, type AppDatabase } from './index'
import { openSqliteDatabase } from './sqliteStore'

export function createMemoryAppDb(locale: 'zh-CN' | 'en-US' = 'zh-CN'): AppDatabase {
  const db = openSqliteDatabase(':memory:')
  setConfigValue(db, 'config.locale', locale)
  return db
}

export function createTempDatabase(prefix: string): { db: AppDatabase; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dbPath = path.join(dir, 'test.db')
  const db = openDatabase(dbPath)
  return {
    db,
    dbPath,
    cleanup: () => {
      try {
        db.close()
      } catch {
        /* ignore */
      }
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(`${dbPath}${suffix}`)
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }
}

export function openMemoryDatabase(): AppDatabase {
  return openDatabase(':memory:')
}
