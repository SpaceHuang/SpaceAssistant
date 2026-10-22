import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession } from '../../database/operations'
import { createMemoryAppDb } from '../../database/testHelpers'
import { getDbConnection } from '../../database/sqliteStore'
import { openDatabase } from '../../database'
import { createProjectionBuildCheckpoint } from '../domain/projectionBuild'
import { createSqliteProjectionStateStore } from '../infrastructure/sqlite/sessionProjectionStateStore'
import { createProjectionService } from './projectionService'

describe('Session ProjectionService', () => {
  let db: ReturnType<typeof createMemoryAppDb> | undefined
  let tempDir: string | undefined
  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
    tempDir = undefined
  })

  it('owns rebuild leases and only publishes a cache against the captured live source identity', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection service lease', model: 'test' })
    let now = 1
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 2, connectionEpoch: () => 1, createToken: () => 'token-a', now: () => now,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!

    const forged = { ...lease }
    expect(service.publish(forged, {
      sourceIdentityJson: lease.sourceIdentityJson, payloadGeneration: 'payload-forged',
      payloadDigest: 'digest-forged', validatedRangeJson: '{"from":0,"to":0}', inlinePayload: '[]',
    })).toBeNull()
    expect(service.publish(lease, {
      sourceIdentityJson: lease.sourceIdentityJson, payloadGeneration: 'payload-a',
      payloadDigest: 'digest-a', validatedRangeJson: '{"from":0,"to":0}', inlinePayload: '[]',
    })).toMatchObject({ status: 'valid', payloadGeneration: 'payload-a' })

    now = 2
    const nextLease = service.invalidateInTransaction({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    expect(nextLease).toMatchObject({ status: 'invalid' })
    expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM session_projection_cache WHERE session_id=? AND scope_key=?').get(session.id, 'scope-a'))
      .toEqual({ count: 0 })
  })

  it('stores retryable projection rejection as a scope state with a due retry time', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection rejection state', model: 'test' })
    let now = 1
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 2, connectionEpoch: () => 1, createToken: () => 'reject-token', now: () => now,
    })
    const scopeKey = 'session-projection:chatBodyV1:v1'
    service.ensureInvalid({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey, sessionGeneration: session.generation })!
    now = 5

    expect(service.reject(lease, { failureCaseJson: JSON.stringify({ caseId: 'legacy-mismatch', fingerprint: 'a'.repeat(64) }),
      attempts: 3, retryAfter: 500 })).toMatchObject({ status: 'rejected', attempts: 3, retryAfter: 500,
      failureCaseJson: expect.stringContaining('legacy-mismatch') })
    expect(service.get(session.id, scopeKey)).toMatchObject({ status: 'rejected', retryAfter: 500 })
    expect(service.get(session.id, scopeKey)?.sourceIdentityJson).toBeNull()
  })

  it('reopens due rejected work and fences a rebuild owner from the previous process generation', () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-projection-service-reopen-'))
    const dbPath = path.join(tempDir, 'test.db')
    db = openDatabase(dbPath)
    const session = createSession(db, { name: 'projection process takeover', model: 'test' })
    let now = 1
    let token = 0
    const first = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 2, connectionEpoch: () => 1, createToken: () => `token-${++token}`, now: () => now,
    })
    first.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const firstLease = first.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    expect(first.reject(firstLease, { failureCaseJson: '{"case":"source-mismatch"}', attempts: 1, retryAfter: 10 }))
      .toMatchObject({ status: 'rejected', attempts: 1, retryAfter: 10 })

    db.close()
    db = openDatabase(dbPath)
    const reopenedAtNine = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 2, connectionEpoch: () => 1, createToken: () => `token-${++token}`, now: () => 9,
    })
    expect(reopenedAtNine.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })).toBeNull()

    now = 10
    const dueService = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 2, connectionEpoch: () => 1, createToken: () => `token-${++token}`, now: () => now,
    })
    const dueLease = dueService.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    expect(dueService.get(session.id, 'scope-a')).toMatchObject({ status: 'rebuilding', rebuildToken: dueLease.rebuildToken })

    db.close()
    db = openDatabase(dbPath)
    const nextProcess = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 3, connectionEpoch: () => 2, createToken: () => `token-${++token}`, now: () => 11,
    })
    expect(nextProcess.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation }))
      .toMatchObject({ processGeneration: 3, rebuildToken: 'token-4' })
    expect(nextProcess.publish(dueLease, {
      sourceIdentityJson: dueLease.sourceIdentityJson, payloadGeneration: 'stale-payload', payloadDigest: 'stale-digest',
      validatedRangeJson: '{"from":0,"to":0}', inlinePayload: '[]',
    })).toBeNull()
  })

  it('persists checkpoints only for the live lease and clears them when the source is invalidated', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection checkpoint service', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 8, connectionEpoch: () => 1, createToken: () => 'checkpoint-token-a', now: () => 1,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const checkpointJson = JSON.stringify(createProjectionBuildCheckpoint({ sessionId: lease.sessionId,
      sessionGeneration: lease.sessionGeneration, scopeKey: lease.scopeKey, specVersion: 1,
      sourceIdentityJson: lease.sourceIdentityJson, processGeneration: lease.processGeneration,
      rebuildToken: lease.rebuildToken, startSequence: 0 }))
    expect(service.saveCheckpoint(lease, checkpointJson)).toBe(true)
    expect(service.readCheckpoint(session.id, 'scope-a')).toBe(checkpointJson)
    expect(service.saveCheckpoint({ ...lease }, checkpointJson)).toBe(false)

    const nextProcess = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 9, connectionEpoch: () => 2, createToken: () => 'checkpoint-token-b', now: () => 2,
    })
    const nextLease = nextProcess.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    expect(nextProcess.readCheckpoint(session.id, 'scope-a')).toBe(checkpointJson)
    expect(service.saveCheckpoint(lease, checkpointJson)).toBe(false)
    const transferredCheckpoint = JSON.stringify({ ...JSON.parse(checkpointJson),
      processGeneration: nextLease.processGeneration, rebuildToken: nextLease.rebuildToken })
    expect(nextProcess.saveCheckpoint(nextLease, transferredCheckpoint)).toBe(true)
    expect(nextProcess.readCheckpoint(session.id, 'scope-a')).toBe(transferredCheckpoint)

    service.invalidateInTransaction({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    expect(nextProcess.readCheckpoint(session.id, 'scope-a')).toBeNull()
    expect(nextProcess.saveCheckpoint(nextLease, transferredCheckpoint)).toBe(false)
  })

  it('fences callbacks after the bound database connection epoch changes', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection connection epoch', model: 'test' })
    let connectionEpoch = 11
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => connectionEpoch, createToken: () => 'epoch-token', now: () => 1,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    expect(lease.connectionEpoch).toBe(11)
    connectionEpoch = 12
    expect(service.publish(lease, { sourceIdentityJson: lease.sourceIdentityJson, payloadGeneration: 'payload',
      payloadDigest: 'digest', validatedRangeJson: '{"from":0,"to":0}', inlinePayload: '[]' })).toBeNull()
    expect(service.reject(lease, { failureCaseJson: '{"case":"stale"}', attempts: 1, retryAfter: 2 })).toBeNull()
  })

  it('does not resume or persist a checkpoint after the live session generation changes', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection changed generation', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'generation-token', now: () => 1,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    const checkpointJson = JSON.stringify(createProjectionBuildCheckpoint({ sessionId: lease.sessionId,
      sessionGeneration: lease.sessionGeneration, scopeKey: lease.scopeKey, specVersion: 1,
      sourceIdentityJson: lease.sourceIdentityJson, processGeneration: lease.processGeneration,
      rebuildToken: lease.rebuildToken, startSequence: 0 }))
    expect(service.saveCheckpoint(lease, checkpointJson)).toBe(true)
    getDbConnection(db).prepare('UPDATE sessions SET generation=? WHERE id=?').run('new-session-generation', session.id)
    expect(service.readCheckpoint(session.id, 'scope-a')).toBeNull()
    expect(service.saveCheckpoint(lease, checkpointJson)).toBe(false)
  })

  it('invalidates only the exact live rebuild lease after a worker detects source drift', () => {
    db = createMemoryAppDb()
    const session = createSession(db, { name: 'projection source drift lease', model: 'test' })
    const service = createProjectionService(createSqliteProjectionStateStore(db), {
      processGeneration: () => 1, connectionEpoch: () => 1, createToken: () => 'drift-token', now: () => 1,
    })
    service.ensureInvalid({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })
    const lease = service.beginRebuild({ sessionId: session.id, scopeKey: 'scope-a', sessionGeneration: session.generation })!
    expect(service.invalidateLease(lease)).toBe(true)
    expect(service.get(session.id, 'scope-a')).toMatchObject({ status: 'invalid', rebuildToken: null })
    expect(service.invalidateLease(lease)).toBe(false)
  })
})
