import { afterEach, describe, expect, it } from 'vitest'
import { isImAutoReviewTestModeEnabled, setImAutoReviewTestModeEnabled } from './imAutoReviewTestMode'

afterEach(() => { setImAutoReviewTestModeEnabled(false, false) })

describe('IM auto-review development test mode', () => {
  it('is process-local and can be enabled only in unpackaged builds', () => {
    expect(isImAutoReviewTestModeEnabled()).toBe(false)
    expect(setImAutoReviewTestModeEnabled(true, false)).toBe(true)
    expect(isImAutoReviewTestModeEnabled()).toBe(true)
    expect(() => setImAutoReviewTestModeEnabled(false, true)).toThrow('IM_AUTO_REVIEW_TEST_MODE_UNAVAILABLE')
    expect(isImAutoReviewTestModeEnabled()).toBe(true)
  })
})
