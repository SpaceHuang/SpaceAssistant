import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendMessage, createSession } from '../database/operations'
import { createTempDatabase } from '../database/testHelpers'
import { openDatabase } from '../database'
import { DB_SCHEMA_VERSION } from '../database/schema'
import { getDbConnection } from '../database/sqliteStore'
import { enableCanonicalSessionWriteAuthority } from '../runtime/sessionContentWriteAuthority'
import { certifyCanonicalSessionApiRead } from '../sessionStorage/certification'
import { SqliteAgentHistory } from '../runtime/sqliteAgentHistory'
import { createSessionStorageCleanupProductionBoundary } from '../runtime/sessionStorageCleanupProduction'
import {
  approveSessionStorageCleanupScope,
  createSessionStorageCleanupScopeProposal,
  revokeSessionStorageCleanupScope,
} from '../runtime/sessionStorageCleanupAuthorization'
import {
  getSessionStorageCleanupCompatibilityRecordSha256,
  type SessionStorageCleanupCompatibilityRecord,
} from '../runtime/sessionStorageCleanupReleaseGate'
import {
  SESSION_STORAGE_HISTORY_FORMAT_VERSION,
  SESSION_STORAGE_SPILL_FORMAT_VERSION,
} from '../runtime/sessionStorageCleanupReleaseConfig'
import {
  runSessionMessageContentCleanupMaintenance,
  scheduleSessionMessageContentCleanupMaintenance,
} from './sessionMessageContentCleanupMaintenance'

const currentCommit = 'c'.repeat(40)
const currentVersion = '0.2.4'
const compatibilityRecord: SessionStorageCleanupCompatibilityRecord = {
  formatVersion: 1,
  decision: 'accepted',
  review: { reference: 'rollback-floor-audit#accepted', reviewedAt: '2026-10-04T10:00:00.000Z' },
  candidate: {
    version: currentVersion, commitSha: currentCommit, schemaVersion: DB_SCHEMA_VERSION,
    historyFormatVersion: SESSION_STORAGE_HISTORY_FORMAT_VERSION,
    spillFormatVersion: SESSION_STORAGE_SPILL_FORMAT_VERSION,
  },
  rollback: {
    version: '0.2.3-r', commitSha: 'b'.repeat(40), maxReadableSchemaVersion: DB_SCHEMA_VERSION,
    historyFormatVersions: [SESSION_STORAGE_HISTORY_FORMAT_VERSION],
    spillFormatVersions: [SESSION_STORAGE_SPILL_FORMAT_VERSION], canonicalOnlyReader: true,
    cleanupStates: ['write-stopped', 'pending', 'complete'],
    artifacts: { 'mac-arm64': { downloadUrl: 'https://example.invalid/rollback.dmg', sha256: 'a'.repeat(64) } },
  },
}

function createBoundary(allowContentCleanup: boolean) {
  const resources = new Map([
    ['session-storage-build-identity.json', JSON.stringify({
      formatVersion: 2, version: currentVersion, commitSha: currentCommit, sourceTreeClean: true,
      buildId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', target: { platform: 'mac', arch: 'arm64' },
    })],
    ['session-storage-cleanup-deployment.json', JSON.stringify({
      formatVersion: 1,
      allowContentCleanup,
      compatibilityRecordSha256: allowContentCleanup
        ? getSessionStorageCleanupCompatibilityRecordSha256(compatibilityRecord)
        : null,
    })],
    ['session-storage-cleanup-compatibility.json', JSON.stringify(allowContentCleanup ? compatibilityRecord : null)],
  ])
  return createSessionStorageCleanupProductionBoundary({
    resourcesPath: '/bundle/resources', appVersion: currentVersion, schemaVersion: DB_SCHEMA_VERSION,
    historyFormatVersion: SESSION_STORAGE_HISTORY_FORMAT_VERSION,
    spillFormatVersion: SESSION_STORAGE_SPILL_FORMAT_VERSION, platform: 'darwin', arch: 'arm64',
    readFile: (filePath) => {
      const value = resources.get(filePath.split('/').at(-1)!)
      if (!value) throw new Error('ENOENT')
      return value
    },
  })
}

