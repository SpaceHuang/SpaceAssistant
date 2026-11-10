import { describe, expect, it, vi } from 'vitest'
import { beginManagedProcess, finishManagedProcess, listManagedProcessTargets, managedProcessRuntimeGeneration, readManagedProcessExit, resetManagedProcessSourceForTests } from './processSource'
import { createTempDatabase } from '../database/testHelpers'
import { createSession, getSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { subscribeRuntimeTriggerProcessExitHandoff } from './processExitHandoff'
import { getDbConnection, openDatabase } from '../database'
import { createRuntimeTriggerHostService } from './hostService'
import { createRuntimeTriggerDelivery } from './delivery'
import { createRuntimeTriggerAuthorizationBinding } from './hostAuthorization'
import { createRuntimeTriggerRecovery } from './recovery'

describe('managed process trigger facts', () => {
  it('tracks opaque IDs and emits one settled exit with code, signal and bounded output reference', () => {
    resetManagedProcessSourceForTests()
    const handle = beginManagedProcess({ sessionId: 'session-a', toolName: 'run_shell' })
    expect(handle.managedProcessId).not.toMatch(/^\d+$/)
    expect(listManagedProcessTargets('session-a')).toEqual([{ kind: 'managed-process', id: handle.managedProcessId, label: 'run_shell', status: 'running' }])
    expect(listManagedProcessTargets('session-b')).toEqual([])
    expect(finishManagedProcess(handle, { exitCode: 2, signal: null, reason: 'process_exit', outputRef: { bytes: 5, truncated: false } })).toBe(true)
    expect(finishManagedProcess(handle, { exitCode: 0, signal: null, reason: 'late-close' })).toBe(false)
    expect(readManagedProcessExit(handle.managedProcessId, handle.runtimeGeneration)).toMatchObject({ exitCode: 2, reason: 'process_exit' })
    expect(readManagedProcessExit(handle.managedProcessId, 'other-generation')).toMatchObject({ kind: 'source-gap', code: 'TRIGGER_SOURCE_GAP' })
    expect(listManagedProcessTargets('session-a')).toEqual([])
  })

  it('keeps a live process distinguishable from a lost process until its exit is recorded', () => {
    resetManagedProcessSourceForTests()
    const handle = beginManagedProcess({ sessionId: 'session-a', toolName: 'run_shell' })
    expect(readManagedProcessExit(handle.managedProcessId, handle.runtimeGeneration)).toEqual({ kind: 'running' })
    expect(finishManagedProcess(handle, { exitCode: 0, signal: null, reason: 'process_exit' })).toBe(true)
    expect(readManagedProcessExit(handle.managedProcessId, handle.runtimeGeneration)).toMatchObject({ kind: 'terminal', exitCode: 0 })
    expect(readManagedProcessExit('missing', handle.runtimeGeneration)).toMatchObject({ kind: 'source-gap' })
  })

  it('rejects arbitrary IDs and cannot infer prior-generation or restart outcomes', () => {
    resetManagedProcessSourceForTests()
    expect(readManagedProcessExit('1234', 'current')).toMatchObject({ kind: 'source-gap', code: 'TRIGGER_SOURCE_GAP' })
    const handle = beginManagedProcess({ sessionId: 'session-a', toolName: 'run_script' })
    const previousGeneration = handle.runtimeGeneration
    resetManagedProcessSourceForTests()
    expect(handle.runtimeGeneration).toBe(previousGeneration)
    expect(previousGeneration).not.toBe(managedProcessRuntimeGeneration())
    expect(readManagedProcessExit(handle.managedProcessId, handle.runtimeGeneration)).toMatchObject({ kind: 'source-gap', code: 'TRIGGER_SOURCE_GAP' })
  })

  it('commits matching registrations before a managed process exit can be observed or lost to restart', async () => {
    resetManagedProcessSourceForTests()
    const temp = createTempDatabase('runtime-trigger-process-handoff-')
    let db = temp.db
    let unsubscribe = () => undefined
    try {
      const ownerSession = createSession(db, { name: 'process owner', workDirProfileId: 'process-profile' })
      const receiverSession = createSession(db, { name: 'process receiver', workDirProfileId: 'process-profile' })
      const owner = ownerSession.id
      const receiver = receiverSession.id
      const commands = createSessionCommands(db)
      const process = beginManagedProcess({ sessionId: owner, toolName: 'run_script' })
      let visibleSessions = [ownerSession, receiverSession]
      const params = { clientKey: 'process-handoff', receiverSessionId: receiver, expiresAt: Date.now() + 60_000,
        condition: { type: 'process_exit' as const, managedProcessId: process.managedProcessId } }
      const service = createRuntimeTriggerHostService({ commands,
        queries: { listSessions: () => visibleSessions, readSession: (sessionId: string) => getSession(db, sessionId), imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }), readTurn: () => undefined } as never })
      const registered = await service.register({ ownerSessionId: owner, params })
      unsubscribe = subscribeRuntimeTriggerProcessExitHandoff(commands)
      expect(finishManagedProcess(process, { exitCode: 0, signal: null, reason: 'process_exit' })).toBe(true)
      expect(commands.runtimeTriggers.read(registered.trigger.triggerId)).toMatchObject({
        state: 'matched', event: { type: 'process_exit', managedProcessId: process.managedProcessId, exitCode: 0 }
      })
      await expect(service.register({ ownerSessionId: owner, params })).resolves.toMatchObject({ replayed: true,
        trigger: { triggerId: registered.trigger.triggerId, state: 'matched' } })
      await expect(service.register({ ownerSessionId: owner, params: { ...params, clientKey: 'new-key-after-exit' } }))
        .rejects.toThrow('TRIGGER_NOT_FOUND_OR_FORBIDDEN:session-not-authorized')
      await expect(service.register({ ownerSessionId: owner, params: { ...params, condition: { type: 'process_exit', managedProcessId: 'different-process' } } }))
        .rejects.toThrow('TRIGGER_CONFLICT:client-key-definition-mismatch')
      visibleSessions = [receiverSession]
      await expect(service.register({ ownerSessionId: owner, params })).rejects.toThrow('TRIGGER_NOT_FOUND_OR_FORBIDDEN:session-not-authorized')
      visibleSessions = [ownerSession]
      await expect(service.register({ ownerSessionId: owner, params })).rejects.toThrow('TRIGGER_NOT_FOUND_OR_FORBIDDEN:session-not-authorized')
      visibleSessions = [ownerSession, receiverSession]
      db.close()
      resetManagedProcessSourceForTests()
      db = openDatabase(temp.dbPath)
      const reopenedCommands = createSessionCommands(db)
      const reopenedService = createRuntimeTriggerHostService({ commands: reopenedCommands,
        queries: { listSessions: () => visibleSessions, readSession: (sessionId: string) => getSession(db, sessionId), imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }), readTurn: () => undefined } as never })
      const recovered = reopenedCommands.runtimeTriggers.read(registered.trigger.triggerId)!
      expect(recovered).toMatchObject({ state: 'matched', event: { exitCode: 0 } })
      expect(reopenedService.authorizeSource(owner, receiver, recovered.definition.condition, recovered.definition.sourceBaseline,
        { ...recovered.event, managedProcessId: 'tampered-process-id' })).toMatchObject({ allowed: false })
      const scopeForReceiver = reopenedService.resolveQueueScope(receiver)!
      let failMessageIdCommit = true
      const deliver = createRuntimeTriggerDelivery({
        read: (id) => reopenedCommands.runtimeTriggers.read(id),
        update: (id, revision, patch) => {
          if ('messageId' in patch && failMessageIdCommit) { failMessageIdCommit = false; return null }
          return reopenedCommands.runtimeTriggers.update(id, revision, patch)
        },
        expire: (id, revision) => reopenedCommands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: Date.now() }),
        authorize: (trigger, queueScope) => {
          const decision = reopenedService.authorizeSource(trigger.ownerSessionId, trigger.receiverSessionId,
            trigger.definition.condition, trigger.definition.sourceBaseline, trigger.event)
          return decision.allowed ? createRuntimeTriggerAuthorizationBinding({ trigger, queueScope,
            authority: { policyRevision: 'policy-current', authorizationGeneration: 'auth-current', runtimeGeneration: 'runtime-current' },
            isAuthorized: () => true }) : null
        },
        queueScope: () => scopeForReceiver,
        enqueue: (request) => reopenedCommands.scopedQueue.enqueue(request),
        readReceipt: (request) => reopenedCommands.scopedQueue.readReceipt(request)
      })
      visibleSessions = [receiverSession]
      expect(deliver(registered.trigger.triggerId)).toMatchObject({ kind: 'failed', case: 'delivery-write-conflict' })
      const requestId = `runtime-trigger:${registered.trigger.triggerId}`
      expect(reopenedCommands.scopedQueue.readReceipt({ sessionId: receiver, requestId, queueScope: scopeForReceiver })).toBeUndefined()
      visibleSessions = [ownerSession, receiverSession]
      expect(deliver(registered.trigger.triggerId)).toMatchObject({ kind: 'failed', case: 'delivery-write-conflict' })
      const durableReceipt = reopenedCommands.scopedQueue.readReceipt({ sessionId: receiver, requestId, queueScope: scopeForReceiver })
      expect(durableReceipt).toMatchObject({ queuedMessageId: expect.any(String), state: 'queued' })
      db.close()
      db = openDatabase(temp.dbPath)
      const afterCrashCommands = createSessionCommands(db)
      const afterCrashService = createRuntimeTriggerHostService({ commands: afterCrashCommands,
        queries: { listSessions: () => visibleSessions, readSession: (sessionId: string) => getSession(db, sessionId), imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }), readTurn: () => undefined } as never })
      const afterCrashDelivery = createRuntimeTriggerDelivery({
        read: (id) => afterCrashCommands.runtimeTriggers.read(id),
        update: (id, revision, patch) => afterCrashCommands.runtimeTriggers.update(id, revision, patch),
        expire: (id, revision) => afterCrashCommands.runtimeTriggers.update(id, revision, { state: 'expired', updatedAt: Date.now() }),
        authorize: (trigger, queueScope) => createRuntimeTriggerAuthorizationBinding({ trigger, queueScope,
          authority: { policyRevision: 'policy-current', authorizationGeneration: 'auth-current', runtimeGeneration: 'runtime-current' },
          isAuthorized: () => true }),
        queueScope: () => scopeForReceiver,
        enqueue: (request) => afterCrashCommands.scopedQueue.enqueue(request),
        readReceipt: (request) => afterCrashCommands.scopedQueue.readReceipt(request)
      })
      const recoveryDelivery = vi.fn(afterCrashDelivery)
      const recovery = createRuntimeTriggerRecovery({
        listWaiting: () => [], listMatched: () => afterCrashCommands.runtimeTriggers.listByState('matched', 100),
        read: (id) => afterCrashCommands.runtimeTriggers.read(id), evaluateWaiting: () => ({ kind: 'none' }),
        match: vi.fn(), expire: vi.fn(), fail: (id, revision, code, caseId) => afterCrashCommands.runtimeTriggers.update(id, revision,
          { state: 'failed', result: { code, case: caseId }, updatedAt: Date.now() }),
        deliver: recoveryDelivery, update: (id, revision, patch) => afterCrashCommands.runtimeTriggers.update(id, revision, patch),
        readReceipt: (trigger) => afterCrashCommands.scopedQueue.readReceipt({ sessionId: receiver,
          requestId: `runtime-trigger:${trigger.id}`, queueScope: scopeForReceiver }),
        isSessionBusy: () => false, startReceiver: () => 'busy', readTurnTerminal: () => ({ kind: 'active' })
      })
      await recovery.scan()
      expect(recoveryDelivery).not.toHaveBeenCalled()
      expect(afterCrashCommands.runtimeTriggers.read(registered.trigger.triggerId)?.messageId).toBe(durableReceipt!.queuedMessageId)
      expect(getDbConnection(db).prepare('SELECT COUNT(*) AS count FROM queue_input_requests WHERE request_id=?').get(requestId))
        .toEqual({ count: 1 })
      const matched = afterCrashCommands.runtimeTriggers.read(registered.trigger.triggerId)!
      expect(afterCrashCommands.runtimeTriggers.update(matched.id, matched.revision, { state: 'completed', updatedAt: Date.now() }))
        .toMatchObject({ state: 'completed' })
      await expect(afterCrashService.register({ ownerSessionId: owner, params })).resolves.toMatchObject({ replayed: true,
        trigger: { triggerId: registered.trigger.triggerId, state: 'completed' } })
    } finally { unsubscribe(); temp.cleanup(db) }
  })

  it.each([
    { exitCode: null, signal: 'SIGTERM', reason: 'signal' },
    { exitCode: null, signal: null, reason: 'spawn_error' }
  ])('keeps signal and spawn failure as distinct known terminal facts', (result) => {
    resetManagedProcessSourceForTests()
    const handle = beginManagedProcess({ sessionId: 'session-a', toolName: 'run_shell' })
    expect(finishManagedProcess(handle, result)).toBe(true)
    expect(readManagedProcessExit(handle.managedProcessId, handle.runtimeGeneration)).toMatchObject({ ok: true, ...result })
  })
})
