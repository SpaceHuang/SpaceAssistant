import { describe, expect, it } from 'vitest'
import { createAcceptedTurn } from './acceptedTurn'

const accepted = () => createAcceptedTurn({
  turnId: 'turn-1', requestId: 'request-1', sessionId: 'session-1', lane: 'desktop', startToken: 'start-1',
  currentUserMessageId: 'user-1', transcriptVersion: 3, config: { lane: 'desktop', skillFragments: ['frozen'] }
})

describe('AcceptedTurn', () => {
  it('freezes identity and clones execution config at acceptance', () => {
    const input = { lane: 'desktop' as const, skillFragments: ['frozen'] }
    const value = createAcceptedTurn({ ...accepted(), config: input })
    input.skillFragments[0] = 'changed'
    expect(value.config.skillFragments).toEqual(['frozen'])
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.config.skillFragments)).toBe(true)
  })

  it('rejects missing execution identity and invalid transcript versions', () => {
    expect(() => createAcceptedTurn({ ...accepted(), turnId: ' ' })).toThrow('ACCEPTED_TURN_TURNID_REQUIRED')
    expect(() => createAcceptedTurn({ ...accepted(), transcriptVersion: -1 })).toThrow('ACCEPTED_TURN_TRANSCRIPT_VERSION_INVALID')
  })
})
