import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, deleteQueuedUserMessage, deleteSession, appendMessage, enqueueQueuedUserMessage, updateSession, type AppDatabase } from './index'
import { createTempDatabase } from './testHelpers'
import {
  bumpScopeVersionInTx,
  getScopeVersion,
  resetInvalidationBroadcaster,
  setInvalidationBroadcaster
} from './scopeVersion'
import { runInTransaction } from './transaction'
import { getDbConnection } from './index'

describe('scopeVersion(Storage 版本号,偏差 11 权威源)', () => {
  let db: AppDatabase
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDatabase('sa-scopever-')
    db = temp.db
    cleanup = temp.cleanup
    resetInvalidationBroadcaster()
  })

  afterEach(() => {
    resetInvalidationBroadcaster()
    cleanup()
  })

  it('初始版本为 0,bump 后单调递增', () => {
    expect(getScopeVersion(db, 'session-list')).toBe(0)
    bumpScopeVersionInTx(db, 'session-list')
    bumpScopeVersionInTx(db, 'session-list')
    expect(getScopeVersion(db, 'session-list')).toBe(2)
    expect(getScopeVersion(db, 'session:s1')).toBe(0)
  })

  it('同事务回滚时版本一并回滚(Storage 在事务内递增的不变量)', () => {
    const conn = getDbConnection(db)
    expect(() =>
      runInTransaction(conn, () => {
        bumpScopeVersionInTx(db, 'session-list')
        expect(getScopeVersion(db, 'session-list')).toBe(1)
        throw new Error('rollback')
      })
    ).toThrow('rollback')
    expect(getScopeVersion(db, 'session-list')).toBe(0)
  })

  it('提交后经微任务广播一次;同 scope 多次 bump 合并为一条(版本取最新)', async () => {
    const broadcaster = vi.fn()
    setInvalidationBroadcaster(broadcaster)
    bumpScopeVersionInTx(db, 'session-list')
    bumpScopeVersionInTx(db, 'session-list')
    bumpScopeVersionInTx(db, 'session:s1:messages')
    await new Promise((r) => setTimeout(r, 0))
    expect(broadcaster).toHaveBeenCalledTimes(2)
    expect(broadcaster).toHaveBeenCalledWith('session-list', 2)
    expect(broadcaster).toHaveBeenCalledWith('session:s1:messages', 1)
  })

  it('业务写路径:创建/更新/删除会话在同一事务内递增 session-list 与 session:<id>', async () => {
    const broadcaster = vi.fn()
    setInvalidationBroadcaster(broadcaster)
    const session = createSession(db, { name: 'a' })
    const updated = updateSession(db, session.id, { name: 'b' })
    expect(updated?.name).toBe('b')
    deleteSession(db, session.id)
    await new Promise((r) => setTimeout(r, 0))
    // 同 scope 多次递增合并为一次广播(版本取最新)
    const calls = Object.fromEntries(broadcaster.mock.calls.map((c) => [c[0] as string, c[1] as number]))
    expect(broadcaster.mock.calls.filter((c) => c[0] === 'session-list')).toHaveLength(1)
    expect(calls['session-list']).toBeGreaterThanOrEqual(3)
    expect(calls[`session:${session.id}`]).toBeGreaterThanOrEqual(1)
  })

  it('业务写路径:消息追加/排队删除递增 session:<id>:messages', async () => {
    const broadcaster = vi.fn()
    setInvalidationBroadcaster(broadcaster)
    const session = createSession(db, { name: 'm' })
    appendMessage(db, { id: 'm1', sessionId: session.id, role: 'user', content: 'x', timestamp: 1, status: 'sent' })
    const enq = enqueueQueuedUserMessage(db, { sessionId: session.id, requestId: 'r1', content: 'q' })
    deleteQueuedUserMessage(db, enq.persisted.message.id)
    await new Promise((r) => setTimeout(r, 0))
    const calls = Object.fromEntries(broadcaster.mock.calls.map((c) => [c[0] as string, c[1] as number]))
    expect(broadcaster.mock.calls.filter((c) => c[0] === `session:${session.id}:messages`)).toHaveLength(1)
    expect(calls[`session:${session.id}:messages`]).toBeGreaterThanOrEqual(2)
    expect(calls['session-list']).toBeGreaterThanOrEqual(2)
  })
})
