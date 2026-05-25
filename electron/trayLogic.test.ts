import { describe, expect, it, vi } from 'vitest'
import {
  buildTrayMenuTemplate,
  handleShowMainWindow,
  setupWindowCloseHandler,
  shouldHideOnClose,
  TRAY_TOOLTIP
} from './trayLogic'

describe('buildTrayMenuTemplate', () => {
  it('builds menu with open, separator, and quit', () => {
    const showMainWindow = vi.fn()
    const quitApp = vi.fn()
    const template = buildTrayMenuTemplate({ showMainWindow, quitApp })

    expect(template).toHaveLength(3)
    expect(template[0].label).toBe('打开主窗口')
    expect(template[1].type).toBe('separator')
    expect(template[2].label).toBe('退出')

    template[0].click?.()
    expect(showMainWindow).toHaveBeenCalledOnce()

    template[2].click?.()
    expect(quitApp).toHaveBeenCalledOnce()
  })
})

describe('TRAY_TOOLTIP', () => {
  it('is SpaceAssistant', () => {
    expect(TRAY_TOOLTIP).toBe('SpaceAssistant')
  })
})

describe('handleShowMainWindow', () => {
  it('shows and focuses hidden window', async () => {
    const win = {
      isDestroyed: () => false,
      isVisible: () => false,
      show: vi.fn(),
      focus: vi.fn()
    }
    const createMainWindow = vi.fn()

    await handleShowMainWindow(() => win, createMainWindow)

    expect(win.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(createMainWindow).not.toHaveBeenCalled()
  })

  it('only focuses visible window', async () => {
    const win = {
      isDestroyed: () => false,
      isVisible: () => true,
      show: vi.fn(),
      focus: vi.fn()
    }
    const createMainWindow = vi.fn()

    await handleShowMainWindow(() => win, createMainWindow)

    expect(win.show).not.toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(createMainWindow).not.toHaveBeenCalled()
  })

  it('creates window when none exists', async () => {
    const createMainWindow = vi.fn().mockResolvedValue(undefined)

    await handleShowMainWindow(() => null, createMainWindow)

    expect(createMainWindow).toHaveBeenCalledOnce()
  })

  it('creates window when existing is destroyed', async () => {
    const win = {
      isDestroyed: () => true,
      isVisible: () => false,
      show: vi.fn(),
      focus: vi.fn()
    }
    const createMainWindow = vi.fn().mockResolvedValue(undefined)

    await handleShowMainWindow(() => win, createMainWindow)

    expect(createMainWindow).toHaveBeenCalledOnce()
  })
})

describe('shouldHideOnClose', () => {
  it('returns true when not quitting and tray enabled', () => {
    expect(shouldHideOnClose(false, true)).toBe(true)
  })

  it('returns false when quitting', () => {
    expect(shouldHideOnClose(true, true)).toBe(false)
  })

  it('returns false when tray disabled', () => {
    expect(shouldHideOnClose(false, false)).toBe(false)
  })
})

describe('setupWindowCloseHandler', () => {
  it('prevents close and hides when tray active and not quitting', () => {
    const hide = vi.fn()
    const preventDefault = vi.fn()
    let closeHandler: ((e: { preventDefault: () => void }) => void) | undefined

    const win = {
      hide,
      on: vi.fn((event: string, handler: (e: { preventDefault: () => void }) => void) => {
        if (event === 'close') closeHandler = handler
      })
    }

    setupWindowCloseHandler(win, () => false, () => true)
    closeHandler?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalledOnce()
    expect(hide).toHaveBeenCalledOnce()
  })

  it('does not intercept close when quitting', () => {
    const hide = vi.fn()
    const preventDefault = vi.fn()
    let closeHandler: ((e: { preventDefault: () => void }) => void) | undefined

    const win = {
      hide,
      on: vi.fn((_event: string, handler: (e: { preventDefault: () => void }) => void) => {
        closeHandler = handler
      })
    }

    setupWindowCloseHandler(win, () => true, () => true)
    closeHandler?.({ preventDefault })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })

  it('does not intercept close when tray disabled', () => {
    const hide = vi.fn()
    const preventDefault = vi.fn()
    let closeHandler: ((e: { preventDefault: () => void }) => void) | undefined

    const win = {
      hide,
      on: vi.fn((_event: string, handler: (e: { preventDefault: () => void }) => void) => {
        closeHandler = handler
      })
    }

    setupWindowCloseHandler(win, () => false, () => false)
    closeHandler?.({ preventDefault })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(hide).not.toHaveBeenCalled()
  })
})
