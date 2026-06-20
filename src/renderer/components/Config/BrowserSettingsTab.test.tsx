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
import { changeAppLocale } from '../../i18n/localeSync'

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
  beforeEach(async () => {
    vi.clearAllMocks()
    await changeAppLocale('zh-CN')
  })

  it('shows repair button without full install steps when deps missing (zh-CN)', async () => {
    renderTab()
    expect(await screen.findByRole('button', { name: '帮我修复' })).toBeTruthy()
    expect(screen.queryByText('安装步骤')).toBeNull()
    expect(screen.queryByText('复制全部步骤')).toBeNull()
  })

  it('shows repair button without full install steps when deps missing (en-US)', async () => {
    await changeAppLocale('en-US')
    renderTab()
    expect(await screen.findByRole('button', { name: 'Help me fix' })).toBeTruthy()
    expect(screen.queryByText('安装步骤')).toBeNull()
    expect(screen.queryByText('复制全部步骤')).toBeNull()
  })

  it('creates session and launch intent on repair click (zh-CN)', async () => {
    const store = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: '帮我修复' }))
    await waitFor(() => {
      expect(window.api.sessionCreate).toHaveBeenCalled()
      expect(store.getState().chatLaunch.intent?.sessionId).toBe('new-session')
    })
    expect(store.getState().config.settingsOpen).toBe(false)
  })

  it('creates session and launch intent on repair click (en-US)', async () => {
    await changeAppLocale('en-US')
    const store = renderTab()
    fireEvent.click(await screen.findByRole('button', { name: 'Help me fix' }))
    await waitFor(() => {
      expect(window.api.sessionCreate).toHaveBeenCalled()
      expect(store.getState().chatLaunch.intent?.sessionId).toBe('new-session')
    })
    expect(store.getState().config.settingsOpen).toBe(false)
  })

  it('adds trusted domain via input and supports batch delete', async () => {
    const onChange = vi.fn()
    const store = configureStore({
      reducer: {
        config: configReducer,
        chat: chatReducer,
        session: sessionReducer,
        chatLaunch: chatLaunchReducer,
        browserDetect: browserDetectReducer
      }
    })
    window.api = {
      ...window.api,
      browserDetect: vi.fn().mockResolvedValue(detectMissing)
    } as typeof window.api

    render(
      <Provider store={store}>
        <ConfigProvider>
          <App>
            <BrowserSettingsTab
              browser={{ ...DEFAULT_BROWSER_CONFIG, trustedDomains: ['github.com', 'example.com'] }}
              onChange={onChange}
              active={false}
            />
          </App>
        </ConfigProvider>
      </Provider>
    )

    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Select all' })[0]!)
    fireEvent.click(screen.getAllByRole('button', { name: '批量删除' })[0]!)
    expect(onChange).toHaveBeenCalled()
    const next = onChange.mock.calls.at(-1)?.[0] as typeof DEFAULT_BROWSER_CONFIG
    expect(next.trustedDomains).toEqual([])

    fireEvent.change(screen.getAllByPlaceholderText('例：example.com')[0]!, {
      target: { value: 'docs.github.com' }
    })
    fireEvent.click(screen.getAllByRole('button', { name: /添/ })[0]!)
    expect(onChange).toHaveBeenCalled()
    const added = onChange.mock.calls.at(-1)?.[0] as typeof DEFAULT_BROWSER_CONFIG
    expect(added.trustedDomains).toContain('docs.github.com')
  })
})
