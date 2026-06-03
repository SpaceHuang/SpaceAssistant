import { describe, expect, it } from 'vitest'
import { changeAppLocale } from '../i18n/localeSync'
import { ErrorCodes } from '../../shared/errorCodes'
import { formatUserFacingError } from './formatUserFacingError'

describe('formatUserFacingError', () => {
  it('translates error codes in zh-CN', async () => {
    await changeAppLocale('zh-CN')
    expect(formatUserFacingError(ErrorCodes.INVALID_PATH)).toBe('路径无效')
  })

  it('translates error codes in en-US', async () => {
    await changeAppLocale('en-US')
    expect(formatUserFacingError(ErrorCodes.INVALID_PATH)).toBe('Invalid path')
  })

  it('parses code|param interpolation', async () => {
    await changeAppLocale('zh-CN')
    expect(formatUserFacingError(`${ErrorCodes.SHELL_PROCESS_EXIT_CODE}|42`)).toBe('进程退出码 42')
    await changeAppLocale('en-US')
    expect(formatUserFacingError(`${ErrorCodes.SHELL_PROCESS_EXIT_CODE}|42`)).toBe('Process exited with code 42')
  })

  it('returns legacy free text unchanged', async () => {
    await changeAppLocale('en-US')
    expect(formatUserFacingError('自定义错误')).toBe('自定义错误')
  })

  it('handles empty input', () => {
    expect(formatUserFacingError(undefined)).toBe('')
    expect(formatUserFacingError('')).toBe('')
  })
})
