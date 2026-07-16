import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { Menu } from 'antd'
import type { MenuProps } from 'antd'

interface Props {
  items: MenuProps['items']
  open: boolean
  x: number
  y: number
  onClose: () => void
}

const MENU_PANEL_CLASS = 'file-tree-context-menu-panel'

/** 在固定坐标展示文件树右键菜单 */
export function FileTreeContextMenuOverlay({ items, open, x, y, onClose }: Props) {
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest(`.${MENU_PANEL_CLASS}`)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onScroll = () => onClose()
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, onClose])

  if (!open || !items?.length) return null

  return createPortal(
    <Menu
      className={MENU_PANEL_CLASS}
      items={items}
      style={{ position: 'fixed', left: x, top: y, zIndex: 1200, minWidth: 168 }}
      onClick={() => onClose()}
    />,
    document.body
  )
}
