import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { runMigrations } from './database/migrations'
import { CREATE_TABLES_SQL } from './database/schema'
import { createTempDatabase } from './database/testHelpers'
import { getDbConnection } from './database/sqliteStore'
import { openDatabase } from './database'
import {
  decideSessionLedgerGate,
  beginSessionLedgerCheck,
  completeSessionLedgerCheck,
  ensureLegacyLedgerReadiness,
  markMissingLegacyLedgerBlocked,
  recoverInterruptedSessionLedgerCheck
} from './sessionLedgerReadiness'

function createDb(): DatabaseSync {
  const conn = new DatabaseSync(':memory:')
  conn.exec(CREATE_TABLES_SQL)
  conn.exec("INSERT INTO schema_meta VALUES('schema_version','15');")
  runMigrations(conn)
  return conn
}

describe('session ledger readiness state', () => {
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
      ledgerGeneration: 0, canonicalWatermark: null, checkedAt: null, ownerReconciledProcessGeneration: 0,
      retryScope: null, failureClass: null
    }
    expect(decideSessionLedgerGate({ ...base, origin: 'new_location', state: 'initializing', bootstrapId: 'bootstrap-1' }))
      .toEqual({ kind: 'resume-bootstrap', bootstrapId: 'bootstrap-1' })
    expect(decideSessionLedgerGate({ ...base, origin: 'legacy', state: 'checking', bootstrapId: null })).toEqual({ kind: 'recover-check' })
    expect(() => decideSessionLedgerGate({ ...base, origin: 'legacy', state: 'uninitialized', bootstrapId: null })).toThrow('SESSION_LEDGER_BOOTSTRAP_PROVENANCE_INVALID')
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
    const proof = { canonicalWatermark: 'seq:4', ledgerGeneration: 1, fileIdentity: 'dev-ino', fileBytes: 100,
      tailFrame: 'frame-hash', indexSeq: 4, indexEventCount: 4, indexBytes: 100, indexLastAt: 40 }
    expect(completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, 'stale-token', proof, 4)).toBe(false)
    expect(completeSessionLedgerCheck(conn, readiness.ledgerLocationKey, token!, proof, 5)).toBe(true)
    const ready = ensureLegacyLedgerReadiness(conn, { workDir: '/tmp/cas-root', sessionId: 'cas', createdAt: 30 }, 'generation', 6)
    expect(ready).toMatchObject({ state: 'ready', canonicalWatermark: 'seq:4', proofFileBytes: 100,
      proofIndexSeq: 4, proofIndexEventCount: 4, proofIndexBytes: 100, checkToken: null })
    expect(recoverInterruptedSessionLedgerCheck(conn, readiness.ledgerLocationKey, 7)).toBe(false)
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
