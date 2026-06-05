import { describe, expect, it } from 'vitest'
import { changeAppLocale } from '../../i18n/localeSync'
import { formatFeishuSettingsEventStatus } from './feishuEventStatusText'
import i18n from '../../i18n'

describe('formatFeishuSettingsEventStatus', () => {
  it('formats badge in Chinese', async () => {
    await changeAppLocale('zh-CN')
    const t = i18n.getFixedT('zh-CN', 'config')
    expect(formatFeishuSettingsEventStatus({ state: 'connecting', processedCount: 3 }, t)).toBe(
      '正在连接 · 已处理 3'
    )
  })

  it('formats badge in English', async () => {
    await changeAppLocale('en-US')
    const t = i18n.getFixedT('en-US', 'config')
    expect(formatFeishuSettingsEventStatus({ state: 'connected', processedCount: 5 }, t)).toBe(
      'Connected · Processed 5'
    )
  })
})
