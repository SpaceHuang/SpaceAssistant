import type { ReactNode } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from 'antd'
import { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

function DetailPanelTestWrapper({ children }: { children: ReactNode }) {
  return (
    <App>
      <DetailPanelProvider>{children}</DetailPanelProvider>
    </App>
  )
}

vi.mock('../../utils/shikiHighlighter', () => ({
  preloadShiki: vi.fn().mockResolvedValue({})
}))

describe('DetailPanelContext', () => {
  let originalApi: unknown
  const fileReadFile = vi.fn()
  const fileToViewerUrl = vi.fn()

  beforeEach(() => {
    originalApi = (window as Record<string, unknown>).api
    fileReadFile.mockResolvedValue({
      kind: 'text',
      content: 'hello',
      encoding: 'utf8'
    })
    fileToViewerUrl.mockResolvedValue({ ok: true, url: 'file:///tmp/page.html' })
    ;(window as Record<string, unknown>).api = { fileReadFile, fileToViewerUrl }
  })

  afterEach(() => {
    ;(window as Record<string, unknown>).api = originalApi
    vi.clearAllMocks()
  })

  it('openFile loads text content', async () => {
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

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
    fileReadFile.mockResolvedValueOnce({
      kind: 'text',
      content: '# Title',
      encoding: 'utf8'
    })

    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

    await act(async () => {
      await result.current.openFile('docs/readme.md')
    })

    await waitFor(() => {
      expect(result.current.fileType).toBe('markdown')
      expect(result.current.viewMode).toBe('render')
    })
  })

  it('openFile defaults html to render preview and resolves local viewer url', async () => {
    fileReadFile.mockResolvedValueOnce({
      kind: 'text',
      content: '<html></html>',
      encoding: 'utf8'
    })

    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

    await act(async () => {
      await result.current.openFile('pages/index.html')
    })

    await waitFor(() => {
      expect(result.current.fileType).toBe('html')
      expect(result.current.viewMode).toBe('render')
      expect(result.current.localFileViewerUrl).toBe('file:///tmp/page.html')
      expect(result.current.isWebViewActive).toBe(true)
    })
    expect(fileToViewerUrl).toHaveBeenCalledWith('pages/index.html')
  })

  it('openFile defaults non-markdown to code view', async () => {
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

    await act(async () => {
      await result.current.openFile('test.txt')
    })

    await waitFor(() => {
      expect(result.current.viewMode).toBe('code')
    })
  })

  it('openUrl normalizes bare domain and switches to url mode', async () => {
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

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
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

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
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

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
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })

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
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })
    expect(result.current.referencedFilesHeight).toBe(0.38)
  })

  it('resetReferencedFilesHeight restores default ratio', () => {
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelTestWrapper
    })
    act(() => {
      result.current.setReferencedFilesHeight(0.5)
    })
    act(() => {
      result.current.resetReferencedFilesHeight()
    })
    expect(result.current.referencedFilesHeight).toBe(0.38)
  })
})
