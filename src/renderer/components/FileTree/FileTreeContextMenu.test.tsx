import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App } from 'antd'
import { FileTreeContextMenu } from './FileTreeContextMenu'

function renderMenu(props: ComponentProps<typeof FileTreeContextMenu>) {
  return render(
    <App>
      <FileTreeContextMenu {...props}>child</FileTreeContextMenu>
    </App>
  )
}

describe('FileTreeContextMenu', () => {
  const defaultProps = {
    relPath: 'src/file.ts',
    name: 'file.ts',
    isDirectory: false,
    onAddToChat: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelPath: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn()
  }

  it('renders all menu items', () => {
    renderMenu({ ...defaultProps, open: true })
    expect(screen.getByText('添加到对话')).toBeDefined()
    expect(screen.getByText('复制路径')).toBeDefined()
    expect(screen.getByText('复制相对路径')).toBeDefined()
    expect(screen.getByText('重命名...')).toBeDefined()
    expect(screen.getByText('删除')).toBeDefined()
  })

  it('calls onAddToChat', () => {
    renderMenu({ ...defaultProps, open: true })
    fireEvent.click(screen.getByText('添加到对话'))
    expect(defaultProps.onAddToChat).toHaveBeenCalled()
  })

  it('calls onCopyPath', () => {
    renderMenu({ ...defaultProps, open: true })
    fireEvent.click(screen.getByText('复制路径'))
    expect(defaultProps.onCopyPath).toHaveBeenCalled()
  })

  it('calls onCopyRelPath', () => {
    renderMenu({ ...defaultProps, open: true })
    fireEvent.click(screen.getByText('复制相对路径'))
    expect(defaultProps.onCopyRelPath).toHaveBeenCalled()
  })

  it('calls onRename', () => {
    renderMenu({ ...defaultProps, open: true })
    fireEvent.click(screen.getByText('重命名...'))
    expect(defaultProps.onRename).toHaveBeenCalled()
  })

  it('calls onDelete', () => {
    renderMenu({ ...defaultProps, open: true })
    fireEvent.click(screen.getByText('删除'))
    expect(defaultProps.onDelete).toHaveBeenCalled()
  })
})
