import { describe, expect, it } from 'vitest'
import { shouldShowLegacyWriteDirUi } from './legacyWriteDirUi'

describe('shouldShowLegacyWriteDirUi', () => {
  it('hides legacy write-dir UI when artifact management is enabled', () => {
    expect(shouldShowLegacyWriteDirUi(true, true)).toBe(false)
  })

  it('shows legacy write-dir UI only for legacy sessions with workspace layout enabled', () => {
    expect(shouldShowLegacyWriteDirUi(true, false)).toBe(true)
    expect(shouldShowLegacyWriteDirUi(true, undefined)).toBe(true)
    expect(shouldShowLegacyWriteDirUi(false, false)).toBe(false)
  })
})
