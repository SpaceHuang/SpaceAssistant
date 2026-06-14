import type { ReactNode } from 'react'
import { act, fireEvent, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchProvider, useSearch } from './SearchProvider'

const useDetailPanelMock = vi.fn()

vi.mock('../DetailPanel/DetailPanelContext', () => ({
  useDetailPanel: () => useDetailPanelMock()
}))

function wrapper({ children }: { children: ReactNode }) {
  return <SearchProvider>{children}</SearchProvider>
}

describe('SearchProvider', () => {
  beforeEach(() => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: null,
      contentMode: 'file',
      fileType: null,
      viewMode: 'code',
      isWebViewActive: false
    })
    document.body.innerHTML = ''
  })

  it('opens search bar on Ctrl+F in chat context', () => {
    const { result } = renderHook(() => useSearch(), { wrapper })
    expect(result.current.isOpen).toBe(false)

    act(() => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    })

    expect(result.current.isOpen).toBe(true)
    expect(result.current.activePanel).toBe('chat')
    expect(result.current.panelSupported).toBe(true)
  })

  it('does not open when composer is focused', () => {
    document.body.innerHTML = `<div class="composer"><textarea></textarea></div>`
    const textarea = document.querySelector('textarea') as HTMLTextAreaElement
    textarea.focus()

    const { result } = renderHook(() => useSearch(), { wrapper })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    })

    expect(result.current.isOpen).toBe(false)
  })

  it('opens for file source mode', () => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'readme.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'code',
      isWebViewActive: false
    })

    const { result } = renderHook(() => useSearch(), { wrapper })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    })

    expect(result.current.isOpen).toBe(true)
    expect(result.current.activePanel).toBe('file-source')
    expect(result.current.panelSupported).toBe(true)
  })

  it('opens for markdown render mode', () => {
    useDetailPanelMock.mockReturnValue({
      selectedFile: 'readme.md',
      contentMode: 'file',
      fileType: 'markdown',
      viewMode: 'render',
      isWebViewActive: false
    })

    const { result } = renderHook(() => useSearch(), { wrapper })
    act(() => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
    })

    expect(result.current.isOpen).toBe(true)
    expect(result.current.activePanel).toBe('file-markdown')
  })

  it('closes on Escape and clears match state', () => {
    const { result } = renderHook(() => useSearch(), { wrapper })

    act(() => {
      fireEvent.keyDown(window, { key: 'f', ctrlKey: true })
      result.current.setSearchResults({ totalMatches: 3, matchOverflow: false })
    })
    expect(result.current.isOpen).toBe(true)

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })

    expect(result.current.isOpen).toBe(false)
    expect(result.current.totalMatches).toBe(0)
  })
})
