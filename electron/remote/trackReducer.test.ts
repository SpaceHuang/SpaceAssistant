import { describe, expect, it } from 'vitest'
import { reduceTrackState, type TrackChildWork, type TrackState } from './trackReducer'

describe('remote Track reducer', () => {
  it('accepts only declared lifecycle transitions', () => {
    expect(reduceTrackState('open', { type: 'execution-started' }, [])).toEqual({ state: 'processing' })
    expect(reduceTrackState('completed', { type: 'continuation-accepted' }, [])).toEqual({
      state: 'completed',
      rejected: 'terminal-state-is-immutable'
    })
  })

  it('blocks completion while any child work remains non-terminal', () => {
    const children: TrackChildWork[] = [
      { kind: 'turn', id: 'turn-1', state: 'completed' },
      { kind: 'async-todo', id: 'todo-1', state: 'pending' }
    ]
    expect(reduceTrackState('processing', { type: 'terminal-requested', target: 'completed' }, children)).toEqual({
      state: 'waiting-async-approval',
      rejected: 'unfinished-child-work',
      blockingChildren: [{ kind: 'async-todo', id: 'todo-1', state: 'pending' }]
    })
  })

  it('does not treat an unknown or outcome-unknown dispatch as settled', () => {
    const children: TrackChildWork[] = [
      { kind: 'tool-dispatch', id: 'dispatch-1', state: 'outcome-unknown' }
    ]
    const result = reduceTrackState('processing', { type: 'terminal-requested', target: 'completed' }, children)
    expect(result.state).not.toBe('completed')
    expect(result.rejected).toBe('unfinished-child-work')
  })

  it('permits completion only after every child source is terminal', () => {
    const children: TrackChildWork[] = [
      { kind: 'turn', id: 'turn-1', state: 'completed' },
      { kind: 'confirmation', id: 'confirm-1', state: 'settled' },
      { kind: 'execution-work', id: 'work-1', state: 'completed' }
    ]
    const result = reduceTrackState('processing', { type: 'terminal-requested', target: 'completed' }, children)
    expect(result).toEqual({ state: 'completed' })
  })
})
