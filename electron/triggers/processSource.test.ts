import { describe, expect, it } from 'vitest'
import { beginManagedProcess, finishManagedProcess, listManagedProcessTargets, managedProcessRuntimeGeneration, readManagedProcessExit, resetManagedProcessSourceForTests } from './processSource'
import { createTempDatabase } from '../database/testHelpers'
import { createSession } from '../database/operations'
import { createSessionCommands } from '../sessionStorage/commands'
import { createRuntimeTriggerService } from './service'
import { subscribeRuntimeTriggerProcessExitHandoff } from './processExitHandoff'
import { openDatabase } from '../database'

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
      const owner = createSession(db, { name: 'process owner' }).id
      const receiver = createSession(db, { name: 'process receiver' }).id
      const commands = createSessionCommands(db)
      const process = beginManagedProcess({ sessionId: owner, toolName: 'run_script' })
      const service = createRuntimeTriggerService(commands, { authorize: () => true, authorizeTarget: () => true,
        resolveBaseline: () => ({ runtimeGeneration: process.runtimeGeneration }) })
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
      expect(createSessionCommands(db).runtimeTriggers.read(registered.trigger.triggerId)).toMatchObject({ state: 'matched', event: { exitCode: 0 } })
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
