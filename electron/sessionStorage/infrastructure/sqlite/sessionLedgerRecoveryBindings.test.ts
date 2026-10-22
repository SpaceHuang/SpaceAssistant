import { describe, expect, it } from 'vitest'
import { createSessionLedgerRecoveryBindings } from './sessionLedgerRecoveryBindings'

describe('session ledger recovery host bindings', () => {
  it('resolves configured roots and accepts only exact configured ledger locations', () => {
    const bindings = createSessionLedgerRecoveryBindings()
    const roots = bindings.getAllowedRoots({
      configuredWorkDir: '/workspace/main',
      profilesJson: JSON.stringify([{ id: 'secondary', path: '/workspace/secondary' }])
    })

    expect(roots).toEqual(['/workspace/main', '/workspace/secondary'])
    expect(bindings.isLocationAllowed({ location: { workDir: '/workspace/secondary' }, allowedRoots: roots })).toBe(true)
    expect(bindings.isLocationAllowed({ location: { workDir: '/workspace/secondary/nested' }, allowedRoots: roots })).toBe(false)
    expect(bindings.isLocationAllowed({ location: { workDir: '  ' }, allowedRoots: roots })).toBe(false)
  })

  it('keeps a valid fallback root when profile configuration is malformed and normalizes aliases', () => {
    const bindings = createSessionLedgerRecoveryBindings()
    expect(bindings.getAllowedRoots({ configuredWorkDir: '/workspace/./main/', profilesJson: '{bad json' }))
      .toEqual(['/workspace/main'])
    expect(bindings.getAllowedRoots({ configuredWorkDir: undefined, profilesJson: '[]' })).toEqual([])
    expect(bindings.isLocationAllowed({ location: { workDir: '/workspace/main/.' }, allowedRoots: ['/workspace/main'] })).toBe(true)
  })

  it('resolves a session owner from its persisted profile without guessing stale references', () => {
    const bindings = createSessionLedgerRecoveryBindings()
    const profilesJson = JSON.stringify([{ id: 'client', path: '/workspace/client' }])

    expect(bindings.resolveLocation({
      sessionId: 'session-client', createdAt: 42, workDirProfileId: 'client',
      activeProfileId: 'default', configuredWorkDir: '/workspace/default', profilesJson
    })).toEqual({ workDir: '/workspace/client', sessionId: 'session-client', createdAt: 42 })
    expect(bindings.resolveLocation({
      sessionId: 'session-stale', createdAt: 42, workDirProfileId: 'removed-profile',
      configuredWorkDir: '/workspace/default', profilesJson
    })).toBeUndefined()
    expect(bindings.resolveLocation({
      sessionId: 'session-legacy', createdAt: 42, activeProfileId: 'client',
      configuredWorkDir: '/workspace/default', profilesJson
    })).toEqual({ workDir: '/workspace/client', sessionId: 'session-legacy', createdAt: 42 })
    expect(bindings.resolveLocation({
      sessionId: 'session-fallback', createdAt: 42,
      configuredWorkDir: '/workspace/default', profilesJson: '{bad json'
    })).toEqual({ workDir: '/workspace/default', sessionId: 'session-fallback', createdAt: 42 })
    expect(bindings.resolveLocation({ sessionId: '  ', createdAt: 42, configuredWorkDir: '/workspace/default' })).toBeUndefined()
  })

  it('projects tool ledger identities and payloads through the recovery binding', () => {
    const bindings = createSessionLedgerRecoveryBindings()
    expect(bindings.toToolCallProjection({
      toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1',
      invocationRequestId: 'invocation-1', lane: 'analysis', name: 'read_file', args: { path: 'note.txt' }
    })).toEqual({
      toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1',
      invocationRequestId: 'invocation-1', lane: 'analysis', name: 'read_file', args: { path: 'note.txt' }
    })
    expect(bindings.toToolResultProjection({
      toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1',
      invocationRequestId: 'invocation-1', lane: 'analysis', result: { success: true }
    })).toEqual({
      toolUseId: 'tool-1', turnId: 'turn-1', stepId: 'step-1', requestId: 'request-1',
      invocationRequestId: 'invocation-1', lane: 'analysis', result: { success: true }
    })
  })

  it('preserves optional identity fields only when present in recovered tool projections', () => {
    const bindings = createSessionLedgerRecoveryBindings()
    expect(bindings.toToolCallProjection({ toolUseId: 'tool-2', stepId: 'step-2', name: 'read_file', args: {} }))
      .toEqual({ toolUseId: 'tool-2', stepId: 'step-2', name: 'read_file', args: {} })
    expect(bindings.toToolResultProjection({ toolUseId: 'tool-2', stepId: 'step-2', result: { success: false } }))
      .toEqual({ toolUseId: 'tool-2', stepId: 'step-2', result: { success: false } })
  })
})
