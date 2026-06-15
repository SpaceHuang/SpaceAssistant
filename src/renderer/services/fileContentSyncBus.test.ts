import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  emitFileContentSyncForTests,
  emitRefreshExpandedForTests,
  flushFileContentSyncForTests,
  resetFileContentSyncBusForTests,
  setFileContentMetadataGetterForTests,
  subscribeFileContentSync
} from './fileContentSyncBus'
import { FILE_CONTENT_DEBOUNCE_MS, FILE_CONTENT_SETTLE_MS } from '../../shared/fileContentSync'

describe('fileContentSyncBus', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetFileContentSyncBusForTests()
    setFileContentMetadataGetterForTests(async () => ({ mtime: 1000, size: 10 }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('debounces path events before notifying listeners', async () => {
    const listener = vi.fn()
    subscribeFileContentSync(listener)

    emitFileContentSyncForTests('a.txt')
    emitFileContentSyncForTests('b.txt')

    expect(listener).not.toHaveBeenCalled()

    const flushPromise = flushFileContentSyncForTests()
    await vi.advanceTimersByTimeAsync(FILE_CONTENT_SETTLE_MS)
    await flushPromise

    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenCalledWith({ kind: 'path', relPath: 'a.txt', reason: 'paths' })
    expect(listener).toHaveBeenCalledWith({ kind: 'path', relPath: 'b.txt', reason: 'paths' })
  })

  it('emits refreshExpanded after debounce', async () => {
    const listener = vi.fn()
    subscribeFileContentSync(listener)

    emitRefreshExpandedForTests()
    await vi.advanceTimersByTimeAsync(FILE_CONTENT_DEBOUNCE_MS)
    await flushFileContentSyncForTests()

    expect(listener).toHaveBeenCalledWith({ kind: 'refreshExpanded' })
  })

  it('cancel clears pending sync', async () => {
    const listener = vi.fn()
    subscribeFileContentSync(listener)

    emitFileContentSyncForTests('cancel.txt')
    resetFileContentSyncBusForTests()
    setFileContentMetadataGetterForTests(async () => ({ mtime: 1000, size: 10 }))
    subscribeFileContentSync(listener)

    await vi.advanceTimersByTimeAsync(FILE_CONTENT_DEBOUNCE_MS)
    await flushFileContentSyncForTests()

    expect(listener).not.toHaveBeenCalled()
  })
})
