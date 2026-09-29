import { describe, expect, it } from 'vitest'
import { InvocationLifecycle } from '../src/lifecycle'

describe('InvocationLifecycle', () => {
  it('supports the five terminal outcomes and rejects a second settlement', () => {
    for (const status of ['completed', 'cancelled', 'failed', 'denied', 'interrupted'] as const) {
      const lifecycle = new InvocationLifecycle('inv-1')
      expect(lifecycle.settle(status)).toEqual({ invocationId: 'inv-1', status })
      expect(lifecycle.settle('completed')).toBeUndefined()
    }
  })

  it('starts running and does not permit reopening after settlement', () => {
    const lifecycle = new InvocationLifecycle('inv-2')
    expect(lifecycle.snapshot()).toEqual({ invocationId: 'inv-2', status: 'running' })
    lifecycle.settle('interrupted')
    expect(lifecycle.snapshot().status).toBe('interrupted')
  })
})
