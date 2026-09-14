import { describe, expect, it } from 'vitest'
import { ErrorCodes, errorCodeOf, isErrorCode, splitCodedError } from './errorCodes'

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

describe('errorCodeOf', () => {
  it('extracts the code from a coded error message', () => {
    expect(errorCodeOf('SKILL_NAME_CONFLICT: 用户级目录下已存在 Skill「alpha」')).toBe(ErrorCodes.SKILL_NAME_CONFLICT)
  })

  it('accepts a bare code', () => {
    expect(errorCodeOf(ErrorCodes.FILE_NOT_FOUND)).toBe(ErrorCodes.FILE_NOT_FOUND)
  })

  it('prefers the pipe separator, matching the renderer error pipeline', () => {
    expect(errorCodeOf('SKILL_NAME_CONFLICT|detail: with colon')).toBe(ErrorCodes.SKILL_NAME_CONFLICT)
  })

  it('returns null for uncoded text', () => {
    expect(errorCodeOf('路径无效')).toBeNull()
    expect(errorCodeOf('NOT_A_REAL_CODE: x')).toBeNull()
    expect(errorCodeOf('')).toBeNull()
  })
})

describe('splitCodedError', () => {
  it('splits the code from its detail text', () => {
    expect(splitCodedError('SKILL_NAME_CONFLICT: 用户级目录下已存在 Skill「alpha」')).toEqual({
      code: ErrorCodes.SKILL_NAME_CONFLICT,
      detail: '用户级目录下已存在 Skill「alpha」'
    })
  })

  it('supports the pipe separator and reports an empty detail for bare codes', () => {
    expect(splitCodedError('SKILL_URL_INVALID|../x')).toEqual({ code: ErrorCodes.SKILL_URL_INVALID, detail: '../x' })
    expect(splitCodedError('FILE_NOT_FOUND')).toEqual({ code: ErrorCodes.FILE_NOT_FOUND, detail: '' })
  })

  it('returns null when no known code is present', () => {
    expect(splitCodedError('NOT_A_REAL_CODE: x')).toBeNull()
    expect(splitCodedError('   ')).toBeNull()
  })
})
