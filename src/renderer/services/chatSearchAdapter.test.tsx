import type { ReactNode, RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider, useSearch } from '../components/Search/SearchProvider'
import type { Message } from '../../../shared/domainTypes'
import { useChatSearchAdapter } from './chatSearchAdapter'

const useDetailPanelMock = vi.fn()

function msg(id: string, content: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'user',
    content,
    timestamp: 1,
    status: 'sent',
    schemaVersion: 1
  }
}

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
    Object.assign(window.api ?? {}, {
      chatGetSearchCorpusPage: vi.fn().mockResolvedValue({
        entries: [],
        nextSequence: 0,
        hasMore: false
      })
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds matches in chat bubbles after debounce', async () => {
    const containerRef = createContainer(`
      <div class="chat-message-list">
        <div class="chat-bubble" data-message-id="1">
          <div data-search-fragment-id="1|user-content">hello world</div>
        </div>
        <div class="chat-bubble" data-message-id="2">
          <div data-search-fragment-id="2|user-content">hello again</div>
        </div>
      </div>
    `)

    const { result } = renderHook(
      () => {
        useChatSearchAdapter(containerRef, {
          sessionId: 's1',
          messages: [msg('1', 'hello world'), msg('2', 'hello again')],
          displayEntries: []
        })
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
    expect(document.querySelectorAll('mark.sa-search-highlight')).toHaveLength(1)
    expect(document.querySelector('mark.sa-search-highlight-current')?.textContent).toBe('hello')
  })

  it('does not reset match count when adapter becomes inactive', async () => {
    const containerRef = createContainer(`
      <div class="chat-message-list">
        <div class="chat-bubble">hello world</div>
      </div>
    `)

    const { result, rerender } = renderHook(
      () => {
        useChatSearchAdapter(containerRef, {
          sessionId: 's1',
          messages: [msg('1', 'hello world')],
          displayEntries: []
        })
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

  it('loads search corpus IPC once across multiple query changes', async () => {
    const corpusPage = vi.fn().mockResolvedValue({
      entries: [
        {
          message: msg('m0', 'alpha beta'),
          sequence: 0
        }
      ],
      nextSequence: 1,
      hasMore: false
    })
    Object.assign(window.api ?? {}, {
      chatGetSearchCorpusPage: corpusPage
    })

    const containerRef = createContainer(`
      <div class="chat-message-list">
        <div class="chat-bubble" data-message-id="m0">alpha beta</div>
      </div>
    `)

    const { result } = renderHook(
      () => {
        useChatSearchAdapter(containerRef, {
          sessionId: 's1',
          messages: [msg('m0', 'alpha beta')],
          displayEntries: []
        })
        return useSearch()
      },
      { wrapper }
    )

    act(() => {
      result.current.open()
    })
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    act(() => {
      result.current.setQuery('a')
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    act(() => {
      result.current.setQuery('al')
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    act(() => {
      result.current.setQuery('alpha')
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
      await Promise.resolve()
    })

    expect(corpusPage).toHaveBeenCalledTimes(1)
    expect(result.current.totalMatches).toBeGreaterThan(0)
  })

  it('排队消息即使来自数据库语料或加载竞态也不进入搜索 entries', async () => {
    const queued = { ...msg('q', 'secret queued phrase'), status: 'queued' as const }
    const corpusPage = vi.fn().mockResolvedValue({ entries: [{ message: queued, sequence: 0 }], nextSequence: 1, hasMore: false })
    Object.assign(window.api ?? {}, { chatGetSearchCorpusPage: corpusPage })
    const { result } = renderHook(() => {
      useChatSearchAdapter(createContainer('<div class="chat-message-list" />'), { sessionId: 's1', messages: [queued], displayEntries: [] })
      return useSearch()
    }, { wrapper })
    act(() => { result.current.open(); result.current.setQuery('secret') })
    await act(async () => { await Promise.resolve(); await Promise.resolve(); vi.advanceTimersByTime(350); await Promise.resolve() })
    expect(result.current.totalMatches).toBe(0)
  })

  it('排队项转为 sent 后可以通过实时消息覆盖命中', async () => {
    const queued = { ...msg('promoted', 'promoted searchable phrase'), status: 'queued' as const }
    Object.assign(window.api ?? {}, { chatGetSearchCorpusPage: vi.fn().mockResolvedValue({ entries: [{ message: queued, sequence: 0 }], nextSequence: 1, hasMore: false }) })
    const containerRef = createContainer('<div class="chat-message-list" />')
    const live = { ...queued, status: 'sent' as const }
    const { result, rerender } = renderHook(({ current }) => {
      useChatSearchAdapter(containerRef, { sessionId: 's1', messages: [current], displayEntries: [] })
      return useSearch()
    }, { initialProps: { current: queued }, wrapper })
    act(() => { result.current.open(); result.current.setQuery('promoted') })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    rerender({ current: live })
    await act(async () => { vi.advanceTimersByTime(350); await Promise.resolve() })
    expect(result.current.totalMatches).toBe(1)
  })
})
