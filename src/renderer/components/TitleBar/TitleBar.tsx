import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Dropdown } from 'antd'
import type { MenuProps } from 'antd'
import { useAppDispatch } from '../../hooks'
import { setAboutOpen, setSettingsOpen } from '../../store/configSlice'
import { useTypedTranslation } from '../../i18n/useTypedTranslation'

type Platform = NodeJS.Platform

function WindowControlButton({
  label,
  className,
  onClick,
  children
}: {
  label: string
  className?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button type="button" className={className} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  )
}

function TitleBarMenu({
  label,
  items
}: {
  label: string
  items: MenuProps['items']
}) {
  return (
    <Dropdown menu={{ items }} trigger={['click']} placement="bottomLeft">
      <button type="button" className="title-bar-menu-btn">
        {label}
      </button>
    </Dropdown>
  )
}

export function TitleBar() {
  const { t } = useTypedTranslation('common')
  const dispatch = useAppDispatch()
  const [platform, setPlatform] = useState<Platform>('win32')
  const [isMaximized, setIsMaximized] = useState(false)

  useEffect(() => {
    void window.api.windowGetPlatform().then(setPlatform)
    void window.api.windowIsMaximized().then(setIsMaximized)
    return window.api.windowOnMaximizeChanged(setIsMaximized)
  }, [])

  const openSettings = useCallback(() => dispatch(setSettingsOpen(true)), [dispatch])
  const openAbout = useCallback(() => dispatch(setAboutOpen(true)), [dispatch])

  const fileItems = useMemo<MenuProps['items']>(
    () => [
      platform === 'darwin'
        ? {
            key: 'close',
            label: t('menu.closeWindow'),
            onClick: () => void window.api.windowClose()
          }
        : {
            key: 'quit',
            label: t('menu.quit'),
            onClick: () => void window.api.appQuit()
          }
    ],
    [platform, t]
  )

  const viewItems = useMemo<MenuProps['items']>(
    () => [
      {
        key: 'devtools',
        label: t('menu.devTools'),
        onClick: () => void window.api.appToggleDevTools()
      },
      { type: 'divider' },
      {
        key: 'settings',
        label: t('menu.settings'),
        onClick: openSettings
      }
    ],
    [openSettings, t]
  )

  const helpItems = useMemo<MenuProps['items']>(
    () => [
      {
        key: 'about',
        label: t('menu.about'),
        onClick: openAbout
      },
      {
        key: 'docs',
        label: t('menu.docs'),
        onClick: () => void window.api.appOpenExternal('https://github.com/SpaceHuang/SpaceAssistant')
      }
    ],
    [openAbout, t]
  )

  const handleDragRegionDoubleClick = () => {
    if (platform === 'darwin') return
    void window.api.windowMaximizeToggle()
  }

  const showWindowControls = platform !== 'darwin'

  return (
    <header
      className={`title-bar${platform === 'darwin' ? ' title-bar--mac' : ''}`}
      data-platform={platform}
    >
      <div className="title-bar-leading">
        <img className="title-bar-icon" src="./favicon.png" alt="" width={16} height={16} draggable={false} />
        <nav className="title-bar-menus" aria-label={t('titleBar.menuBar')}>
          <TitleBarMenu label={t('menu.file')} items={fileItems} />
          <TitleBarMenu label={t('menu.view')} items={viewItems} />
          <TitleBarMenu label={t('menu.help')} items={helpItems} />
        </nav>
      </div>

      <div
        className="title-bar-drag"
        onDoubleClick={handleDragRegionDoubleClick}
        aria-hidden="true"
      />

      {showWindowControls ? (
        <div className="title-bar-controls">
          <WindowControlButton
            label={t('titleBar.minimize')}
            className="title-bar-control title-bar-control--minimize"
            onClick={() => void window.api.windowMinimize()}
          >
            <span aria-hidden="true" />
          </WindowControlButton>
          <WindowControlButton
            label={isMaximized ? t('titleBar.restore') : t('titleBar.maximize')}
            className={`title-bar-control title-bar-control--maximize${isMaximized ? ' is-restored' : ''}`}
            onClick={() => void window.api.windowMaximizeToggle()}
          >
            <span aria-hidden="true" />
          </WindowControlButton>
          <WindowControlButton
            label={t('titleBar.close')}
            className="title-bar-control title-bar-control--close"
            onClick={() => void window.api.windowClose()}
          >
            <span aria-hidden="true" />
          </WindowControlButton>
        </div>
      ) : null}
    </header>
  )
}
