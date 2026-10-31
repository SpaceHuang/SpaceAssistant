import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionBackupLifecycle } from './sessionBackupLifecycle'
import { arrayMessagePageReader } from './sessionBackupManager'
import type { SessionBackupManager } from './sessionBackupManager'
import type { Session } from '../src/shared/domainTypes'

describe('SessionBackupLifecycle', () => {
  afterEach(() => vi.useRealTimers())

  it('writes only when the explicit backup capability is called', async () => {
    const backupSession = vi.fn().mockResolvedValue(undefined)
    const inner = { backupSession, deleteBackup: vi.fn() } as unknown as SessionBackupManager
    const lifecycle = new SessionBackupLifecycle(inner)

    await lifecycle.backupImmediate({ id: 's1' } as Session, arrayMessagePageReader([]))

    expect(backupSession).toHaveBeenCalledTimes(1)
    expect(backupSession).toHaveBeenCalledWith({ id: 's1' }, expect.any(Function))
  })

  it('keeps bounded retry for required session deletion cleanup', async () => {
    vi.useFakeTimers()
    const deleteBackup = vi.fn().mockRejectedValue(new Error('disk unavailable'))
    const inner = { backupSession: vi.fn(), deleteBackup } as unknown as SessionBackupManager
    const lifecycle = new SessionBackupLifecycle(inner)
    const onError = vi.fn()

    lifecycle.deleteBackupWithRetry({ id: 's1' } as Session, 2, onError)
    await vi.advanceTimersByTimeAsync(300)

    expect(deleteBackup).toHaveBeenCalledTimes(2)
    expect(onError).toHaveBeenCalledWith(expect.any(Error))
  })
})
