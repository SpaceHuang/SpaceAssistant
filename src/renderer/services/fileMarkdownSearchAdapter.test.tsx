import type { ReactNode, RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider, useSearch } from '../components/Search/SearchProvider'
import { useFileMarkdownSearchAdapter } from './fileMarkdownSearchAdapter'

const useDetailPanelMock = vi.fn()

vi.mock('../components/DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => useDetailPanelMock()
}))

function wrapper({ children }: { children: ReactNode }) {
  return <SearchProvider>{children}</SearchProvider>
}

describe('useFileMarkdownSearchAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('searches only in markdown render panel', async () => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'doc.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'render',
      isWebViewActive: false
    })

    document.body.innerHTML = `
      <div class="detail-md-search-root">
        <p>alpha beta alpha</p>
      </div>
    `
    const containerRef: RefObject<HTMLDivElement> = {
      current: document.querySelector('.detail-md-search-root') as HTMLDivElement
    }

    const { result } = renderHook(
      () => {
        useFileMarkdownSearchAdapter(containerRef)
        return useSearch()
      },
      { wrapper }
    )

    act(() => {
      result.current.open()
      result.current.setQuery('alpha')
    })

    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current.totalMatches).toBe(2)
  })

  it('does not search in file source panel', async () => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'doc.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'code',
      isWebViewActive: false
    })

    document.body.innerHTML = `<div class="detail-md-search-root"><p>alpha beta</p></div>`
    const containerRef: RefObject<HTMLDivElement> = {
      current: document.querySelector('.detail-md-search-root') as HTMLDivElement
    }

    const { result } = renderHook(
      () => {
        useFileMarkdownSearchAdapter(containerRef)
        return useSearch()
      },
      { wrapper }
    )

    act(() => {
      result.current.open()
      result.current.setQuery('alpha')
    })

    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current.totalMatches).toBe(0)
  })
})
