import { describe, expect, it, vi } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { getDbConnection } from './database/sqliteStore'
import { createSession } from './database/operations'
import { ensureLegacyLedgerReadiness } from './sessionLedgerReadiness'
import { sessionLedgerLocationIdentity, type SessionLedgerLocationInput } from './sessionLedgerIdentity'
import { createSessionLedgerStartupMaintenance } from './sessionLedgerStartupMaintenance'

describe('session ledger startup maintenance', () => {
  it('repairs persisted stale locations once, coalesces concurrent startup calls, and skips usable rows', async () => {
    const db = createMemoryAppDb()
    try {
      const staleSession = createSession(db, { name: 'stale ledger', model: 'test' })
      const usableSession = createSession(db, { name: 'usable ledger', model: 'test' })
      const root = '/startup-ledger-root'
      const staleLocation: SessionLedgerLocationInput = { workDir: root, sessionId: staleSession.id, createdAt: staleSession.createdAt }
      const usableLocation: SessionLedgerLocationInput = { workDir: root, sessionId: usableSession.id, createdAt: usableSession.createdAt }
      const conn = getDbConnection(db)
      const stale = ensureLegacyLedgerReadiness(conn, staleLocation, staleSession.generation)
      const usable = ensureLegacyLedgerReadiness(conn, usableLocation, usableSession.generation)
      conn.prepare("UPDATE session_ledger_projection_state SET state='ready' WHERE ledger_location_key=?").run(usable.ledgerLocationKey)

      const repair = vi.fn(async () => true)
      const onAttempt = vi.fn()
      const maintenance = createSessionLedgerStartupMaintenance({
        conn,
        resolve: (row) => row.session_id === staleSession.id
          ? { location: staleLocation, sessionGeneration: staleSession.generation }
          : undefined,
        repair,
        onAttempt
      })

      const [first, concurrent] = await Promise.all([maintenance.run(), maintenance.run()])
      const subsequent = await maintenance.run()

      expect(first).toEqual({ inspectedCount: 1, repairedCount: 1, repairFailureCount: 0, skippedCount: 0 })
      expect(concurrent).toBe(first)
      expect(subsequent).toBe(first)
      expect(repair).toHaveBeenCalledTimes(1)
      expect(repair).toHaveBeenCalledWith(staleLocation, staleSession.generation)
      expect(onAttempt).toHaveBeenCalledWith({ location: staleLocation, status: 'repaired' })
      expect(sessionLedgerLocationIdentity(staleLocation).key).toBe(stale.ledgerLocationKey)
    } finally {
      db.close()
    }
  })

  it('reports stale locations that cannot be safely resolved without attempting repair', async () => {
    const db = createMemoryAppDb()
    try {
      const session = createSession(db, { name: 'unresolvable stale ledger', model: 'test' })
      ensureLegacyLedgerReadiness(getDbConnection(db),
        { workDir: '/removed-profile', sessionId: session.id, createdAt: session.createdAt }, session.generation)
      const repair = vi.fn(async () => true)
      const maintenance = createSessionLedgerStartupMaintenance({ conn: getDbConnection(db),
        resolve: () => { throw new Error('profile resolution failed') }, repair })
      expect(await maintenance.run()).toEqual({ inspectedCount: 1, repairedCount: 0, repairFailureCount: 0, skippedCount: 1 })
      expect(repair).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })
})
