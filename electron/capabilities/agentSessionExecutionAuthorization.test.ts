import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { claimAgentSessionTurnAtomically, createSession, deleteSession, updateSession } from '../database/operations'
import { createMemoryAppDb } from '../database/testHelpers'
import { createSqliteSessionStorage } from '../sessionStorage/sqliteSessionStorage'
import { createAgentSessionExecutionAuthorization, evaluateAgentSessionExecutionPolicy } from './agentSessionExecutionAuthorization'
import { DEFAULT_POLICY_RULES } from '../../src/shared/policy/defaultRules'

describe('agent-session execution authorization', () => {
  const dbs: ReturnType<typeof createMemoryAppDb>[] = []
  afterEach(() => { for (const db of dbs.splice(0)) db.close() })

  it('uses the current shared toolkit policy for reauthorization without exposing the queued body', () => {
    const decision = evaluateAgentSessionExecutionPolicy({ sessionId: 'execution-target', rules: DEFAULT_POLICY_RULES, config: {} })
    expect(decision).toEqual({ kind: 'require-confirm', ruleId: 'toolkit-act-ask' })
    const denied = evaluateAgentSessionExecutionPolicy({ sessionId: 'execution-target', config: {}, rules: [
      { id: 'execution-target-deny', when: 'invocation', match: { lane: ['desktop'], toolName: 'toolkit.call', signals: ['toolkit-act'] },
        action: 'deny', reason: 'execution denied by policy' }
    ] })
    expect(denied).toEqual({ kind: 'deny', ruleId: 'execution-target-deny' })
  })

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

  it('rejects an old approval when the same profile id resolves to a different actual path', async () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'same-profile-path-owner', workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: 'same-profile-path-target', workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'same-profile-path-change'
    const bindingA = 'profile-a:sha256-path-a'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'approval bound to path a', authorizationBinding: { ownerSessionId: owner.id,
        targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: bindingA, queueScope: 'desktop',
        payloadDigest: createHash('sha256').update('approval bound to path a').digest('hex') } })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision-path-a', permitRef: 'permit-path-a',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: bindingA, requestId,
      messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1', approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    const requestUserConfirmation = vi.fn(async () => 'approved' as const)
    const service = createAgentSessionExecutionAuthorization({ storage,
      readCurrentAuthority: () => ({ policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1' }),
      resolveWorkDirProfileId: () => 'profile-a:sha256-path-b',
      evaluateCurrentPolicy: () => ({ kind: 'require-confirm', ruleId: 'toolkit-act-ask' }), requestUserConfirmation })
    const resolved = service.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })
    expect(resolved).toMatchObject({ kind: 'waiting', reason: 'source-mismatch' })
    await expect(service.reauthorize!({ sessionId: target.id, requestId, messageId: accepted.source.messageId })).resolves.toBe('waiting')
    expect(requestUserConfirmation).not.toHaveBeenCalled()
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
  })

  it('rechecks the effective workdir path inside the atomic claim callback', () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'claim-path-owner', workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: 'claim-path-target', workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'claim-path-change'
    const binding = 'profile-a:sha256-path-a'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'claim path binding', authorizationBinding: { ownerSessionId: owner.id, targetSessionId: target.id,
        targetGeneration: target.generation, workDirProfileId: binding, queueScope: 'desktop',
        payloadDigest: createHash('sha256').update('claim path binding').digest('hex') } })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision-claim-path', permitRef: 'permit-claim-path',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: binding, requestId,
      messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1', approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    let pathBinding = binding
    const resolved = createAgentSessionExecutionAuthorization({ storage,
      readCurrentAuthority: () => ({ policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: '1' }),
      resolveWorkDirProfileId: () => pathBinding,
      resolveWorkDirSnapshot: () => ({ workDir: pathBinding.endsWith('path-a') ? '/work/a' : '/work/b', binding: pathBinding })
    }).resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })
    expect(resolved.kind).toBe('approved')
    if (resolved.kind !== 'approved') throw new Error(`unexpected waiting: ${resolved.reason}`)
    const current = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    pathBinding = 'profile-a:sha256-path-b'
    expect(resolved.finalCheck({ source: current.source, approval: current.approval!, originDigest: current.originDigest,
      approvalDigest: current.approvalDigest!, targetGeneration: target.generation })).toBe(false)
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
  })

  it('re-enters target execution policy after restart even when the sender session was deleted', () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'restart-policy-owner', workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: 'restart-policy-target', workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'restart-policy-request'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id,
      requestId, content: 'persisted untrusted input', authorizationBinding: { ownerSessionId: owner.id, targetSessionId: target.id,
        targetGeneration: target.generation, workDirProfileId: 'profile-a', queueScope: 'desktop',
        payloadDigest: createHash('sha256').update('persisted untrusted input').digest('hex'),
        policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: 'old-process' } })
    const snapshot = storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })!
    const approval = { version: 1 as const, originDigest: snapshot.originDigest, decisionTraceRef: 'decision-old', permitRef: 'permit-old',
      ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation, workDirProfileId: 'profile-a', requestId,
      messageId: accepted.source.messageId, queueScope: 'desktop' as const, payloadDigest: accepted.source.payloadSha256,
      policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: 'old-process', approvedAt: Date.now() }
    storage.commands.agentSessionMessages.refreshExecutionApproval({ sessionId: target.id, requestId,
      expectedOriginDigest: snapshot.originDigest, expectedApprovalDigest: null, approval })
    deleteSession(db, owner.id)
    const evaluateCurrentPolicy = vi.fn(() => ({ kind: 'deny' as const, ruleId: 'current-execution-deny' }))
    const service = createAgentSessionExecutionAuthorization({ storage,
      readCurrentAuthority: () => ({ policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: 'new-process' }),
      resolveWorkDirProfileId: () => 'profile-a', evaluateCurrentPolicy })
    const resolution = service.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId })
    expect(evaluateCurrentPolicy).toHaveBeenCalledWith(expect.objectContaining({ sessionId: target.id, requestId,
      source: expect.objectContaining({ ownerSessionId: owner.id, messageId: accepted.source.messageId }) }))
    expect(resolution).toMatchObject({ kind: 'rejected', reason: 'policy-rejected', ruleId: 'current-execution-deny' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId })).toMatchObject({ kind: 'queued' })
    const requireConfirm = createAgentSessionExecutionAuthorization({ storage,
      readCurrentAuthority: () => ({ policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: 'new-process' }),
      resolveWorkDirProfileId: () => 'profile-a', evaluateCurrentPolicy: () => ({ kind: 'require-confirm', ruleId: 'toolkit-act-ask' }) })
    expect(requireConfirm.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId }))
      .toEqual({ kind: 'waiting', reason: 'approval-stale' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
    const allow = createAgentSessionExecutionAuthorization({ storage,
      readCurrentAuthority: () => ({ policyRevision: '1', authorizationGeneration: '1', runtimeGeneration: 'new-process' }),
      resolveWorkDirProfileId: () => 'profile-a', evaluateCurrentPolicy: () => ({ kind: 'allow' }) })
    expect(allow.resolve({ sessionId: target.id, requestId, messageId: accepted.source.messageId }))
      .toEqual({ kind: 'waiting', reason: 'approval-stale' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
  })

  it('replays a missing approval through deduplicated target confirmation without creating a Turn while waiting', async () => {
    const db = createMemoryAppDb(); dbs.push(db)
    const owner = createSession(db, { name: 'recovery-confirm-owner', workDirProfileId: 'profile-a' })
    const target = createSession(db, { name: 'recovery-confirm-target', workDirProfileId: 'profile-a' })
    const storage = createSqliteSessionStorage(db)
    const requestId = 'recovery-confirm-request'
    const accepted = storage.commands.agentSessionMessages.accept({ ownerSessionId: owner.id, targetSessionId: target.id, requestId,
      content: 'persisted through application restart', authorizationBinding: { decisionTraceRef: 'send-decision',
        permitRef: 'send-user-receipt', ownerSessionId: owner.id, targetSessionId: target.id, targetGeneration: target.generation,
        workDirProfileId: 'profile-a', queueScope: 'desktop', payloadDigest: createHash('sha256').update('persisted through application restart').digest('hex'),
        policyRevision: '1', authorizationGeneration: 'old-auth', runtimeGeneration: 'old-runtime' } })
    let resolveConfirmation!: (value: 'approved' | 'rejected' | 'waiting') => void
    const requestUserConfirmation = vi.fn(() => new Promise<'approved' | 'rejected' | 'waiting'>((resolve) => { resolveConfirmation = resolve }))
    const service = createAgentSessionExecutionAuthorization({ storage,
      readCurrentAuthority: () => ({ policyRevision: '2', authorizationGeneration: 'new-auth', runtimeGeneration: 'new-runtime' }),
      resolveWorkDirProfileId: () => 'profile-a',
      evaluateCurrentPolicy: () => ({ kind: 'require-confirm', ruleId: 'toolkit-act-ask' }), requestUserConfirmation })
    const input = { sessionId: target.id, requestId, messageId: accepted.source.messageId }
    const first = service.reauthorize!(input)
    const concurrent = service.reauthorize!(input)
    await Promise.resolve()
    expect(requestUserConfirmation).toHaveBeenCalledTimes(1)
    expect(storage.commands.agentSessionMessages.readSettlement({ ownerSessionId: owner.id, requestId })).toMatchObject({ kind: 'queued' })
    expect(storage.execution.readTurnByRequest({ sessionId: target.id, requestId })).toBeUndefined()
    resolveConfirmation('waiting')
    await expect(first).resolves.toBe('waiting')
    await expect(concurrent).resolves.toBe('waiting')
    expect(storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })?.approval).toBeUndefined()

    requestUserConfirmation.mockResolvedValueOnce('approved')
    await expect(service.reauthorize!(input)).resolves.toBe('approved')
    expect(storage.commands.agentSessionMessages.readApprovalSnapshot({ sessionId: target.id, requestId })?.approval).toMatchObject({
      policyRevision: '2', authorizationGeneration: 'new-auth', runtimeGeneration: 'new-runtime',
      ownerSessionId: owner.id, targetSessionId: target.id, requestId, messageId: accepted.source.messageId,
      workDirProfileId: 'profile-a', queueScope: 'desktop', payloadDigest: accepted.source.payloadSha256
    })
    expect(service.resolve(input).kind).toBe('approved')
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
