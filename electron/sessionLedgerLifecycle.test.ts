import { describe, expect, it } from 'vitest'
import { createMemoryAppDb } from './database/testHelpers'
import { getDbConnection } from './database/sqliteStore'
import {
  ensureLegacyLedgerReadiness, beginSessionLedgerCheck, completeSessionLedgerCheck,
  beginSessionLedgerTargetCheck, completeSessionLedgerTargetCheck, type SessionLedgerReadyProof
} from './sessionLedgerReadiness'
import { ensureSessionLedgerReady, withSessionLedgerLifecycleLock } from './sessionLedgerLifecycle'

const proof: SessionLedgerReadyProof = { canonicalWatermark: 'seq:3', ledgerGeneration: 1, fileIdentity: 'dev-ino', fileBytes: 80,
  tailFrame: 'tail-hash', indexSeq: 3, indexEventCount: 3, indexBytes: 80, indexLastAt: 100 }

describe('session ledger lifecycle lock', () => {
  it('serializes operations for one location while allowing other locations to proceed', async () => {
    const order: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const first = withSessionLedgerLifecycleLock('same', async () => {
      order.push('first-start')
      await blocked
      order.push('first-end')
    })
    const second = withSessionLedgerLifecycleLock('same', async () => { order.push('second') })
    await withSessionLedgerLifecycleLock('other', async () => { order.push('other') })
    expect(order).toEqual(['first-start', 'other'])
    release()
    await Promise.all([first, second])
    expect(order).toEqual(['first-start', 'other', 'first-end', 'second'])
  })

  it('releases the location lock after a failed operation', async () => {
    await expect(withSessionLedgerLifecycleLock('failure', async () => { throw new Error('expected') })).rejects.toThrow('expected')
    await expect(withSessionLedgerLifecycleLock('failure', async () => 'recovered')).resolves.toBe('recovered')
  })

  it('supports reentrant sink work under the same lifecycle lock', async () => {
    await expect(withSessionLedgerLifecycleLock('reentrant', async () =>
      withSessionLedgerLifecycleLock('reentrant', async () => 'inside'))).resolves.toBe('inside')
  })

  it('blocks only the requested legacy ledger when its file is missing and never bootstraps it', async () => {
    const db = createMemoryAppDb()
    try {
      const conn = getDbConnection(db)
      const location = { workDir: '/tmp/lifecycle-missing', sessionId: 'legacy-session', createdAt: 1 }
      const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: 'g1', processGeneration: 1,
        dependencies: {
          fileExists: async () => false,
          readProof: async () => undefined,
          bootstrap: async () => { throw new Error('must not bootstrap a legacy ledger') },
          baseline: async () => { throw new Error('must not scan a missing file') },
          applyTarget: async () => ({ eventIds: [], events: [] })
        } })
      expect(result).toMatchObject({ status: 'blocked', readiness: { origin: 'legacy', state: 'blocked', failureClass: 'ledger_missing' } })
      expect(conn.prepare('SELECT COUNT(*) AS count FROM session_ledger_projection_state WHERE session_id=?').get('legacy-session')).toEqual({ count: 1 })
    } finally { db.close() }
  })

  it('builds one baseline proof then reuses it until the file or index proof changes', async () => {
    const db = createMemoryAppDb()
    try {
      const conn = getDbConnection(db)
      const location = { workDir: '/tmp/lifecycle-baseline', sessionId: 'legacy-session', createdAt: 2 }
      const readiness = ensureLegacyLedgerReadiness(conn, location, 'g1')
      const counters = { baseline: 0, read: 0 }
      const traces: Array<Record<string, unknown>> = []
      const dependencies = {
        fileExists: async () => true,
        readProof: async () => { counters.read += 1; return proof },
        bootstrap: async () => proof,
        baseline: async () => { counters.baseline += 1; return proof },
        applyTarget: async () => ({ eventIds: [], events: [] })
      }
      const first = await ensureSessionLedgerReady({ conn, location, sessionGeneration: 'g1', processGeneration: 1, dependencies,
        onTrace: (trace) => traces.push(trace) })
      const second = await ensureSessionLedgerReady({ conn, location, sessionGeneration: 'g1', processGeneration: 1, dependencies,
        onTrace: (trace) => traces.push(trace) })
      expect(first.status).toBe('ready')
      expect(second.status).toBe('ready')
      expect(counters.baseline).toBe(1)
      expect(counters.read).toBe(2)
      expect(traces).toMatchObject([
        { operation: 'baseline', status: 'ready', baselineScanCount: 1, projectedCount: 0, durationMs: expect.any(Number) },
        { operation: 'proof-reused', status: 'ready', baselineScanCount: 0, projectedCount: 0, durationMs: expect.any(Number) }
      ])
      expect(first.readiness.ledgerLocationKey).toBe(readiness.ledgerLocationKey)
    } finally { db.close() }
  })

  it('rejects stale baseline completion after readiness state has changed', () => {
    const db = createMemoryAppDb()
    try {
      const conn = getDbConnection(db)
      const readiness = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/lifecycle-cas', sessionId: 's', createdAt: 3 }, 'g')
      const token = beginSessionLedgerCheck(conn, readiness.ledgerLocationKey)
      conn.prepare("UPDATE session_ledger_projection_state SET state='blocked',check_token=NULL WHERE ledger_location_key=?").run(readiness.ledgerLocationKey)
      expect(completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, token!, proof)).toBe(false)
    } finally { db.close() }
  })

  it('blocks only a target whose canonical projection cannot be committed and preserves the pending obligation', async () => {
    const db = createMemoryAppDb()
    try {
      const conn = getDbConnection(db)
      const location = { workDir: '/tmp/lifecycle-target-failure', sessionId: 's', createdAt: 4 }
      const readiness = ensureLegacyLedgerReadiness(conn, location, 'g')
      const baselineToken = beginSessionLedgerCheck(conn, readiness.ledgerLocationKey)!
      completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, baselineToken, proof)
      conn.prepare("UPDATE session_ledger_projection_state SET state='dirty' WHERE ledger_location_key=?").run(readiness.ledgerLocationKey)
      const token = beginSessionLedgerTargetCheck(conn, readiness.ledgerLocationKey)!
      conn.prepare(`INSERT INTO session_ledger_projection_outbox(target_id,ledger_location_key,session_id,session_generation,canonical_event_id,
        canonical_sequence,projection_order,projection_kind,expected_events_json,expected_event_ids_json,payload_sha256,status,created_at)
        VALUES('pending-target',?,'s','g','canonical',1,0,'tool-result','[]','[]','digest','pending',1)`).run(readiness.ledgerLocationKey)
      expect(completeSessionLedgerTargetCheck(conn, readiness.ledgerLocationKey, token, proof)).toBe(false)
      const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: 'g', processGeneration: 1, retryBlocked: true,
        dependencies: {
          fileExists: async () => true,
          readProof: async () => proof,
          bootstrap: async () => proof,
          baseline: async () => proof,
          applyTarget: async () => { throw new Error('sink unavailable') }
        } })
      expect(result).toMatchObject({ status: 'blocked', readiness: { state: 'blocked', retryScope: 'target', failureClass: 'projection_failed' } })
      expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE target_id='pending-target'").get()).toEqual({ status: 'pending' })
    } finally { db.close() }
  })

  it('drains a dirty proof-backed target without repeating the full baseline scan', async () => {
    const db = createMemoryAppDb()
    try {
      const conn = getDbConnection(db)
      const location = { workDir: '/tmp/lifecycle-target-success', sessionId: 'target-session', createdAt: 5 }
      const readiness = ensureLegacyLedgerReadiness(conn, location, 'g')
      const baselineToken = beginSessionLedgerCheck(conn, readiness.ledgerLocationKey)!
      completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, baselineToken, proof)
      const expectedEvents = [{ type: 'tool_result', payload: { toolUseId: 'target-tool', result: { success: true } } }]
      const expectedIds = ['tool_result:target-tool']
      conn.prepare(`INSERT INTO session_ledger_projection_outbox(target_id,ledger_location_key,session_id,session_generation,canonical_event_id,
        canonical_sequence,projection_order,projection_kind,expected_events_json,expected_event_ids_json,payload_sha256,status,created_at)
        VALUES('target-success',?,'target-session','g','canonical-target',4,0,'tool-result',?,?,'digest','pending',1)`)
        .run(readiness.ledgerLocationKey, JSON.stringify(expectedEvents), JSON.stringify(expectedIds))
      conn.prepare("UPDATE session_ledger_projection_state SET state='dirty' WHERE ledger_location_key=?").run(readiness.ledgerLocationKey)
      let baselineCalls = 0
      let targetCalls = 0
      const dependencies = {
        fileExists: async () => true,
        readProof: async () => proof,
        bootstrap: async () => proof,
        baseline: async () => { baselineCalls += 1; return proof },
        applyTarget: async (_location: typeof location, target: { targetId: string; expectedEventIds: readonly string[]; expectedEvents: readonly import('./sessionEvents').SessionEventInput[] }) => {
          targetCalls += 1
          return { eventIds: target.expectedEventIds, events: target.expectedEvents }
        }
      }

      const result = await ensureSessionLedgerReady({ conn, location, sessionGeneration: 'g', processGeneration: 1, dependencies })

      expect(result).toMatchObject({ status: 'ready', readiness: { state: 'ready' } })
      expect({ baselineCalls, targetCalls }).toEqual({ baselineCalls: 0, targetCalls: 1 })
      expect(conn.prepare("SELECT status FROM session_ledger_projection_outbox WHERE target_id='target-success'").get()).toEqual({ status: 'acked' })
    } finally { db.close() }
  })
})
