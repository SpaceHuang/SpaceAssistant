import { describe, expect, it } from 'vitest'
import { resolveRegisteredToolName } from './registeredToolName'

describe('resolveRegisteredToolName', () => {
  it('resolves sanitized API names only when they identify one registered tool', () => {
    const registry = {
      get: (name: string) => name === 'lookup.internal' ? { name } : undefined,
      entries: () => [{ name: 'lookup.internal' }]
    }
    expect(resolveRegisteredToolName('lookup_internal', registry)).toBe('lookup.internal')
  })

  it('rejects ambiguous sanitized aliases instead of selecting an executor', () => {
    const registry = {
      get: () => undefined,
      entries: () => [{ name: 'lookup.internal' }, { name: 'lookup/internal' }]
    }
    expect(() => resolveRegisteredToolName('lookup_internal', registry)).toThrow('REGISTERED_TOOL_ALIAS_AMBIGUOUS:lookup_internal')
  })

  it('normalizes the legacy Bash spelling to the sole registered run_shell tool', () => {
    const registry = { get: (name: string) => name === 'run_shell' ? { name } : undefined }
    expect(resolveRegisteredToolName('Bash', registry)).toBe('run_shell')
  })
})
