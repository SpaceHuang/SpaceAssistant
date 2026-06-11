import type { ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { changeAppLocale } from '../../i18n/localeSync'
import { SearchBar } from './SearchBar'
import { SearchProvider, useSearch } from './SearchProvider'

const useDetailPanelMock = vi.fn()

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => useDetailPanelMock()
}))

function OpenSearchBar({ children }: { children?: ReactNode }) {
  const { open } = useSearch()
  return (
    <>
      <button type="button" onClick={open}>
        open
      </button>
      {children}
    </>
  )
}

function renderSearchBar() {
  return render(
    <SearchProvider>
      <OpenSearchBar />
      <SearchBar />
    </SearchProvider>
  )
}

describe('SearchBar', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    useDetailPanelMock.mockReturnValue({
      selectedFile: null,
      contentMode: 'file',
      fileType: null,
      viewMode: 'code',
      isWebViewActive: false
    })
  })

  it('shows Chinese placeholder when opened', () => {
    renderSearchBar()
    act(() => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    })
    expect(screen.getByPlaceholderText('查找')).toBeDefined()
    expect(screen.getByRole('search').getAttribute('aria-label')).toBe('在当前面板中查找')
  }, 15000)

  it('shows unsupported hint when panel is not supported', () => {
    const view = renderSearchBar()
    fireEvent.click(screen.getByText('open'))
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'pic.png',
      contentMode: 'file',
      fileType: 'image',
      viewMode: 'render',
      isWebViewActive: false
    })
    view.rerender(
      <SearchProvider>
        <OpenSearchBar />
        <SearchBar />
      </SearchProvider>
    )
    expect(screen.getByText('当前面板不支持查找')).toBeDefined()
    expect(screen.getByText('—')).toBeDefined()
  })

  it('shows regex error from i18n only', () => {
    renderSearchBar()
    fireEvent.click(screen.getByText('open'))
    fireEvent.change(screen.getByPlaceholderText('查找'), { target: { value: '[' } })
    const regexButton = screen.getByRole('button', { name: '正则表达式 (Alt+R)' })
    fireEvent.click(regexButton)
    expect(screen.getByText('正则表达式无效')).toBeDefined()
  })
})
