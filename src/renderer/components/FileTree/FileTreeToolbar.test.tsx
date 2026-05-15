import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FileTreeToolbar } from './FileTreeToolbar'

describe('FileTreeToolbar', () => {
  it('renders two icon buttons', () => {
    render(<FileTreeToolbar onNewDirectory={vi.fn()} onRefresh={vi.fn()} />)
    expect(screen.getByTestId('new-directory-btn')).toBeDefined()
    expect(screen.getByTestId('refresh-btn')).toBeDefined()
  })

  it('calls onNewDirectory when new directory button clicked', () => {
    const onNewDirectory = vi.fn()
    render(<FileTreeToolbar onNewDirectory={onNewDirectory} onRefresh={vi.fn()} />)
    fireEvent.click(screen.getByTestId('new-directory-btn'))
    expect(onNewDirectory).toHaveBeenCalled()
  })

  it('calls onRefresh when refresh button clicked', () => {
    const onRefresh = vi.fn()
    render(<FileTreeToolbar onNewDirectory={vi.fn()} onRefresh={onRefresh} />)
    fireEvent.click(screen.getByTestId('refresh-btn'))
    expect(onRefresh).toHaveBeenCalled()
  })
})
