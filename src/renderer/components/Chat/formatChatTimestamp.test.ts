import { describe, expect, it } from 'vitest'
import { formatChatTimestamp } from './formatChatTimestamp'

describe('formatChatTimestamp', () => {
  it('shows time only for today', () => {
    const now = Date.now()
    const formatted = formatChatTimestamp(now)
    expect(formatted).toMatch(/\d/)
    expect(formatted).not.toMatch(/\//)
  })

  it('shows date for older messages', () => {
    const old = new Date('2020-01-15T10:30:00').getTime()
    const formatted = formatChatTimestamp(old)
    expect(formatted).toMatch(/1/)
  })
})
