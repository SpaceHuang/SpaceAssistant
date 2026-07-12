import { describe, expect, it } from 'vitest'
import {
  formatWeChatPollError,
  isWeChatPollStartFailed,
  resolveWeChatPollBadgeStatus,
  resolveWeChatPollStatusText
} from './wechatPollFeedback'
import type { WeChatConnectionStatus } from '../../shared/wechatTypes'

const t = (key: string, opts?: Record<string, unknown>) => {
  if (key === 'settings.wechat.sessionExpired') return 'session expired'
  if (key === 'settings.wechat.listenFailedDetail') return `failed: ${opts?.detail}`
  if (key === 'settings.wechat.listenFailed') return 'listen failed'
  if (key === 'settings.wechat.statusListening') return 'listening'
  if (key === 'settings.wechat.statusError') return 'error'
  if (key === 'settings.wechat.statusStopped') return 'stopped'
  return key
}

describe('wechatPollFeedback', () => {
  it('detects poll start failure from error state', () => {
    expect(isWeChatPollStartFailed({ loggedIn: true, pollState: 'error', lastError: 'boom' })).toBe(true)
    expect(isWeChatPollStartFailed({ loggedIn: true, pollState: 'polling' })).toBe(false)
  })

  it('formats session expired error', () => {
    const status: WeChatConnectionStatus = { loggedIn: true, pollState: 'error', lastError: 'session_expired' }
    expect(formatWeChatPollError(status, t)).toBe('session expired')
  })

  it('shows error status text when lastError present', () => {
    expect(
      resolveWeChatPollStatusText({ loggedIn: true, pollState: 'stopped', lastError: 'x' }, t)
    ).toBe('error')
  })

  it('uses success badge when polling and processing when connecting', () => {
    expect(resolveWeChatPollBadgeStatus({ loggedIn: true, pollState: 'polling' })).toBe('success')
    expect(resolveWeChatPollBadgeStatus({ loggedIn: true, pollState: 'connecting' })).toBe('processing')
    expect(resolveWeChatPollBadgeStatus({ loggedIn: true, pollState: 'error' })).toBe('error')
  })
})
