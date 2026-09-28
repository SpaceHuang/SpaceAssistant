import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DebouncedSessionBackupManager, SESSION_BACKUP_DEBOUNCE_MS } from './debouncedSessionBackupManager'
import { arrayMessagePageReader } from './sessionBackupManager'
import type { SessionBackupManager } from './sessionBackupManager'
import type { Session } from '../src/shared/domainTypes'

describe('DebouncedSessionBackupManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces backup writes', async () => {
    const backupSession = vi.fn().mockResolvedValue(undefined)
    const inner = { backupSession, deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const mgr = new DebouncedSessionBackupManager(inner)
    const session = { id: 's1' } as Session
    const readPage = arrayMessagePageReader([])

    mgr.schedule('s1', async () => ({ session, readPage }))
    expect(backupSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3000)
    expect(backupSession).toHaveBeenCalledTimes(1)
  })

  it('flush writes immediately', async () => {
    const backupSession = vi.fn().mockResolvedValue(undefined)
    const inner = { backupSession, deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const mgr = new DebouncedSessionBackupManager(inner)
    const session = { id: 's1' } as Session
    const readPage = arrayMessagePageReader([])

    mgr.schedule('s1', async () => ({ session, readPage }))
    await mgr.flush('s1', async () => ({ session, readPage }))
    expect(backupSession).toHaveBeenCalledTimes(1)
  })

  it('retries a failed backup with bounded attempts', async () => {
    const backupSession = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined)
    const inner = { backupSession, deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const mgr = new DebouncedSessionBackupManager(inner)

    const promise = mgr.backupWithRetry({ id: 's1' } as Session, arrayMessagePageReader([]))
    await vi.advanceTimersByTimeAsync(250)
    await promise

    expect(backupSession).toHaveBeenCalledTimes(2)
  })

  it('retries deletion in the background and reports terminal failure', async () => {
    const deleteBackup = vi.fn().mockRejectedValue(new Error('permanent'))
    const inner = { backupSession: vi.fn(), deleteBackup } as unknown as SessionBackupManager
    const mgr = new DebouncedSessionBackupManager(inner)
    const onError = vi.fn()

    mgr.deleteBackupWithRetry({ id: 's1' } as Session, 3, onError)
    await vi.advanceTimersByTimeAsync(1000)

    expect(deleteBackup).toHaveBeenCalledTimes(3)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })

  // 评审 1.2：schedule 的防抖备份链无调用方 await，rejection 必须被链尾 .catch 吞掉并经
  // onBackgroundError 上报——否则 unhandledRejection 直接崩溃主进程。
  it('schedule 失败链（loadSessionAndMessages reject）经 onBackgroundError 上报且不逃逸', async () => {
    const inner = { backupSession: vi.fn(), deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const onError = vi.fn()
    const mgr = new DebouncedSessionBackupManager(inner, onError)
    const boom = new Error('db closed')

    mgr.schedule('s1', async () => { throw boom })
    await vi.advanceTimersByTimeAsync(SESSION_BACKUP_DEBOUNCE_MS)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom, 's1')
  })

  it('schedule 失败链（backupSession reject）经 onBackgroundError 上报且不逃逸', async () => {
    const boom = new Error('disk full')
    const inner = { backupSession: vi.fn().mockRejectedValue(boom), deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const onError = vi.fn()
    const mgr = new DebouncedSessionBackupManager(inner, onError)
    const session = { id: 's1' } as Session
    const readPage = arrayMessagePageReader([])

    mgr.schedule('s1', async () => ({ session, readPage }))
    await vi.advanceTimersByTimeAsync(SESSION_BACKUP_DEBOUNCE_MS)

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(boom, 's1')
  })

  // 评审 2.2：退出流程 flush 挂起备份的前置——pending 集合可枚举、flushAll 后清空。
  it('getPendingSessionIds 返回挂起会话，flushAll 后清空', async () => {
    const inner = { backupSession: vi.fn().mockResolvedValue(undefined), deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const mgr = new DebouncedSessionBackupManager(inner)
    const readPage = arrayMessagePageReader([])

    mgr.schedule('s1', async () => ({ session: { id: 's1' } as Session, readPage }))
    mgr.schedule('s2', async () => ({ session: { id: 's2' } as Session, readPage }))
    expect(mgr.getPendingSessionIds()).toEqual(expect.arrayContaining(['s1', 's2']))

    await mgr.flushAll(['s1', 's2'], async (id) => ({ session: { id } as Session, readPage }))
    expect(mgr.getPendingSessionIds()).toEqual([])
  })
})
