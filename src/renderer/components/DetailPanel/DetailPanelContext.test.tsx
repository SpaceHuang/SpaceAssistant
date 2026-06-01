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

  beforeEach(() => {
    originalApi = (window as Record<string, unknown>).api
    fileReadFile.mockResolvedValue({
      kind: 'text',
      content: 'hello',
      encoding: 'utf8'
    })
    ;(window as Record<string, unknown>).api = { fileReadFile }
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
