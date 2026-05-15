import { Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'

interface FileTreeContextMenuProps {
  relPath: string
  name: string
  isDirectory: boolean
  onAddToChat: () => void
  onCopyPath: () => void
  onCopyRelPath: () => void
  onRename: () => void
  onDelete: () => void
  children: React.ReactNode
  /** For testing only - controls dropdown open state */
  open?: boolean
}

export function FileTreeContextMenu({
  relPath: _relPath,
  name: _name,
  isDirectory: _isDirectory,
  onAddToChat,
  onCopyPath,
  onCopyRelPath,
  onRename,
  onDelete,
  children,
  open
}: FileTreeContextMenuProps) {
  const items: MenuProps['items'] = [
    {
      key: 'add-to-chat',
      label: '添加到对话',
      onClick: () => {
        onAddToChat()
        message.info('功能开发中')
      }
    },
    { type: 'divider' },
    {
      key: 'copy-path',
      label: '复制路径',
      onClick: onCopyPath
    },
    {
      key: 'copy-rel-path',
      label: '复制相对路径',
      onClick: onCopyRelPath
    },
    { type: 'divider' },
    {
      key: 'rename',
      label: '重命名...',
      onClick: onRename
    },
    {
      key: 'delete',
      label: '删除',
      danger: true,
      onClick: onDelete
    }
  ]

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']} open={open}>
      <div className="file-tree-context-trigger">{children}</div>
    </Dropdown>
  )
}
