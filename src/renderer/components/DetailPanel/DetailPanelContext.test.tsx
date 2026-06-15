import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from 'antd'
import { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'
import {
  emitFileContentSyncForTests,
  flushFileContentSyncForTests,
  resetFileContentSyncBusForTests,
  setFileContentMetadataGetterForTests
} from '../../services/fileContentSyncBus'
import { FILE_CONTENT_DEBOUNCE_MS, FILE_CONTENT_SETTLE_MS } from '../../../shared/fileContentSync'

function DetailPanelTestWrapper({ children }: { children: ReactNode }) {
  return (
    <App>
      <DetailPanelProvider>{children}</DetailPanelProvider>
    </App>
  )
}

function createMockApi(overrides: Record<string, unknown> = {}) {
  return {
    fileReadFile: vi.fn().mockResolvedValue({
      kind: 'text',
      content: 'hello',
      encoding: 'utf8'
    }),
    fileToViewerUrl: vi.fn().mockResolvedValue({ ok: true, url: 'file:///tmp/page.html' }),
    fileGetMetadata: vi.fn().mockResolvedValue({ mtime: 1000, size: 5, isText: true }),
    fileWatchContent: vi.fn().mockResolvedValue(undefined),
    fileOnTreeChanged: vi.fn(() => () => {}),
    fileOnContentChanged: vi.fn(() => () => {}),
    ...overrides
  }
}

vi.mock('../../utils/shikiHighlighter', () => ({
  preloadShiki: vi.fn().mockResolvedValue({})
}))

describe('DetailPanelContext', () => {
  let originalApi: unknown
  let unmountHook: (() => void) | undefined

  beforeEach(() => {
    resetFileContentSyncBusForTests()
    originalApi = (window as Record<string, unknown>).api
    ;(window as Record<string, unknown>).api = createMockApi()
    setFileContentMetadataGetterForTests(async () => ({ mtime: 1000, size: 5 }))
    unmountHook = undefined
  })

  afterEach(() => {
    unmountHook?.()
    resetFileContentSyncBusForTests()
    ;(window as Record<string, unknown>).api = originalApi
    vi.clearAllMocks()
  })

  function renderDetailPanel() {
    const rendered = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })
    unmountHook = rendered.unmount
    return rendered
  }

  function apiMock() {
    return (window as Record<string, unknown>).api as ReturnType<typeof createMockApi>
  }

  it('openFile loads text content', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    await waitFor(() => {
      expect(result.current.selectedFile).toBe('test.txt')
      expect(result.current.previewContent).toBe('hello')
      expect(result.current.fileType).toBe('text')
      expect(result.current.contentMode).toBe('file')
    })
  })

  it('openFile defaults markdown to render preview', async () => {
    apiMock().fileReadFile.mockResolvedValueOnce({
      kind: 'text',
      content: '# Title',
      encoding: 'utf8'
    })

    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('docs/readme.md')
    })

    await waitFor(() => {
      expect(result.current.fileType).toBe('markdown')
      expect(result.current.viewMode).toBe('render')
    })
  })

  it('openFile defaults html to render preview and resolves local viewer url', async () => {
    apiMock().fileReadFile.mockResolvedValueOnce({
      kind: 'text',
      content: '<html></html>',
      encoding: 'utf8'
    })

    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('pages/index.html')
    })

    await waitFor(() => {
      expect(result.current.fileType).toBe('html')
      expect(result.current.viewMode).toBe('render')
      expect(result.current.localFileViewerUrl).toBe('file:///tmp/page.html')
      expect(result.current.isWebViewActive).toBe(true)
    })
    expect(apiMock().fileToViewerUrl).toHaveBeenCalledWith('pages/index.html')
  })

  it('openFile defaults non-markdown to code view', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    await waitFor(() => {
      expect(result.current.viewMode).toBe('code')
    })
  })

  it('openUrl normalizes bare domain and switches to url mode', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openUrl('example.com')
    })

    await waitFor(() => {
      expect(result.current.contentMode).toBe('url')
      expect(result.current.selectedUrl).toBe('https://example.com/')
      expect(result.current.displayUrl).toBe('https://example.com/')
      expect(result.current.selectedFile).toBeNull()
    })
  })

  it('openFile clears previous url mode state', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openUrl('https://example.com/')
    })
    await act(async () => {
      await result.current.openFile('test.txt')
    })

    await waitFor(() => {
      expect(result.current.contentMode).toBe('file')
      expect(result.current.selectedUrl).toBeNull()
      expect(result.current.selectedFile).toBe('test.txt')
    })
  })

  it('navigateBack and navigateForward update selected url', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openUrl('https://a.example/')
    })
    await act(async () => {
      await result.current.openUrl('https://b.example/')
    })

    act(() => {
      result.current.navigateBack()
    })

    await waitFor(() => {
      expect(result.current.selectedUrl).toBe('https://a.example/')
      expect(result.current.canNavigateForward).toBe(true)
    })

    act(() => {
      result.current.navigateForward()
    })

    await waitFor(() => {
      expect(result.current.selectedUrl).toBe('https://b.example/')
    })
  })

  it('closeFile clears state', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })
    act(() => {
      result.current.closeFile()
    })

    expect(result.current.selectedFile).toBeNull()
    expect(result.current.previewContent).toBeNull()
    expect(result.current.contentMode).toBe('file')
  })

  it('defaults referencedFilesHeight to 0.38', () => {
    const { result } = renderDetailPanel()
    expect(result.current.referencedFilesHeight).toBe(0.38)
  })

  it('resetReferencedFilesHeight restores default ratio', () => {
    const { result } = renderDetailPanel()
    act(() => {
      result.current.setReferencedFilesHeight(0.5)
    })
    act(() => {
      result.current.resetReferencedFilesHeight()
    })
    expect(result.current.referencedFilesHeight).toBe(0.38)
  })

  it('starts content watch when opening a previewable file', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    expect(apiMock().fileWatchContent).toHaveBeenCalledWith('test.txt')
  })
})

