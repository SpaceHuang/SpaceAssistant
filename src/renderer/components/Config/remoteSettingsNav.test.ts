import { describe, expect, it } from 'vitest'
import { isRemoteSettingsKey, REMOTE_SETTINGS_KEYS } from './remoteSettingsNav'

describe('remoteSettingsNav', () => {
  it('groups the common IM, Feishu, and WeChat settings in order', () => {
    expect(REMOTE_SETTINGS_KEYS).toEqual(['remoteIm', 'feishu', 'wechat'])
    expect(REMOTE_SETTINGS_KEYS.every(isRemoteSettingsKey)).toBe(true)
    expect(isRemoteSettingsKey('tools')).toBe(false)
  })
})
