import { describe, expect, it, vi } from 'vitest'
import { finalizeInvocationResult, HostedTurnFinalizedError, getHostedTurnFinalization, hostedTerminalSessionEventReason, markHostedTurnFinalization } from './hostedTurnFinalization'

describe('HostedTurnFinalization', () => {
  it('projects canonical hosted interruption outcomes without collapsing them into failure', () => {
    expect(hostedTerminalSessionEventReason('interrupted')).toBe('interrupted')
    expect(hostedTerminalSessionEventReason('cancelled')).toBe('cancelled')
    expect(hostedTerminalSessionEventReason('failed')).toBe('failed')
  })

  it('binds terminal ownership and usage summary to one result object without changing its public shape', () => {
    const result = { ok: true, content: [], stopReason: 'end_turn' }
    markHostedTurnFinalization(result, {
      outcome: 'completed',
      usage: { modelTurns: 2, initialMessageCount: 1, messages: [{ role: 'assistant', content: 'done' }] as never }
    })
    expect(result).toEqual({ ok: true, content: [], stopReason: 'end_turn' })
    expect(getHostedTurnFinalization(result)).toMatchObject({ outcome: 'completed', usage: { modelTurns: 2, initialMessageCount: 1 } })
  })

  it('carries an already-written terminal state through a thrown SDK failure', () => {
    const cause = new Error('policy denied')
    const error = new HostedTurnFinalizedError(cause, 'failed')
    expect(error).toMatchObject({ cause, outcome: 'failed', historyTerminalCommitted: true })
  })

  it('rejects duplicate finalization of a result', () => {
    const result = { ok: true }
    markHostedTurnFinalization(result, { outcome: 'completed' })
    expect(() => markHostedTurnFinalization(result, { outcome: 'completed' })).toThrow('HOSTED_TURN_ALREADY_FINALIZED')
  })

  it('keeps legacy terminal writes for old results and skips them only for SDK-owned terminal results', async () => {
    const appendLegacyTerminal = vi.fn(async () => undefined)
    const counts = { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 }
    const legacy = await finalizeInvocationResult({ result: { ok: true }, counts, appendLegacyTerminal })
    expect(legacy).toEqual({ outcome: 'completed', terminalCommittedBy: 'legacy' })
    expect(appendLegacyTerminal).toHaveBeenCalledOnce()

    const hostedResult = { ok: true, content: [], stopReason: 'end_turn' }
    markHostedTurnFinalization(hostedResult, {
      outcome: 'completed',
      usage: { modelTurns: 2, initialMessageCount: 0, messages: [{ role: 'tool', toolCallId: 'one', content: 'done' }] as never }
    })
    const hosted = await finalizeInvocationResult({ result: hostedResult, counts, appendLegacyTerminal })
    expect(hosted).toEqual({ outcome: 'completed', terminalCommittedBy: 'hosted' })
    expect(appendLegacyTerminal).toHaveBeenCalledOnce()
    expect(counts).toEqual({ stepCount: 2, toolCallCount: 1, toolErrorCount: 0, toolSkippedCount: 0 })
  })

  it('preserves an interrupted Hosted terminal reason independently of the public result shape', async () => {
    const result = { ok: false, error: 'Shell command execution during dispatch is uncertain' }
    markHostedTurnFinalization(result, { outcome: 'interrupted' })
    const finalization = await finalizeInvocationResult({
      result, counts: { stepCount: 0, toolCallCount: 0, toolErrorCount: 0, toolSkippedCount: 0 },
      appendLegacyTerminal: vi.fn(async () => undefined)
    })

    expect(finalization).toEqual({ outcome: 'interrupted', terminalCommittedBy: 'hosted' })
  })
})
