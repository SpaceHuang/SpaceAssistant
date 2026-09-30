import type { HistoryEvent } from '../../packages/agent-sdk/src/history'

export type CanonicalTerminalOutcome = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted' | 'commit_uncertain'

/** Decode execution outcome from the canonical terminal event itself; sidecar ledgers are projections. */
export function decodeTerminalOutcome(terminal: Pick<HistoryEvent, 'kind' | 'payload'>): CanonicalTerminalOutcome | undefined {
  const payload = terminal.payload && typeof terminal.payload === 'object'
    ? terminal.payload as Record<string, unknown>
    : {}
  if (terminal.kind === 'invocation-completed') return 'completed'
  if (terminal.kind === 'invocation-failed') {
    return payload.status === 'timed_out' || payload.reason === 'timeout' ? 'timed_out' : 'failed'
  }
  if (terminal.kind !== 'invocation-interrupted') return undefined
  if (payload.status === 'cancelled') return 'cancelled'
  if (payload.status === 'timed_out' || payload.reason === 'timeout') return 'timed_out'
  return 'interrupted'
}
