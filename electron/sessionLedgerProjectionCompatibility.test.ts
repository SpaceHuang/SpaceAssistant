import { describe, expect, it } from 'vitest'
import { sessionEventProjectionMatches } from './sessionLedgerProjectionCompatibility'

describe('session event projection schema compatibility', () => {
  it('upcasts an older tool result and accepts the registered additive artifact reference', () => {
    const actual = {
      type: 'tool_result', schemaVersion: 1,
      payload: { toolUseId: 'tool-1', stepId: 'step-1', result: { success: true, data: { rawArtifact: { path: 'artifact.txt' } } } }
    }
    const expected = {
      type: 'tool_result', schemaVersion: 2,
      payload: { toolUseId: 'tool-1', stepId: 'step-1', result: { success: true, data: { rawArtifact: {
        path: 'artifact.txt', artifactId: `artifact-${'a'.repeat(64)}`
      } } } }
    }

    expect(sessionEventProjectionMatches(actual, expected)).toBe(true)
  })

  it('accepts registered tool-call attribution fields while preserving the command semantics', () => {
    const actual = {
      type: 'tool_call', schemaVersion: 1,
      payload: { toolUseId: 'tool-1', stepId: 'step-1', name: 'git', args: { args: ['status'] } }
    }
    const expected = {
      type: 'tool_call', schemaVersion: 2,
      payload: { ...actual.payload, requestId: 'request-1', invocationRequestId: 'invocation-1', lane: 'desktop' }
    }
    expect(sessionEventProjectionMatches(actual, expected)).toBe(true)
    expect(sessionEventProjectionMatches(actual, {
      ...expected, payload: { ...expected.payload, args: { args: ['push'] } }
    })).toBe(false)
  })

  it('still rejects a changed semantic field after schema normalization', () => {
    expect(sessionEventProjectionMatches(
      { type: 'tool_result', schemaVersion: 1, payload: { toolUseId: 'tool-1', result: { success: false } } },
      { type: 'tool_result', schemaVersion: 2, payload: { toolUseId: 'tool-1', result: { success: true } } }
    )).toBe(false)
  })

  it('does not preserve an artifact reference that canonical History does not contain', () => {
    expect(sessionEventProjectionMatches(
      { type: 'tool_result', schemaVersion: 2, payload: { toolUseId: 'tool-1', result: { data: { rawArtifact: { artifactId: `artifact-${'a'.repeat(64)}` } } } } },
      { type: 'tool_result', schemaVersion: 1, payload: { toolUseId: 'tool-1', result: { data: { rawArtifact: {} } } } }
    )).toBe(false)
  })

  it('does not project an unknown future schema or silently accept undeclared fields', () => {
    expect(sessionEventProjectionMatches(
      { type: 'tool_result', schemaVersion: 99, payload: { toolUseId: 'tool-1', result: { success: true } } },
      { type: 'tool_result', schemaVersion: 2, payload: { toolUseId: 'tool-1', result: { success: true } } }
    )).toBe(false)
    expect(sessionEventProjectionMatches(
      { type: 'tool_result', schemaVersion: 2, payload: { toolUseId: 'tool-1', result: { success: true } } },
      { type: 'tool_result', schemaVersion: 2, payload: { toolUseId: 'tool-1', result: { success: true }, meaningChanged: true } }
    )).toBe(false)
  })
})
