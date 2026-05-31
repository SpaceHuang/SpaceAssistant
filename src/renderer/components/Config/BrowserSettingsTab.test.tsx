import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserSettingsTab } from './BrowserSettingsTab'
import configReducer from '../../store/configSlice'
import chatReducer from '../../store/chatSlice'
import sessionReducer from '../../store/sessionSlice'
import chatLaunchReducer from '../../store/chatLaunchSlice'
import browserDetectReducer from '../../store/browserDetectSlice'
import { DEFAULT_BROWSER_CONFIG } from '../../../shared/domainTypes'
import type { BrowserDetectResult } from '../../../shared/browserTypes'

const detectMissing: BrowserDetectResult = {
  stagehand: { installed: true, version: '3.0.0' },
  playwright: { installed: true, browsers: ['chromium'] },
  chromium: { ready: false },
  node: { version: 'v22.0.0', meetsRequirement: true },
  canInitialize: false,
  primaryFailure: 'chromium_missing',
  errors: ['Chromium 浏览器未安装'],
  recommendedCwd: 'E:\\Develop\\SpaceAssistant',
  installContext: 'development'
}

function renderTab(active = true) {
  const store = configureStore({
    reducer: {
      config: configReducer,
      chat: chatReducer,
      session: sessionReducer,
      chatLaunch: chatLaunchReducer,
      browserDetect: browserDetectReducer
    }
  })
  const onChange = vi.fn()
  window.api = {
    ...window.api,
    browserDetect: vi.fn().mockResolvedValue(detectMissing),
    sessionCreate: vi.fn().mockResolvedValue({
      id: 'new-session',
      name: '网络访问修复',
      skillsState: { manualActivated: [], manualDisabled: [] },
      metadata: {}
    })
  } as typeof window.api

  render(
    <Provider store={store}>
      <ConfigProvider>
        <App>
          <BrowserSettingsTab browser={DEFAULT_BROWSER_CONFIG} onChange={onChange} active={active} />
        </App>
      </ConfigProvider>
    </Provider>
  )
  return store
}

describe('BrowserSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows repair button without full install steps when deps missing', async () => {
    renderTab()
    expect(await screen.findByRole('button', { name: '帮我修复' })).toBeTruthy()
    expect(screen.queryByText('安装步骤')).toBeNull()
    expect(screen.queryByText('复制全部步骤')).toBeNull()
  })

  it('creates session and launch intent on repair click', async () => {
    const store = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '帮我修复' }))
    await waitFor(() => {
      expect(window.api.sessionCreate).toHaveBeenCalled()
      expect(store.getState().chatLaunch.intent?.sessionId).toBe('new-session')
    })
    expect(store.getState().config.settingsOpen).toBe(false)
  })
})
