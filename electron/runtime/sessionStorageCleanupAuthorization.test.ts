import { describe, expect, it } from 'vitest'
import { createSession, appendMessage } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { getDbConnection } from '../database/sqliteStore'
import { enableCanonicalSessionWriteAuthority } from './sessionContentWriteAuthority'
import { SqliteAgentHistory } from './sqliteAgentHistory'
import { certifyCanonicalSessionApiRead } from '../sessionStorage/certification'
import {
  approveSessionStorageCleanupScope,
  createSessionStorageCleanupScopeProposal,
  getSessionStorageCleanupScopeAuthorization,
  revokeSessionStorageCleanupScope,
  type SessionStorageCleanupScopeProposal,
} from './sessionStorageCleanupAuthorization'

async function makeEligible(db: ReturnType<typeof createTempDatabase>['db'], sessionId: string): Promise<void> {
  const messages = [
    { id: `${sessionId}-user`, role: 'user' as const, content: 'question', timestamp: 1 },
    { id: `${sessionId}-assistant`, role: 'assistant' as const, content: 'answer', timestamp: 2 },
  ]
  for (const message of messages) appendMessage(db, { ...message, sessionId, status: message.role === 'user' ? 'sent' : 'completed' })
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).appendBatch([{
    invocationId: `scope-${sessionId}`,
    turnId: `turn-${sessionId}`,
    sequence: 1,
    schemaVersion: 1,
    eventId: `scope-event-${sessionId}`,
    idempotencyKey: `scope-event-${sessionId}`,
    kind: 'invocation-context-committed',
    payload: { messages },
  }], 0)
  expect(certifyCanonicalSessionApiRead(db, sessionId).status).toBe('eligible')
  expect(enableCanonicalSessionWriteAuthority(db, sessionId).status).toBe('enabled')
  const session = getDbConnection(db).prepare('SELECT generation FROM sessions WHERE id=?').get(sessionId) as { generation: string }
  getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
    VALUES(?,?,?)`).run(sessionId, session.generation, Date.now())
}

describe('session content cleanup authorization scope', () => {
  it('binds an owner approved exact session set to persistent profile identity and canonical snapshots', async () => {
    const temp = createTempDatabase('session-cleanup-scope-')
    try {
      const approved = createSession(temp.db, { name: 'approved', model: 'test' })
      const rejected = createSession(temp.db, { name: 'not approved', model: 'test' })
      await makeEligible(temp.db, approved.id)
      await makeEligible(temp.db, rejected.id)

      const proposal = createSessionStorageCleanupScopeProposal(temp.db, {
        sessionIds: [approved.id],
        validFrom: 1_800_000_000_000,
        validUntil: 1_800_000_060_000,
      })
      approveSessionStorageCleanupScope(temp.db, proposal, {
        approvalReference: 'maintenance-review/42',
        approvedScopeSha256: proposal.scopeSha256,
      })

      expect(getSessionStorageCleanupScopeAuthorization(temp.db, approved.id, 1_800_000_030_000))
        .toMatchObject({ allowed: true, approvalReference: 'maintenance-review/42' })
      expect(getSessionStorageCleanupScopeAuthorization(temp.db, rejected.id, 1_800_000_030_000))
        .toMatchObject({ allowed: false, reason: 'session-not-authorized' })
    } finally {
      temp.cleanup()
    }
  })

  it('rejects altered approval digest, expiry, profile mismatch, and certification drift', async () => {
    const temp = createTempDatabase('session-cleanup-scope-reject-')
    try {
      const session = createSession(temp.db, { name: 'scoped', model: 'test' })
      await makeEligible(temp.db, session.id)
      const proposal = createSessionStorageCleanupScopeProposal(temp.db, {
        sessionIds: [session.id], validFrom: 10, validUntil: 20,
      })
      expect(() => approveSessionStorageCleanupScope(temp.db, proposal, {
        approvalReference: 'review/43', approvedScopeSha256: '0'.repeat(64),
      })).toThrow(/approved scope digest/)

      approveSessionStorageCleanupScope(temp.db, proposal, {
        approvalReference: 'review/43', approvedScopeSha256: proposal.scopeSha256,
      })
      expect(getSessionStorageCleanupScopeAuthorization(temp.db, session.id, 20))
        .toMatchObject({ allowed: false, reason: 'authorization-expired' })
      expect(getSessionStorageCleanupScopeAuthorization(temp.db, session.id, 9))
        .toMatchObject({ allowed: false, reason: 'authorization-not-yet-valid' })

      const profileId = getDbConnection(temp.db).prepare(`SELECT value FROM schema_meta WHERE key='session_storage_profile_id'`)
        .get() as { value: string }
      getDbConnection(temp.db).prepare(`UPDATE schema_meta SET value=? WHERE key='session_storage_profile_id'`)
        .run('6f3a0d45-358f-4b4c-9194-f8ed6646aa52')
      expect(getSessionStorageCleanupScopeAuthorization(temp.db, session.id, 15))
        .toMatchObject({ allowed: false, reason: 'profile-identity-mismatch' })
      getDbConnection(temp.db).prepare(`UPDATE schema_meta SET value=? WHERE key='session_storage_profile_id'`)
        .run(profileId.value)

      getDbConnection(temp.db).prepare(`UPDATE sessions SET preview='drift' WHERE id=?`).run(session.id)
      expect(getSessionStorageCleanupScopeAuthorization(temp.db, session.id, 15))
        .toMatchObject({ allowed: false, reason: 'session-snapshot-mismatch' })
    } finally {
      temp.cleanup()
    }
  })

  it('persists revocation across database reopen and binds the record to profile identity', async () => {
    const temp = createTempDatabase('session-cleanup-scope-revoke-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'scoped', model: 'test' })
      await makeEligible(db, session.id)
      const proposal = createSessionStorageCleanupScopeProposal(db, {
        sessionIds: [session.id], validFrom: 1, validUntil: 100,
      })
      approveSessionStorageCleanupScope(db, proposal, {
        approvalReference: 'review/44', approvedScopeSha256: proposal.scopeSha256,
      })
      const scopeRow = getDbConnection(db).prepare(`SELECT value FROM schema_meta WHERE key='session_storage_cleanup_scope'`)
        .get() as { value: string }
      const record = JSON.parse(scopeRow.value) as { proposal: { profileId: string } }
      expect(record.proposal.profileId).toBe(proposal.profileId)

      revokeSessionStorageCleanupScope(db, 'review/revoked/44')
      db.close()
      const { openDatabase } = await import('../database')
      db = openDatabase(temp.dbPath)
      expect(getSessionStorageCleanupScopeAuthorization(db, session.id, 50))
        .toMatchObject({ allowed: false, reason: 'authorization-revoked' })

      const altered = { ...proposal, profileId: 'different-profile' } as SessionStorageCleanupScopeProposal
      expect(() => approveSessionStorageCleanupScope(db, altered, {
        approvalReference: 'review/45', approvedScopeSha256: proposal.scopeSha256,
      })).toThrow(/profile identity/)
    } finally {
      try { db.close() } catch { /* already closed */ }
      temp.cleanup()
    }
  })
})
