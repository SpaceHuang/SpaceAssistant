import { describe, expect, it } from 'vitest'
import { mergeHostedTurnUsageSummary } from './hostedTurnUsageSummary'

describe('mergeHostedTurnUsageSummary', () => {
  it('adds model turns and only tool results appended after the handoff checkpoint', () => {
    const counts = { stepCount: 2, toolCallCount: 4, toolErrorCount: 1, toolSkippedCount: 1 }
    mergeHostedTurnUsageSummary(counts, {
      modelTurns: 3,
      initialMessageCount: 5,
      messages: [
        { role: 'user', content: 'older' },
        { role: 'assistant', content: 'older answer' },
        { role: 'tool', toolCallId: 'old', content: 'prior result', isError: false },
        { role: 'assistant', content: 'handoff context' },
        { role: 'user', content: 'current request' },
        { role: 'assistant', content: 'accepted first response' },
        { role: 'tool', toolCallId: 'new-ok', content: 'ok', isError: false },
        { role: 'tool', toolCallId: 'new-error', content: 'failed', isError: true },
        { role: 'assistant', content: 'done' }
      ] as never
    })
    expect(counts).toEqual({ stepCount: 5, toolCallCount: 6, toolErrorCount: 2, toolSkippedCount: 1 })
  })

  it('rejects invalid checkpoints instead of silently producing misleading totals', () => {
    const counts = { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 }
    expect(() => mergeHostedTurnUsageSummary(counts, { modelTurns: 1, initialMessageCount: 2, messages: [{ role: 'assistant', content: 'short' }] as never })).toThrow('HOSTED_USAGE_CHECKPOINT_INVALID')
    expect(counts).toEqual({ stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 })
  })

  it('counts not-dispatched proposals as skipped tool results, not execution errors', () => {
    const counts = { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 }
    mergeHostedTurnUsageSummary(counts, {
      modelTurns: 2,
      initialMessageCount: 1,
      messages: [
        { role: 'user', content: 'run tools' },
        { role: 'assistant', toolCalls: [
          { id: 'succeeded', name: 'lookup', input: {} },
          { id: 'failed', name: 'lookup', input: {} },
          { id: 'denied', name: 'write_file', input: {} },
          { id: 'cancelled', name: 'write_file', input: {} }
        ] },
        { role: 'tool', toolCallId: 'succeeded', content: 'ok', isError: false },
        { role: 'tool', toolCallId: 'failed', content: 'failed', isError: true },
        { role: 'tool', toolCallId: 'denied', content: 'denied', isError: true },
        { role: 'tool', toolCallId: 'cancelled', content: 'cancelled', isError: true },
        { role: 'assistant', content: 'done' }
      ] as never,
      notDispatchedToolCallIds: ['denied', 'cancelled']
    })
    expect(counts).toEqual({ stepCount: 2, toolCallCount: 4, toolErrorCount: 1, toolSkippedCount: 2 })
  })
})
