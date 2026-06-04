import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { App } from 'antd'
import { changeAppLocale } from '../../i18n/localeSync'
import configReducer from '../../store/configSlice'
import { FeishuRemoteStatusBar } from './FeishuRemoteStatusBar'
import { type FeishuHealthCheck } from '../../../shared/feishuTypes'

vi.mock('./useFeishuRemoteDisplayStatus', () => ({
  useFeishuRemoteDisplayStatus: vi.fn()
}))

vi.mock('../Config/FeishuAuditDrawer', () => ({
  FeishuAuditDrawer: ({ open }: { open: boolean }) => (open ? <div data-testid="feishu-audit-drawer" /> : null)
}))

import { useFeishuRemoteDisplayStatus } from './useFeishuRemoteDisplayStatus'
import { openSettings } from '../../store/configSlice'

const mockHook = vi.mocked(useFeishuRemoteDisplayStatus)

const baseHealth: FeishuHealthCheck = {
  cli: { installed: true, nodeAvailable: true, npmAvailable: true },
  event: { state: 'stopped', processedCount: 0 },
  pendingConfirms: 0
}

function renderBar() {
  const store = configureStore({ reducer: { config: configReducer } })
  return {
    store,
    ...render(
      <Provider store={store}>
        <App>
          <FeishuRemoteStatusBar />
        </App>
      </Provider>
    )
  }
}

describe('FeishuRemoteStatusBar', () => {
  const start = vi.fn()
  const stop = vi.fn()

  beforeEach(async () => {
    await changeAppLocale('zh-CN')
    start.mockReset()
    stop.mockReset()
    mockHook.mockReturnValue({
      status: {
        displayState: 'stopped',
        subtextKey: 'serviceStopped',
        startEnabled: true,
        stopEnabled: false,
        eventStatus: { state: 'stopped', processedCount: 0 },
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

  it('renders main label from status (zh-CN)', () => {
    renderBar()
    expect(screen.getByText('已停止')).toBeDefined()
    expect(screen.getByText('服务已停止')).toBeDefined()
  })

  it('renders main label from status (en-US)', async () => {
    await changeAppLocale('en-US')
    renderBar()
    expect(screen.getByText('Stopped')).toBeDefined()
    expect(screen.getByText('Service stopped')).toBeDefined()
  })

  it('dispatches openSettings with feishu tab when main area clicked', () => {
    const { store } = renderBar()
    fireEvent.click(screen.getByText('已停止').closest('.feishu-remote-status-main')!)
    const state = store.getState()
    expect(state.config.settingsOpen).toBe(true)
    expect(state.config.settingsActiveTab).toBe('feishu')
  })

  it('calls start without opening settings', () => {
    const { store } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: '启动飞书远程指令监听' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(store.getState().config.settingsOpen).toBe(false)
  })

  it('opens audit drawer without opening settings', async () => {
    const { store } = renderBar()
    fireEvent.click(screen.getByRole('button', { name: '打开飞书操作记录' }))
    expect(store.getState().config.settingsOpen).toBe(false)
    await waitFor(() => {
      expect(screen.getByTestId('feishu-audit-drawer')).toBeDefined()
    })
  })

  it('shows only start when stopped and start enabled', () => {
    renderBar()
    expect(screen.getByRole('button', { name: '启动飞书远程指令监听' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '停止飞书远程指令监听' })).toBeNull()
  })

  it('shows only stop when listening', () => {
    mockHook.mockReturnValue({
      status: {
        displayState: 'listening',
        subtextKey: 'connecting',
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
    renderBar()
    expect(screen.getByRole('button', { name: '停止飞书远程指令监听' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '启动飞书远程指令监听' })).toBeNull()
  })

  it('disables start button while action loading', () => {
    mockHook.mockReturnValue({
      status: {
        displayState: 'stopped',
        subtextKey: 'serviceStopped',
        startEnabled: true,
        stopEnabled: false,
        eventStatus: { state: 'stopped', processedCount: 0 },
        health: baseHealth
      },
      actionLoading: 'start',
      refresh: vi.fn(),
      start,
      stop
    })
    renderBar()
    expect(screen.getByRole('button', { name: '启动飞书远程指令监听' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '停止飞书远程指令监听' })).toBeNull()
  })

  it('shows error label and only stop when error with both actions allowed', () => {
    mockHook.mockReturnValue({
      status: {
        displayState: 'error',
        startEnabled: true,
        stopEnabled: true,
        tooltipData: { lastError: '连接超时', processedCount: 0 },
        eventStatus: { state: 'error', processedCount: 0, lastError: '连接超时' },
        health: baseHealth
      },
      actionLoading: null,
      refresh: vi.fn(),
      start,
      stop
    })
    renderBar()
    expect(screen.getByText('出错')).toBeDefined()
    expect(screen.getByRole('button', { name: '停止飞书远程指令监听' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '启动飞书远程指令监听' })).toBeNull()
  })
})

describe('openSettings action', () => {
  it('sets tab when provided', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(openSettings({ tab: 'feishu' }))
    expect(store.getState().config.settingsOpen).toBe(true)
    expect(store.getState().config.settingsActiveTab).toBe('feishu')
  })

  it('sets tools sub tab when provided', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(openSettings({ tab: 'tools', toolsSubTab: 'browser' }))
    expect(store.getState().config.settingsActiveTab).toBe('tools')
    expect(store.getState().config.settingsToolsSubTab).toBe('browser')
  })

  it('maps browser tab to tools browser sub tab', () => {
    const store = configureStore({ reducer: { config: configReducer } })
    store.dispatch(openSettings({ tab: 'browser' }))
    expect(store.getState().config.settingsActiveTab).toBe('tools')
    expect(store.getState().config.settingsToolsSubTab).toBe('browser')
  })
})
