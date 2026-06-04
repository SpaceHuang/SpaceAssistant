import { App, Dropdown } from 'antd'
import type { MenuInfo, MenuProps } from 'antd/es/menu/interface'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

/** 阻止菜单点击冒泡到 Tree 节点，避免误触发文件选中/打开 */
function wrapMenuClick(handler: () => void): (info: MenuInfo) => void {
  return ({ domEvent }) => {
    domEvent.stopPropagation()
    domEvent.preventDefault()
    handler()
  }
}

interface FileTreeContextMenuProps {
  relPath: string
  name: string
  isDirectory: boolean
  onAddToChat: () => void
  onCopyPath: () => void
  onCopyRelPath: () => void
  onRename: () => void
  onDelete: () => void
  onCollectToWiki?: () => void
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
  onRename,
  onDelete,
  onCollectToWiki,
  showCollectToWiki = false,
  readOnly = false,
  children,
  open
}: FileTreeContextMenuProps) {
  const { message } = App.useApp()
  const { t } = useTypedTranslation('fileTree')
  const { t: tc } = useTypedTranslation('common')
  const items: MenuProps['items'] = [
    ...(showCollectToWiki && onCollectToWiki
      ? [
          {
            key: 'collect-wiki',
            label: t('contextMenu.collectToWiki'),
            onClick: wrapMenuClick(onCollectToWiki)
          },
          { type: 'divider' as const }
        ]
      : []),
    {
      key: 'add-to-chat',
      label: t('contextMenu.addToChat'),
      onClick: wrapMenuClick(() => {
        onAddToChat()
        message.info(t('contextMenu.featureInDevelopment'))
      })
    },
    { type: 'divider' },
    {
      key: 'copy-path',
      label: t('contextMenu.copyPath'),
      onClick: wrapMenuClick(onCopyPath)
    },
    {
      key: 'copy-rel-path',
      label: t('contextMenu.copyRelPath'),
      onClick: wrapMenuClick(onCopyRelPath)
    },
    ...(readOnly
      ? []
      : ([
          { type: 'divider' as const },
          {
            key: 'rename',
            label: t('contextMenu.rename'),
            onClick: wrapMenuClick(onRename)
          },
          {
            key: 'delete',
            label: tc('delete'),
            danger: true,
            onClick: wrapMenuClick(onDelete)
          }
        ] as MenuProps['items']))
  ]

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
