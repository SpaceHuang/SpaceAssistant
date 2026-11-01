import { describe, expect, it } from 'vitest'
import { beginManagedProcess, finishManagedProcess, listManagedProcessTargets, managedProcessRuntimeGeneration, readManagedProcessExit, resetManagedProcessSourceForTests } from './processSource'

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
    expect(readManagedProcessExit(handle.managedProcessId, 'other-generation')).toMatchObject({ ok: false, code: 'TRIGGER_SOURCE_GAP' })
    expect(listManagedProcessTargets('session-a')).toEqual([])
  })

  it('rejects arbitrary IDs and cannot infer prior-generation or restart outcomes', () => {
    resetManagedProcessSourceForTests()
    expect(readManagedProcessExit('1234', 'current')).toMatchObject({ ok: false, code: 'TRIGGER_SOURCE_GAP' })
    const handle = beginManagedProcess({ sessionId: 'session-a', toolName: 'run_script' })
    const previousGeneration = handle.runtimeGeneration
    resetManagedProcessSourceForTests()
    expect(handle.runtimeGeneration).toBe(previousGeneration)
    expect(previousGeneration).not.toBe(managedProcessRuntimeGeneration())
    expect(readManagedProcessExit(handle.managedProcessId, handle.runtimeGeneration)).toMatchObject({ ok: false, code: 'TRIGGER_SOURCE_GAP' })
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
