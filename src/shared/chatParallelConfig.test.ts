import { describe, expect, it } from 'vitest'
import { clampMaxParallelChatSessions, DEFAULT_MAX_PARALLEL_CHAT_SESSIONS } from './chatParallelConfig'

describe('clampMaxParallelChatSessions', () => {
  it('returns default for invalid', () => {
    expect(clampMaxParallelChatSessions(undefined)).toBe(DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
    expect(clampMaxParallelChatSessions('x')).toBe(DEFAULT_MAX_PARALLEL_CHAT_SESSIONS)
  })

  it('clamps to range', () => {
    expect(clampMaxParallelChatSessions(0)).toBe(1)
    expect(clampMaxParallelChatSessions(99)).toBe(10)
    expect(clampMaxParallelChatSessions(3.7)).toBe(4)
  })
})
