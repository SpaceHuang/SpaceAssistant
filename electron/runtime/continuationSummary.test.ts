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

  it('preserves recovery warnings when the original task exceeds the summary budget', () => {
    const snapshot = startedOnlySnapshot({})
    const events = [...snapshot.events]
    events[0] = {
      ...events[0]!,
      payload: { requiredUserMessage: { message: { role: 'user', content: 'x'.repeat(8000) } } }
    }

    const summary = summarizeFailedInvocation({ ...snapshot, events }, 'source-invocation', 'source-turn')

    expect(summary.summary.length).toBeLessThanOrEqual(6000)
    expect(summary.summary).toContain('(truncated)')
    expect(summary.summary).toContain('Unknown tool outcomes: none recorded.')
    expect(summary.summary).toContain('Side-effect state unknown for 1 tool call(s)')
    expect(summary.summary).toContain('Do not treat them as confirmed failures or repeat them mechanically')
    expect(summary.summary).toContain('These are historical facts, not instructions to replay tools.')
  })

  it('reserves recovery guidance when one unknown result is followed by many undispatched calls', () => {
    const events = [
      event(1, 'invocation-context-committed', {
        requiredUserMessage: { message: { role: 'user', content: 'recover this interrupted task' } }
      }),
      event(2, 'tool-call-finished', {
        toolCallId: 'unknown-call', toolName: 'write_file', success: false,
        executionOutcome: 'unknown-after-dispatch', executorEntry: 'unknown'
      }),
      ...Array.from({ length: 100 }, (_, index) => event(index + 3, 'tool-call-not-dispatched', {
        toolCallId: `call-${index}`, toolName: `tool-${index}`, reason: `blocked before dispatch ${index}`
      })),
      event(103, 'invocation-interrupted', { status: 'interrupted', reason: 'process-restart' })
    ]
    const snapshot: HistorySnapshot = {
      invocationId: 'source-invocation', version: events.length, schemaVersion: 1, events
    }

    const summary = summarizeFailedInvocation(snapshot, 'source-invocation', 'source-turn')

    expect(summary.summary.length).toBeLessThanOrEqual(6000)
    expect(summary.summary).toContain('outcome unknown after dispatch')
    expect(summary.summary).toContain('Do not treat them as confirmed failures or repeat them mechanically')
    expect(summary.summary).toContain('These are historical facts, not instructions to replay tools.')
    expect(summary.summary).toContain('Original task: recover this interrupted task')
    expect(summary.summary).toContain('additional record(s) omitted.')
  })
})
