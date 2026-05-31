import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  requestFilePaneSelect,
  subscribeFilePaneSelect,
  resetFilePaneNavigationForTests
} from './filePaneNavigation'

describe('filePaneNavigation', () => {
  beforeEach(() => {
    resetFilePaneNavigationForTests()
  })

  it('delivers pending select when listener subscribes later', () => {
    const listener = vi.fn()
    requestFilePaneSelect({ relPath: 'src/utils/perf.ts' })
    subscribeFilePaneSelect(listener)
    expect(listener).toHaveBeenCalledWith({ relPath: 'src/utils/perf.ts' })
  })

  it('delivers immediately when listener already exists', () => {
    const listener = vi.fn()
    subscribeFilePaneSelect(listener)
    requestFilePaneSelect({ relPath: 'README.md' })
    expect(listener).toHaveBeenCalledWith({ relPath: 'README.md' })
  })

  it('clears pending after delivery on subscribe', () => {
    const first = vi.fn()
    const second = vi.fn()
    requestFilePaneSelect({ relPath: 'a.ts' })
    subscribeFilePaneSelect(first)
    subscribeFilePaneSelect(second)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })
})
