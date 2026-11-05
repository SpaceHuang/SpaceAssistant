import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { claimAgentSessionTurnAtomically, createSession, deleteSession, updateSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createAgentSessionExecutionAuthorization } from './agentSessionExecutionAuthorization'

describe('agent-session execution authorization', () => {
  const dbs: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of dbs.splice(0)) db.close() })

  it('allows only the persisted approval under the current authority and rechecks inside claim', () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'approval owner' })
    const target = createSession(db, { name: 'approval target' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'approval-current-request'
    const decision = { decisionTraceRef: 'decision-current', permitRef: 'permit-current', ownerSessionId: owner.id,
      targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), queueScope: 'desktop', payloadDigest: createHash('sha256').update('message body').digest('hex'),
      policyRevision: '7', authorizationGeneration: 'auth-current', runtimeGeneration: 'runtime-current' }
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'message body', authorizationBinding: decision })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: decision.decisionTraceRef,
      permitRef: decision.permitRef, ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"),
      requestId, messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: decision.policyRevision, authorizationGeneration: decision.authorizationGeneration,
      runtimeGeneration: decision.runtimeGeneration, approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    const authority = { policyRevision: '7', authorizationGeneration: 'auth-current', runtimeGeneration: 'runtime-current' }
    const service = createAgentSessionExecutionAuthorization({ storage, readCurrentAuthority: () => authority })

    const resolved = service.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })
    if (resolved.kind === 'waiting') throw new Error(resolved.reason)
    expect(resolved).toMatchObject({ kind: 'approved' })
    if (resolved.kind !== 'approved') throw new Error('expected a current approval')
    const persisted = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    expect(resolved.finalCheck({ source: persisted.source, approval: persisted.approval!, originDigest: persisted.originDigest,
      approvalDigest: persisted.approvalDigest!, targetGeneration: target.generation })).toBe(true)

    updateSession(db, target.id, { workDirProfileId: 'different-profile' })
    expect(resolved.finalCheck({ source: persisted.source, approval: persisted.approval!, originDigest: persisted.originDigest,
      approvalDigest: persisted.approvalDigest!, targetGeneration: target.generation })).toBe(false)

    authority.authorizationGeneration = 'auth-revoked'
    expect(resolved.finalCheck({ source: persisted.source, approval: persisted.approval!, originDigest: persisted.originDigest,
      approvalDigest: persisted.approvalDigest!, targetGeneration: target.generation })).toBe(false)
    expect(createAgentSessionExecutionAuthorization({ storage, readCurrentAuthority: () => authority })
      .resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })).toEqual({ kind: 'waiting', reason: 'source-mismatch' })
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId })).toMatchObject({ kind: 'queued' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
  })

  it('accepts a newly user-approved policy trace for the same immutable queued source', () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'reauthorization owner' })
    const target = createSession(db, { name: 'reauthorization target' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'reauthorization-request'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'same immutable message', authorizationBinding: {
        decisionTraceRef: 'old-decision', permitRef: 'old-permit', ownerSessionId: owner.id, targetSessionId: target.id,
        targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), queueScope: 'desktop', payloadDigest: createHash('sha256').update('same immutable message').digest('hex'),
        policyRevision: '7', authorizationGeneration: 'auth-old', runtimeGeneration: 'runtime-old'
      } })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'new-decision', permitRef: 'new-user-permit',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), requestId,
      messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: '8', authorizationGeneration: 'auth-new', runtimeGeneration: 'runtime-new', approvedAt: Date.now() }
    expect(storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })).not.toBeNull()
    const refreshedAuthorization = createAgentSessionExecutionAuthorization({ storage, readCurrentAuthority: () => ({ policyRevision: '8',
      authorizationGeneration: 'auth-new', runtimeGeneration: 'runtime-new' }) }).resolve({ sessionId: target.id, requestId,
      messageId: accepted.source.messageId })
    expect(refreshedAuthorization).toMatchObject({ kind: 'approved' })
    if (refreshedAuthorization.kind !== 'approved') throw new Error('expected refreshed approval')
    const refreshed = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    expect(refreshedAuthorization.finalCheck({ source: refreshed.source, approval: refreshed.approval!, originDigest: refreshed.originDigest,
      approvalDigest: refreshed.approvalDigest!, targetGeneration: target.generation })).toBe(true)
    expect(storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })?.source.authorizationBinding)
      .toMatchObject({ decisionTraceRef: 'old-decision', permitRef: 'old-permit', policyRevision: '7' })
  })

  it('rechecks desktop ownership and profile at claim after the queued target classification changes', () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'scope-owner', workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: 'scope-target', workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'scope-recheck-request'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'scope bound', authorizationBinding: {} })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision', permitRef: 'permit',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), requestId,
      messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1', approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    const service = createAgentSessionExecutionAuthorization({ storage, readCurrentAuthority: () => ({
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1'
    }) })
    updateSession(db, target.id, { ownership: 'remote' })
    expect(service.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId }))
      .toMatchObject({ kind: 'waiting', reason: 'source-mismatch' })
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId })).toMatchObject({ kind: 'queued' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
  })

  it('does not resolve an old approval after the target changes work-directory profile before resolution', () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'profile-change-owner', workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: 'profile-change-target', workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'profile-change-before-resolution'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'approval bound to profile a', authorizationBinding: { ownerSessionId: owner.id, targetSessionId: target.id,
        targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), queueScope: 'desktop', payloadDigest: createHash('sha256').update('approval bound to profile a').digest('hex'),
        profileId: 'profile-a' } })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision', permitRef: 'permit',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: 'profile-a', requestId, messageId: accepted.source.messageId,
      queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256, policyRevision: '1', authorizationGeneration: '1',
      runtimeGeneration: '1', approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    updateSession(db, target.id, { workDirProfileId: 'profile-b' })
    const resolved = createAgentSessionExecutionAuthorization({ storage, readCurrentAuthority: () => ({ policyRevision: '1',
      authorizationGeneration: '1', runtimeGeneration: '1' }) }).resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })
    expect(resolved).toMatchObject({ kind: 'waiting', reason: 'source-mismatch' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
  })

  it.each(['before-resolution', 'after-resolution'] as const)('keeps the approved source executable when its sender is deleted %s', (deleteTiming) => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: `deleted-owner-${deleteTiming}`, workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: `deleted-owner-target-${deleteTiming}`, workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = `deleted-owner-${deleteTiming}-request`
    const payloadDigest = createHash('sha256').update('approved before sender deletion').digest('hex')
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'approved before sender deletion', authorizationBinding: { ownerSessionId: owner.id,
        targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), queueScope: 'desktop', payloadDigest } })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision', permitRef: 'permit',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: (target.workDirProfileId || "default"), requestId,
      messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1', approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    const service = createAgentSessionExecutionAuthorization({ storage, readCurrentAuthority: () => ({
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1'
    }) })
    if (deleteTiming === 'before-resolution') deleteSession(db, owner.id)
    const resolution = service.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })
    expect(resolution.kind).toBe('approved')
    if (resolution.kind !== 'approved') throw new Error(`unexpected waiting: ${resolution.reason}`)
    if (deleteTiming === 'after-resolution') deleteSession(db, owner.id)
    expect(claimAgentSessionTurnAtomically(db, { sessionId: target.id, requestId, userMessageId: accepted.source.messageId,
      turnId: `deleted-owner-${deleteTiming}-turn`, assistantMessageId: `deleted-owner-${deleteTiming}-assistant`,
      startToken: 'start-token' }, resolution.finalCheck)).toBeTruthy()
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId }))
      .toMatchObject({ kind: 'claimed', turnId: `deleted-owner-${deleteTiming}-turn` })
  })
})
