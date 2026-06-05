import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockNativeTheme = vi.hoisted(() => ({
  shouldUseDarkColors: false,
  on: vi.fn()
}))

const mockGetMainWindow = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: { isPackaged: false },
  nativeTheme: mockNativeTheme
}))

vi.mock('./windowRef', () => ({
  getMainWindow: mockGetMainWindow
}))

describe('windowIcon', () => {
  beforeEach(() => {
    vi.resetModules()
    mockNativeTheme.shouldUseDarkColors = false
    mockNativeTheme.on.mockClear()
    mockGetMainWindow.mockReset()
  })

  it('resolves light icon path by default', async () => {
    const { resolveWindowIconPath } = await import('./windowIcon')
    const iconPath = resolveWindowIconPath('/app/dist-electron/electron')
    expect(iconPath.replace(/\\/g, '/')).toContain('/res/icons/sa-logo-256.png')
  })

  it('resolves dark icon path when system uses dark colors', async () => {
    mockNativeTheme.shouldUseDarkColors = true
    const { resolveWindowIconPath } = await import('./windowIcon')
    const iconPath = resolveWindowIconPath('/app/dist-electron/electron')
    expect(iconPath.replace(/\\/g, '/')).toContain('/res/icons/dark/sa-logo-dark-256.png')
  })

  it('registers nativeTheme listener once', async () => {
    const { setupWindowIconThemeListener } = await import('./windowIcon')
    setupWindowIconThemeListener('/app/dist-electron/electron')
    setupWindowIconThemeListener('/app/dist-electron/electron')
    expect(mockNativeTheme.on).toHaveBeenCalledTimes(1)
    expect(mockNativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function))
  })

  it('updates main window icon when theme changes', async () => {
    const setIcon = vi.fn()
    mockGetMainWindow.mockReturnValue({ isDestroyed: () => false, setIcon })
    const { setupWindowIconThemeListener } = await import('./windowIcon')
    setupWindowIconThemeListener('/app/dist-electron/electron')
    const handler = mockNativeTheme.on.mock.calls[0][1] as () => void
    handler()
    expect(setIcon).toHaveBeenCalledTimes(1)
  })
})
