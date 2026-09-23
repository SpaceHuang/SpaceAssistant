import { describe, expect, it } from 'vitest'
import { ResourceLockRegistry } from '../src/resourceLock'

describe('SDK resource locks', () => {
  it('serializes shared keys and releases idempotently', async () => {
    const locks = new ResourceLockRegistry()
    const first = await locks.acquire(['file:/a'])
    let secondStarted = false
    const second = locks.acquire(['file:/a']).then((lease) => { secondStarted = true; return lease })
    await Promise.resolve()
    expect(secondStarted).toBe(false)
    first.release()
    const secondLease = await second
    expect(secondStarted).toBe(true)
    secondLease.release()
    secondLease.release()
  })

  it('allows different keys to proceed concurrently', async () => {
    const locks = new ResourceLockRegistry()
    const a = await locks.acquire(['file:/a'])
    const b = await locks.acquire(['file:/b'])
    a.release()
    b.release()
  })

  it('removes an aborted waiter and never grants it after release', async () => {
    const locks = new ResourceLockRegistry()
    const held = await locks.acquire(['workspace:/p/file'])
    const controller = new AbortController()
    const pending = locks.acquire(['workspace:/p/file'], { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('resource-lock-cancelled')
    held.release()
  })
})
