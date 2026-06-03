import { describe, expect, it, vi } from 'vitest'

// Mock i18next 为固定 locale，使用 getter 支持动态切换
const mockLanguage = { current: 'zh-CN' }
vi.mock('i18next', () => ({
  default: {
    get language() { return mockLanguage.current }
  }
}))

import { formatChatTimestamp } from './formatChatTimestamp'

describe('formatChatTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-03T06:30:00Z')) // 14:30 北京时间
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('zh-CN locale', () => {
    it('shows time without AM/PM for today', () => {
      mockLanguage.current = 'zh-CN'
      const today = new Date('2026-06-03T02:00:00Z').getTime()
      const result = formatChatTimestamp(today)
      expect(result).not.toMatch(/AM|PM/i)
      expect(result).toMatch(/\d/)
    })

    it('shows date with slash for older messages', () => {
      mockLanguage.current = 'zh-CN'
      const old = new Date('2026-05-15T10:30:00Z').getTime()
      const result = formatChatTimestamp(old)
      expect(result).toMatch(/\//)
      expect(result).not.toMatch(/AM|PM/i)
    })
  })

  describe('en-US locale', () => {
    it('shows time with AM/PM for today', () => {
      mockLanguage.current = 'en-US'
      const today = new Date('2026-06-03T02:00:00Z').getTime()
      const result = formatChatTimestamp(today)
      expect(result).toMatch(/AM|PM/i)
    })

    it('shows date with slash for older messages', () => {
      mockLanguage.current = 'en-US'
      const old = new Date('2026-05-15T10:30:00Z').getTime()
      const result = formatChatTimestamp(old)
      expect(result).toMatch(/\//)
    })
  })
})