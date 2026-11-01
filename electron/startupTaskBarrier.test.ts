import { describe, expect, it, vi } from 'vitest'
import { createStartupTaskBarrier } from './startupTaskBarrier'

describe('createStartupTaskBarrier', () => {
  it('starts independent startup work immediately and exposes a completion barrier', async () => {
    let finishTask!: () => void
    const task = vi.fn(() => new Promise<void>((resolve) => { finishTask = resolve }))
    const waitForTask = createStartupTaskBarrier(task, vi.fn())

    expect(task).toHaveBeenCalledOnce()
    let settled = false
    const waiting = waitForTask().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    finishTask()
    await waiting
    expect(settled).toBe(true)
  })

  it('reports task failures without rejecting the completion barrier', async () => {
    const error = new Error('cleanup failed')
    const onError = vi.fn()
    const waitForTask = createStartupTaskBarrier(() => Promise.reject(error), onError)

    await expect(waitForTask()).resolves.toBeUndefined()
    expect(onError).toHaveBeenCalledWith(error)
  })
})
