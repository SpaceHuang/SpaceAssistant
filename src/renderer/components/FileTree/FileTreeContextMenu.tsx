import { Dropdown, message } from 'antd'
import type { MenuProps } from 'antd'
import copyLineRaw from '../../assets/copy_line.svg?raw'
import deleteLineRaw from '../../assets/delete_line.svg?raw'
import pencilLineRaw from '../../assets/pencil_line.svg?raw'

const patchSvg = (raw: string) =>
  raw.replace(/fill="#09244B"/g, 'fill="currentColor"').replace(/width="24"/, 'width="1em"').replace(/height="24"/, 'height="1em"')

const copySvg = patchSvg(copyLineRaw)
const deleteSvg = patchSvg(deleteLineRaw)
const pencilSvg = patchSvg(pencilLineRaw)

const iconStyle: React.CSSProperties = { width: 14, height: 14, display: 'inline-block', verticalAlign: '-2px', marginRight: 6 }

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
  relPath, name, isDirectory, onAddToChat, onCopyPath, onCopyRelPath, onRename, onDelete, children, open
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
      icon: <span dangerouslySetInnerHTML={{ __html: copySvg }} style={iconStyle} />,
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
      icon: <span dangerouslySetInnerHTML={{ __html: pencilSvg }} style={iconStyle} />,
      onClick: onRename
    },
    {
      key: 'delete',
      label: '删除',
      danger: true,
      icon: <span dangerouslySetInnerHTML={{ __html: deleteSvg }} style={iconStyle} />,
      onClick: onDelete
    }
  ]

  return (
    <Dropdown menu={{ items }} trigger={['contextMenu']} open={open} getPopupContainer={(trigger) => trigger.parentElement || document.body}>
      {children}
    </Dropdown>
  )
}
