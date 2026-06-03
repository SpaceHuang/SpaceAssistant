import { beforeEach, describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTypedTranslation } from './useTypedTranslation'
import { changeAppLocale } from './localeSync'

describe('useTypedTranslation', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('returns translated strings for common namespace', () => {
    const { result } = renderHook(() => useTypedTranslation('common'))
    expect(result.current.t('cancel')).toBe('取消')
    expect(result.current.t('settings.general')).toBe('通用')
  })

  it('returns translated strings for config namespace', () => {
    const { result } = renderHook(() => useTypedTranslation('config'))
    expect(result.current.t('language.label')).toBe('界面语言')
  })
})
