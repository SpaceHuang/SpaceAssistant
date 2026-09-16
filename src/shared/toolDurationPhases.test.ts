import { describe, expect, it } from 'vitest'
import { getToolDurationPhases } from './toolDurationPhases'

describe('getToolDurationPhases', () => {
  it('splits confirmation wait and execution time', () => {
    expect(getToolDurationPhases({ startedAt: 1000, confirmedAt: 9000, completedAt: 21000 })).toEqual({ waitingMs: 8000, executionMs: 12000, totalMs: 20000 })
  })

  it('uses the current time for an executing tool', () => {
    expect(getToolDurationPhases({ startedAt: 1000, confirmedAt: 4000, now: 10000 })).toEqual({ waitingMs: 3000, executionMs: 6000, totalMs: 9000 })
  })
})
