import { App, Dropdown } from 'antd'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'
import { buildFileTreeContextMenuItems } from './fileTreeContextMenuItems'

interface FileTreeContextMenuProps {
  relPath: string
  name: string
  isDirectory: boolean
  onAddToChat: () => void
  onCopyPath: () => void
  onCopyRelPath: () => void
  onShowInFolder: () => void
  onRename: () => void
  onDelete: () => void
  onCollectToWiki?: () => void
  onNewSubdirectory?: () => void
  showCollectToWiki?: boolean
  readOnly?: boolean
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
  onShowInFolder,
  onRename,
  onDelete,
  onCollectToWiki,
  onNewSubdirectory,
  showCollectToWiki = false,
  readOnly = false,
  children,
  open
}: FileTreeContextMenuProps) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('fileTree')
  const { t: tc } = useTypedTranslation('common')
  const items = buildFileTreeContextMenuItems({
    onAddToChat,
    onCopyPath,
    onCopyRelPath,
    onShowInFolder,
    onRename,
    onDelete,
    onCollectToWiki,
    onNewSubdirectory,
    isDirectory: _isDirectory,
    showCollectToWiki,
    readOnly,
    onAddToChatPlaceholder: () => message.info(t('contextMenu.featureInDevelopment')),
    t,
    tc
  })

  return (
    <Dropdown
      menu={{ items }}
      trigger={['contextMenu']}
      open={open}
      popupRender={(menu) => (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu}
        </div>
      )}
    >
      <div className="file-tree-context-trigger">{children}</div>
    </Dropdown>
  )
}
