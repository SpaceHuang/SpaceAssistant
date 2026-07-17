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

  it('exposes stable artifact-management failures', () => {
    expect(ErrorCodes.ARTIFACT_PATH_TYPE_CONFLICT).toBe('ARTIFACT_PATH_TYPE_CONFLICT')
    expect(ErrorCodes.ARTIFACT_WORKSPACE_UNAVAILABLE).toBe('ARTIFACT_WORKSPACE_UNAVAILABLE')
    expect(ErrorCodes.ARTIFACT_WORKSPACE_CHANGED).toBe('ARTIFACT_WORKSPACE_CHANGED')
    expect(ErrorCodes.ARTIFACT_DECISION_INVALID).toBe('ARTIFACT_DECISION_INVALID')
    expect(ErrorCodes.ARTIFACT_DECISION_ALREADY_CONSUMED).toBe('ARTIFACT_DECISION_ALREADY_CONSUMED')
    expect(ErrorCodes.ARTIFACT_EXPLICIT_PATH_UNRESOLVED).toBe('ARTIFACT_EXPLICIT_PATH_UNRESOLVED')
  })
})
