import { describe, expect, it, vi } from 'vitest'
import { beginManagedProcess, finishManagedProcess, listManagedProcessTargets, managedProcessRuntimeGeneration, readManagedProcessExit, resetManagedProcessSourceForTests } from './processSource'
import { createTempDatabase } from '../database/testHelpers'
import { createSession, getSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { subscribeRuntimeTriggerProcessExitHandoff } from './processExitHandoff'
import { openDatabase } from '../database'
import { createRuntimeTriggerHostService } from './hostService'
import { createRuntimeTriggerDelivery } from './delivery'
import { createRuntimeTriggerAuthorizationBinding } from './hostAuthorization'

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
      const service = createRuntimeTriggerHostService({ commands,
        queries: { listSessions: () => visibleSessions, readSession: (sessionId: string) => getSession(db, sessionId), imAcceptedFacts: {} } as never,
        execution: { historyFor: () => ({ listInvocationIds: () => [], read: vi.fn() }), readTurn: () => undefined } as never })
      const registered = await service.register({ ownerSessionId: owner, params: { clientKey: 'process-handoff', receiverSessionId: receiver,
        expiresAt: Date.now() + 60_000, condition: { type: 'process_exit', managedProcessId: process.managedProcessId } } })
      unsubscribe = subscribeRuntimeTriggerProcessExitHandoff(commands)
      expect(finishManagedProcess(process, { exitCode: 0, signal: null, reason: 'process_exit' })).toBe(true)
      expect(commands.runtimeTriggers.read(registered.trigger.triggerId)).toMatchObject({
        state: 'matched', event: { type: 'process_exit', managedProcessId: process.managedProcessId, exitCode: 0 }
      })
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
      const deliver = createRuntimeTriggerDelivery({
        read: (id) => reopenedCommands.runtimeTriggers.read(id),
        update: (id, revision, patch) => reopenedCommands.runtimeTriggers.update(id, revision, patch),
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
      expect(reopenedCommands.scopedQueue.readReceipt({ sessionId: receiver, requestId: `runtime-trigger:${registered.trigger.triggerId}`,
        queueScope: scopeForReceiver })).toBeUndefined()
      visibleSessions = [ownerSession, receiverSession]
      expect(deliver(registered.trigger.triggerId)).toMatchObject({ kind: 'enqueued', messageId: expect.any(String) })
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
