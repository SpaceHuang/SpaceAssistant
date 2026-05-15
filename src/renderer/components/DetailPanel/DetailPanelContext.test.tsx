import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DetailPanelProvider, useDetailPanel } from './DetailPanelContext'

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
      wrapper: DetailPanelProvider
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

  it('closeFile clears state', async () => {
    const { result } = renderHook(() => useDetailPanel(), {
      wrapper: DetailPanelProvider
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
})
