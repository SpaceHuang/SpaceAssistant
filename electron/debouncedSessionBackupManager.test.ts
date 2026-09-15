import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
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
})
