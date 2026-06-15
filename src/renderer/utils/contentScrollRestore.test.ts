import { describe, expect, it } from 'vitest'
import { restoreScroll } from './contentScrollRestore'

function mockScrollElement(overrides: Partial<HTMLElement> & Pick<HTMLElement, 'scrollHeight' | 'clientHeight'>) {
  return {
    scrollTop: 0,
    ...overrides
  } as HTMLElement
}

describe('contentScrollRestore', () => {
  it('restores scrollTop when not near bottom', () => {
    const el = mockScrollElement({ scrollHeight: 1000, clientHeight: 400, scrollTop: 120 })
    const snap = { element: el, scrollTop: 120, distanceFromBottom: 480 }
    el.scrollTop = 0
    restoreScroll(snap, 50)
    expect(el.scrollTop).toBe(120)
  })

  it('scrolls to bottom when near bottom before sync', () => {
    const el = mockScrollElement({ scrollHeight: 1200, clientHeight: 400, scrollTop: 0 })
    const snap = { element: el, scrollTop: 760, distanceFromBottom: 40 }
    restoreScroll(snap, 50)
    expect(el.scrollTop).toBe(800)
  })
})
