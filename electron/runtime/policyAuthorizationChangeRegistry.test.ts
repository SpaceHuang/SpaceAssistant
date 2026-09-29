import { describe, expect, it, vi } from 'vitest'
import { PolicyAuthorizationChangeRegistry } from './policyAuthorizationChangeRegistry'

describe('PolicyAuthorizationChangeRegistry', () => {
  it('publishes policy changes only to active subscribers on the affected lane', () => {
    const registry = new PolicyAuthorizationChangeRegistry()
    const desktop = vi.fn()
    const feishu = vi.fn()
    registry.subscribe('request-1', 'desktop', desktop)
    registry.subscribe('request-2', 'feishu', feishu)

    expect(registry.publish('desktop')).toBe(1)
    expect(desktop).toHaveBeenCalledOnce()
    expect(feishu).not.toHaveBeenCalled()

    const lateDesktop = vi.fn()
    registry.subscribe('request-3', 'desktop', lateDesktop)
    expect(lateDesktop).not.toHaveBeenCalled()
  })

  it('isolates listener failures while delivering the version to every active invocation', () => {
    const registry = new PolicyAuthorizationChangeRegistry()
    const next = vi.fn()
    registry.subscribe('request-1', 'desktop', () => { throw new Error('broken listener') })
    registry.subscribe('request-2', 'desktop', next)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(registry.publish('desktop')).toBe(2)
    expect(next).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledOnce()
  })
})
