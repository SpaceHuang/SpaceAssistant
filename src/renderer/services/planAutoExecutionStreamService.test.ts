import { describe, expect, it, afterEach, vi } from 'vitest'
import {
  beginPlanAutoExecutionStream,
  clearPlanAutoExecutionStreamState,
  endPlanAutoExecutionStream,
  isPlanAutoExecutionStreamActive
} from './planAutoExecutionStreamService'

describe('planAutoExecutionStreamService', () => {
  afterEach(() => {
    clearPlanAutoExecutionStreamState()
    vi.restoreAllMocks()
  })

  it('tracks active auto execution session', () => {
    window.api = {
      planOnStepStarted: vi.fn(() => () => {}),
      planOnStepCompleted: vi.fn(() => () => {})
    } as unknown as typeof window.api

    expect(isPlanAutoExecutionStreamActive('s1')).toBe(false)
    beginPlanAutoExecutionStream({ sessionId: 's1', loopRequestId: 'loop-1' })
    expect(isPlanAutoExecutionStreamActive('s1')).toBe(true)
    endPlanAutoExecutionStream('s1')
    expect(isPlanAutoExecutionStreamActive('s1')).toBe(false)
  })
})
