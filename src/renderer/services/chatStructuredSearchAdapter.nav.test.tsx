import type { ReactNode, RefObject } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider, useSearch } from '../components/Search/SearchProvider'
import type { DisplayMessageEntry } from '../../shared/displayOrder'
import type { Message } from '../../shared/domainTypes'
import { useChatStructuredSearchAdapter } from './chatStructuredSearchAdapter'

const useDetailPanelMock = vi.fn()

vi.mock('../components/DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => useDetailPanelMock()
}))

function msg(id: string, content: string, sequence: number): DisplayMessageEntry {
  const message: Message = {
    id,
    sessionId: 's1',
    role: 'user',
    content,
    timestamp: sequence,
    status: 'sent',
    schemaVersion: 1
  }
  return { message, order: { kind: 'persisted', sequence } }
}

function wrapper({ children }: { children: ReactNode }) {
  return <SearchProvider>{children}</SearchProvider>
}

describe('useChatStructuredSearchAdapter navigation', () => {
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
    document.body.innerHTML = ''
  })

  it('navigates by messageId when unique hit is not in mounted DOM', async () => {
    // 最新页 DOM 无命中；语料 entries 含第三页唯一命中
    document.body.innerHTML = `
      <div class="chat-message-list">
        <div class="chat-bubble" data-message-id="m-latest">unrelated latest page</div>
      </div>
    `
    const containerRef: RefObject<HTMLElement | null> = {
      current: document.querySelector('.chat-message-list')
    }
    const onNavigateToMatch = vi.fn()
    const corpus = [
      msg('m-page3', 'needle only on page three', 10),
      msg('m-latest', 'unrelated latest page', 100)
    ]

    const { result } = renderHook(
      () => {
        useChatStructuredSearchAdapter({
          containerRef,
          active: true,
          entries: corpus,
          onNavigateToMatch
        })
        return useSearch()
      },
      { wrapper }
    )

    act(() => {
      result.current.open()
      result.current.setQuery('needle')
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })

    expect(result.current.totalMatches).toBe(1)
    expect(onNavigateToMatch).toHaveBeenCalledWith('m-page3')
    expect(document.querySelectorAll('mark.sa-search-highlight')).toHaveLength(0)
  })

  it('highlights correct mark after target bubble mounts (global index ≠ local marks)', async () => {
    document.body.innerHTML = `
      <div class="chat-message-list">
        <div class="chat-bubble" data-message-id="m-page3">
          <div data-search-fragment-id="m-page3|user-content">needle only on page three</div>
        </div>
      </div>
    `
    const containerRef: RefObject<HTMLElement | null> = {
      current: document.querySelector('.chat-message-list')
    }
    const onNavigateToMatch = vi.fn()
    // 结构化结果索引 0 是未挂载的 m-early；索引 1 是已挂载的 m-page3
    const corpus = [
      msg('m-early', 'needle early', 1),
      msg('m-page3', 'needle only on page three', 10)
    ]

    const { result, rerender } = renderHook(
      ({ entries }: { entries: DisplayMessageEntry[] }) => {
        useChatStructuredSearchAdapter({
          containerRef,
          active: true,
          entries,
          onNavigateToMatch
        })
        return useSearch()
      },
      { wrapper, initialProps: { entries: corpus } }
    )

    act(() => {
      result.current.open()
      result.current.setQuery('needle')
    })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(result.current.totalMatches).toBe(2)

    // 跳到第二个命中（已挂载）
    act(() => {
      result.current.goNext()
    })
    await act(async () => {
      vi.advanceTimersByTime(50)
    })

    expect(onNavigateToMatch).toHaveBeenCalledWith('m-page3')
    const current = document.querySelector('mark.sa-search-highlight-current')
    expect(current?.textContent).toContain('needle')
    expect(current?.closest('[data-message-id]')?.getAttribute('data-message-id')).toBe(
      'm-page3'
    )

    // 模拟分页后 entries 变化，仍能按 fragmentId 对齐
    rerender({ entries: [...corpus, msg('m-extra', 'other', 200)] })
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(
      document
        .querySelector('mark.sa-search-highlight-current')
        ?.closest('[data-message-id]')
        ?.getAttribute('data-message-id')
    ).toBe('m-page3')
  })
})
