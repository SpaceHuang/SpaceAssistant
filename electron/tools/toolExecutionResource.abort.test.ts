import { describe, expect, it, vi } from 'vitest'
import { isUserAbortError, raceWithUserAbort, throwIfAborted } from './toolExecutionResource'

describe('raceWithUserAbort', () => {
  it('rejects when signal aborts before settle', async () => {
    const ac = new AbortController()
    const onAbort = vi.fn()
    const p = raceWithUserAbort(
      new Promise<string>((resolve) => setTimeout(() => resolve('ok'), 50)),
      ac.signal,
      onAbort
    )
    ac.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(onAbort).toHaveBeenCalled()
  })

  it('resolves when promise completes first', async () => {
    const ac = new AbortController()
    await expect(raceWithUserAbort(Promise.resolve(1), ac.signal)).resolves.toBe(1)
  })

  it('throwIfAborted throws for aborted signal', () => {
    const ac = new AbortController()
    ac.abort()
    expect(() => throwIfAborted(ac.signal)).toThrow()
    expect(isUserAbortError(new DOMException('Aborted', 'AbortError'))).toBe(true)
  })
})
