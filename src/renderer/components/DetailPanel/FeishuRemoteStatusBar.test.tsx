import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { App } from 'antd'
import { changeAppLocale } from '../../i18n/localeSync'
import configReducer from '../../store/configSlice'
import { RemoteStatusBar } from './RemoteStatusBar'
import { type FeishuHealthCheck } from '../../../shared/feishuTypes'

vi.mock('./useFeishuRemoteDisplayStatus', () => ({
  useFeishuRemoteDisplayStatus: vi.fn()
}))

vi.mock('./useWeChatRemoteDisplayStatus', () => ({
  useWeChatRemoteDisplayStatus: vi.fn()
}))

vi.mock('./RemoteAuditDrawer', () => ({
  RemoteAuditDrawer: ({ open }: { open: boolean }) => (open ? <div data-testid="remote-audit-drawer" /> : null)
}))

import { useFeishuRemoteDisplayStatus } from './useFeishuRemoteDisplayStatus'
import { useWeChatRemoteDisplayStatus } from './useWeChatRemoteDisplayStatus'
import { openSettings } from '../../store/configSlice'

const mockFeishuHook = vi.mocked(useFeishuRemoteDisplayStatus)
const mockWechatHook = vi.mocked(useWeChatRemoteDisplayStatus)

const baseHealth: FeishuHealthCheck = {
  cli: { installed: true, nodeAvailable: true, npmAvailable: true },
  event: { state: 'stopped', processedCount: 0 },
  pendingConfirms: 0
}

const wechatStopped = {
  displayState: 'stopped' as const,
  startEnabled: false,
  stopEnabled: false,
  connectionStatus: { loggedIn: false, pollState: 'stopped' as const }
}

function renderBar() {
  const store = configureStore({
    reducer: { config: configReducer },
    preloadedState: {
      config: {
        config: {
          feishu: { enabled: true },
          wechat: { enabled: false }
        },
        settingsOpen: false
      }
    }
  })
  return {
    store,
    ...render(
      <Provider store={store}>
        <App>
          <RemoteStatusBar />
        </App>
      </Provider>
    )
  }
}

describe('RemoteStatusBar', () => {
  const start = vi.fn()
  const stop = vi.fn()

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    start.mockReset()
    stop.mockReset()
    mockWechatHook.mockReturnValue({
      status: wechatStopped,
      actionLoading: null,
      refresh: vi.fn(),
      start: vi.fn(),
      stop: vi.fn()
    })
    mockFeishuHook.mockReturnValue({
      status: {
        displayState: 'listening',
        subtextKey: 'processedCount',
        subtextParams: { count: 1 },
        startEnabled: false,
        stopEnabled: true,
        eventStatus: { state: 'connected', processedCount: 1 },
        health: baseHealth
      },
      actionLoading: null,
      refresh: vi.fn(),
      start,
      stop
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('renders feishu channel when listening', () => {
    renderBar()
    expect(screen.getByText('飞书')).toBeDefined()
    expect(screen.getByText('监听中')).toBeDefined()
  })

  it('dispatches openSettings with feishu tab when main area clicked', () => {
    const { store } = renderBar()
    fireEvent.click(screen.getByText('监听中').closest('.remote-status-main')!)
    const state = store.getState()
    expect(state.config.settingsOpen).toBe(true)
    expect(state.config.settingsActiveTab).toBe('feishu')
  })

  it('calls stop without opening settings', () => {
    const { store } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: '停止远程监听' }))
    expect(stop).toHaveBeenCalledTimes(1)
    expect(store.getState().config.settingsOpen).toBe(false)
  })

  it('opens audit drawer without opening settings', async () => {
    const { store } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: '打开远程操作记录' }))
    expect(store.getState().config.settingsOpen).toBe(false)
    await waitFor(() => {
      expect(screen.getByTestId('remote-audit-drawer')).toBeDefined()
    })
  })
})

describe('openSettings action', () => {
  it('sets wechat tab when provided', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(openSettings({ tab: 'wechat' }))
    expect(store.getState().config.settingsOpen).toBe(true)
    expect(store.getState().config.settingsActiveTab).toBe('wechat')
  })
})
