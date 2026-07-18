import { describe, expect, it } from 'vitest'
import { ArtifactDecisionRegistry } from './decisionRegistry'

describe('ArtifactDecisionRegistry', () => {
  it('reuses one pending ownership decision for the same request and group key', () => {
    const registry = new ArtifactDecisionRegistry()
    const first = registry.createPending({ requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 1, groupKey: 'ownership:reports' })
    const repeated = registry.createPending({ requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-2', attempt: 1, groupKey: 'ownership:reports' })

    expect(repeated.decisionId).toBe(first.decisionId)
  })
})
