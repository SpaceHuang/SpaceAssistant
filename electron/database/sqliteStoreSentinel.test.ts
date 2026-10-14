import { describe, expect, it, vi, afterEach } from 'vitest'
import { getDbConnection, reopenDatabaseConnection } from './sqliteStore'
import { createTempDatabase } from './testHelpers'

/**
 * D4 旧连接哨兵：压缩换入（db.close() → reopenDatabaseConnection）后，闭包捕获的旧
 * DatabaseSync 仍被调用时必须先打点再按原语义抛 `database is not open`，
 * 便于同类回归在测试期暴露（不影响失败行为，不做自愈）。
 */
describe('closed connection sentinel', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('close 后旧连接被调用：console.error 打点一次，且仍按原语义抛 database is not open', () => {
    const { db, cleanup } = createTempDatabase('conn-sentinel-')
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const staleConn = getDbConnection(db)
      db.close()

      expect(() => staleConn.prepare('SELECT 1')).toThrow('database is not open')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(String(errorSpy.mock.calls[0]?.[0])).toContain('closed database connection')
      expect(String(errorSpy.mock.calls[0]?.[1] ?? '')).toContain('sqliteStoreSentinel.test.ts')

      expect(() => staleConn.exec('SELECT 1')).toThrow('database is not open')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(() => staleConn.prepare('SELECT 1')).toThrow('database is not open')
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      cleanup()
    }
  })

  it('压缩换入序列：旧连接触发哨兵，换入后的新连接读写正常', () => {
    const { db, cleanup } = createTempDatabase('conn-sentinel-swap-')
    try {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const staleConn = getDbConnection(db)
      db.close()
      reopenDatabaseConnection(db)

      expect(() => staleConn.prepare('SELECT 1')).toThrow('database is not open')
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS c FROM sessions').get()).toEqual({ c: 0 })
    } finally {
      cleanup()
    }
  })
})
