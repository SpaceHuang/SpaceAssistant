import { describe, expect, it } from 'vitest'
import { sessionDisplayNameRaw } from './sessionDisplay'

describe('sessionDisplayNameRaw', () => {
  it('returns empty string when name is missing', () => {
    expect(sessionDisplayNameRaw(undefined, 'session-1')).toBe('')
    expect(sessionDisplayNameRaw('  ', 'session-1')).toBe('')
  })

  it('returns empty string when name equals session id', () => {
    expect(sessionDisplayNameRaw('session-1', 'session-1')).toBe('')
  })

  it('returns trimmed user title', () => {
    expect(sessionDisplayNameRaw('  我的会话  ', 'session-1')).toBe('我的会话')
  })
})
