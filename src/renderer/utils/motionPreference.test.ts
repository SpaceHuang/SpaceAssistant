import { describe, expect, it, vi, afterEach } from 'vitest'
import { prefersReducedMotion, scrollBehaviorPreference, scrollIntoViewWithMotionPreference } from './motionPreference'

describe('motionPreference', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns false when matchMedia is unavailable', () => {
    const original = window.matchMedia
    // @ts-expect-error test stub
    window.matchMedia = undefined
    expect(prefersReducedMotion()).toBe(false)
    window.matchMedia = original
  })

  it('prefers auto scroll when reduced motion is enabled', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
    expect(scrollBehaviorPreference('smooth')).toBe('auto')
  })

  it('keeps smooth scroll when reduced motion is disabled', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
    expect(scrollBehaviorPreference('smooth')).toBe('smooth')
  })

  it('passes reduced motion behavior to scrollIntoView', () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: true,
      media: '',
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn()
    })
    const el = document.createElement('div')
    const scrollIntoView = vi.fn()
    el.scrollIntoView = scrollIntoView
    scrollIntoViewWithMotionPreference(el, { block: 'center', behavior: 'smooth' })
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
  })
})
