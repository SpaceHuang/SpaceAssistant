import { describe, expect, it } from 'vitest'
import { changeAppLocale } from '../../i18n/localeSync'
import { wechatRemoteLabel, resolveWeChatDisplayText } from './wechatDisplayText'
import { resolveWeChatRemoteDisplayStatus } from './wechatRemoteDisplayStatus'

describe('wechatDisplayText', () => {
  it('formats remote labels in zh-CN', async () => {
    await changeAppLocale('zh-CN')
    expect(wechatRemoteLabel('listening')).toBeTruthy()
    const status = resolveWeChatRemoteDisplayStatus(
      { enabled: true, loggedIn: true, remoteEnabled: true } as never,
      { loggedIn: true, pollState: 'polling', processedCount: 3 }
    )
    const text = resolveWeChatDisplayText(status)
    expect(text.label).toBeTruthy()
    expect(text.subtext).toBeTruthy()
  })
})
