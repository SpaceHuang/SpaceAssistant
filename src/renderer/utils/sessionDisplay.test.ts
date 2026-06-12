import { describe, expect, it } from 'vitest'
import {
  sessionDisplayName,
  sessionListEmptyDescription,
  truncateSessionTitle
} from './sessionDisplay'

describe('sessionDisplay', () => {
  it('sessionDisplayName falls back for empty titles', () => {
    expect(sessionDisplayName('')).toBe('未命名会话')
    expect(sessionDisplayName('  ')).toBe('未命名会话')
    expect(sessionDisplayName('我的会话')).toBe('我的会话')
  })

  it('sessionDisplayName falls back when name equals session id', () => {
    expect(sessionDisplayName('abc-123', 'abc-123')).toBe('未命名会话')
  })

  it('truncateSessionTitle truncates long strings', () => {
    const long = 'a'.repeat(60)
    expect(truncateSessionTitle(long)).toHaveLength(49)
    expect(truncateSessionTitle(long).endsWith('…')).toBe(true)
  })

  it('sessionListEmptyDescription distinguishes search vs empty', () => {
    expect(sessionListEmptyDescription(0, false)).toContain('新会话')
    expect(sessionListEmptyDescription(5, true)).toBe('没有匹配的会话')
  })
})
