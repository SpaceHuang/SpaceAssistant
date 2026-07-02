import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { FileTreeContextMenuOverlay } from './FileTreeContextMenuOverlay'

describe('FileTreeContextMenuOverlay', () => {
  it('renders menu items at fixed coordinates when open', () => {
    render(
      <FileTreeContextMenuOverlay
        open
        x={120}
        y={80}
        items={[{ key: 'copy', label: 'Copy path' }]}
        onClose={vi.fn()}
      />
    )

    const menu = document.body.querySelector('.file-tree-context-menu-panel') as HTMLElement
    expect(menu).toBeTruthy()
    expect(menu.style.left).toBe('120px')
    expect(menu.style.top).toBe('80px')
    expect(screen.getByText('Copy path')).toBeTruthy()
  })

  it('closes when clicking outside the menu', () => {
    const onClose = vi.fn()
    render(
      <FileTreeContextMenuOverlay
        open
        x={10}
        y={10}
        items={[{ key: 'copy', label: 'Copy path' }]}
        onClose={onClose}
      />
    )

    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalled()
  })
})
