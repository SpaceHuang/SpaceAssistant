import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { App, ConfigProvider } from 'antd'
import { WeChatSettingsTab } from './WeChatSettingsTab'
import { DEFAULT_WECHAT_CONFIG } from '../../../shared/wechatTypes'
import { changeAppLocale } from '../../i18n/localeSync'

describe('WeChatSettingsTab', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    window.api = {
      ...window.api,
      wechatDetectSdk: vi.fn().mockResolvedValue({ available: true, version: '2.2.0' }),
      wechatConnectionStatus: vi.fn().mockResolvedValue({ loggedIn: false, pollState: 'stopped' }),
      wechatOnQrUrl: vi.fn(() => () => undefined),
      wechatOnLoginProgress: vi.fn(() => () => undefined),
      wechatOnInboundMessage: vi.fn(() => () => undefined),
      wechatOnPollingStats: vi.fn(() => () => undefined)
    } as typeof window.api
  })

  it('renders bind button when not logged in', async () => {
    render(
      <ConfigProvider>
        <App>
          <WeChatSettingsTab wechat={DEFAULT_WECHAT_CONFIG} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    expect(await screen.findByRole('button', { name: '绑定微信' })).toBeTruthy()
    expect(screen.getByText('通过微信遥控桌面 Agent')).toBeTruthy()
  })

  it('shows bound status and audit when logged in', async () => {
    window.api.wechatConnectionStatus = vi.fn().mockResolvedValue({
      loggedIn: true,
      pollState: 'stopped',
      displayName: 'TestUser'
    })
    render(
      <ConfigProvider>
        <App>
          <WeChatSettingsTab
            wechat={{ ...DEFAULT_WECHAT_CONFIG, loggedIn: true, displayName: 'TestUser' }}
            onChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    )
    expect(await screen.findByText(/已绑定/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '查看操作记录' })).toBeTruthy()
    expect(screen.queryByText('收到消息时弹窗通知')).toBeNull()
    expect(screen.queryByText('安全设置')).toBeNull()
  })

  it('restores the bound account allowlist from live connection status when config state is stale', async () => {
    window.api.wechatConnectionStatus = vi.fn().mockResolvedValue({
      loggedIn: true,
      boundUserId: 'bound-user@wechat',
      pollState: 'polling'
    })
    const onChange = vi.fn()
    const Harness = () => {
      const [wechat, setWechat] = useState({ ...DEFAULT_WECHAT_CONFIG, loggedIn: true, remoteEnabled: true })
      return <WeChatSettingsTab wechat={wechat} onChange={(next) => { onChange(next); setWechat(next) }} />
    }

    render(
      <ConfigProvider>
        <App>
          <Harness />
        </App>
      </ConfigProvider>
    )

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
        remoteSenderAllowlist: ['bound-user@wechat']
      }))
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(window.api.wechatDetectSdk).toHaveBeenCalledTimes(2)
  })

  it('does not start polling again when login confirmation arrives', async () => {
    let emitProgress: Parameters<typeof window.api.wechatOnLoginProgress>[0] | undefined
    const pollStart = vi.fn().mockResolvedValue({ loggedIn: true, pollState: 'polling' })
    window.api.wechatPollStart = pollStart
    window.api.wechatOnLoginProgress = vi.fn((callback) => {
      emitProgress = callback
      return () => undefined
    })

    render(
      <ConfigProvider>
        <App>
          <WeChatSettingsTab wechat={DEFAULT_WECHAT_CONFIG} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )
    await screen.findByRole('button', { name: '绑定微信' })

    await act(async () => {
      emitProgress?.({ stage: 'confirmed' })
    })

    expect(pollStart).not.toHaveBeenCalled()
  })
})
