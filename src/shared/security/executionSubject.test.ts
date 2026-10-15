import { describe, expect, it } from 'vitest'
import { createExecutionSubject, digestExecutionSubject, EXECUTION_SUBJECT_SCHEMA_VERSION } from './executionSubject'

describe('versioned execution subject', () => {
  it('canonicalizes object key order and exposes only a versioned digest', () => {
    const a = createExecutionSubject({ toolName: 'write_file', invocationId: 'inv-1', toolUseId: 'tool-1', subject: { path: '/tmp/a', content: 'secret body' } })
    const b = createExecutionSubject({ toolName: 'write_file', invocationId: 'inv-1', toolUseId: 'tool-1', subject: { content: 'secret body', path: '/tmp/a' } })
    expect(a).toEqual(b)
    expect(a.schemaVersion).toBe(EXECUTION_SUBJECT_SCHEMA_VERSION)
    expect(a.subjectDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(JSON.stringify(a)).not.toContain('secret body')
  })

  it('changes when any approved execution field or identity changes', () => {
    const base = { toolName: 'run_shell', invocationId: 'inv-1', toolUseId: 'tool-1', subject: { command: 'ls', cwd: '/tmp' } }
    const digest = digestExecutionSubject(base)
    expect(digestExecutionSubject({ ...base, subject: { command: 'pwd', cwd: '/tmp' } })).not.toBe(digest)
    expect(digestExecutionSubject({ ...base, invocationId: 'inv-2' })).not.toBe(digest)
    expect(digestExecutionSubject({ ...base, toolName: 'run_shell_alt' })).not.toBe(digest)
  })

  it('rejects unsupported values that cannot be canonically bound', () => {
    expect(() => digestExecutionSubject({ toolName: 'mcp.call', invocationId: 'i', toolUseId: 't', subject: { value: Number.NaN } })).toThrow('EXECUTION_SUBJECT_NOT_CANONICAL')
  })
})
