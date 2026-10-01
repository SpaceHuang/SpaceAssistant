import { describe, expect, it } from 'vitest'
import { decodeTerminalOutcome } from './terminalOutcome'

describe('decodeTerminalOutcome', () => {
  it('uses cancelled status on canonical terminal even when the session ledger is absent', () => {
    expect(decodeTerminalOutcome({ kind: 'invocation-interrupted', payload: { status: 'cancelled' } as never })).toBe('cancelled')
  })

  it('does not mistake a cancellation-shaped sidecar reason for a cancelled terminal', () => {
    expect(decodeTerminalOutcome({ kind: 'invocation-interrupted', payload: { status: 'interrupted', sessionLedger: { reason: 'cancelled' } } as never })).toBe('interrupted')
  })

  it('distinguishes timeout, restart interruption, failure, and completion', () => {
    expect(decodeTerminalOutcome({ kind: 'invocation-interrupted', payload: { status: 'interrupted', reason: 'process-restart' } as never })).toBe('interrupted')
    expect(decodeTerminalOutcome({ kind: 'invocation-failed', payload: { status: 'failed', reason: 'timeout' } as never })).toBe('timed_out')
    expect(decodeTerminalOutcome({ kind: 'invocation-failed', payload: { status: 'failed' } as never })).toBe('failed')
    expect(decodeTerminalOutcome({ kind: 'invocation-completed', payload: { status: 'completed' } as never })).toBe('completed')
  })

  it('does not reinterpret a session reconciliation fence as a History execution terminal', () => {
    expect(decodeTerminalOutcome({ kind: 'invocation-failed', payload: { status: 'commit_uncertain' } as never })).toBeUndefined()
  })
})
