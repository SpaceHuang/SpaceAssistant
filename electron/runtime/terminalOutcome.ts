import type { HistoryEvent } from '../../packages/agent-sdk/src/history'

export type CanonicalTerminalOutcome = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'

/** Decode execution outcome from the canonical terminal event itself; sidecar ledgers are projections. */
export function decodeTerminalOutcome(terminal: Pick<HistoryEvent, 'kind' | 'payload'>): CanonicalTerminalOutcome | undefined {
  const payload = terminal.payload && typeof terminal.payload === 'object'
    ? terminal.payload as Record<string, unknown>
    : {}
  if (terminal.kind === 'invocation-completed') return payload.status === 'completed' ? 'completed' : undefined
  if (terminal.kind === 'invocation-failed') {
    if (payload.status !== 'failed' && payload.status !== 'denied') return undefined
    return payload.reason === 'timeout' ? 'timed_out' : 'failed'
  }
  if (terminal.kind !== 'invocation-interrupted') return undefined
  if (payload.status === 'cancelled') return 'cancelled'
  if (payload.status !== 'interrupted') return undefined
  if (payload.reason === 'timeout') return 'timed_out'
  return 'interrupted'
}
