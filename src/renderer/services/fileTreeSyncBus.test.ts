import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  emitFileTreeSyncForTests,
  resetFileTreeSyncBusForTests,
  subscribeFileTreeSync
} from './fileTreeSyncBus'

describe('fileTreeSyncBus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFileTreeSyncBusForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces path events before notifying listeners', () => {
    const listener = vi.fn()
    subscribeFileTreeSync(listener)

    emitFileTreeSyncForTests({ kind: 'paths', relPaths: ['a.txt'] })
    emitFileTreeSyncForTests({ kind: 'paths', relPaths: ['b.txt'] })

    expect(listener).not.toHaveBeenCalled()

    vi.advanceTimersByTime(400)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith({ kind: 'paths', relPaths: ['a.txt', 'b.txt'] })
  })

  it('emits refreshExpanded after debounce', () => {
    const listener = vi.fn()
    subscribeFileTreeSync(listener)

    emitFileTreeSyncForTests({ kind: 'refreshExpanded' })
    vi.advanceTimersByTime(400)

    expect(listener).toHaveBeenCalledWith({ kind: 'refreshExpanded' })
  })
})
