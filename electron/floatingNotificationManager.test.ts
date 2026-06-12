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
    webContents: {
      send: vi.fn(),
      isDestroyed: vi.fn(() => false)
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

      vi.advanceTimersByTime(500)
      expect(sendCloseToFloatingWindow).toHaveBeenCalled()
    })
  })

  describe('showTestNotification', () => {
    it('should create window and push mock data on ready', () => {
      const mainWin = createMockMainWindow({ isVisible: true, isFocused: true })
      const manager = createManager(mainWin)

      manager.showTestNotification()

      // testMode: 只创建窗口，不立即推送数据
      expect(createFloatingNotificationWindow).toHaveBeenCalled()
      expect(pushDataToFloatingWindow).not.toHaveBeenCalled()

      // 渲染进程就绪后才推送
      manager.onNotificationReady()
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
  })
})
