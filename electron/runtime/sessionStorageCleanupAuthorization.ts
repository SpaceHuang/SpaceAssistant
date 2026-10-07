import { createHash, randomUUID } from 'node:crypto'
import type { AppDatabase } from '../database'
import { getDbConnection, getSchemaMeta, setSchemaMeta } from '../database/sqliteStore'
import { runInTransaction } from '../database/transaction'
import { certifyCanonicalSessionApiRead } from '../sessionStorage/certification'
import { getSessionMessageContentCleanupAuthorizationSnapshotSha256 } from '../sessionStorage/maintenance'

const PROFILE_ID_KEY = 'session_storage_profile_id'
const CLEANUP_SCOPE_KEY = 'session_storage_cleanup_scope'

export type SessionStorageCleanupScopeProposal = Readonly<{
  formatVersion: 1
  profileId: string
  validFrom: number
  validUntil: number
  sessions: readonly Readonly<{ sessionId: string; snapshotSha256: string }>[]
  scopeSha256: string
}>

type PersistedSessionStorageCleanupScope = Readonly<{
  proposal: SessionStorageCleanupScopeProposal
  approvalReference: string
  approvedScopeSha256: string
  revokedAt: number | null
  revocationReference: string | null
}>

export type SessionStorageCleanupScopeAuthorization = Readonly<{
  allowed: true
  profileId: string
  approvalReference: string
  scopeSha256: string
  validUntil: number
}> | Readonly<{
  allowed: false
  reason: 'authorization-missing' | 'authorization-revoked' | 'authorization-not-yet-valid' |
    'authorization-expired' | 'authorization-record-invalid' | 'profile-identity-mismatch' |
    'session-not-authorized' | 'session-snapshot-mismatch'
}>

type InvalidSessionStorageCleanupScopeAuthorization = Extract<SessionStorageCleanupScopeAuthorization, { allowed: false }>

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value), 'utf8').digest('hex')
}

function readOrCreateProfileId(db: AppDatabase): string {
  const conn = getDbConnection(db)
  const existing = getSchemaMeta(conn, PROFILE_ID_KEY)
  if (existing !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) {
      throw new Error('session storage profile identity is invalid')
    }
    return existing
  }
  return runInTransaction(conn, () => {
    const raced = getSchemaMeta(conn, PROFILE_ID_KEY)
    if (raced !== undefined) return raced
    const profileId = randomUUID()
    setSchemaMeta(conn, PROFILE_ID_KEY, profileId)
    return profileId
  })
}

