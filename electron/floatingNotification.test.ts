import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false },
  screen: {
    getPrimaryDisplay: vi.fn(),
    getDisplayMatching: vi.fn()
  },
  BrowserWindow: vi.fn()
}))

import { screen } from 'electron'
import { calculateFloatingWindowPosition, getFloatingNotificationDevUrl } from './floatingNotification'

describe('calculateFloatingWindowPosition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should position window at bottom-right of workArea with 20px margin', () => {
    const mockDisplay = {
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }
    };
    (screen.getPrimaryDisplay as ReturnType<typeof vi.fn>).mockReturnValue(mockDisplay)

    const pos = calculateFloatingWindowPosition()

    expect(pos.x).toBe(1920 - 280 - 20)
    expect(pos.y).toBe(1040 - 108 - 20)
  })

  it('should account for taskbar offset in workArea', () => {
    const mockDisplay = {
      workArea: { x: 0, y: 0, width: 1920, height: 1000 }
    };
    (screen.getPrimaryDisplay as ReturnType<typeof vi.fn>).mockReturnValue(mockDisplay)

    const pos = calculateFloatingWindowPosition()

    expect(pos.x).toBe(1920 - 280 - 20)
    expect(pos.y).toBe(1000 - 108 - 20)
  })

  it('should handle non-zero workArea origin', () => {
    const mockDisplay = {
      workArea: { x: 100, y: 50, width: 1600, height: 900 }
    };
    (screen.getPrimaryDisplay as ReturnType<typeof vi.fn>).mockReturnValue(mockDisplay)

    const pos = calculateFloatingWindowPosition()

    expect(pos.x).toBe(100 + 1600 - 280 - 20)
    expect(pos.y).toBe(50 + 900 - 108 - 20)
  })

  it('should use the display matching the anchor window', () => {
    const mockDisplay = {
      workArea: { x: 1920, y: 0, width: 1920, height: 1040 }
    };
    (screen.getDisplayMatching as ReturnType<typeof vi.fn>).mockReturnValue(mockDisplay)

    const pos = calculateFloatingWindowPosition({
      isDestroyed: () => false,
      getBounds: () => ({ x: 2000, y: 100, width: 1200, height: 800 })
    } as never)

    expect(screen.getDisplayMatching).toHaveBeenCalled()
    expect(pos.x).toBe(1920 + 1920 - 280 - 20)
    expect(pos.y).toBe(1040 - 108 - 20)
  })
})

describe('getFloatingNotificationDevUrl', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('should default to vite dev server page', () => {
    delete process.env.ELECTRON_START_URL
    delete process.env.VITE_DEV_SERVER_PORT

    expect(getFloatingNotificationDevUrl()).toBe('http://127.0.0.1:9240/floating-notification.html')
  })

  it('should normalize ELECTRON_START_URL without trailing slash', () => {
    process.env.ELECTRON_START_URL = 'http://127.0.0.1:9240'

    expect(getFloatingNotificationDevUrl()).toBe('http://127.0.0.1:9240/floating-notification.html')
  })
})