describe('DetailPanelContext auto sync', () => {
  let originalApi: unknown
  let unmountHook: (() => void) | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    resetFileContentSyncBusForTests()
    originalApi = (window as Record<string, unknown>).api
    ;(window as Record<string, unknown>).api = createMockApi()
    setFileContentMetadataGetterForTests(async () => ({ mtime: 2000, size: 7 }))
    unmountHook = undefined
  })

  afterEach(() => {
    unmountHook?.()
    resetFileContentSyncBusForTests()
    ;(window as Record<string, unknown>).api = originalApi
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  function renderDetailPanel() {
    const rendered = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })
    unmountHook = rendered.unmount
    return rendered
  }

  function apiMock() {
    return (window as Record<string, unknown>).api as ReturnType<typeof createMockApi>
  }

  it('auto sync updates previewContent without setting isLoading', async () => {
    apiMock().fileReadFile
      .mockResolvedValueOnce({ kind: 'text', content: 'hello', encoding: 'utf8' })
      .mockResolvedValueOnce({ kind: 'text', content: 'updated', encoding: 'utf8' })

    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    apiMock().fileGetMetadata.mockResolvedValue({ mtime: 2000, size: 7, isText: true })

    expect(result.current.isLoading).toBe(false)

    emitFileContentSyncForTests('test.txt')
    await act(async () => {
      const flushPromise = flushFileContentSyncForTests()
      await vi.advanceTimersByTimeAsync(FILE_CONTENT_SETTLE_MS)
      await flushPromise
    })

    expect(result.current.previewContent).toBe('updated')
    expect(result.current.isLoading).toBe(false)
  })

  it('auto sync ignores changes for other files', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    apiMock().fileReadFile.mockClear()
    emitFileContentSyncForTests('other.txt')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(FILE_CONTENT_DEBOUNCE_MS)
      await flushFileContentSyncForTests()
    })

    expect(apiMock().fileReadFile).not.toHaveBeenCalled()
    expect(result.current.previewContent).toBe('hello')
  })

  it('manual refresh sets isLoading during reload', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    let resolveRead: ((value: unknown) => void) | undefined
    apiMock().fileReadFile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRead = resolve
        })
    )

    let refreshPromise: Promise<void> | undefined
    act(() => {
      refreshPromise = result.current.refreshFile()
    })

    expect(result.current.isLoading).toBe(true)

    await act(async () => {
      resolveRead?.({ kind: 'text', content: 'hello', encoding: 'utf8' })
      await refreshPromise
    })

    expect(result.current.isLoading).toBe(false)
  })

  it('closeFile stops further auto sync reads', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    act(() => {
      result.current.closeFile()
    })

    apiMock().fileReadFile.mockClear()
    emitFileContentSyncForTests('test.txt')
    await act(async () => {
      const flushPromise = flushFileContentSyncForTests()
      await vi.advanceTimersByTimeAsync(FILE_CONTENT_SETTLE_MS)
      await flushPromise
    })

    expect(apiMock().fileReadFile).not.toHaveBeenCalled()
  })

  it('shows fileDeleted error when metadata reports ENOENT during auto sync', async () => {
    const { result } = renderDetailPanel()

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    apiMock().fileGetMetadata.mockRejectedValue(new Error('ENOENT: no such file'))
    emitFileContentSyncForTests('test.txt')
    await act(async () => {
      const flushPromise = flushFileContentSyncForTests()
      await vi.advanceTimersByTimeAsync(FILE_CONTENT_SETTLE_MS)
      await flushPromise
    })

    expect(result.current.loadError).toBe('文件已被删除或移动')
    expect(apiMock().fileWatchContent).toHaveBeenCalledWith(null)
  })
})
