import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
    let currentConfig = { ...DEFAULT_WECHAT_CONFIG, loggedIn: true, remoteEnabled: true }
    const Harness = () => {
      const [wechat, setWechat] = useState(currentConfig)
      const updateWechat = (update: Parameters<typeof setWechat>[0]) => {
        onChange(update)
        setWechat((previous) => {
          const next = typeof update === 'function' ? update(previous) : update
          currentConfig = next
          return next
        })
      }
      return <WeChatSettingsTab wechat={wechat} onChange={updateWechat} />
    }

    render(
      <ConfigProvider>
        <App>
          <Harness />
        </App>
      </ConfigProvider>
    )

    await waitFor(() => {
      expect(currentConfig.remoteSenderAllowlist).toEqual(['bound-user@wechat'])
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

  it('preserves the confirmed enabled flags when an older status refresh resolves late', async () => {
    let resolveInitialStatus: ((status: Awaited<ReturnType<typeof window.api.wechatConnectionStatus>>) => void) | undefined
    const initialStatus = new Promise<Awaited<ReturnType<typeof window.api.wechatConnectionStatus>>>((resolve) => {
      resolveInitialStatus = resolve
    })
    window.api.wechatConnectionStatus = vi.fn()
      .mockReturnValueOnce(initialStatus)
      .mockResolvedValue({
        loggedIn: true,
        boundUserId: 'bound-user@wechat',
        pollState: 'polling'
      })
    window.api.wechatLoginStart = vi.fn().mockResolvedValue({ ok: true })

    let emitProgress: Parameters<typeof window.api.wechatOnLoginProgress>[0] | undefined
    window.api.wechatOnLoginProgress = vi.fn((callback) => {
      emitProgress = callback
      return () => undefined
    })

    let currentConfig = { ...DEFAULT_WECHAT_CONFIG }
    const Harness = () => {
      const [wechat, setWechat] = useState(currentConfig)
      const updateWechat = (update: typeof setWechat extends (value: infer T) => void ? T : never) => {
        setWechat((previous) => {
          const next = typeof update === 'function' ? update(previous) : update
          currentConfig = next
          return next
        })
      }
      return <WeChatSettingsTab wechat={wechat} onChange={updateWechat} />
    }

    render(
      <ConfigProvider>
        <App>
          <Harness />
        </App>
      </ConfigProvider>
    )
    const bindButton = await screen.findByRole('button', { name: '绑定微信' })

    await act(async () => {
      fireEvent.click(bindButton)
    })
    await waitFor(() => expect(window.api.wechatLoginStart).toHaveBeenCalled())
    await act(async () => {
      emitProgress?.({ stage: 'confirmed' })
    })
    await waitFor(() => expect(currentConfig.remoteEnabled).toBe(true))

    await act(async () => {
      resolveInitialStatus?.({
        loggedIn: true,
        boundUserId: 'bound-user@wechat',
        pollState: 'polling'
      })
    })

    await waitFor(() => {
      expect(currentConfig.loggedIn).toBe(true)
      expect(currentConfig.remoteSenderAllowlist).toEqual(['bound-user@wechat'])
    })
    expect(currentConfig.enabled).toBe(true)
    expect(currentConfig.remoteEnabled).toBe(true)
  })

  it('shows a new QR panel during rebind while the previous account remains authenticated', async () => {
    window.api.wechatConnectionStatus = vi.fn().mockResolvedValue({
      loggedIn: true,
      boundUserId: 'bound-user@wechat',
      pollState: 'stopped'
    })
    window.api.wechatLoginStop = vi.fn().mockResolvedValue({ ok: true })
    window.api.wechatLoginStart = vi.fn().mockResolvedValue({ ok: true })
    let emitQr: Parameters<typeof window.api.wechatOnQrUrl>[0] | undefined
    window.api.wechatOnQrUrl = vi.fn((callback) => {
      emitQr = callback
      return () => undefined
    })

    render(
      <ConfigProvider>
        <App>
          <WeChatSettingsTab
            wechat={{ ...DEFAULT_WECHAT_CONFIG, enabled: true, loggedIn: true }}
            onChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    )

    await screen.findByText(/已绑定/)
    fireEvent.click(screen.getByRole('button', { name: '重新绑定' }))
    await waitFor(() => expect(window.api.wechatLoginStart).toHaveBeenCalledWith({ force: true }))

    await act(async () => {
      emitQr?.({ url: 'https://example.test/wechat-qr', expired: false })
    })

    expect(await screen.findByText('等待扫描')).toBeTruthy()
  })
})
