import { describe, expect, it } from 'vitest'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { openDatabase } from '../database'
import { createRemoteAuthorizationEpochStore } from './remoteAuthorizationEpochStore'
import { runMigrations } from '../database/migrations'

describe('persistent remote authorization epoch', () => {
  it('increments monotonically per channel and survives database reopen', () => {
    const temp = createTempDatabase('remote-auth-epoch-')
    const first = createRemoteAuthorizationEpochStore(temp.db)
    expect(first.initialize()).toEqual({ feishu: 1, wechat: 1 })
    expect(first.advance('feishu', 'owner-cleared')).toBe(2)
    expect(first.advance('feishu', 'allowlist-changed')).toBe(3)
    temp.db.close()

    const reopenedDb = openDatabase(temp.dbPath)
    const reopened = createRemoteAuthorizationEpochStore(reopenedDb)
    expect(reopened.initialize()).toEqual({ feishu: 3, wechat: 1 })
    expect(reopened.advance('wechat', 'logout')).toBe(2)
    reopenedDb.close()
  })

  it('persists a session scope on revocation rows for precise startup replay', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    store.advance('feishu', 'session_deleted', 10, 'session-1')
    expect(store.pendingRevocations()).toEqual([{ channel: 'feishu', epoch: 2, reason: 'session_deleted', createdAt: 10, sessionId: 'session-1' }])
    db.close()
  })

  it('fails closed when an initialized epoch row is missing', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    store.initialize()
    getDbConnection(db).prepare('DELETE FROM remote_authorization_epochs WHERE channel=?').run('feishu')
    expect(() => store.current('feishu')).toThrow(/AUTHORIZATION_EPOCH/)
    db.close()
  })

  it('fails closed for malformed epoch data instead of returning zero', () => {
    const db = createMemoryAppDb()
    const store = createRemoteAuthorizationEpochStore(db)
    store.initialize()
    getDbConnection(db).prepare('UPDATE remote_authorization_epochs SET epoch=epoch+0.5 WHERE channel=?').run('wechat')
    expect(() => store.current('wechat')).toThrow(/AUTHORIZATION_EPOCH/)
    db.close()
  })

  it('v73 migration creates epoch and revocation journal with a nonzero baseline', () => {
    const db = createMemoryAppDb()
    const conn = getDbConnection(db)
    conn.exec('DROP TABLE remote_authorization_revocations; DROP TABLE remote_authorization_epochs; UPDATE schema_meta SET value=\'73\' WHERE key=\'schema_version\'')
    runMigrations(conn)
    expect(conn.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get()).toEqual({ value: '82' })
    expect(conn.prepare('SELECT channel,epoch FROM remote_authorization_epochs ORDER BY channel').all()).toEqual([
      { channel: 'feishu', epoch: 1 }, { channel: 'wechat', epoch: 1 }
    ])
    db.close()
  })
})
