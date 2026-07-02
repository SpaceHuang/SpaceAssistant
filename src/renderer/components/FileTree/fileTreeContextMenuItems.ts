import type { MenuProps } from 'antd/es/menu/interface'
import type { MenuInfo } from 'antd/es/menu/interface'

/** 阻止菜单点击冒泡到 Tree 节点，避免误触发文件选中/打开 */
export function wrapFileTreeMenuClick(handler: () => void): (info: MenuInfo) => void {
  return ({ domEvent }) => {
    domEvent.stopPropagation()
    domEvent.preventDefault()
    handler()
  }
}

export interface FileTreeContextMenuActionHandlers {
  onAddToChat: () => void
  onCopyPath: () => void
  onCopyRelPath: () => void
  onShowInFolder: () => void
  onRename: () => void
  onDelete: () => void
  onCollectToWiki?: () => void
  onNewSubdirectory?: () => void
  isDirectory?: boolean
  showCollectToWiki?: boolean
  readOnly?: boolean
  onAddToChatPlaceholder: () => void
  t: (key: string) => string
  tc: (key: string) => string
}

export function buildFileTreeContextMenuItems(handlers: FileTreeContextMenuActionHandlers): MenuProps['items'] {
  const {
    onAddToChat,
    onCopyPath,
    onCopyRelPath,
    onShowInFolder,
    onRename,
    onDelete,
    onCollectToWiki,
    onNewSubdirectory,
    isDirectory = false,
    showCollectToWiki = false,
    readOnly = false,
    onAddToChatPlaceholder,
    t,
    tc
  } = handlers

  return [
    ...(showCollectToWiki && onCollectToWiki
      ? [
          {
            key: 'collect-wiki',
            label: t('contextMenu.collectToWiki'),
            onClick: wrapFileTreeMenuClick(onCollectToWiki)
          },
          { type: 'divider' as const }
        ]
      : []),
    {
      key: 'add-to-chat',
      label: t('contextMenu.addToChat'),
      onClick: wrapFileTreeMenuClick(() => {
        onAddToChat()
        onAddToChatPlaceholder()
      })
    },
    { type: 'divider' },
    {
      key: 'copy-path',
      label: t('contextMenu.copyPath'),
      onClick: wrapFileTreeMenuClick(onCopyPath)
    },
    {
      key: 'copy-rel-path',
      label: t('contextMenu.copyRelPath'),
      onClick: wrapFileTreeMenuClick(onCopyRelPath)
    },
    { type: 'divider' },
    {
      key: 'show-in-folder',
      label: t('contextMenu.showInFolder'),
      onClick: wrapFileTreeMenuClick(onShowInFolder)
    },
    ...(readOnly
      ? []
      : ([
          ...(isDirectory && onNewSubdirectory
            ? [
                { type: 'divider' as const },
                {
                  key: 'new-subdirectory',
                  label: t('contextMenu.newSubdirectory'),
                  onClick: wrapFileTreeMenuClick(onNewSubdirectory)
                }
              ]
            : []),
          { type: 'divider' as const },
          {
            key: 'rename',
            label: t('contextMenu.rename'),
            onClick: wrapFileTreeMenuClick(onRename)
          },
          {
            key: 'delete',
            label: tc('delete'),
            danger: true,
            onClick: wrapFileTreeMenuClick(onDelete)
          }
        ] as MenuProps['items']))
  ]
}
