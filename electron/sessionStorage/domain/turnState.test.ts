import { describe, expect, it } from 'vitest'
import { isActiveTurnState, sqlActiveTurnPredicate, TURN_STATES } from './turnState'

describe('turn state specification', () => {
  it('keeps active and terminal state vocabulary explicit', () => {
    expect(TURN_STATES.filter(isActiveTurnState)).toEqual(['configuring', 'prepared', 'executing', 'waiting-confirm'])
    expect(TURN_STATES.filter((state) => !isActiveTurnState(state))).toEqual(['terminal', 'completed', 'failed', 'cancelled', 'interrupted'])
    expect(sqlActiveTurnPredicate('turn.state')).toBe("turn.state IN ('configuring','prepared','executing','waiting-confirm')")
  })
})
