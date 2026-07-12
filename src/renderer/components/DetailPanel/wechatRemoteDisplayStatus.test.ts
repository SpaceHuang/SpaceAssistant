import { describe, expect, it } from 'vitest'
import { DEFAULT_WECHAT_CONFIG } from '../../../shared/wechatTypes'
import { resolveWeChatRemoteDisplayStatus } from './wechatRemoteDisplayStatus'

function readyConfig(over: Partial<typeof DEFAULT_WECHAT_CONFIG> = {}) {
  return { ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true, remoteEnabled: true, ...over }
}

describe('resolveWeChatRemoteDisplayStatus', () => {
  it('shows unconfigured when not enabled and not logged in', () => {
    const r = resolveWeChatRemoteDisplayStatus(
      { ...DEFAULT_WECHAT_CONFIG, enabled: false, remoteEnabled: false },
      { loggedIn: false, pollState: 'stopped' }
    )
    expect(r.displayState).toBe('unconfigured')
    expect(r.subtextKey).toBe('goToSettings')
  })

  it('shows listening when polling', () => {
    const r = resolveWeChatRemoteDisplayStatus(readyConfig(), {
      loggedIn: true,
      pollState: 'polling',
      processedCount: 5
    })
    expect(r.displayState).toBe('listening')
    expect(r.stopEnabled).toBe(true)
    expect(r.subtextKey).toBe('processedCount')
  })

  it('shows stopped when remote disabled', () => {
    const r = resolveWeChatRemoteDisplayStatus(readyConfig({ remoteEnabled: false }), {
      loggedIn: true,
      pollState: 'stopped'
    })
    expect(r.displayState).toBe('stopped')
    expect(r.subtextKey).toBe('remoteOff')
  })
})
