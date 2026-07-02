import type { ComponentProps } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App } from 'antd'
import { changeAppLocale } from '../../i18n/localeSync'
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
    onShowInFolder: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn()
  }

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('renders all menu items (zh-CN)', () => {
    renderMenu({ ...defaultProps, open: true })
    expect(screen.getByText('添加到对话')).toBeDefined()
    expect(screen.getByText('复制路径')).toBeDefined()
    expect(screen.getByText('复制相对路径')).toBeDefined()
    expect(screen.getByText('查看所在目录')).toBeDefined()
    expect(screen.getByText('重命名...')).toBeDefined()
    expect(screen.getByText('删除')).toBeDefined()
  })

  it('renders English menu items (en-US)', async () => {
    await changeAppLocale('en-US')
    renderMenu({ ...defaultProps, open: true })
    expect(screen.getByText('Add to chat')).toBeDefined()
    expect(screen.getByText('Copy path')).toBeDefined()
    expect(screen.getByText('Rename...')).toBeDefined()
    expect(screen.getByText('Delete')).toBeDefined()
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

  it('calls onShowInFolder', () => {
    renderMenu({ ...defaultProps, open: true })
    fireEvent.click(screen.getByText('查看所在目录'))
    expect(defaultProps.onShowInFolder).toHaveBeenCalled()
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

  it('shows new subdirectory for directory nodes', () => {
    const onNewSubdirectory = vi.fn()
    renderMenu({
      ...defaultProps,
      isDirectory: true,
      onNewSubdirectory,
      open: true
    })
    fireEvent.click(screen.getByText('新建子目录'))
    expect(onNewSubdirectory).toHaveBeenCalled()
  })

  it('hides new subdirectory for file nodes', () => {
    renderMenu({ ...defaultProps, isDirectory: false, onNewSubdirectory: vi.fn(), open: true })
    expect(screen.queryByText('新建子目录')).toBeNull()
  })
})
