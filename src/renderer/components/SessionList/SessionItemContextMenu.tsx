import { Dropdown } from 'antd'
import type { MenuInfo, MenuProps } from 'antd/es/menu/interface'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

function wrapMenuClick(handler: () => void): (info: MenuInfo) => void {
  return ({ domEvent }) => {
    domEvent.stopPropagation()
    domEvent.preventDefault()
    handler()
  }
}

interface SessionItemContextMenuProps {
  onRename: () => void
  children: React.ReactNode
  /** For testing only - controls dropdown open state */
  open?: boolean
}

export function SessionItemContextMenu({ onRename, children, open }: SessionItemContextMenuProps) {
  const { t } = useTypedTranslation('common')
  const items: MenuProps['items'] = [
    {
      key: 'rename',
      label: t('session.rename.menuItem'),
      onClick: wrapMenuClick(onRename)
    }
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
      <div className="session-item-context-trigger">{children}</div>
    </Dropdown>
  )
}
