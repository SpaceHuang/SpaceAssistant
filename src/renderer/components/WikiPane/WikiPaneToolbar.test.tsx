import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { WikiPaneToolbar } from './WikiPaneToolbar'

describe('WikiPaneToolbar', () => {
  it('renders open and refresh icon buttons', () => {
    render(<WikiPaneToolbar onOpen={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('wiki-open-btn')).toBeDefined()
    expect(screen.getByTestId('wiki-refresh-btn')).toBeDefined()
  })

  it('hides open button when showOpen is false', () => {
    render(<WikiPaneToolbar onOpen={vi.fn()} onRefresh={vi.fn()} showOpen={false} />)
    expect(screen.queryByTestId('wiki-open-btn')).toBeNull()
    expect(screen.getByTestId('wiki-refresh-btn')).toBeDefined()
  })

  it('calls handlers on click', () => {
    const onOpen = vi.fn()
    const onRefresh = vi.fn()
    render(<WikiPaneToolbar onOpen={onOpen} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('wiki-open-btn'))
    fireEvent.click(screen.getByTestId('wiki-refresh-btn'))
    expect(onOpen).toHaveBeenCalled()
    expect(onRefresh).toHaveBeenCalled()
  })
})
