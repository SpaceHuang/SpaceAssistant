import { describe, expect, it } from 'vitest'
import { createSessionRecoveryPort } from './recovery'
import { createMemoryAppDb } from '../database/testHelpers'
import { appendMessage, createSession } from '../database/operations'
import { createSqliteSessionStorage } from './sqliteSessionStorage'

describe('SessionRecoveryPort', () => {
  it('exposes SQLite readiness as pending before recovery and actual session readiness afterward', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'recovery readiness', model: 'test' })
      appendMessage(db, { id: 'readiness-user', sessionId: session.id, role: 'user', content: 'hello', timestamp: 1, status: 'sent' })
      const storage = createSqliteSessionStorage(db, { recoveryStages: {
        history: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        snapshots: () => ({ restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }),
        coordinator: () => ({ recoveredCount: 0, succeeded: true }),
        reconcile: () => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }),
        continuations: () => ({ interrupted: 0, unknownSideEffect: 0, settled: 0 })
      } })

      expect(storage.recovery.inspectReadiness(session.id)).toEqual({ readable: false, executable: false, reason: 'recovery-pending' })
      await storage.recovery.recover()
      expect(storage.recovery.inspectReadiness(session.id)).toEqual({ readable: true, executable: true })
    } finally {
      db.close()
    }
  })

  it('runs recovery stages in order, shares concurrent work, and reports stage-owned counts', async () => {
    const order: string[] = []
    const port = createSessionRecoveryPort({
      history: async () => { order.push('history'); return { interruptedCount: 2, repairFailureCount: 0 } },
      snapshots: async () => { order.push('snapshots'); return { restoredCount: 3, skippedCanonicalUnavailableCount: 1, missingAssistantCount: 2 } },
      coordinator: async () => { order.push('coordinator'); return { recoveredCount: 4, succeeded: true } },
      hasUnfinishedProjections: () => { order.push('fence'); return false },
      reconcile: () => { order.push('reconcile'); return { releasedUnstarted: 1, markedUncertain: 2, repairedCheckpoints: 3, reconciled: 4 } },
      continuations: (recoveryReady) => { order.push(`continuations:${recoveryReady}`); return { interrupted: 5, unknownSideEffect: 6, settled: 7 } },
      inspectReadiness: () => ({ readable: true, executable: true })
    })

    const [first, concurrent] = await Promise.all([port.recover(), port.recover()])

    expect(first).toEqual(concurrent)
    expect(order).toEqual(['history', 'snapshots', 'coordinator', 'fence', 'fence', 'reconcile', 'continuations:true'])
    expect(first).toMatchObject({
      status: 'degraded',
      history: { succeeded: true, interruptedCount: 2, repairFailureCount: 0 },
      snapshots: { restoredCount: 3, skippedCanonicalUnavailableCount: 1, missingAssistantCount: 2 },
      coordinator: { succeeded: true, recoveredCount: 4 },
      reconciliation: { status: 'completed', releasedUnstarted: 1, markedUncertain: 2, repairedCheckpoints: 3, reconciled: 4 },
      continuations: { interrupted: 5, unknownSideEffect: 6, settled: 7 },
      failures: []
    })
    expect(port.inspectReadiness('session')).toEqual({ readable: true, executable: true })
  })

  it('keeps coordinator fences closed and marks continuation outcomes uncertain when History recovery fails', async () => {
    const coordinator = vi.fn(async () => ({ recoveredCount: 1, succeeded: true }))
    const reconcile = vi.fn()
    const continuations = vi.fn((recoveryReady: boolean) => ({ interrupted: 0, unknownSideEffect: recoveryReady ? 0 : 2, settled: 0 }))
    const port = createSessionRecoveryPort({
      history: async () => { throw new Error('history failed') },
      snapshots: async () => ({ restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }),
      coordinator,
      hasUnfinishedProjections: () => false,
      reconcile,
      continuations,
      inspectReadiness: () => ({ readable: false, executable: false, reason: 'recovery-pending' })
    })

    const report = await port.recover()

    expect(coordinator).toHaveBeenCalledOnce()
    expect(reconcile).not.toHaveBeenCalled()
    expect(continuations).toHaveBeenCalledWith(false)
    expect(report).toMatchObject({ status: 'blocked', history: { succeeded: false }, coordinator: { succeeded: true }, reconciliation: { status: 'skipped', reason: 'history-recovery-incomplete' }, continuations: { unknownSideEffect: 2 }, failures: [{ stage: 'history', error: expect.any(Error) }] })
    expect(port.inspectReadiness('session')).toEqual({ readable: false, executable: false, reason: 'recovery-pending' })
  })

  it('runs bound ledger recovery after History and includes its actual failures in the recovery gate', async () => {
    const order: string[] = []
    const port = createSessionRecoveryPort({
      history: async () => { order.push('history'); return { interruptedCount: 1, repairFailureCount: 0 } },
      ledgerRepairs: async () => { order.push('ledger'); return 1 },
      snapshots: () => { order.push('snapshots'); return { restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 } },
      coordinator: () => { order.push('coordinator'); return { recoveredCount: 2, succeeded: true } },
      hasUnfinishedProjections: () => false,
      reconcile: () => { order.push('reconcile'); return { releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 } },
      continuations: (ready) => { order.push(`continuations:${ready}`); return { interrupted: 0, unknownSideEffect: ready ? 0 : 1, settled: 0 } },
      inspectReadiness: () => ({ readable: true, executable: true })
    })

    const report = await port.recover()

    expect(order).toEqual(['history', 'ledger', 'snapshots', 'coordinator', 'continuations:false'])
    expect(report).toMatchObject({ status: 'blocked', history: { interruptedCount: 1, repairFailureCount: 1, succeeded: false }, reconciliation: { status: 'skipped', reason: 'history-recovery-incomplete' } })
  })
})
