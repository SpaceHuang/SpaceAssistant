import { describe, expect, it } from 'vitest'
import { ErrorCodes, isErrorCode } from './errorCodes'

describe('isErrorCode', () => {
  it('recognizes defined codes', () => {
    expect(isErrorCode(ErrorCodes.FILE_NOT_FOUND)).toBe(true)
    expect(isErrorCode(ErrorCodes.API_KEY_NOT_CONFIGURED)).toBe(true)
  })

  it('rejects unknown strings', () => {
    expect(isErrorCode('NOT_A_REAL_CODE')).toBe(false)
    expect(isErrorCode('路径无效')).toBe(false)
  })
})
