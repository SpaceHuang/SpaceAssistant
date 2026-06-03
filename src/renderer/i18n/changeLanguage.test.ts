import { describe, expect, it } from 'vitest'
import i18n from './index'
import { changeAppLocale } from './localeSync'

describe('changeLanguage performance', () => {
  it('switches language in under 200ms', async () => {
    await changeAppLocale('zh-CN')
    const start = performance.now()
    await changeAppLocale('en-US')
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(200)
    expect(i18n.language).toBe('en-US')
  })
})