function proposalPayload(proposal: Omit<SessionStorageCleanupScopeProposal, 'scopeSha256'> | SessionStorageCleanupScopeProposal) {
  return {
    formatVersion: proposal.formatVersion,
    profileId: proposal.profileId,
    validFrom: proposal.validFrom,
    validUntil: proposal.validUntil,
    sessions: [...proposal.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  }
}

function isWellFormedProposal(value: unknown): value is SessionStorageCleanupScopeProposal {
  if (!value || typeof value !== 'object') return false
  const proposal = value as Partial<SessionStorageCleanupScopeProposal>
  return proposal.formatVersion === 1 && typeof proposal.profileId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(proposal.profileId) &&
    Number.isSafeInteger(proposal.validFrom) && Number.isSafeInteger(proposal.validUntil) &&
    proposal.validFrom! >= 0 && proposal.validUntil! > proposal.validFrom! &&
    Array.isArray(proposal.sessions) && proposal.sessions.length > 0 &&
    proposal.sessions.every((session, index) => !!session && typeof session.sessionId === 'string' && !!session.sessionId.trim() &&
      /^[0-9a-f]{64}$/i.test(session.snapshotSha256) && (index === 0 || proposal.sessions![index - 1]!.sessionId < session.sessionId)) &&
    typeof proposal.scopeSha256 === 'string' && /^[0-9a-f]{64}$/i.test(proposal.scopeSha256)
}

/** Main-process maintenance API: create a reviewable proposal; never expose through renderer IPC. */
export function createSessionStorageCleanupScopeProposal(
  db: AppDatabase,
  input: Readonly<{ sessionIds: readonly string[]; validFrom: number; validUntil: number }>,
): SessionStorageCleanupScopeProposal {
  if (!Number.isSafeInteger(input.validFrom) || !Number.isSafeInteger(input.validUntil) || input.validFrom < 0 || input.validUntil <= input.validFrom) {
    throw new RangeError('cleanup scope validity window is invalid')
  }
  const sessionIds = [...new Set(input.sessionIds)].sort()
  if (sessionIds.length === 0 || sessionIds.length !== input.sessionIds.length || sessionIds.some((id) => !id.trim())) {
    throw new Error('cleanup scope must contain a unique, non-empty session ID set')
  }
  const sessions = sessionIds.map((sessionId) => {
    const cleanupState = getDbConnection(db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
      .get(sessionId) as { cleanup_state: string } | undefined
    const certification = cleanupState?.cleanup_state === 'retained'
      ? certifyCanonicalSessionApiRead(db, sessionId)
      : undefined
    const snapshotSha256 = getSessionMessageContentCleanupAuthorizationSnapshotSha256(db, sessionId)
    const resumable = cleanupState?.cleanup_state === 'write-stopped' || cleanupState?.cleanup_state === 'pending'
    if ((!resumable && certification?.status !== 'eligible') || !snapshotSha256) {
      throw new Error(`session is not certifiable for cleanup authorization: ${sessionId}`)
    }
    return { sessionId, snapshotSha256 }
  })
  const payload = {
    formatVersion: 1 as const,
    profileId: readOrCreateProfileId(db),
    validFrom: input.validFrom,
    validUntil: input.validUntil,
    sessions,
  }
  return { ...payload, scopeSha256: sha256(proposalPayload(payload)) }
}

/** Main-process maintenance API: persist only a separately owner-approved proposal with the exact approved digest. */
export function approveSessionStorageCleanupScope(
  db: AppDatabase,
  proposal: SessionStorageCleanupScopeProposal,
  approval: Readonly<{ approvalReference: string; approvedScopeSha256: string }>,
): void {
  const currentProfileId = readOrCreateProfileId(db)
  if (proposal.profileId !== currentProfileId) throw new Error('cleanup scope profile identity mismatch')
  if (typeof approval.approvalReference !== 'string' || !approval.approvalReference.trim() ||
    !/^[0-9a-f]{64}$/i.test(approval.approvedScopeSha256) ||
    !isWellFormedProposal(proposal) || proposal.scopeSha256 !== sha256(proposalPayload(proposal)) ||
    proposal.scopeSha256 !== approval.approvedScopeSha256) {
    throw new Error('approved scope digest does not match the owner approved record')
  }
  for (const session of proposal.sessions) {
    const cleanupState = getDbConnection(db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
      .get(session.sessionId) as { cleanup_state: string } | undefined
    const certification = cleanupState?.cleanup_state === 'retained'
      ? certifyCanonicalSessionApiRead(db, session.sessionId)
      : undefined
    const resumable = cleanupState?.cleanup_state === 'write-stopped' || cleanupState?.cleanup_state === 'pending'
    const snapshotSha256 = getSessionMessageContentCleanupAuthorizationSnapshotSha256(db, session.sessionId)
    if ((!resumable && certification?.status !== 'eligible') || snapshotSha256 !== session.snapshotSha256) {
      throw new Error(`cleanup scope certification changed: ${session.sessionId}`)
    }
  }
  const record: PersistedSessionStorageCleanupScope = {
    proposal: { ...proposal, sessions: [...proposal.sessions] },
    approvalReference: approval.approvalReference,
    approvedScopeSha256: approval.approvedScopeSha256,
    revokedAt: null,
    revocationReference: null,
  }
  runInTransaction(getDbConnection(db), () => setSchemaMeta(getDbConnection(db), CLEANUP_SCOPE_KEY, JSON.stringify(record)))
}

/** Main-process maintenance API: persist the revocation so every subsequent phase and process restart observes it. */
export function revokeSessionStorageCleanupScope(db: AppDatabase, revocationReference: string, now = Date.now()): boolean {
  if (!revocationReference.trim()) throw new Error('cleanup scope revocation reference is required')
  return runInTransaction(getDbConnection(db), () => {
    const raw = getSchemaMeta(getDbConnection(db), CLEANUP_SCOPE_KEY)
    if (!raw) return false
    const record = JSON.parse(raw) as PersistedSessionStorageCleanupScope
    setSchemaMeta(getDbConnection(db), CLEANUP_SCOPE_KEY, JSON.stringify({
      ...record, revokedAt: now, revocationReference,
    }))
    return true
  })
}

function readValidRecord(db: AppDatabase, now: number):
  | Readonly<{ record: PersistedSessionStorageCleanupScope; profileId: string }>
  | InvalidSessionStorageCleanupScopeAuthorization {
  const raw = getSchemaMeta(getDbConnection(db), CLEANUP_SCOPE_KEY)
  if (!raw) return { allowed: false, reason: 'authorization-missing' }
  let record: PersistedSessionStorageCleanupScope
  try { record = JSON.parse(raw) as PersistedSessionStorageCleanupScope } catch {
    return { allowed: false, reason: 'authorization-record-invalid' }
  }
  if (!record || typeof record !== 'object' || !record.proposal || typeof record.proposal !== 'object') {
    return { allowed: false, reason: 'authorization-record-invalid' }
  }
  if (record.revokedAt !== null) return { allowed: false, reason: 'authorization-revoked' }
  const proposal = record.proposal
  if (!isWellFormedProposal(proposal) || proposal.scopeSha256 !== sha256(proposalPayload(proposal)) ||
    proposal.scopeSha256 !== record.approvedScopeSha256 || typeof record.approvalReference !== 'string' ||
    !record.approvalReference.trim()) {
    return { allowed: false, reason: 'authorization-record-invalid' }
  }
  const profileId = getSchemaMeta(getDbConnection(db), PROFILE_ID_KEY)
  if (!profileId || profileId !== proposal.profileId) return { allowed: false, reason: 'profile-identity-mismatch' }
  if (now < proposal.validFrom) return { allowed: false, reason: 'authorization-not-yet-valid' }
  if (now >= proposal.validUntil) return { allowed: false, reason: 'authorization-expired' }
  return { record, profileId }
}

export function getSessionStorageCleanupScopeAuthorization(
  db: AppDatabase,
  sessionId: string,
  now = Date.now(),
): SessionStorageCleanupScopeAuthorization {
  const scope = readValidRecord(db, now)
  if ('allowed' in scope) return scope
  const session = scope.record.proposal.sessions.find((item) => item.sessionId === sessionId)
  if (!session) return { allowed: false, reason: 'session-not-authorized' }
  const currentSnapshot = getSessionMessageContentCleanupAuthorizationSnapshotSha256(db, sessionId)
  if (!currentSnapshot || currentSnapshot !== session.snapshotSha256) return { allowed: false, reason: 'session-snapshot-mismatch' }
  return {
    allowed: true,
    profileId: scope.profileId,
    approvalReference: scope.record.approvalReference,
    scopeSha256: scope.record.proposal.scopeSha256,
    validUntil: scope.record.proposal.validUntil,
  }
}

export function getActiveSessionStorageCleanupScope(
  db: AppDatabase,
  now = Date.now(),
): Readonly<{ allowed: true; sessionIds: readonly string[] }> | InvalidSessionStorageCleanupScopeAuthorization {
  const scope = readValidRecord(db, now)
  if ('allowed' in scope) return scope
  return { allowed: true, sessionIds: scope.record.proposal.sessions.map(({ sessionId }) => sessionId) }
}
