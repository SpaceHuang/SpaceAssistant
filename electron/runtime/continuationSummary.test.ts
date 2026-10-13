import { describe, expect, it } from 'vitest'
import type { HistoryEvent, HistorySnapshot } from '../../packages/agent-sdk/src/history'
import { summarizeFailedInvocation } from './continuationSummary'

function event(sequence: number, kind: HistoryEvent['kind'], payload: unknown): HistoryEvent {
  return {
    invocationId: 'source-invocation', turnId: 'source-turn', sequence, schemaVersion: 1,
    eventId: `event-${sequence}`, idempotencyKey: `key-${sequence}`, kind, payload
  }
}

function startedOnlySnapshot(startPayload: Record<string, unknown>): HistorySnapshot {
  const events = [
    event(1, 'invocation-context-committed', {
      requiredUserMessage: { message: { role: 'user', content: 'continue the task' } }
    }),
    event(2, 'model-response-committed', {
      message: { role: 'assistant', toolCalls: [{ id: 'call-1', name: 'lookup', input: { token: 'must-not-appear' } }] }
    }),
    event(3, 'tool-call-started', { toolCallId: 'call-1', toolName: 'lookup', ...startPayload }),
    event(4, 'invocation-interrupted', { status: 'interrupted', reason: 'process-restart' })
  ]
  return { invocationId: 'source-invocation', version: events.length, schemaVersion: 1, events }
}

describe('summarizeFailedInvocation', () => {
  it.each([
    ['legacy started-only record', {}],
    ['crash after started was committed', { executorEntry: 'unknown' }]
  ])('%s preserves unknown entry and does not reveal tool input', (_label, startPayload) => {
    const summary = summarizeFailedInvocation(startedOnlySnapshot(startPayload), 'source-invocation', 'source-turn')

    expect(summary).toMatchObject({ state: 'unknown', sourceInvocationId: 'source-invocation', sourceTurnId: 'source-turn' })
    expect(summary.summary).toContain('1 started-only call(s) have unknown executor entry')
    expect(summary.summary).toContain('Do not treat them as confirmed failures or repeat them mechanically')
    expect(summary.summary).not.toContain('must-not-appear')
  })
})
