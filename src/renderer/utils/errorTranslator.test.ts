import { describe, expect, it } from 'vitest'
import i18n from '../i18n'
import { changeAppLocale } from '../i18n/localeSync'
import { LOCALE_STORAGE_KEY } from '../../shared/locale'
import { translateError } from './errorTranslator'
import { ErrorCodes } from '../../shared/errorCodes'

describe('translateError', () => {
  it('returns zh-CN messages', async () => {
    await changeAppLocale('zh-CN')
    expect(translateError({ code: ErrorCodes.FILE_NOT_FOUND })).toBe('文件未找到')
    expect(translateError({ code: ErrorCodes.BROWSER_REMOTE_DISABLED })).toContain('远程会话')
    expect(translateError({ code: ErrorCodes.BROWSER_FEISHU_REMOTE_DISABLED })).toContain('远程会话')
    expect(translateError({ code: ErrorCodes.API_KEY_NOT_CONFIGURED })).toBe('API Key 未配置')
  })

  it('returns en-US messages', async () => {
    await changeAppLocale('en-US')
    expect(translateError({ code: ErrorCodes.FILE_NOT_FOUND })).toBe('File not found')
    expect(translateError({ code: ErrorCodes.TARGET_NOT_DIRECTORY })).toBe('Target path is not a directory')
    expect(translateError({ code: ErrorCodes.WINDOW_NOT_READY })).toBe('Window is not ready')
  })

  it('falls back to error code for unknown codes', async () => {
    await changeAppLocale('en-US')
    expect(translateError({ code: 'UNKNOWN_CODE_XYZ' })).toBe('UNKNOWN_CODE_XYZ')
  })
})

describe('language switch integration', () => {
  it('updates i18next and localStorage', async () => {
    await changeAppLocale('en-US')
    expect(i18n.language).toBe('en-US')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en-US')

    await changeAppLocale('zh-CN')
    expect(i18n.language).toBe('zh-CN')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN')
  })
})
