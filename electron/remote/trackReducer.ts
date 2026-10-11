import type { RemoteTrackState } from '../../src/shared/remoteTrack'

/** Durable aggregate states for a remote user intent. Session/request/turn state remains independent. */
export type TrackState = RemoteTrackState

export type TrackChildWork = {
  kind: 'turn' | 'confirmation' | 'async-todo' | 'parked-input' | 'resume-work' | 'execution-work' | 'clarification-resolution' | 'tool-dispatch'
  id: string
  state: string
}

export type TrackEvent =
  | { type: 'execution-started' }
  | { type: 'needs-user-input' }
  | { type: 'confirmation-pending' }
  | { type: 'continuation-accepted' }
  | { type: 'async-approval-pending' }
  | { type: 'resume-accepted' }
  | { type: 'terminal-requested'; target: 'completed' | 'cancelled' | 'expired' | 'failed' }
  | { type: 'reconciliation-required' }

export type TrackReduction = {
  state: TrackState
  rejected?: 'terminal-state-is-immutable' | 'invalid-transition' | 'unfinished-child-work'
  blockingChildren?: TrackChildWork[]
}

const TERMINAL_STATES = new Set<TrackState>(['completed', 'cancelled', 'expired', 'failed'])
const SETTLED_CHILD_STATES = new Set([
  'completed', 'settled', 'consumed', 'cancelled', 'expired', 'rejected', 'invalidated', 'failed', 'interrupted'
])

function blockers(children: TrackChildWork[]): TrackChildWork[] {
  return children.filter((child) => !SETTLED_CHILD_STATES.has(child.state))
}

function stateForBlockers(children: TrackChildWork[]): TrackState {
  if (children.some((child) => child.kind === 'async-todo' && ['pending', 'dispatching', 'outcome_unknown'].includes(child.state))) {
    return 'waiting-async-approval'
  }
  if (children.some((child) => child.kind === 'resume-work' && ['queued', 'claimed', 'pending'].includes(child.state))) {
    return 'resuming'
  }
  if (children.some((child) => ['confirmation', 'parked-input'].includes(child.kind))) return 'waiting-user'
  if (children.some((child) => child.state === 'needs-reconciliation' || child.state === 'outcome-unknown')) return 'reconciliation-blocked'
  return 'processing'
}

/** Pure lifecycle reducer. Callers must read source child rows in the same transaction as terminal settlement. */
export function reduceTrackState(current: TrackState, event: TrackEvent, children: TrackChildWork[]): TrackReduction {
  if (TERMINAL_STATES.has(current)) return { state: current, rejected: 'terminal-state-is-immutable' }

  switch (event.type) {
    case 'execution-started':
      return current === 'open' || current === 'resuming'
        ? { state: 'processing' }
        : { state: current, rejected: 'invalid-transition' }
    case 'needs-user-input':
    case 'confirmation-pending':
      return current === 'processing' ? { state: 'waiting-user' } : { state: current, rejected: 'invalid-transition' }
    case 'continuation-accepted':
      return current === 'waiting-user' ? { state: 'processing' } : { state: current, rejected: 'invalid-transition' }
    case 'async-approval-pending':
      return current === 'processing' ? { state: 'waiting-async-approval' } : { state: current, rejected: 'invalid-transition' }
    case 'resume-accepted':
      return current === 'waiting-async-approval' ? { state: 'resuming' } : { state: current, rejected: 'invalid-transition' }
    case 'reconciliation-required':
      return { state: 'reconciliation-blocked' }
    case 'terminal-requested': {
      const pending = blockers(children)
      if (pending.length > 0) {
        if (event.target === 'cancelled') return { state: 'cancelling', rejected: 'unfinished-child-work', blockingChildren: pending }
        return { state: stateForBlockers(pending), rejected: 'unfinished-child-work', blockingChildren: pending }
      }
      return { state: event.target }
    }
  }
}
