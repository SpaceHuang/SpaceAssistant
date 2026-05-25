export const TRAY_TOOLTIP = 'SpaceAssistant'

export interface TrayMenuActions {
  showMainWindow: () => void | Promise<void>
  quitApp: () => void
}

export interface TrayMenuItemShape {
  label?: string
  type?: string
  click?: () => void
}

export function buildTrayMenuTemplate(actions: TrayMenuActions): TrayMenuItemShape[] {
  return [
    { label: '打开主窗口', click: () => void actions.showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => actions.quitApp() }
  ]
}

export interface MainWindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  focus(): void
}

export async function handleShowMainWindow(
  getMainWindow: () => MainWindowLike | null,
  createMainWindow: () => void | Promise<void>
): Promise<void> {
  const win = getMainWindow()
  if (win && !win.isDestroyed()) {
    if (!win.isVisible()) win.show()
    win.focus()
    return
  }
  await createMainWindow()
}

export interface CloseEventLikeWindow {
  hide(): void
  on(event: 'close', listener: (e: CloseEventLike) => void): void
}

export interface CloseEventLike {
  preventDefault(): void
}

export function shouldHideOnClose(isQuitting: boolean, trayEnabled: boolean): boolean {
  return !isQuitting && trayEnabled
}

export function setupWindowCloseHandler(
  win: CloseEventLikeWindow,
  getIsQuitting: () => boolean,
  isTrayEnabled: () => boolean
): void {
  win.on('close', (e: CloseEventLike) => {
    if (shouldHideOnClose(getIsQuitting(), isTrayEnabled())) {
      e.preventDefault()
      win.hide()
    }
  })
}
