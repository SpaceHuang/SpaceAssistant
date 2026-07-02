import { Dropdown } from 'antd'
import type { MenuProps } from 'antd/es/menu/interface'

interface Props {
  items: MenuProps['items']
  open: boolean
  x: number
  y: number
  onClose: () => void
}

/** 在固定坐标展示文件树右键菜单（整行委托触发） */
export function FileTreeContextMenuOverlay({ items, open, x, y, onClose }: Props) {
  return (
    <Dropdown
      menu={{ items }}
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      trigger={['contextMenu']}
      getPopupContainer={() => document.body}
      popupRender={(menu) => (
        <div
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {menu}
        </div>
      )}
    >
      <div
        className="file-tree-context-menu-anchor"
        style={{ position: 'fixed', left: x, top: y, width: 0, height: 0 }}
        aria-hidden
      />
    </Dropdown>
  )
}
