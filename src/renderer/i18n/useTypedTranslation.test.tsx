import { beforeEach, describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
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

  it('keeps a stable t reference across rerenders', () => {
    const { result, rerender } = renderHook(() => useTypedTranslation('common'))
    const first = result.current.t
    rerender()
    rerender()
    expect(result.current.t).toBe(first)
    expect(result.current.t('cancel')).toBe('取消')
  })

  it('changes the t reference and translations after a language switch', async () => {
    const { result } = renderHook(() => useTypedTranslation('common'))
    const before = result.current.t
    await act(async () => { await changeAppLocale('en-US') })
    expect(result.current.t).not.toBe(before)
    expect(result.current.t('cancel')).toBe('Cancel')
  })
})
