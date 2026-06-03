import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { App, ConfigProvider } from 'antd'
import configReducer from '../../store/configSlice'
import chatReducer from '../../store/chatSlice'
import sessionReducer from '../../store/sessionSlice'
import { WorkDirSelector } from './WorkDirSelector'

const profiles = [
  { id: 'p1', name: 'Project A', path: '/a', isDefault: true },
  { id: 'p2', name: 'Project B', path: '/b' }
]

function renderSelector(preloaded?: Partial<{ chatStatus: string }>) {
  const store = configureStore({
    reducer: { config: configReducer, chat: chatReducer, session: sessionReducer },
    preloadedState: {
      config: {
        config: {
          workDir: '/a',
          workDirProfiles: profiles,
          activeWorkDirProfileId: 'p1'
        },
        settingsOpen: false,
        aboutOpen: false
      },
      chat: {
        currentSessionId: null,
        messages: [],
        chatStatus: preloaded?.chatStatus ?? 'idle',
        error: null,
        runningSessions: {},
        confirmFocusToolUseId: null,
        scrollToMessageId: null
      },
      session: { list: [], loading: false }
    } as never
  })

  return { store, ...render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <WorkDirSelector />
        </App>
      </ConfigProvider>
    </Provider>
  ) }
}

describe('WorkDirSelector', () => {
  beforeEach(() => {
    vi.stubGlobal('api', {
      workdirSwitch: vi.fn().mockResolvedValue({ success: true, sessions: [] }),
      configGet: vi.fn().mockResolvedValue({
        workDir: '/a',
        workDirProfiles: profiles,
        activeWorkDirProfileId: 'p1'
      })
    })
  })

  it('显示当前目录名称', () => {
    renderSelector()
    expect(screen.getByText(/Project A/)).toBeTruthy()
  })

  it('点击「设置工作目录...」打开设置通用页且不切换目录', async () => {
    const { store } = renderSelector()
    fireEvent.mouseDown(screen.getByRole('combobox', { name: '切换工作目录' }))
    fireEvent.click(await screen.findByRole('button', { name: '设置工作目录...' }))
    expect(store.getState().config.settingsOpen).toBe(true)
    expect(store.getState().config.settingsActiveTab).toBe('general')
    expect(window.api.workdirSwitch).not.toHaveBeenCalled()
  })

  it('空列表时显示配置提示', () => {
    const store = configureStore({
      reducer: { config: configReducer, chat: chatReducer, session: sessionReducer },
      preloadedState: {
        config: {
          config: { workDir: '', workDirProfiles: [], activeWorkDirProfileId: '' },
          settingsOpen: false,
          aboutOpen: false
        },
        chat: {
          currentSessionId: null,
          messages: [],
          chatStatus: 'idle',
          error: null,
          runningSessions: {},
          confirmFocusToolUseId: null,
          scrollToMessageId: null
        },
        session: { list: [], loading: false }
      } as never
    })
    render(
      <Provider store={store}>
        <ConfigProvider>
          <App>
            <WorkDirSelector />
          </App>
        </ConfigProvider>
      </Provider>
    )
    expect(screen.getByText('请先配置工作目录')).toBeTruthy()
  })
})
