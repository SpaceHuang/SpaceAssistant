import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { RemoteImCommonSettings } from './RemoteImCommonSettings'
import { DEFAULT_REMOTE_IM_COMMON_CONFIG } from '../../../shared/imTypes'
import configReducer from '../../store/configSlice'
import { changeAppLocale } from '../../i18n/localeSync'

function renderTab(props: {
  value?: typeof DEFAULT_REMOTE_IM_COMMON_CONFIG
  onChange?: (patch: Partial<typeof DEFAULT_REMOTE_IM_COMMON_CONFIG>) => void
  onAllowRemoteBrowserSessionsChange?: (enabled: boolean) => void
}) {
  const store = configureStore({ reducer: { config: configReducer } })
  render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <RemoteImCommonSettings
            value={props.value ?? DEFAULT_REMOTE_IM_COMMON_CONFIG}
            onChange={props.onChange ?? vi.fn()}
            allowRemoteBrowserSessions={false}
            onAllowRemoteBrowserSessionsChange={props.onAllowRemoteBrowserSessionsChange ?? vi.fn()}
          />
        </App>
      </ConfigProvider>
    </Provider>
  )
  return store
}

describe('RemoteImCommonSettings', () => {
  beforeEach(async () => {
    await changeAppLocale('zh-CN')
  })

  it('renders shared remote IM controls', async () => {
    renderTab({})

    expect(await screen.findByText('允许远程会话使用浏览器')).toBeTruthy()
    expect(await screen.findByText('收到远程指令时发送系统通知')).toBeTruthy()
    expect(screen.getByText(/会话续接/)).toBeTruthy()
    expect(screen.getByText('远程默认模型')).toBeTruthy()
    expect(screen.getByText('远程进展同步')).toBeTruthy()
    expect(screen.getByText('限制远程写入与出站')).toBeTruthy()
    expect(screen.getByText('禁止远程出站（微信发送 / 飞书写工具）')).toBeTruthy()
    expect(screen.getByText(/消息频率限制/)).toBeTruthy()
    expect(screen.getByText('已绑定发送者（只读）')).toBeTruthy()
    // P4：确认/信任管理项降级为「工具与安全」快捷入口
    expect(screen.getByText('远程确认开关与链路硬约束已迁移到「工具与安全」页统一管理。')).toBeTruthy()
    expect(screen.queryByText('允许远程指令执行本地文件写操作')).toBeNull()
    expect(screen.queryByText('远程浏览器导航需确认')).toBeNull()
  })

  it('shortcut navigates to tools security sub tab', async () => {
    const store = renderTab({})
    fireEvent.click(await screen.findByRole('button', { name: '前往「工具与安全」' }))
    expect(store.getState().config.settingsActiveTab).toBe('tools')
    expect(store.getState().config.settingsToolsSubTab).toBe('security')
  })

  it('calls onChange when notify checkbox is toggled', async () => {
    const onChange = vi.fn()
    renderTab({
      value: { ...DEFAULT_REMOTE_IM_COMMON_CONFIG, remoteNotifyOnReceive: true },
      onChange
    })

    fireEvent.click(await screen.findByText('收到远程指令时发送系统通知'))
    expect(onChange).toHaveBeenCalledWith({ remoteNotifyOnReceive: false })
  })

  it('calls onAllowRemoteBrowserSessionsChange when browser switch is toggled', async () => {
    const onAllowRemoteBrowserSessionsChange = vi.fn()
    renderTab({ onAllowRemoteBrowserSessionsChange })

    const switches = screen.getAllByRole('switch')
    fireEvent.click(switches[0]!)
    expect(onAllowRemoteBrowserSessionsChange).toHaveBeenCalledWith(true)
  })
})
