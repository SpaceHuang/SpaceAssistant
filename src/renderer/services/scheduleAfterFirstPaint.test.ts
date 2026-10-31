import { scheduleAfterFirstPaint } from './scheduleAfterFirstPaint'

describe('scheduleAfterFirstPaint', () => {
  it('waits for two animation frames before starting optional work', () => {
    const callbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callbacks.push(callback)
      return callbacks.length
    })
    const task = vi.fn()

    scheduleAfterFirstPaint(task)
    expect(task).not.toHaveBeenCalled()
    expect(callbacks).toHaveLength(1)

    callbacks.shift()?.(0)
    expect(task).not.toHaveBeenCalled()
    expect(callbacks).toHaveLength(1)

    callbacks.shift()?.(16)
    expect(task).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })
})
