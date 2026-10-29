import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSession, setConfigValue } from '../database/operations'
import { appendSqliteAgentHistoryBatchInTransaction } from '../database/agentHistoryStorage'
import { getDbConnection } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { sessionLedgerLocationIdentity } from '../sessionLedgerIdentity'
import { ensureSessionLedgerReady, runOutsideSessionLedgerLifecycleLock } from '../sessionLedgerLifecycle'
import { readSessionLedgerReadiness } from '../sessionLedgerReadiness'
import { getSessionEventSink, notifySessionEventLedgerFailure, readCompactionReplay, readSessionEvents, retireSessionEventSink,
  setSessionEventFailureObserver } from '../sessionEvents'
import { createSessionLedgerRepairScheduler } from '../sessionLedgerRepairScheduler'
import { createProductionSessionLedgerLifecycleDependencies } from './sessionLedgerLifecycleProduction'
import { handleSessionLedgerEventFailure } from './sessionLedgerRepairFailure'

describe('session ledger read failure repair', () => {
  const databases: ReturnType<typeof createMemoryAppDb>[] = []
  const roots: string[] = []
  afterEach(async () => {
    setSessionEventFailureObserver(undefined)
    for (const db of databases.splice(0)) db.close()
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  it('invalidates ready, quarantines a malformed ledger, rebuilds from canonical history, and fences the old writer', async () => {
    const db = createMemoryAppDb()
    databases.push(db)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-ledger-read-failure-'))
    roots.push(root)
    setConfigValue(db, 'config.workDirProfiles', JSON.stringify([{ id: 'repair-profile', path: root, isDefault: true }]))
    const session = createSession(db, { name: 'read failure repair', workDirProfileId: 'repair-profile' })
    const conn = getDbConnection(db)
    const location = { workDir: root, sessionId: session.id, createdAt: session.createdAt }
    const dependencies = createProductionSessionLedgerLifecycleDependencies(conn)
    expect((await ensureSessionLedgerReady({ conn, location, sessionGeneration: session.generation, processGeneration: 1, dependencies })).status)
      .toBe('ready')
    const canonicalEvent = { invocationId: 'read-failure-rebuild-invocation', turnId: 'canonical-rebuild-turn', sequence: 1, schemaVersion: 1,
      eventId: 'read-failure-rebuild-event', idempotencyKey: 'read-failure-rebuild-event', kind: 'invocation-completed' as const,
      payload: { status: 'completed', sessionLedger: { location, turnId: 'canonical-rebuild-turn', reason: 'completed' } } }
    runInTransaction(conn, () => appendSqliteAgentHistoryBatchInTransaction(conn, [canonicalEvent], 0, { sessionId: session.id }))
    expect(conn.prepare("SELECT COUNT(*) AS count FROM session_ledger_projection_outbox WHERE status='pending'").get())
      .toEqual({ count: 0 })
    const oldSink = getSessionEventSink(root, session.id, session.createdAt)
    await oldSink.appendCritical({ type: 'turn_start', payload: { turnId: 'canonical-rebuild-turn' } })
    await oldSink.flush()
    await fs.appendFile(oldSink.eventsPath, '{broken}\n')

    const attempts: Array<{ status: string }> = []
    let generation = 0
    const scheduler = createSessionLedgerRepairScheduler({ initialDelayMs: 5, maxDelayMs: 10,
      onAttempt: ({ status }) => attempts.push({ status }),
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
    setSessionEventFailureObserver((failedLocation) =>
      handleSessionLedgerEventFailure({ conn, scheduler, location: failedLocation, generation: ++generation }))

    try {
      await expect(readCompactionReplay(oldSink.eventsPath)).rejects.toThrow('degraded')
      const readError = new Error('SESSION_LEDGER_BASELINE_DEGRADED') as Error & { code?: string }
      readError.code = 'SESSION_LEDGER_BASELINE_DEGRADED'
      notifySessionEventLedgerFailure(location, readError, 'read')

      await vi.waitFor(() => expect(scheduler.pendingCount()).toBe(0), { timeout: 2_000 })
      expect(attempts).toContainEqual({ status: 'recovered' })
      const identity = sessionLedgerLocationIdentity(location)
      expect(readSessionLedgerReadiness(conn, identity.key)?.state).toBe('ready')
      expect(() => oldSink.appendCritical({ type: 'turn_end', payload: { turnId: 'late-old-writer' } }))
        .toThrow('SESSION_LEDGER_SINK_RETIRED')
      expect((await readSessionEvents(getSessionEventSink(root, session.id, session.createdAt).eventsPath))
        .some(({ type, payload }) => type === 'turn_start' && payload.turnId === 'canonical-rebuild-turn')).toBe(true)
      const quarantineRoot = path.join(root, 'sessions', '.quarantine')
      expect(await fs.readdir(quarantineRoot)).toHaveLength(1)
    } finally {
      scheduler.stop()
      await oldSink.retire()
    }
  })
})
