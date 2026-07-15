import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { RemoteImCommonSettings } from './RemoteImCommonSettings'
import { DEFAULT_REMOTE_IM_COMMON_CONFIG } from '../../../shared/imTypes'
import { changeAppLocale } from '../../i18n/localeSync'

describe('RemoteImCommonSettings', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('renders shared remote IM controls', async () => {
    render(
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={DEFAULT_REMOTE_IM_COMMON_CONFIG}
            onChange={vi.fn()}
            allowRemoteBrowserSessions={false}
            onAllowRemoteBrowserSessionsChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    )

    expect(await screen.findByText('允许远程会话使用浏览器')).toBeTruthy()
    expect(await screen.findByText('收到远程指令时发送系统通知')).toBeTruthy()
    expect(screen.getByText(/会话续接/)).toBeTruthy()
    expect(screen.getByText('远程默认模型')).toBeTruthy()
    expect(screen.getByText('远程进展同步')).toBeTruthy()
    expect(screen.getByText('限制远程写入与出站')).toBeTruthy()
    expect(screen.getByText('允许远程指令执行本地文件写操作')).toBeTruthy()
    expect(screen.getByText('禁止远程出站（微信发送 / 飞书写工具）')).toBeTruthy()
    expect(screen.getByText('远程「未发现已知高风险模式」的脚本仍需确认')).toBeTruthy()
    expect(screen.getByText('远程浏览器导航需确认')).toBeTruthy()
    expect(screen.getByText('远程浏览器页面操作需确认')).toBeTruthy()
    expect(screen.getByText(/消息频率限制/)).toBeTruthy()
    expect(screen.getByText('已绑定发送者（只读）')).toBeTruthy()
  })

  it('calls onChange when notify checkbox is toggled', async () => {
    const onChange = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={{ ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteNotifyOnReceive: true }}
            onChange={onChange}
            allowRemoteBrowserSessions={false}
            onAllowRemoteBrowserSessionsChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    )

    fireEvent.click(await screen.findByText('收到远程指令时发送系统通知'))
    expect(onChange).toHaveBeenCalledWith({ remoteNotifyOnReceive: false })
  })

  it('calls onChange when allow-local-write checkbox is toggled', async () => {
    const onChange = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={{ ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteAllowLocalWrite: true }}
            onChange={onChange}
            allowRemoteBrowserSessions={false}
            onAllowRemoteBrowserSessionsChange={vi.fn()}
          />
        </App>
      </ConfigProvider>
    )

    fireEvent.click(await screen.findByText('允许远程指令执行本地文件写操作'))
    expect(onChange).toHaveBeenCalledWith({ remoteAllowLocalWrite: false })
  })

  it('calls onAllowRemoteBrowserSessionsChange when browser switch is toggled', async () => {
    const onAllowRemoteBrowserSessionsChange = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={DEFAULT_REMOTE_IM_COMMON_CONFIG}
            onChange={vi.fn()}
            allowRemoteBrowserSessions={false}
            onAllowRemoteBrowserSessionsChange={onAllowRemoteBrowserSessionsChange}
          />
        </App>
      </ConfigProvider>
    )

    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0]!)
    expect(onAllowRemoteBrowserSessionsChange).toHaveBeenCalledWith(true)
  })
})
