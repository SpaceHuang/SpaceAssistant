import type { ReactNode, RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider, useSearch } from '../components/Search/SearchProvider'
import { useChatSearchAdapter } from './chatSearchAdapter'

const useDetailPanelMock = vi.fn()

vi.mock('../components/DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => useDetailPanelMock()
}))

function createContainer(html: string): RefObject<HTMLDivElement> {
  document.body.innerHTML = html
  const el = document.querySelector('.chat-message-list') as HTMLDivElement
  return { current: el }
}

function wrapper({ children }: { children: ReactNode }) {
  return <SearchProvider>{children}</SearchProvider>
}

describe('useChatSearchAdapter', () => {
  beforeEach(() => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: null,
      contentMode: 'file',
      fileType: null,
      viewMode: 'code',
      isWebViewActive: false
    })
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds matches in chat bubbles after debounce', async () => {
    const containerRef = createContainer(`
      <div class="chat-message-list">
        <div class="chat-bubble">hello world</div>
        <div class="chat-bubble">hello again</div>
      </div>
    `)

    const { result } = renderHook(
      () => {
        useChatSearchAdapter(containerRef, 2)
        return useSearch()
      },
      { wrapper }
    )

    act(() => {
      result.current.open()
      result.current.setQuery('hello')
    })

    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current.totalMatches).toBe(2)
    expect(document.querySelectorAll('mark.sa-search-highlight')).toHaveLength(2)
  })

  it('does not reset match count when adapter becomes inactive', async () => {
    const containerRef = createContainer(`
      <div class="chat-message-list">
        <div class="chat-bubble">hello world</div>
      </div>
    `)

    const { result, rerender } = renderHook(
      () => {
        useChatSearchAdapter(containerRef, 1)
        return useSearch()
      },
      { wrapper }
    )

    act(() => {
      result.current.open()
      result.current.setQuery('hello')
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current.totalMatches).toBe(1)

    useDetailPanelMock.mockReturnValue({
      selectedFile: 'doc.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'render',
      isWebViewActive: false
    })
    rerender()

    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current.totalMatches).toBe(1)
  })
})