async function appendCanonicalTranscript(
  db: ReturnType<typeof createTempDatabase>['db'],
  sessionId: string,
  messages: readonly Readonly<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>[],
): Promise<void> {
  await new SqliteAgentHistory(getDbConnection(db), 1, Date.now, sessionId).appendBatch([{
    invocationId: `cleanup-worker-${sessionId}`,
    turnId: `turn-${sessionId}`,
    sequence: 1,
    schemaVersion: 1,
    eventId: `cleanup-worker-context-${sessionId}`,
    idempotencyKey: `cleanup-worker-context-${sessionId}`,
    kind: 'invocation-context-committed',
    payload: { messages },
  }], 0)
}

function approveCleanupScope(db: ReturnType<typeof createTempDatabase>['db'], sessionIds: readonly string[]): void {
  const proposal = createSessionStorageCleanupScopeProposal(db, {
    sessionIds,
    validFrom: Date.now() - 1_000,
    validUntil: Date.now() + 60 * 60_000,
  })
  approveSessionStorageCleanupScope(db, proposal, {
    approvalReference: 'isolated-fixture-approval',
    approvedScopeSha256: proposal.scopeSha256,
  })
}

async function prepareCanonicalSession(db: ReturnType<typeof createTempDatabase>['db'], name: string, suffix: string): Promise<string> {
  const session = createSession(db, { name, model: 'test' })
  const messages = [
    { id: `${suffix}-user`, role: 'user' as const, content: `${suffix} question`, timestamp: 1 },
    { id: `${suffix}-assistant`, role: 'assistant' as const, content: `${suffix} answer`, timestamp: 2 },
  ]
  for (const message of messages) appendMessage(db, { ...message, sessionId: session.id, status: message.role === 'user' ? 'sent' : 'completed' })
  await appendCanonicalTranscript(db, session.id, messages)
  expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
  expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
  getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
    VALUES(?,?,?)`).run(session.id, session.generation, Date.now())
  return session.id
}

describe('会话正文清理维护 worker', () => {
  afterEach(() => vi.useRealTimers())

  it('门禁关闭时不读取候选 session，也不改变任何正文或清理状态', () => {
    const temp = createTempDatabase('session-content-cleanup-worker-disabled-')
    try {
      const session = createSession(temp.db, { name: 'cleanup disabled', model: 'test' })
      appendMessage(temp.db, { id: 'cleanup-disabled-user', sessionId: session.id, role: 'user', content: 'keep me', timestamp: 1, status: 'sent' })
      const before = getDbConnection(temp.db).prepare(`SELECT content,content_storage_state FROM messages WHERE id=?`)
        .get('cleanup-disabled-user')
      const result = runSessionMessageContentCleanupMaintenance(temp.db, createBoundary(false))

      expect(result).toMatchObject({ status: 'blocked', gateReason: 'deployment-disabled', scanned: 0 })
      expect(getDbConnection(temp.db).prepare(`SELECT content,content_storage_state FROM messages WHERE id=?`)
        .get('cleanup-disabled-user')).toEqual(before)
      expect(getDbConnection(temp.db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?')
        .get(session.id)).toEqual({ cleanup_state: 'retained' })
    } finally {
      temp.cleanup()
    }
  })

  it('部署 gate 打开但没有持久 owner scope 时不读取或处理候选 session', () => {
    const temp = createTempDatabase('session-content-cleanup-worker-no-scope-')
    try {
      const session = createSession(temp.db, { name: 'cleanup unapproved', model: 'test' })
      appendMessage(temp.db, { id: 'cleanup-unapproved-user', sessionId: session.id, role: 'user', content: 'keep me', timestamp: 1, status: 'sent' })
      const before = getDbConnection(temp.db).prepare(`SELECT content,content_storage_state FROM messages WHERE id=?`)
        .get('cleanup-unapproved-user')
      const result = runSessionMessageContentCleanupMaintenance(temp.db, createBoundary(true))

      expect(result).toMatchObject({ status: 'blocked', gateReason: 'authorization-missing', scanned: 0 })
      expect(getDbConnection(temp.db).prepare(`SELECT content,content_storage_state FROM messages WHERE id=?`)
        .get('cleanup-unapproved-user')).toEqual(before)
      expect(getDbConnection(temp.db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
        .get(session.id)).toEqual({ cleanup_state: 'retained' })
    } finally {
      temp.cleanup()
    }
  })

  it('逐批清理并从持久 pending 状态续跑，重开数据库后再完成终验', async () => {
    const temp = createTempDatabase('session-content-cleanup-worker-resume-')
    let db = temp.db
    try {
      const session = createSession(db, { name: 'cleanup resumable', model: 'test' })
      const messages = [
        { id: 'cleanup-resume-user', role: 'user' as const, content: 'question', timestamp: 1 },
        { id: 'cleanup-resume-assistant', role: 'assistant' as const, content: 'answer', timestamp: 2 },
      ]
      for (const message of messages) {
        appendMessage(db, { ...message, sessionId: session.id, status: message.role === 'user' ? 'sent' : 'completed' })
      }
      await appendCanonicalTranscript(db, session.id, messages)
      expect(certifyCanonicalSessionApiRead(db, session.id).status).toBe('eligible')
      expect(enableCanonicalSessionWriteAuthority(db, session.id).status).toBe('enabled')
      getDbConnection(db).prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
        VALUES(?,?,?)`).run(session.id, session.generation, Date.now())
      approveCleanupScope(db, [session.id])

      const options = { batchSize: 1, maxSessionsPerRun: 10, maxBatchesPerSession: 1 }
      const boundary = createBoundary(true)
      const first = runSessionMessageContentCleanupMaintenance(db, boundary, options)
      expect(first).toMatchObject({ status: 'processed', writeStopped: 1, pendingStarted: 1, batches: 1, completed: 0 })
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?')
        .get(session.id)).toEqual({ cleanup_state: 'pending' })
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?')
        .get('cleanup-resume-user')).toEqual({ content: '', content_storage_state: 'canonical-backed-only' })
      expect(getDbConnection(db).prepare('SELECT content,content_storage_state FROM messages WHERE id=?')
        .get('cleanup-resume-assistant')).toEqual({ content: 'answer', content_storage_state: 'canonical-backed-dual-write' })

      expect(revokeSessionStorageCleanupScope(db, 'isolated-fixture-revoke-before-resume')).toBe(true)
      expect(runSessionMessageContentCleanupMaintenance(db, boundary, options))
        .toMatchObject({ status: 'blocked', scanned: 0, gateReason: 'authorization-revoked' })
      approveCleanupScope(db, [session.id])

      db.close()
      db = openDatabase(temp.dbPath)
      const resumed = runSessionMessageContentCleanupMaintenance(db, boundary, options)
      expect(resumed).toMatchObject({ status: 'processed', batches: 1, completed: 1 })
      expect(getDbConnection(db).prepare('SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?')
        .get(session.id)).toEqual({ cleanup_state: 'complete' })
      expect(getDbConnection(db).prepare(`SELECT id,content,content_storage_state FROM messages WHERE session_id=? ORDER BY sequence`)
        .all(session.id)).toEqual([
          { id: 'cleanup-resume-user', content: '', content_storage_state: 'canonical-backed-only' },
          { id: 'cleanup-resume-assistant', content: '', content_storage_state: 'canonical-backed-only' },
        ])
    } finally {
      try { db.close() } catch { /* already closed */ }
      temp.cleanup()
    }
  })

  it('API 资格因历史失效后先重新认证，再停写并清理', async () => {
    const temp = createTempDatabase('session-content-cleanup-worker-revalidate-')
    try {
      const session = createSession(temp.db, { name: 'cleanup revalidate', model: 'test' })
      const messages = [
        { id: 'cleanup-revalidate-user', role: 'user' as const, content: 'question', timestamp: 1 },
        { id: 'cleanup-revalidate-assistant', role: 'assistant' as const, content: 'answer', timestamp: 2 },
      ]
      for (const message of messages) {
        appendMessage(temp.db, { ...message, sessionId: session.id, status: message.role === 'user' ? 'sent' : 'completed' })
      }
      await appendCanonicalTranscript(temp.db, session.id, messages)
      expect(certifyCanonicalSessionApiRead(temp.db, session.id).status).toBe('eligible')
      expect(enableCanonicalSessionWriteAuthority(temp.db, session.id).status).toBe('enabled')
      getDbConnection(temp.db).prepare(`INSERT INTO canonical_session_projection_eligibility(session_id,session_generation,validated_at)
        VALUES(?,?,?)`).run(session.id, session.generation, Date.now())
      getDbConnection(temp.db).prepare(`DELETE FROM canonical_session_api_context_eligibility WHERE session_id=?`).run(session.id)
      getDbConnection(temp.db).prepare(`DELETE FROM canonical_session_projection_cache WHERE session_id=? AND cache_key='transcript'`).run(session.id)
      getDbConnection(temp.db).prepare(`UPDATE session_message_content_cutover SET api_read_mode='revalidation-required' WHERE session_id=?`).run(session.id)
      approveCleanupScope(temp.db, [session.id])

      const result = runSessionMessageContentCleanupMaintenance(temp.db, createBoundary(true), {
        batchSize: 10, maxSessionsPerRun: 10, maxBatchesPerSession: 1,
      })

      expect(result).toMatchObject({ status: 'processed', scanned: 1, writeStopped: 1, pendingStarted: 1, batches: 1, ineligible: 0 })
      expect(getDbConnection(temp.db).prepare(`SELECT cleanup_state,api_read_mode FROM session_message_content_cutover WHERE session_id=?`)
        .get(session.id)).toEqual({ cleanup_state: 'complete', api_read_mode: 'revalidation-required' })
    } finally {
      temp.cleanup()
    }
  })

  it('worker 只枚举获批 A；直接边界拒绝 B，新增的合格 C 也不进入停写或清理', async () => {
    const temp = createTempDatabase('session-content-cleanup-scope-boundary-')
    try {
      const approvedA = await prepareCanonicalSession(temp.db, 'approved A', 'scope-a')
      const rejectedB = await prepareCanonicalSession(temp.db, 'rejected B', 'scope-b')
      const driftedD = await prepareCanonicalSession(temp.db, 'approved but drifted D', 'scope-d')
      approveCleanupScope(temp.db, [approvedA, driftedD])
      getDbConnection(temp.db).prepare(`UPDATE sessions SET preview='post-approval drift' WHERE id=?`).run(driftedD)
      const addedC = await prepareCanonicalSession(temp.db, 'added C', 'scope-c')
      const boundary = createBoundary(true)

      for (const step of [
        { kind: 'certify' }, { kind: 'write-stop' }, { kind: 'begin' },
        { kind: 'batch', batchSize: 1 }, { kind: 'verify-complete' },
      ] as const) {
        expect(boundary(temp.db, rejectedB, step)).toMatchObject({
          status: 'blocked', scopeReason: 'session-not-authorized',
        })
      }
      const result = runSessionMessageContentCleanupMaintenance(temp.db, boundary, {
        batchSize: 1, maxSessionsPerRun: 10, maxBatchesPerSession: 1,
      })

      expect(result).toMatchObject({ status: 'processed', scanned: 2, ineligible: 1, writeStopped: 1, pendingStarted: 1, batches: 1 })
      expect(getDbConnection(temp.db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
        .get(approvedA)).toEqual({ cleanup_state: 'pending' })
      expect(getDbConnection(temp.db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
        .get(rejectedB)).toEqual({ cleanup_state: 'retained' })
      expect(getDbConnection(temp.db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
        .get(addedC)).toEqual({ cleanup_state: 'retained' })
      expect(getDbConnection(temp.db).prepare(`SELECT cleanup_state FROM session_message_content_cutover WHERE session_id=?`)
        .get(driftedD)).toEqual({ cleanup_state: 'retained' })
      expect(getDbConnection(temp.db).prepare(`SELECT content FROM messages WHERE session_id=? ORDER BY sequence`).all(rejectedB))
        .toEqual([{ content: 'scope-b question' }, { content: 'scope-b answer' }])
      expect(getDbConnection(temp.db).prepare(`SELECT content FROM messages WHERE session_id=? ORDER BY sequence`).all(addedC))
        .toEqual([{ content: 'scope-c question' }, { content: 'scope-c answer' }])
    } finally {
      temp.cleanup()
    }
  })

  it('延迟启动后按周期检查门禁，停止后不再调度', () => {
    vi.useFakeTimers()
    const temp = createTempDatabase('session-content-cleanup-worker-schedule-')
    try {
      const boundary = createBoundary(false)
      const checkGate = vi.spyOn(boundary, 'checkGate')
      const onResult = vi.fn()
      const stop = scheduleSessionMessageContentCleanupMaintenance(temp.db, boundary, {
        initialDelayMs: 60_000,
        intervalMs: 15 * 60_000,
        onResult,
      })

      vi.advanceTimersByTime(59_999)
      expect(checkGate).not.toHaveBeenCalled()
      expect(onResult).not.toHaveBeenCalled()

      vi.advanceTimersByTime(1)
      expect(checkGate).toHaveBeenCalledTimes(1)
      expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ status: 'blocked', scanned: 0 }))

      vi.advanceTimersByTime(15 * 60_000)
      expect(checkGate).toHaveBeenCalledTimes(2)
      expect(onResult).toHaveBeenCalledTimes(2)

      stop()
      vi.advanceTimersByTime(30 * 60_000)
      expect(checkGate).toHaveBeenCalledTimes(2)
      expect(onResult).toHaveBeenCalledTimes(2)
    } finally {
      temp.cleanup()
    }
  })

  it('owner scope 到期后自动停止周期 worker', async () => {
    const temp = createTempDatabase('session-content-cleanup-scope-expiry-schedule-')
    try {
      const sessionId = await prepareCanonicalSession(temp.db, 'expires while scheduled', 'scope-expiry')
      const now = Date.now()
      const proposal = createSessionStorageCleanupScopeProposal(temp.db, {
        sessionIds: [sessionId], validFrom: now - 1_000, validUntil: now + 500,
      })
      approveSessionStorageCleanupScope(temp.db, proposal, {
        approvalReference: 'isolated-expiring-approval', approvedScopeSha256: proposal.scopeSha256,
      })

      vi.useFakeTimers()
      const boundary = createBoundary(true)
      const checkGate = vi.spyOn(boundary, 'checkGate')
      const onResult = vi.fn()
      const stop = scheduleSessionMessageContentCleanupMaintenance(temp.db, boundary, {
        initialDelayMs: 100, intervalMs: 1_000, onResult,
      })
      vi.advanceTimersByTime(100)
      expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'processed' }))
      vi.advanceTimersByTime(1_000)
      expect(onResult).toHaveBeenLastCalledWith(expect.objectContaining({
        status: 'blocked', gateReason: 'authorization-expired',
      }))
      vi.advanceTimersByTime(10_000)
      expect(checkGate).toHaveBeenCalledTimes(2)
      expect(onResult).toHaveBeenCalledTimes(2)
      stop()
    } finally {
      vi.useRealTimers()
      temp.cleanup()
    }
  })
})
