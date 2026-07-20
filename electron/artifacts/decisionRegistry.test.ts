import { describe, expect, it, vi } from 'vitest'
import { ArtifactDecisionRegistry } from './decisionRegistry'

describe('ArtifactDecisionRegistry', () => {
  it('reuses one pending ownership decision for the same request and group key', () => {
    const registry = new ArtifactDecisionRegistry()
    const first = registry.createPending({ requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 1, groupKey: 'ownership:reports' })
    const repeated = registry.createPending({ requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-2', attempt: 1, groupKey: 'ownership:reports' })

    expect(repeated.decisionId).toBe(first.decisionId)
  })

  it('cleans pending decisions on cancellation, session/window teardown, and timeout', () => {
    vi.useFakeTimers()
    try {
      const registry = new ArtifactDecisionRegistry({ timeoutMs: 100 })
      const create = (requestId: string, sessionId: string, groupKey: string) => registry.createPending({ requestId, sessionId, toolUseId: 'tool-1', attempt: 1, groupKey })
      const cancelled = create('req-cancel', 'session-1', 'cancel')
      registry.cancelForRequest('req-cancel')
      expect(registry.get(cancelled.decisionId)).toBeUndefined()

      const session = create('req-session', 'session-1', 'session')
      registry.clearForSession('session-1')
      expect(registry.get(session.decisionId)).toBeUndefined()

      const window = create('req-window', 'session-2', 'window')
      registry.clearAll()
      expect(registry.get(window.decisionId)).toBeUndefined()

      const expired = create('req-timeout', 'session-3', 'timeout')
      vi.advanceTimersByTime(100)
      expect(registry.get(expired.decisionId)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('requires response bindings and permits a decision to be consumed only once', () => {
    const registry = new ArtifactDecisionRegistry()
    const pending = registry.createPending({ requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 2, groupKey: 'ownership:reports' })

    expect(() => registry.consume({ decisionId: pending.decisionId, requestId: 'req-1', sessionId: 'session-1', toolUseId: 'other-tool', attempt: 2 })).toThrow('ARTIFACT_DECISION_INVALID')
    expect(registry.consume({ decisionId: pending.decisionId, requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 2 })).toEqual(pending)
    expect(() => registry.consume({ decisionId: pending.decisionId, requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 2 })).toThrow('ARTIFACT_DECISION_ALREADY_CONSUMED')
  })

  it('constructs trusted user-decision provenance only from a consumed rename/change-directory decision', () => {
    const registry = new ArtifactDecisionRegistry()
    const pending = registry.createPending({ requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 1, groupKey: 'path:rename' })

    expect(registry.consumeAsUserDecision({ decisionId: pending.decisionId, requestId: 'req-1', sessionId: 'session-1', toolUseId: 'tool-1', attempt: 1 })).toEqual({
      pathSource: 'user-decision', pathDecisionId: pending.decisionId
    })
  })

  it('maps missing pending to stale for tryConsumeAsUserDecision', () => {
    const registry = new ArtifactDecisionRegistry()
    expect(
      registry.tryConsumeAsUserDecision({
        decisionId: 'missing',
        requestId: 'r',
        sessionId: 's',
        toolUseId: 't',
        attempt: 1
      })
    ).toEqual({ ok: false, reason: 'stale' })
  })

  it('skips auto-timeout when timeoutMs is 0', () => {
    vi.useFakeTimers()
    try {
      const registry = new ArtifactDecisionRegistry({ timeoutMs: 0 })
      const pending = registry.createPending({
        requestId: 'req-1',
        sessionId: 'session-1',
        toolUseId: 'tool-1',
        attempt: 1,
        groupKey: 'g'
      })
      vi.advanceTimersByTime(10 * 60 * 1000)
      expect(registry.get(pending.decisionId)).toBeDefined()
      registry.clearAll()
    } finally {
      vi.useRealTimers()
    }
  })
})
