import { describe, expect, it, vi } from 'vitest'
import { formatChatTimestamp } from './formatChatTimestamp'

vi.mock('i18next', () => ({
  default: {
    get language(): string {
      return (globalThis as any).__currentLocale || 'zh-CN'
    }
  }
}))

function setLocale(locale: string) {
  ;(globalThis as any).__currentLocale = locale
}

describe('formatChatTimestamp', () => {
  it('zh-CN today (no AM/PM)', () => {
    setLocale('zh-CN')
    const now = new Date()
    now.setHours(14, 30, 0, 0)
    const formatted = formatChatTimestamp(now.getTime())
    expect(formatted).toMatch(/14:30/)
    expect(formatted).not.toMatch(/[AaPp][Mm]/)
  })

  it('zh-CN older (slash, no AM/PM)', () => {
    setLocale('zh-CN')
    const old = new Date('2020-01-15T14:30:00').getTime()
    const formatted = formatChatTimestamp(old)
    expect(formatted).toMatch(/\//)
    expect(formatted).not.toMatch(/[AaPp][Mm]/)
  })

  it('en-US today (has AM/PM)', () => {
    setLocale('en-US')
    const now = new Date()
    now.setHours(14, 30, 0, 0)
    const formatted = formatChatTimestamp(now.getTime())
    expect(formatted).toMatch(/[Pp][Mm]/)
  })

  it('en-US older (slash)', () => {
    setLocale('en-US')
    const old = new Date('2020-01-15T14:30:00').getTime()
    const formatted = formatChatTimestamp(old)
    expect(formatted).toMatch(/\//)
  })
})
