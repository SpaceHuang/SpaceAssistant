import { describe, expect, it } from 'vitest'
import { getSessionLedgerRecoveryRoots, isSessionLedgerLocationAllowed, resolveSessionLedgerLocation, toSessionLedgerToolCallProjection, toSessionLedgerToolResultProjection } from './sessionLedgerRecovery'

describe('session ledger recovery roots', () => {
  it('allows the configured workspace and valid configured work-dir profiles only', () => {
    const roots = getSessionLedgerRecoveryRoots('/workspace/default', JSON.stringify([
      { id: 'default', path: '/workspace/default' },
      { id: 'client', path: '/workspace/client' },
      { id: 'invalid', path: '  ' },
      { id: 'missing' },
      null
    ]))

    expect(isSessionLedgerLocationAllowed({ workDir: '/workspace/default' }, roots)).toBe(true)
    expect(isSessionLedgerLocationAllowed({ workDir: '/workspace/client' }, roots)).toBe(true)
    expect(isSessionLedgerLocationAllowed({ workDir: '/workspace/client/child' }, roots)).toBe(false)
    expect(isSessionLedgerLocationAllowed({ workDir: '/unconfigured' }, roots)).toBe(false)
  })

  it('keeps a usable fallback root when the profile setting is malformed', () => {
    expect(getSessionLedgerRecoveryRoots('/workspace/default', '{bad json')).toEqual(['/workspace/default'])
    expect(getSessionLedgerRecoveryRoots(undefined, '[]')).toEqual([])
    expect(isSessionLedgerLocationAllowed({ workDir: ' ' }, ['/workspace/default'])).toBe(false)
  })

  it('resolves a session owner only from its exact persisted profile or configured fallback', () => {
    const profilesJson = JSON.stringify([{ id: 'client', path: '/workspace/client' }])
    expect(resolveSessionLedgerLocation({
      sessionId: 'session-client', createdAt: 42, workDirProfileId: 'client',
      activeProfileId: 'default', configuredWorkDir: '/workspace/default', profilesJson
    })).toEqual({ workDir: '/workspace/client', sessionId: 'session-client', createdAt: 42 })
    expect(resolveSessionLedgerLocation({
      sessionId: 'session-stale', createdAt: 42, workDirProfileId: 'removed-profile',
      configuredWorkDir: '/workspace/default', profilesJson
    })).toBeUndefined()
    expect(resolveSessionLedgerLocation({
      sessionId: 'session-legacy', createdAt: 42, activeProfileId: 'client',
      configuredWorkDir: '/workspace/default', profilesJson
    })).toEqual({ workDir: '/workspace/client', sessionId: 'session-legacy', createdAt: 42 })
    expect(resolveSessionLedgerLocation({
      sessionId: 'session-fallback', createdAt: 42,
      configuredWorkDir: '/workspace/default', profilesJson: '{bad json'
    })).toEqual({ workDir: '/workspace/default', sessionId: 'session-fallback', createdAt: 42 })
  })

  it('preserves canonical turn ownership in startup tool proposal and result projection inputs', () => {
    expect(toSessionLedgerToolCallProjection({
      toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'invocation-1', name: 'read_file', args: { path: 'note.txt' }
    })).toEqual({ toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'invocation-1', name: 'read_file', args: { path: 'note.txt' } })
    expect(toSessionLedgerToolResultProjection({
      toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'invocation-1', result: { success: true, data: 'text' }
    })).toEqual({ toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'invocation-1', result: { success: true, data: 'text' } })
  })
})
