import { describe, expect, it } from 'vitest'
import { DEFAULT_WECHAT_CONFIG, mergeWeChatConfig } from './wechatTypes'

describe('wechatTypes channel configuration', () => {
  it('keeps connection defaults and drops retired channel policy fields', () => {
    expect(DEFAULT_WECHAT_CONFIG.remoteEnabled).toBe(false)
    expect(DEFAULT_WECHAT_CONFIG).not.toHaveProperty('remoteDenyOutbound')
    const merged = mergeWeChatConfig({
      remoteConfirmPolicy: 'remote_read_only',
      remoteWechatConfirm: true
    } as never)
    expect(merged).not.toHaveProperty('remoteConfirmPolicy')
    expect(merged).not.toHaveProperty('remoteWechatConfirm')
  })

})
