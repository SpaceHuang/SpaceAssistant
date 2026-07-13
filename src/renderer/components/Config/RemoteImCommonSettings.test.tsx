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
          <RemoteImCommonSettings value={DEFAULT_REMOTE_IM_COMMON_CONFIG} onChange={vi.fn()} />
        </App>
      </ConfigProvider>
    )

    expect(await screen.findByText('收到远程指令时发送系统通知')).toBeTruthy()
    expect(screen.getByText(/会话续接/)).toBeTruthy()
    expect(screen.getByText('远程默认模型')).toBeTruthy()
    expect(screen.getByText('远程进展同步')).toBeTruthy()
    expect(screen.getByText('允许远程指令执行本地文件写操作')).toBeTruthy()
    expect(screen.getByText('远程写确认策略')).toBeTruthy()
    expect(screen.getByText(/消息频率限制/)).toBeTruthy()
    expect(screen.getByText('发送者白名单')).toBeTruthy()
  })

  it('calls onChange when notify checkbox is toggled', async () => {
    const onChange = vi.fn()
    render(
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={{ ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteNotifyOnReceive: true }}
            onChange={onChange}
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
          />
        </App>
      </ConfigProvider>
    )

    fireEvent.click(await screen.findByText('允许远程指令执行本地文件写操作'))
    expect(onChange).toHaveBeenCalledWith({ remoteAllowLocalWrite: false })
  })
})
