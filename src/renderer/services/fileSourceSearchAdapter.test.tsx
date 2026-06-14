import type { ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider, useSearch } from '../components/Search/SearchProvider'
import { useFileSourceSearch } from './fileSourceSearchAdapter'

const useDetailPanelMock = vi.fn()

vi.mock('../components/DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => useDetailPanelMock()
}))

function wrapper({ children }: { children: ReactNode }) {
  return <SearchProvider>{children}</SearchProvider>
}

describe('useFileSourceSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'doc.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'code',
      isWebViewActive: false
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('finds matches in source content when search is open', () => {
    const content = '# Title\n\nalpha beta alpha\n'

    const { result } = renderHook(
      () => {
        const source = useFileSourceSearch(content)
        const search = useSearch()
        return { source, search }
      },
      { wrapper }
    )

    act(() => {
      result.current.search.open()
      result.current.search.setQuery('alpha')
    })

    expect(result.current.source.matches.length).toBe(2)
    expect(result.current.search.totalMatches).toBe(2)
  })

  it('returns empty matches when panel is markdown render', () => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'doc.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'render',
      isWebViewActive: false
    })

    const { result } = renderHook(
      () => {
        const source = useFileSourceSearch('alpha beta')
        const search = useSearch()
        return { source, search }
      },
      { wrapper }
    )

    act(() => {
      result.current.search.open()
      result.current.search.setQuery('alpha')
    })

    expect(result.current.source.matches).toEqual([])
    expect(result.current.search.totalMatches).toBe(0)
  })
})
