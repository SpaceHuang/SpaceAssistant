import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { createMemoryAppDb } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { createSession, setConfigValue } from '../database/operations'
import { runInTransaction } from '../database/transaction'
import { ensureSessionLedgerReady, runOutsideSessionLedgerLifecycleLock } from '../sessionLedgerLifecycle'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { createSessionLedgerRepairScheduler } from '../sessionLedgerRepairScheduler'
import { getSessionEventSink, readCompactionReplay, readSessionEvents, retireSessionEventSink, setSessionEventFailureObserver } from '../sessionEvents'
import { createProductionSessionLedgerLifecycleDependencies } from './sessionLedgerLifecycleProduction'
import type { CanonicalLedgerProjectionTarget } from '../sessionLedgerOutbox'

describe('automatic session ledger repair integration', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  const roots: string[] = []
  afterEach(async () => {
    setSessionEventFailureObserver(undefined)
    for (const db of databases.splice(0)) db.close()
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('recovers a failed canonical projection without another user event and replaces the fail-stop sink', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-auto-repair-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'repair-profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'automatic ledger repair', workDirProfileId: 'repair-profile' })
    const conn = getDbConnection(db)
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    const oldSink = getSessionEventSink(root, session.id, session.createdAt)
    const identity = sessionLedgerLocationIdentity(location)
    const turnId = 'automatic-recovery-turn'
    const event = { invocationId: 'automatic-recovery-invocation', turnId, sequence: 1, schemaVersion: 1,
      eventId: 'automatic-recovery-canonical-event', idempotencyKey: 'automatic-recovery-canonical-event',
      kind: 'invocation-context-committed', payload: { context: {} } }
    const target: CanonicalLedgerProjectionTarget = { ledgerLocationKey: identity.key, sessionId: session.id,
      sessionGeneration: session.generation, canonicalEventId: event.eventId, canonicalSequence: 1, projectionOrder: 0,
      projectionKind: 'invocation-terminal', expectedEvents: [{ type: 'turn_start', payload: { turnId } }],
      expectedEventIds: [`turn_start:${turnId}`] }
    runInTransaction(conn, () => appendSqliteAgentHistoryBatchInTransaction(conn, [event], 0,
      { sessionId: session.id, projectionTargets: [target] }))

    const repairAttempts: Array<{ status: string; attempt: number; retryInMs: number }> = []
    const scheduler = createSessionLedgerRepairScheduler({ initialDelayMs: 5, maxDelayMs: 10,
      onAttempt: (result) => repairAttempts.push(result),
      repair: async (repairLocation, retireSink) => runOutsideSessionLedgerLifecycleLock(async () => {
        try {
          if (retireSink) await retireSessionEventSink(repairLocation.workDir, repairLocation.sessionId, repairLocation.createdAt)
          const readiness = await ensureSessionLedgerReady({ conn, location: repairLocation, sessionGeneration: session.generation,
            processGeneration: 1, retryBlocked: true, dependencies })
          if (readiness.status !== 'ready') return false
          await readCompactionReplay(getSessionEventSink(root, session.id, session.createdAt).eventsPath)
          return true
        } catch { return false }
      })
    })
    let generation = 0
    setSessionEventFailureObserver((failedLocation, _error, kind) => scheduler.request(failedLocation,
      { retireSink: kind === 'write', generation: ++generation }))
    let diskWritable = false
    const appendFile = fs.appendFile.bind(fs)
    const appendSpy = vi.spyOn(fs, 'appendFile').mockImplementation(async (...args) => {
      if (!diskWritable) throw new Error('ENOSPC: no space left on device')
      return appendFile(...args)
    })
    let replacement: ReturnType<typeof getSessionEventSink> | undefined
    try {
      const firstAttempt = await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })
      expect(firstAttempt).toMatchObject({ status: 'blocked' })
      await vi.waitFor(() => expect(repairAttempts.filter(({ status }) => status === 'retrying').length).toBeGreaterThanOrEqual(3))
      diskWritable = true
      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(0))
      expect(repairAttempts.some(({ status, retryInMs }) => status === 'retrying' && retryInMs === 10)).toBe(true)
      expect(repairAttempts.at(-1)).toMatchObject({ status: 'recovered', retryInMs: 0 })
      replacement = getSessionEventSink(root, session.id, session.createdAt)
      expect(replacement).not.toBe(oldSink)
      expect(() => oldSink.appendCritical({ type: 'turn_end', payload: { turnId } })).toThrow('SESSION_LEDGER_SINK_RETIRED')
      expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE canonical_event_id=?").get(event.eventId))
        .toEqual({ status: 'acked' })
      expect((await readSessionEvents(replacement.eventsPath)).filter(({ type, payload }) => type === 'turn_start' && payload.turnId === turnId))
        .toHaveLength(1)
      expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation,
        processGeneration: 1, retryBlocked: true, dependencies })).status).toBe('ready')
      expect((await readSessionEvents(replacement.eventsPath)).filter(({ type, payload }) => type === 'turn_start' && payload.turnId === turnId))
        .toHaveLength(1)
    } finally {
      scheduler.stop()
      appendSpy.mockRestore()
      await oldSink.retire()
      await replacement?.close()
    }
  })
})
