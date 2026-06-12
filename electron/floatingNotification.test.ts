import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  screen: {
    getPrimaryDisplay: vi.fn()
  },
  BrowserWindow: vi.fn()
}))

import { screen } from 'electron'
import { calculateFloatingWindowPosition } from './floatingNotification'

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
})
