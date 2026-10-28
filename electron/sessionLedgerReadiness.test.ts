import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './database/migrations'
import { CREATE_TABLES_SQL } from './database/schema'
import { createTempDatabase } from './database/testHelpers'
import { getDbConnection } from './database/sqliteStore'
import { openDatabase } from './database'
import { sessionLedgerLocationIdentity } from './sessionLedgerIdentity'
import {
  decideSessionLedgerGate,
  beginSessionLedgerCheck,
  beginSessionLedgerBootstrap,
  completeSessionLedgerBootstrap,
  completeSessionLedgerCheck,
  ensureLegacyLedgerReadiness,
  markMissingLegacyLedgerBlocked,
  recoverInterruptedSessionLedgerCheck,
  mapSessionLedgerPhysicalState,
  refreshSessionLedgerReadyProof
} from './sessionLedgerReadiness'

function createDb(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec(CREATE_TABLES_SQL)
  conn.exec("INSERT INTO schema_meta VALUES('schema_version','15');")
  runMigrations(conn)
  return conn
}

describe('session ledger readiness state', () => {
  it('maps the physical seven-state schema to absent, usable, or stale without changing stored values', () => {
    expect(mapSessionLedgerPhysicalState(undefined)).toBe('absent')
    expect(mapSessionLedgerPhysicalState('ready')).toBe('usable')
    for (const state of ['uninitialized', 'initializing', 'unknown', 'checking', 'dirty', 'blocked'] as const) {
      expect(mapSessionLedgerPhysicalState(state)).toBe('stale')
    }

    const conn = createDb()
    const location = { workDir: '/tmp/mapped-state', sessionId: 'mapped', createdAt: 3 }
    const readiness = ensureLegacyLedgerReadiness(conn, location, 'g', 1)
    expect(readiness.state).toBe('unknown')
    expect(mapSessionLedgerPhysicalState(readiness.state)).toBe('stale')
    for (const logicalState of ['absent', 'usable', 'stale'] as const) {
      expect(() => conn.prepare(`UPDATE session_ledger_projection_state SET state=? WHERE ledger_location_key=?`)
        .run(logicalState, readiness.ledgerLocationKey)).toThrow()
    }
    for (const physicalState of ['uninitialized', 'initializing', 'unknown', 'checking', 'ready', 'dirty', 'blocked'] as const) {
      expect(() => conn.prepare(`UPDATE session_ledger_projection_state SET state=? WHERE ledger_location_key=?`)
        .run(physicalState, readiness.ledgerLocationKey)).not.toThrow()
    }
    conn.prepare(`UPDATE session_ledger_projection_state SET state='unknown' WHERE ledger_location_key=?`).run(readiness.ledgerLocationKey)
    expect(conn.prepare('SELECT state FROM session_ledger_projection_state WHERE ledger_location_key=?').get(readiness.ledgerLocationKey))
      .toEqual({ state: 'unknown' })
    conn.close()
  })

  it('keeps unknown legacy state on missing baseline and blocks only that ledger-dependent gate', () => {
    const conn = createDb()
    const location = { workDir: '/tmp/legacy-root', sessionId: 'legacy', createdAt: 10 }
    const state = ensureLegacyLedgerReadiness(conn, location, 'generation-1', 11)
    expect(decideSessionLedgerGate(state)).toEqual({ kind: 'check-baseline' })
    expect(markMissingLegacyLedgerBlocked(conn, state.ledgerLocationKey, 12)).toBe(true)
    const blocked = ensureLegacyLedgerReadiness(conn, location, 'generation-1', 13)
    expect(blocked).toMatchObject({ origin: 'legacy', state: 'blocked', retryScope: 'baseline', failureClass: 'ledger_missing' })
    expect(decideSessionLedgerGate(blocked)).toEqual({ kind: 'retry-blocked', scope: 'baseline' })
    conn.close()
  })

  it('resumes only the original bootstrap id and recovers an interrupted check as unknown', () => {
    const base = {
      ledgerLocationKey: 'location', workDirIdentity: 'workdir-hash', sessionId: 's', sessionGeneration: 'g',
      ledgerGeneration: 0, canonicalWatermark: null, proofFileIdentity: null, proofFileBytes: null, proofTailFrame: null,
      proofIndexSeq: null, proofIndexEventCount: null, proofIndexBytes: null, proofIndexLastAt: null, checkToken: null,
      checkedAt: null, ownerReconciledProcessGeneration: 0,
      retryScope: null, failureClass: null
    }
    expect(decideSessionLedgerGate({ ...base, origin: 'new_location', state: 'initializing', bootstrapId: 'bootstrap-1' }))
      .toEqual({ kind: 'resume-bootstrap', bootstrapId: 'bootstrap-1' })
    expect(decideSessionLedgerGate({ ...base, origin: 'legacy', state: 'checking', bootstrapId: null })).toEqual({ kind: 'recover-check' })
    expect(() => decideSessionLedgerGate({ ...base, origin: 'legacy', state: 'uninitialized', bootstrapId: null })).toThrow('SESSION_LEDGER_BOOTSTRAP_PROVENANCE_INVALID')
    expect(decideSessionLedgerGate({ ...base, origin: 'legacy', state: 'dirty', bootstrapId: null })).toEqual({ kind: 'check-baseline' })
    expect(decideSessionLedgerGate({ ...base, origin: 'legacy', state: 'dirty', bootstrapId: null,
      canonicalWatermark: 'seq:1', proofFileIdentity: 'retired-proof' })).toEqual({ kind: 'check-baseline' })
  })

  it('rejects cross-location state reuse for the same session id and creation time', () => {
    const conn = createDb()
    const first = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/profile-a', sessionId: 's', createdAt: 10 }, 'g', 1)
    const second = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/profile-b', sessionId: 's', createdAt: 10 }, 'g', 1)
    expect(second.ledgerLocationKey).not.toBe(first.ledgerLocationKey)
    expect(conn.prepare('SELECT COUNT(*) AS count FROM session_ledger_projection_state WHERE session_id=?').get('s')).toEqual({ count: 2 })
    conn.close()
  })

  it('uses a durable CAS token for ready proof and rejects stale check completions', () => {
    const conn = createDb()
    const readiness = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/cas-root', sessionId: 'cas', createdAt: 30 }, 'generation', 1)
    const token = beginSessionLedgerCheck(conn, readiness.ledgerLocationKey, 2)
    expect(token).toBeTruthy()
    expect(beginSessionLedgerCheck(conn, readiness.ledgerLocationKey, 3)).toBeNull()
    const proof = { canonicalWatermark: 'seq:4', ledgerGeneration: 1 }
    expect(completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, 'stale-token', proof, 4)).toBe(false)
    expect(completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, token!, proof, 5)).toBe(true)
    const ready = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/cas-root', sessionId: 'cas', createdAt: 30 }, 'generation', 6)
    expect(ready).toMatchObject({ state: 'ready', canonicalWatermark: 'seq:4', proofFileBytes: null,
      proofIndexSeq: null, proofIndexEventCount: null, proofIndexBytes: null, checkToken: null })
    expect(recoverInterruptedSessionLedgerCheck(conn, readiness.ledgerLocationKey, 7)).toBe(false)
    conn.close()
  })

  it('does not write retired proof columns during bootstrap, checks, or refresh', () => {
    const conn = createDb()
    const location = { workDir: '/tmp/retired-proof-columns', sessionId: 'retired-proof', createdAt: 41 }
    const readiness = ensureLegacyLedgerReadiness(conn, location, 'g', 1)
    const columns = `proof_file_identity,proof_file_bytes,proof_tail_frame,proof_index_seq,proof_index_event_count,proof_index_bytes,proof_index_last_at`
    expect(conn.prepare(`PRAGMA table_info('session_ledger_projection_state')`).all()
      .map((column) => (column as { name: string }).name).filter((name) => name.startsWith('proof_')))
      .toEqual(['proof_file_identity', 'proof_file_bytes', 'proof_tail_frame', 'proof_index_seq',
        'proof_index_event_count', 'proof_index_bytes', 'proof_index_last_at'])
    const sentinel = { proof_file_identity: 'old-identity', proof_file_bytes: 11, proof_tail_frame: 'old-tail',
      proof_index_seq: 2, proof_index_event_count: 3, proof_index_bytes: 4, proof_index_last_at: 5 }
    const readColumns = () => conn.prepare(`SELECT ${columns} FROM session_ledger_projection_state WHERE ledger_location_key=?`)
      .get(readiness.ledgerLocationKey)
    conn.prepare(`UPDATE session_ledger_projection_state SET ${columns.replaceAll(',', '=?,')}=? WHERE ledger_location_key=?`)
      .run(sentinel.proof_file_identity, sentinel.proof_file_bytes, sentinel.proof_tail_frame, sentinel.proof_index_seq,
        sentinel.proof_index_event_count, sentinel.proof_index_bytes, sentinel.proof_index_last_at, readiness.ledgerLocationKey)
    const proof = { canonicalWatermark: 'seq:10', ledgerGeneration: 1 }

    conn.prepare(`UPDATE session_ledger_projection_state SET origin='new_location',state='uninitialized',bootstrap_id='boot' WHERE ledger_location_key=?`)
      .run(readiness.ledgerLocationKey)
    expect(beginSessionLedgerBootstrap(conn, readiness.ledgerLocationKey, 'boot')).toBe(true)
    expect(completeSessionLedgerBootstrap(conn, readiness.ledgerLocationKey, 'boot', proof)).toBe(true)
    expect(readColumns()).toEqual(sentinel)

    conn.prepare(`UPDATE session_ledger_projection_state SET origin='legacy',state='unknown',bootstrap_id=NULL WHERE ledger_location_key=?`)
      .run(readiness.ledgerLocationKey)
    const baselineToken = beginSessionLedgerCheck(conn, readiness.ledgerLocationKey)
    expect(baselineToken).toBeTruthy()
    expect(completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, baselineToken!, proof)).toBe(true)
    expect(readColumns()).toEqual(sentinel)

    expect(refreshSessionLedgerReadyProof(conn, readiness.ledgerLocationKey, proof)).toBe(true)
    expect(readColumns()).toEqual(sentinel)
    conn.close()
  })

  it('bootstraps only with the creation transaction credential and can resume the same bootstrap after reopen', () => {
    const conn = createDb()
    const location = { workDir: '/tmp/new-bootstrap', sessionId: 'new-session', createdAt: 40 }
    const identity = sessionLedgerLocationIdentity(location)
    conn.prepare(`INSERT INTO session_ledger_projection_state(ledger_location_key,work_dir_identity,created_at,session_id,session_generation,
      origin,state,bootstrap_id,updated_at) VALUES(?,?,?,?,?,'new_location','uninitialized','bootstrap-id',1)`)
      .run(identity.key, identity.workDirIdentity, location.createdAt, location.sessionId, 'g')
    expect(beginSessionLedgerBootstrap(conn, identity.key, 'wrong-id', 2)).toBe(false)
    expect(beginSessionLedgerBootstrap(conn, identity.key, 'bootstrap-id', 3)).toBe(true)
    expect(decideSessionLedgerGate(ensureLegacyLedgerReadiness(conn, location, 'g', 4)))
      .toEqual({ kind: 'resume-bootstrap', bootstrapId: 'bootstrap-id' })
    const proof = { canonicalWatermark: 'seq:-1', ledgerGeneration: 0 }
    expect(completeSessionLedgerBootstrap(conn, identity.key, 'wrong-id', proof, 5)).toBe(false)
    expect(completeSessionLedgerBootstrap(conn, identity.key, 'bootstrap-id', proof, 6)).toBe(true)
    expect(conn.prepare('SELECT state,bootstrap_id,canonical_watermark,proof_file_identity FROM session_ledger_projection_state WHERE ledger_location_key=?')
      .get(identity.key)).toEqual({ state: 'ready', bootstrap_id: 'bootstrap-id', canonical_watermark: 'seq:-1', proof_file_identity: null })
    conn.close()
  })

  it('returns an abandoned check to unknown without authorizing bootstrap', () => {
    const conn = createDb()
    const readiness = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/recovery-root', sessionId: 'recover', createdAt: 31 }, 'g', 1)
    expect(beginSessionLedgerCheck(conn, readiness.ledgerLocationKey)).toBeTruthy()
    expect(recoverInterruptedSessionLedgerCheck(conn, readiness.ledgerLocationKey)).toBe(true)
    const recovered = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/recovery-root', sessionId: 'recover', createdAt: 31 }, 'g', 2)
    expect(recovered).toMatchObject({ origin: 'legacy', state: 'unknown', bootstrapId: null, checkToken: null })
    conn.close()
  })

  it('persists a pending check across a file-backed database reopen', () => {
    const temp = createTempDatabase('ledger-readiness-file-')
    const conn = getDbConnection(temp.db)
    try {
      const readiness = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/file-root', sessionId: 'file-session', createdAt: 32 }, 'g', 1)
      const token = beginSessionLedgerCheck(conn, readiness.ledgerLocationKey, 2)
      expect(token).toBeTruthy()
      temp.db.close()
      const reopened = createTempDatabaseFromPathForRead(temp.dbPath)
      try {
        const row = getDbConnection(reopened).prepare('SELECT state,check_token,origin FROM session_ledger_projection_state WHERE ledger_location_key=?')
          .get(readiness.ledgerLocationKey)
        expect(row).toEqual({ state: 'checking', check_token: token, origin: 'legacy' })
      } finally { reopened.close() }
    } finally { temp.cleanup() }
  })
})

function createTempDatabaseFromPathForRead(dbPath: string) {
  // Opening through the standard DB factory also reapplies idempotent migration checks.
  return openDatabase(dbPath)
}
