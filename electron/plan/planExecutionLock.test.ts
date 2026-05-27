import { describe, expect, it, beforeEach } from 'vitest'
import {
  acquireSessionExecutionLock,
  clearAllPlanExecutionLocks,
  PlanExecutionLockError,
  releaseSessionExecutionLock
} from './planExecutionLock'

describe('planExecutionLock', () => {
  beforeEach(() => {
    clearAllPlanExecutionLocks()
  })

  it('rejects second lock for same session', () => {
    acquireSessionExecutionLock('s1', 'req-a')
    expect(() => acquireSessionExecutionLock('s1', 'req-b')).toThrow(PlanExecutionLockError)
  })

  it('allows re-acquire with same requestId', () => {
    acquireSessionExecutionLock('s1', 'req-a')
    expect(() => acquireSessionExecutionLock('s1', 'req-a')).not.toThrow()
  })

  it('releases lock', () => {
    acquireSessionExecutionLock('s1', 'req-a')
    releaseSessionExecutionLock('s1', 'req-a')
    expect(() => acquireSessionExecutionLock('s1', 'req-b')).not.toThrow()
  })
})
