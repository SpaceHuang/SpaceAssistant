import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { DebouncedSessionBackupManager } from './debouncedSessionBackupManager'
import type { SessionBackupManager } from './sessionBackupManager'
import type { Message, Session } from '../src/shared/domainTypes'

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
    const messages = [] as Message[]

    mgr.schedule('s1', async () => ({ session, messages }))
    expect(backupSession).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(3000)
    expect(backupSession).toHaveBeenCalledTimes(1)
  })

  it('flush writes immediately', async () => {
    const backupSession = vi.fn().mockResolvedValue(undefined)
    const inner = { backupSession, deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const mgr = new DebouncedSessionBackupManager(inner)
    const session = { id: 's1' } as Session

    mgr.schedule('s1', async () => ({ session, messages: [] }))
    await mgr.flush('s1', async () => ({ session, messages: [] }))
    expect(backupSession).toHaveBeenCalledTimes(1)
  })
})
