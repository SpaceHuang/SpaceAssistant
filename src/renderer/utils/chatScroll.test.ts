import { describe, expect, it } from 'vitest'
import { isChatScrollNearBottom } from './chatScroll'

describe('isChatScrollNearBottom', () => {
  it('returns true when within threshold of bottom', () => {
    const el = {
      scrollHeight: 1000,
      scrollTop: 880,
      clientHeight: 100
    } as HTMLElement
    expect(isChatScrollNearBottom(el, 120)).toBe(true)
  })

  it('returns false when user scrolled up', () => {
    const el = {
      scrollHeight: 1000,
      scrollTop: 100,
      clientHeight: 100
    } as HTMLElement
    expect(isChatScrollNearBottom(el, 120)).toBe(false)
  })
})
