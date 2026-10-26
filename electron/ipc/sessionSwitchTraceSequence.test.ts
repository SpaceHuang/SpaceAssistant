import { describe, expect, it } from 'vitest'
import { createSessionSwitchRequestSequence } from './sessionSwitchTraceSequence'

describe('session switch request sequence', () => {
  it('matches preload ordinals per renderer sender and restarts when its process changes', () => {
    const next = createSessionSwitchRequestSequence()
    const senderA = {}
    const senderB = {}
    expect(next(senderA, 100)).toBe(1)
    expect(next(senderA, 100)).toBe(2)
    expect(next(senderB, 100)).toBe(1)
    expect(next(senderA, 101)).toBe(1)
    expect(next(senderA, 101)).toBe(2)
  })
})
