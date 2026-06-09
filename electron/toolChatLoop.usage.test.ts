import { describe, expect, it } from 'vitest'
import { pickToolLoopReturnUsage } from './toolChatLoop'

describe('pickToolLoopReturnUsage', () => {
  const round1 = { input_tokens: 1000, output_tokens: 50 }
  const round2 = { input_tokens: 2000, output_tokens: 80 }

  it('returns current round usage when present', () => {
    expect(pickToolLoopReturnUsage(round2, round1)).toEqual(round2)
  })

  it('falls back to last valid usage when current round is undefined', () => {
    expect(pickToolLoopReturnUsage(undefined, round1)).toEqual(round1)
  })

  it('returns undefined when neither round has usage', () => {
    expect(pickToolLoopReturnUsage(undefined, undefined)).toBeUndefined()
  })
})
