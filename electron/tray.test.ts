import { describe, expect, it, vi, beforeEach } from 'vitest'

const mockTrayInstances: MockTray[] = []
const mockQuit = vi.fn()
const mockBuildFromTemplate = vi.fn((template: unknown[]) => template)
const mockCreateFromPath = vi.fn(() => ({
  setTemplateImage: vi.fn()
}))
const mockExistsSync = vi.fn(() => true)
const mockLogAgentEvent = vi.fn()

class MockTray {
  setToolTip = vi.fn()
  setContextMenu = vi.fn()
  on = vi.fn()
  destroy = vi.fn()
  isDestroyed = vi.fn(() => false)

  constructor(_image: unknown) {
    mockTrayInstances.push(this)
  }
}

vi.mock('fs', () => ({
  default: { existsSync: (...args: unknown[]) => mockExistsSync(...args) },
  existsSync: (...args: unknown[]) => mockExistsSync(...args)
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    quit: (...args: unknown[]) => mockQuit(...args)
  },
  Menu: {
    buildFromTemplate: (...args: unknown[]) => mockBuildFromTemplate(...args)
  },
  nativeImage: {
    createFromPath: (...args: unknown[]) => mockCreateFromPath(...args)
  },
  Tray: MockTray
}))

vi.mock('./agentLogger/agentLogger', () => ({
  logAgentEvent: (...args: unknown[]) => mockLogAgentEvent(...args)
}))

vi.mock('./trayIconPath', () => ({
  resolveTrayIconPath: vi.fn(() => '/fake/tray.ico')
}))

describe('tray module', () => {
  let deps: {
    createMainWindow: ReturnType<typeof vi.fn>
    getMainWindow: ReturnType<typeof vi.fn>
    mainDirname: string
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockTrayInstances.length = 0
    mockExistsSync.mockReturnValue(true)
    deps = {
      createMainWindow: vi.fn().mockResolvedValue(undefined),
      getMainWindow: vi.fn(() => null),
      mainDirname: '/fake/dist-electron/electron'
    }

    vi.resetModules()
    const tray = await import('./tray')
    tray.destroyTray()
  })

  async function loadTray() {
    return import('./tray')
  }

  it('initTray creates a single Tray instance', async () => {
    const { initTray, isTrayEnabled } = await loadTray()

    expect(initTray(deps)).toBe(true)
    expect(initTray(deps)).toBe(true)
    expect(mockTrayInstances).toHaveLength(1)
    expect(isTrayEnabled()).toBe(true)
  })

  it('sets tooltip to SpaceAssistant', async () => {
    const { initTray } = await loadTray()
    initTray(deps)

    expect(mockTrayInstances[0].setToolTip).toHaveBeenCalledWith('SpaceAssistant')
  })

  it('builds context menu with open, separator, and quit', async () => {
    const { initTray } = await loadTray()
    initTray(deps)

    const template = mockBuildFromTemplate.mock.calls[0][0] as Array<{
      label?: string
      type?: string
      click?: () => void
    }>
    expect(template[0].label).toBe('打开主窗口')
    expect(template[1].type).toBe('separator')
    expect(template[2].label).toBe('退出')
  })

  it('menu quit calls app.quit', async () => {
    const { initTray } = await loadTray()
    initTray(deps)

    const template = mockBuildFromTemplate.mock.calls[0][0] as Array<{ click?: () => void }>
    template[2].click?.()
    expect(mockQuit).toHaveBeenCalledOnce()
  })

  it('double-click shows main window', async () => {
    const win = {
      isDestroyed: () => false,
      isVisible: () => false,
      show: vi.fn(),
      focus: vi.fn()
    }
    deps.getMainWindow.mockReturnValue(win as never)

    const { initTray } = await loadTray()
    initTray(deps)

    const doubleClickCall = mockTrayInstances[0].on.mock.calls.find(([event]) => event === 'double-click')
    expect(doubleClickCall).toBeDefined()
    doubleClickCall![1]()

    expect(win.show).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('returns false when icon is missing', async () => {
    mockExistsSync.mockReturnValue(false)

    const { initTray, isTrayEnabled } = await loadTray()
    expect(initTray(deps)).toBe(false)
    expect(isTrayEnabled()).toBe(false)
    expect(mockTrayInstances).toHaveLength(0)
    expect(mockLogAgentEvent).toHaveBeenCalledWith(
      'error',
      'tray.init_failed',
      expect.objectContaining({ reason: 'icon_missing' })
    )
  })

  it('destroyTray destroys instance and disables tray', async () => {
    const { initTray, destroyTray, isTrayEnabled } = await loadTray()
    initTray(deps)
    destroyTray()

    expect(mockTrayInstances[0].destroy).toHaveBeenCalledOnce()
    expect(isTrayEnabled()).toBe(false)
  })

  it('destroyTray is idempotent', async () => {
    const { initTray, destroyTray } = await loadTray()
    initTray(deps)
    destroyTray()
    destroyTray()

    expect(mockTrayInstances[0].destroy).toHaveBeenCalledOnce()
  })

  it('showMainWindow delegates to createMainWindow when no window', async () => {
    const { initTray, showMainWindow } = await loadTray()
    initTray(deps)

    await showMainWindow()
    expect(deps.createMainWindow).toHaveBeenCalledOnce()
  })
})
