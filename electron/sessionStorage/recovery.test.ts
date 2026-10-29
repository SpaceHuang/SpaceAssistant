import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSessionRecoveryPort } from './recovery'
import { createMemoryAppDb, createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database'
import { appendMessage, createPersistedTurn, createSession } from '../database/operations'
import { createSqliteSessionStorage, createSqliteSessionStorageHost } from './sqliteSessionStorage'
import { createSqliteStartupHistoryRecoveryBindings } from './infrastructure/sqlite/sessionHistoryRecoveryHost'
import { ensureLegacyLedgerReadiness, markMissingLegacyLedgerBlocked } from '../sessionLedgerReadiness'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSessionLedgerRecoveryBindings } from './infrastructure/sqlite/sessionLedgerRecoveryBindings'
import { computeCompactionSummaryHash } from '../../src/shared/compactionEvents'
import { readSessionEvents, resolveSessionEventPaths } from '../sessionEvents'
import type { SessionHistoryRecoveryOptions } from './public/ports'

describe('SessionRecoveryPort', () => {
  it('keeps startup recovery options as an explicit contract type', () => {
    const options: SessionHistoryRecoveryOptions = { onSessionLocationResolveError: () => undefined }
    const bindings = createSqliteStartupHistoryRecoveryBindings(createMemoryAppDb())
    expectTypeOf(bindings.recoverInterruptedInvocations).parameter(0).toEqualTypeOf<SessionHistoryRecoveryOptions | undefined>()
    expect(options).toBeDefined()
  })

  it('exposes startup History recovery operations without exposing the adapter instance', async () => {
    const db = createMemoryAppDb()
    try {
      const history = createSqliteStartupHistoryRecoveryBindings(db)
      expect(history.getStartupRecoveryWorkSummary()).toMatchObject({ hasWork: false })
      await expect(history.classifyLegacyProjectionRepairs(10)).resolves.toMatchObject({ complete: true })
      expect(history.getStartupRecoveryWorkSummary()).toMatchObject({ hasWork: false })
      expect(history).not.toHaveProperty('adapter')
      expect(history).not.toHaveProperty('connection')
    } finally {
      db.close()
    }
  })

  it('owns location validation, ledger fencing, event projection, and sink close during startup History recovery', async () => {
    const temp = createTempDatabase('session-history-host-recovery-')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-history-host-recovery-'))
    try {
      const db = temp.db
      const profilesJson = JSON.stringify([{ id: 'profile', path: root, isDefault: true }])
      const session = createSession(db, { name: 'host history repair', workDirProfileId: 'profile' })
      const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
      const compactionId = 'host-recovery-compaction'
      const candidate = { kind: 'summary', checkpointMessage: { id: 'host-checkpoint', role: 'user', content: 'checkpoint' },
        checkpointReplayIdentity: 'host-checkpoint-identity', shadowedRanges: [{ start: 'before', end: 'before' }] }
      const start = { compactionId, windowId: 'host-window', inputSurfaceFingerprint: 'host-input-fingerprint', surfaceBoundaryId: 'before' }
      const summary = { compactionId, windowId: 'host-window', summaryHash: computeCompactionSummaryHash(candidate),
        outputSurfaceFingerprint: 'host-output-fingerprint', shadowedRanges: candidate.shadowedRanges, candidate }
      await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
        invocationId: 'host-recovery-invocation', turnId: 'host-recovery-turn', sequence: 1, schemaVersion: 1,
        eventId: 'host-recovery-compaction-event', idempotencyKey: 'host-recovery-compaction-event', kind: 'transcript-compacted',
        payload: { messages: [candidate.checkpointMessage], sessionLedger: { location, start, summary } }
      }], 0)
      const ledgerRecovery = createSessionLedgerRecoveryBindings()
      const allowedRoots = ledgerRecovery.getAllowedRoots({ configuredWorkDir: root, profilesJson })
      const ensureReady = vi.fn(async () => true)
      const host = createSqliteStartupHistoryRecoveryBindings(db)

      const result = await host.recoverInterruptedInvocationsWithLedger({ ledgerRecovery, allowedRoots, configuredWorkDir: root, profilesJson,
        ensureSessionLedgerReady: ensureReady })

      expect(result).toMatchObject({ interruptedCount: 1, repairFailureCount: 0 })
      expect(ensureReady).toHaveBeenCalledWith({ location, sessionGeneration: session.generation })
      const events = await readSessionEvents(resolveSessionEventPaths(root, session.id, session.createdAt).eventsPath)
      expect(events.map(({ type }) => type)).toEqual(['compaction_start', 'compaction_summary', 'compaction_end', 'turn_start', 'turn_end'])
      expect(events[1]?.payload).toMatchObject({ candidate: { checkpointReplayIdentity: 'host-checkpoint-identity' } })
    } finally {
      temp.cleanup()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  it('isolates a blocked startup location ledger repair from a healthy location', async () => {
    const temp = createTempDatabase('session-history-host-ledger-failure-')
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-history-host-ledger-failure-'))
    try {
      const db = temp.db
      const profilesJson = JSON.stringify([{ id: 'profile', path: root, isDefault: true }])
      const failedSession = createSession(db, { name: 'host ledger failure', workDirProfileId: 'profile' })
      const healthySession = createSession(db, { name: 'host ledger healthy', workDirProfileId: 'profile' })
      const appendCompaction = async (session: typeof failedSession, suffix: string) => {
        const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
        const compactionId = `host-${suffix}-recovery-compaction`
        const candidate = { kind: 'summary', checkpointMessage: { id: `host-${suffix}-checkpoint`, role: 'user', content: 'checkpoint' },
          checkpointReplayIdentity: `host-${suffix}-checkpoint-identity`, shadowedRanges: [{ start: 'before', end: 'before' }] }
        const start = { compactionId, windowId: `host-${suffix}-window`, inputSurfaceFingerprint: `host-${suffix}-input`, surfaceBoundaryId: 'before' }
        const summary = { compactionId, windowId: `host-${suffix}-window`, summaryHash: computeCompactionSummaryHash(candidate),
          outputSurfaceFingerprint: `host-${suffix}-output`, shadowedRanges: candidate.shadowedRanges, candidate }
        await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, session.id).appendBatch([{
          invocationId: `host-${suffix}-recovery-invocation`, turnId: `host-${suffix}-recovery-turn`, sequence: 1, schemaVersion: 1,
          eventId: `host-${suffix}-recovery-event`, idempotencyKey: `host-${suffix}-recovery-event`, kind: 'transcript-compacted',
          payload: { messages: [candidate.checkpointMessage], sessionLedger: { location, start, summary } }
        }], 0)
      }
      await appendCompaction(failedSession, 'failed')
      await appendCompaction(healthySession, 'healthy')
      const ledgerRecovery = createSessionLedgerRecoveryBindings()
      const startupHistory = createSqliteStartupHistoryRecoveryBindings(db)
      let startupResult: Awaited<ReturnType<typeof startupHistory.recoverInterruptedInvocationsWithLedger>> | undefined
      const storageHost = createSqliteSessionStorageHost(db, {
        storage: { getWorkDirForSession: () => root, recoveryStages: {
          coordinator: () => ({ recoveredCount: 0, succeeded: true }),
          reconcile: () => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }),
          continuations: () => ({ interrupted: 0, unknownSideEffect: 0, settled: 0 })
        } },
        startup: {
          recoverHistory: async () => {
            const result = await startupHistory.recoverInterruptedInvocationsWithLedger({
              ledgerRecovery, allowedRoots: ledgerRecovery.getAllowedRoots({ configuredWorkDir: root, profilesJson }), configuredWorkDir: root, profilesJson,
              ensureSessionLedgerReady: async ({ location, sessionGeneration }) => {
                const readiness = ensureLegacyLedgerReadiness(getDbConnection(db), location, sessionGeneration)
                if (location.sessionId === failedSession.id) {
                  markMissingLegacyLedgerBlocked(getDbConnection(db), readiness.ledgerLocationKey)
                  return false
                }
                getDbConnection(db).prepare("UPDATE session_ledger_projection_state SET state='ready' WHERE ledger_location_key=?").run(readiness.ledgerLocationKey)
                return true
              }
            })
            startupResult = result
            return { interruptedCount: result.interruptedCount, repairFailureCount: result.repairFailureCount + result.pendingRepairCount,
              sessionFailures: result.sessionFailures }
          },
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 })
        }
      })

      const report = await storageHost.storage.recovery.recover()

      expect(report).toMatchObject({ status: 'degraded', history: { succeeded: true, sessionFailures: expect.arrayContaining([
        { sessionId: failedSession.id, invocationId: 'host-failed-recovery-invocation', capability: 'ledger', failureClass: 'ledger-repair-failed' },
        { sessionId: failedSession.id, invocationId: 'host-failed-recovery-invocation', capability: 'ledger', failureClass: 'ledger-repair-failed' },
        expect.objectContaining({ sessionId: failedSession.id, invocationId: 'host-failed-recovery-invocation', capability: 'ledger', failureClass: 'ledger-repair-pending' })
      ]) } })
      expect(startupResult?.pendingRepairCount).toBeGreaterThan(0)
      expect(startupResult?.sessionFailures).toEqual(expect.arrayContaining([
        expect.objectContaining({ sessionId: failedSession.id, invocationId: 'host-failed-recovery-invocation', failureClass: 'ledger-repair-pending' })
      ]))
      expect(storageHost.storage.availability.inspect(failedSession.id)).toMatchObject({
        globalFence: { state: 'degraded' }, content: { state: 'readable' }, execution: { state: 'ready' }, ledger: { state: 'degraded', readinessState: 'blocked', reasonCode: 'ledger-blocked' }
      })
      expect(storageHost.storage.availability.inspect(healthySession.id)).toMatchObject({
        globalFence: { state: 'degraded' }, content: { state: 'readable' }, execution: { state: 'ready' }, ledger: { state: 'ready', readinessState: 'ready' }
      })
    } finally {
      temp.cleanup()
      await fs.rm(root, { recursive: true, force: true })
    }
  })

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

  it('keeps commit-uncertain execution distinct from a generic execution block while content remains readable', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'uncertain readiness', model: 'test' })
      const user = appendMessage(db, { id: 'uncertain-user', sessionId: session.id, role: 'user', content: 'verifiable', timestamp: 1, status: 'sent' })
      appendMessage(db, { id: 'uncertain-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 2, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'uncertain-turn', requestId: 'uncertain-request', sessionId: session.id,
        assistantMessageId: 'uncertain-assistant', userMessageId: user.message.id, state: 'prepared', startToken: 'uncertain-token' })
      const storage = createSqliteSessionStorage(db, { recoveryStages: {
        history: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
        snapshots: () => ({ restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }),
        coordinator: () => ({ recoveredCount: 0, succeeded: true }),
        reconcile: () => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }),
        continuations: () => ({ interrupted: 0, unknownSideEffect: 0, settled: 0 })
      } })
      const claim = storage.execution.claimExecution({ sessionId: session.id, turnId: 'uncertain-turn', ownerId: 'uncertain-owner' })
      expect(claim).toMatchObject({ acquired: true })
      if (!claim.acquired) throw new Error('expected execution claim')
      expect(storage.execution.markExecutionUncertain({ sessionId: session.id, turnId: 'uncertain-turn', ownerId: 'uncertain-owner', generation: claim.generation })).toBe(true)
      await storage.recovery.recover()

      expect(storage.recovery.inspectReadiness(session.id)).toEqual({ readable: true, executable: false, reason: 'commit-uncertain' })
      expect(storage.queries.readMessages({ sessionId: session.id }).map(({ content }) => content)).toContain('verifiable')
    } finally {
      db.close()
    }
  })

  it('reports content, execution, ledger location, and maintenance facts independently', async () => {
    const db = createMemoryAppDb()
    try {
      const workDir = '/tmp/session-availability-ledger'
      const session = createSession(db, { name: 'availability dimensions', workDirProfileId: 'profile' })
      appendMessage(db, { id: 'availability-user', sessionId: session.id, role: 'user', content: 'still readable', timestamp: 1, status: 'sent' })
      const storage = createSqliteSessionStorage(db, {
        getWorkDirForSession: () => workDir,
        inspectMaintenance: () => [{ taskId: 'projection-build', category: 'derived-index', status: 'paused', scannedCount: 4, processedCount: 2 }],
        recoveryStages: {
          history: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          snapshots: () => ({ restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }),
          coordinator: () => ({ recoveredCount: 0, succeeded: true }),
          reconcile: () => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }),
          continuations: () => ({ interrupted: 0, unknownSideEffect: 0, settled: 0 })
        }
      })
      const availability = storage.availability.inspect(session.id)

      expect(availability.content).toMatchObject({ state: 'readable', source: { sessionGeneration: session.generation } })
      expect(availability.execution).toMatchObject({ state: 'pending-recovery', source: { sessionId: session.id, transcriptVersion: 0 } })
      expect(availability.ledger).toMatchObject({ state: 'degraded', readinessState: 'unknown', reasonCode: 'readiness-missing', source: { sessionId: session.id } })
      expect(availability.maintenance).toMatchObject({ state: 'paused', tasks: [{ taskId: 'projection-build', status: 'paused' }] })
      expect(availability.globalFence.state).toBe('pending')
      expect(availability.globalFence.source).toEqual({ recoveryState: 'pending' })
      expect(availability.maintenance.source).toEqual([{ taskId: 'projection-build', status: 'paused' }])
      await storage.recovery.recover()
      expect(storage.availability.inspect(session.id)).toMatchObject({
        globalFence: { state: 'ready' }, content: { state: 'readable' }, execution: { state: 'ready' }, ledger: { state: 'degraded', readinessState: 'unknown', reasonCode: 'readiness-missing' },
        maintenance: { state: 'paused' }
      })
      const location = { workDir, sessionId: session.id, createdAt: session.createdAt }
      const readiness = ensureLegacyLedgerReadiness(getDbConnection(db), location, session.generation)
      expect(markMissingLegacyLedgerBlocked(getDbConnection(db), readiness.ledgerLocationKey)).toBe(true)
      expect(storage.availability.inspect(session.id)).toMatchObject({
        content: { state: 'readable' }, execution: { state: 'ready' },
        ledger: { state: 'degraded', readinessState: 'blocked', reasonCode: 'ledger-blocked', source: { locationKey: sessionLedgerLocationIdentity(location).key, failureClass: 'ledger_missing' } }
      })
      const activeUser = appendMessage(db, { id: 'availability-active-user', sessionId: session.id, role: 'user', content: 'turn still active', timestamp: 3, status: 'sent' })
      appendMessage(db, { id: 'availability-active-assistant', sessionId: session.id, role: 'assistant', content: '', timestamp: 4, status: 'streaming' })
      createPersistedTurn(db, { turnId: 'availability-active-turn', requestId: 'availability-active-request', sessionId: session.id,
        assistantMessageId: 'availability-active-assistant', userMessageId: activeUser.message.id, state: 'executing' })
      expect(storage.availability.inspect(session.id)).toMatchObject({
        content: { state: 'readable' }, execution: { state: 'busy' },
        globalFence: { state: 'ready' }, ledger: { state: 'degraded', readinessState: 'blocked', reasonCode: 'ledger-blocked' }
      })
      const claim = storage.execution.claimExecution({ sessionId: session.id, turnId: 'availability-active-turn', ownerId: 'availability-owner' })
      expect(claim).toMatchObject({ acquired: true })
      if (!claim.acquired) throw new Error('expected active turn claim')
      expect(storage.execution.markExecutionUncertain({ sessionId: session.id, turnId: 'availability-active-turn', ownerId: 'availability-owner', generation: claim.generation })).toBe(true)
      expect(storage.availability.inspect(session.id)).toMatchObject({
        content: { state: 'readable' }, execution: { state: 'commit-uncertain' }, globalFence: { state: 'ready' }
      })
    } finally {
      db.close()
    }
  })

  it('propagates host ledger repair failures through the SQLite recovery gate', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'host ledger recovery', model: 'test' })
      const reconcile = vi.fn(() => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }))
      const continuations = vi.fn(() => ({ interrupted: 0, unknownSideEffect: 1, settled: 0 }))
      let ledgerCalls = 0
      const host = createSqliteSessionStorageHost(db, {
        storage: { recoveryStages: {
          snapshots: () => ({ restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }),
          coordinator: () => ({ recoveredCount: 0, succeeded: true }), reconcile, continuations
        } },
        startup: {
          recoverHistory: async () => ({ interruptedCount: 0, repairFailureCount: 0 }),
          recoverSessionLedgers: async () => { ledgerCalls += 1; return { repairFailureCount: 1 } }
        }
      })

      const historyPhase = await host.storage.recovery.recoverHistory()
      expect(historyPhase.history).toMatchObject({ succeeded: false, repairFailureCount: 1 })
      expect(ledgerCalls).toBe(1)

      const report = await host.storage.recovery.recover()

      expect({ ledgerCalls, status: report.status }).toEqual({ ledgerCalls: 1, status: 'blocked' })
      expect(report.history.succeeded).toBe(false)
      expect(report.reconciliation).toEqual({ status: 'skipped', reason: 'history-recovery-incomplete' })
      expect(reconcile).not.toHaveBeenCalled()
      expect(continuations).toHaveBeenCalledWith(false)
      expect(host.storage.queries.readSession(session.id)).toBeTruthy()
      expect(host.storage.availability.inspect(session.id)).toMatchObject({
        globalFence: { state: 'blocked' }, content: { state: 'readable' }, execution: { state: 'pending-recovery' }
      })
    } finally {
      db.close()
    }
  })

  it('does not let a successful ledger callback erase a History recovery exception', async () => {
    const db = createMemoryAppDb()
    try {
      const host = createSqliteSessionStorageHost(db, {
        storage: { recoveryStages: { coordinator: () => ({ recoveredCount: 0, succeeded: true }) } },
        startup: {
          recoverHistory: async () => { throw new Error('history recovery failed') },
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 })
        }
      })
      const report = await host.storage.recovery.recover()
      expect(report.status).toBe('blocked')
      expect(report.history.succeeded).toBe(false)
    } finally {
      db.close()
    }
  })

  it('keeps healthy sessions available when a recoverable History corruption is scoped to one session', async () => {
    const db = createMemoryAppDb()
    try {
      const damagedSession = createSession(db, { name: 'damaged history session', model: 'test' })
      const healthySession = createSession(db, { name: 'healthy history session', model: 'test' })
      const damagedWriter = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, damagedSession.id)
      const healthyWriter = new SqliteAgentHistory(getDbConnection(db), 1, Date.now, healthySession.id)
      const eventFor = (invocationId: string, eventId: string, sessionId: string, fingerprint: string) => ({
        invocationId, turnId: `${invocationId}-turn`, sequence: 1, schemaVersion: 1,
        eventId, idempotencyKey: eventId, kind: 'session-input-committed' as const,
        payload: { sessionId, messageId: `${invocationId}-user`, role: 'user', inputFingerprint: fingerprint }
      })
      await damagedWriter.appendBatch([eventFor('damaged-invocation', 'damaged-input-event', damagedSession.id, 'a'.repeat(64))], 0)
      await healthyWriter.appendBatch([eventFor('healthy-invocation', 'healthy-input-event', healthySession.id, 'b'.repeat(64))], 0)
      getDbConnection(db).prepare("UPDATE agent_history_events SET payload_json='{' WHERE event_id='damaged-input-event'").run()
      const startupHistory = createSqliteStartupHistoryRecoveryBindings(db)
      const host = createSqliteSessionStorageHost(db, {
        storage: { recoveryStages: {
          coordinator: () => ({ recoveredCount: 0, succeeded: true }),
          reconcile: () => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }),
          continuations: () => ({ interrupted: 0, unknownSideEffect: 0, settled: 0 })
        } },
        startup: {
          recoverHistory: async () => {
            const result = await startupHistory.recoverInterruptedInvocationsWithLedger({
              ledgerRecovery: createSessionLedgerRecoveryBindings(), allowedRoots: [], configuredWorkDir: '/workspace',
              ensureSessionLedgerReady: async () => true
            })
            return { interruptedCount: result.interruptedCount, repairFailureCount: result.repairFailureCount,
              sessionFailures: result.sessionFailures }
          },
          recoverSessionLedgers: async () => ({ repairFailureCount: 0 })
        }
      })

      const report = await host.storage.recovery.recover()

      expect(report.status).toBe('degraded')
      expect(report.history).toMatchObject({ succeeded: true, sessionFailures: [{ sessionId: damagedSession.id, invocationId: 'damaged-invocation', failureClass: 'history-stream-corrupt' }] })
      expect(host.storage.recovery.inspectReadiness(damagedSession.id)).toMatchObject({ readable: true, executable: false, reason: 'recovery-pending' })
      expect(host.storage.recovery.inspectReadiness(healthySession.id)).toMatchObject({ readable: true, executable: true })
      expect(host.storage.availability.inspect(healthySession.id)).toMatchObject({ globalFence: { state: 'degraded' }, content: { state: 'readable' }, execution: { state: 'ready' } })
      expect(host.storage.availability.inspect(damagedSession.id)).toMatchObject({ globalFence: { state: 'degraded' }, execution: { state: 'pending-recovery' } })
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

  it('runs the History phase early and reuses its report when completing dependent recovery phases', async () => {
    const order: string[] = []
    const port = createSessionRecoveryPort({
      history: async () => { order.push('history'); return { interruptedCount: 2, repairFailureCount: 0 } },
      ledgerRepairs: async () => { order.push('ledger'); return 0 },
      snapshots: async () => { order.push('snapshots'); return { restoredCount: 1, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 } },
      coordinator: () => { order.push('coordinator'); return { recoveredCount: 1, succeeded: true } },
      hasUnfinishedProjections: () => false,
      reconcile: () => { order.push('reconcile'); return { releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 1 } },
      continuations: () => { order.push('continuations'); return { interrupted: 0, unknownSideEffect: 0, settled: 0 } },
      inspectReadiness: () => ({ readable: true, executable: true })
    })

    await port.recoverHistory()
    expect(order).toEqual(['history', 'ledger'])

    const report = await port.recover()
    expect(order).toEqual(['history', 'ledger', 'snapshots', 'coordinator', 'reconcile', 'continuations'])
    expect(report).toMatchObject({ status: 'ready', history: { succeeded: true, interruptedCount: 2, repairFailureCount: 0 } })
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

  it('limits a session-scoped History repair failure after the global projection fence completes', async () => {
    const damagedSessionId = 'session-local-history-failure'
    const port = createSessionRecoveryPort({
      history: async () => ({ interruptedCount: 0, repairFailureCount: 1, sessionFailures: [
        { sessionId: damagedSessionId, invocationId: 'local-invocation', capability: 'execution', failureClass: 'history-stream-corrupt' }
      ] }),
      snapshots: () => ({ restoredCount: 0, skippedCanonicalUnavailableCount: 0, missingAssistantCount: 0 }),
      coordinator: () => ({ recoveredCount: 0, succeeded: true }),
      hasUnfinishedProjections: () => false,
      reconcile: () => ({ releasedUnstarted: 0, markedUncertain: 0, repairedCheckpoints: 0, reconciled: 0 }),
      continuations: () => ({ interrupted: 0, unknownSideEffect: 0, settled: 0 }),
      inspectReadiness: () => ({ readable: true, executable: true })
    })

    const report = await port.recover()

    expect(report.status).toBe('degraded')
    expect(port.inspectRecoveryStatus()).toEqual({ state: 'degraded' })
    expect(port.inspectReadiness(damagedSessionId)).toMatchObject({ readable: true, executable: false, reason: 'recovery-pending' })
    expect(port.inspectReadiness('healthy-session')).toEqual({ readable: true, executable: true })
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
