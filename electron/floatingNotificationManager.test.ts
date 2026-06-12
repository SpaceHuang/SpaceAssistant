import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: vi.fn(),
  screen: {
    getPrimaryDisplay: vi.fn(() => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }
    }))
  }
}))

vi.mock('./floatingNotification', () => ({
  calculateFloatingWindowPosition: vi.fn(() => ({ x: 1620, y: 912 })),
  createFloatingNotificationWindow: vi.fn(() => ({
    isDestroyed: vi.fn(() => false),
    destroy: vi.fn(),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    moveTop: vi.fn(),
    webContents: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isLoading: vi.fn(() => false),
      once: vi.fn()
    }
  })),
  destroyFloatingNotificationWindow: vi.fn(),
  pushDataToFloatingWindow: vi.fn(),
  sendCloseToFloatingWindow: vi.fn()
}))

vi.mock('./database', () => ({
  getSession: vi.fn(() => ({ id: 's1', name: '测试会话' }))
}))

import { FloatingNotificationManager } from './floatingNotificationManager'
import {
  createFloatingNotificationWindow,
  destroyFloatingNotificationWindow,
  pushDataToFloatingWindow,
  sendCloseToFloatingWindow
} from './floatingNotification'

function createMockMainWindow(overrides: Partial<{
  isDestroyed: boolean
  isVisible: boolean
  isMinimized: boolean
  isFocused: boolean
}> = {}) {
  return {
    isDestroyed: () => overrides.isDestroyed ?? false,
    isVisible: () => overrides.isVisible ?? true,
    isMinimized: () => overrides.isMinimized ?? false,
    isFocused: () => overrides.isFocused ?? true
  } as any
}

function createManager(mainWin: any = createMockMainWindow()) {
  return new FloatingNotificationManager(
    () => mainWin,
    '/fake/mainDirname',
    {} as any
  )
}

const TEST_ENTRY = {
  sessionId: 'session-1',
  sessionName: '测试会话',
  toolUseId: 'tool-1',
  toolName: 'run_shell',
  input: { command: 'npm install' },
  requestId: 'req-1',
  createdAt: Date.now()
}

describe('FloatingNotificationManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('evaluate - show notification', () => {
    it('should show notification when window is hidden and pending items exist', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)

      expect(createFloatingNotificationWindow).toHaveBeenCalled()
      expect(pushDataToFloatingWindow).toHaveBeenCalled()
    })

    it('should show notification when window is minimized and pending items exist', () => {
      const mainWin = createMockMainWindow({ isMinimized: true })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)

      expect(createFloatingNotificationWindow).toHaveBeenCalled()
    })

    it('should show notification when window is not focused and pending items exist', () => {
      const mainWin = createMockMainWindow({ isFocused: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)

      expect(createFloatingNotificationWindow).toHaveBeenCalled()
    })
  })

  describe('evaluate - hide notification', () => {
    it('should NOT show notification when window is visible and focused with pending items', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)

      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()
    })

    it('should close notification when all pending items are resolved', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.onToolResult('req-1', 'tool-1')

      vi.advanceTimersByTime(500)
      expect(sendCloseToFloatingWindow).toHaveBeenCalled()
    })

    it('should close notification when main window gets focus', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.onMainWindowFocus()

      expect(sendCloseToFloatingWindow).toHaveBeenCalled()
    })

    it('should not reopen after user resolved confirm and main window hides', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.onReturnToMain()
      manager.onToolResult('req-1', 'tool-1')
      vi.clearAllMocks()

      mainWin.isVisible = () => false
      mainWin.isFocused = () => false
      manager.onMainWindowHide()

      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()
    })

    it('should not reopen after chat abort clears all pending for request', () => {
      const mainWin = createMockMainWindow({ isVisible: false, isFocused: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.onAllCancelledForRequest('req-1')
      vi.clearAllMocks()

      manager.onMainWindowHide()

      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()
    })
  })

  describe('debounce', () => {
    it('should debounce blur event by 2 seconds', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()

      // Simulate window losing focus
      mainWin.isFocused = () => false
      manager.onMainWindowBlur()
      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()

      vi.advanceTimersByTime(2000)
      expect(createFloatingNotificationWindow).toHaveBeenCalled()
    })

    it('should cancel blur timer if window refocused', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      mainWin.isFocused = () => false
      manager.onMainWindowBlur()
      manager.onMainWindowFocus()

      vi.advanceTimersByTime(2000)
      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()
    })

    it('should debounce close by 500ms when pending items become empty', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.onToolResult('req-1', 'tool-1')

      expect(sendCloseToFloatingWindow).not.toHaveBeenCalled()
      expect(destroyFloatingNotificationWindow).not.toHaveBeenCalled()

      vi.advanceTimersByTime(500)
      expect(sendCloseToFloatingWindow).toHaveBeenCalled()
      expect(destroyFloatingNotificationWindow).toHaveBeenCalled()
    })
  })

  describe('dismiss', () => {
    it('should destroy floating window and suppress re-show until new confirm', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      expect(createFloatingNotificationWindow).toHaveBeenCalledTimes(1)

      manager.dismiss()

      expect(sendCloseToFloatingWindow).toHaveBeenCalled()
      expect(destroyFloatingNotificationWindow).toHaveBeenCalled()

      vi.clearAllMocks()
      manager.onMainWindowBlur()
      vi.advanceTimersByTime(2000)
      expect(createFloatingNotificationWindow).not.toHaveBeenCalled()
    })

    it('should show again after dismiss when a new confirm arrives', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.dismiss()

      vi.clearAllMocks()
      manager.onConfirmRequest({
        ...TEST_ENTRY,
        toolUseId: 'tool-2',
        requestId: 'req-2',
        createdAt: Date.now() + 1
      })

      expect(createFloatingNotificationWindow).toHaveBeenCalled()
      expect(pushDataToFloatingWindow).toHaveBeenCalled()
    })
  })

  describe('onReturnToMain', () => {
    it('should destroy floating window without suppressing future show', () => {
      const mainWin = createMockMainWindow({ isVisible: false })
      const manager = createManager(mainWin)

      manager.onConfirmRequest(TEST_ENTRY)
      manager.onReturnToMain()

      expect(sendCloseToFloatingWindow).toHaveBeenCalled()
      expect(destroyFloatingNotificationWindow).toHaveBeenCalled()

      vi.clearAllMocks()
      manager.onMainWindowBlur()
      vi.advanceTimersByTime(2000)
      expect(createFloatingNotificationWindow).toHaveBeenCalled()
    })

    it('should close test notification when returning to main', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.showTestNotification()
      manager.onReturnToMain()

      expect(destroyFloatingNotificationWindow).toHaveBeenCalled()
    })
  })

  describe('showTestNotification', () => {
    it('should create window and push mock data immediately when page is loaded', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.showTestNotification()

      expect(createFloatingNotificationWindow).toHaveBeenCalled()
      expect(pushDataToFloatingWindow).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          totalSessions: 2,
          totalItems: 3,
          latestItem: expect.objectContaining({
            sessionName: '测试会话',
            toolName: 'run_shell'
          })
        })
      )
    })

    it('should keep test window visible when main window is focused', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.showTestNotification()
      vi.clearAllMocks()

      manager.onMainWindowFocus()

      expect(sendCloseToFloatingWindow).not.toHaveBeenCalled()
      expect(destroyFloatingNotificationWindow).not.toHaveBeenCalled()
    })

    it('should push again on ready when page is still loading', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.showTestNotification()
      vi.clearAllMocks()

      manager.onNotificationReady()
      expect(pushDataToFloatingWindow).toHaveBeenCalled()
    })
  })
})
