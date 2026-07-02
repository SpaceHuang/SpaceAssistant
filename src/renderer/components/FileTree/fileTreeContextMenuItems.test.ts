import { describe, expect, it, vi } from 'vitest'
import { buildFileTreeContextMenuItems } from './fileTreeContextMenuItems'

const baseHandlers = {
  onAddToChat: vi.fn(),
  onCopyPath: vi.fn(),
  onCopyRelPath: vi.fn(),
  onShowInFolder: vi.fn(),
  onRename: vi.fn(),
  onDelete: vi.fn(),
  onAddToChatPlaceholder: vi.fn(),
  t: (key: string) => key,
  tc: (key: string) => key
}

describe('buildFileTreeContextMenuItems', () => {
  it('includes new subdirectory for writable directory nodes', () => {
    const onNewSubdirectory = vi.fn()
    const items = buildFileTreeContextMenuItems({
      ...baseHandlers,
      isDirectory: true,
      onNewSubdirectory
    })
    const labels = items?.map((item) => (item && 'label' in item ? item.label : null))
    expect(labels).toContain('contextMenu.newSubdirectory')
  })

  it('omits new subdirectory for files', () => {
    const items = buildFileTreeContextMenuItems({
      ...baseHandlers,
      isDirectory: false,
      onNewSubdirectory: vi.fn()
    })
    const labels = items?.map((item) => (item && 'label' in item ? item.label : null))
    expect(labels).not.toContain('contextMenu.newSubdirectory')
  })

  it('omits new subdirectory in read-only trees', () => {
    const items = buildFileTreeContextMenuItems({
      ...baseHandlers,
      isDirectory: true,
      readOnly: true,
      onNewSubdirectory: vi.fn()
    })
    const labels = items?.map((item) => (item && 'label' in item ? item.label : null))
    expect(labels).not.toContain('contextMenu.newSubdirectory')
    expect(labels).not.toContain('contextMenu.rename')
  })
})
