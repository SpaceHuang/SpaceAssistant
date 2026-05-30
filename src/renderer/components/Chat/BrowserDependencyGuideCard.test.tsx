import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserDependencyGuideCard } from './BrowserDependencyGuideCard'
import configReducer from '../../store/configSlice'
import browserDetectReducer from '../../store/browserDetectSlice'
import type { BrowserDependencyToolError } from '../../../shared/browserTypes'

const dependencyRecovery: BrowserDependencyToolError = {
  errorCode: 'chromium_missing',
  errorMessage: 'Chromium 浏览器未安装',
  recommendedCwd: 'E:\\Develop\\SpaceAssistant',
  installCommand: 'npx playwright install chromium',
  detectResult: {
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
}

describe('BrowserDependencyGuideCard', () => {
  beforeEach(() => {
    window.api = {
      ...window.api,
      browserDetect: vi.fn(),
      browserOpenTerminal: vi.fn().mockResolvedValue({ ok: true })
    } as typeof window.api
  })

  it('opens settings on tools network sub tab', () => {
    const store = configureStore({
      reducer: { config: configReducer, browserDetect: browserDetectReducer }
    })
    render(
      <Provider store={store}>
        <ConfigProvider>
          <App>
            <BrowserDependencyGuideCard dependencyRecovery={dependencyRecovery} />
          </App>
        </ConfigProvider>
      </Provider>
    )
    fireEvent.click(screen.getByRole('button', { name: '打开设置 → 网络访问' }))
    const { config } = store.getState()
    expect(config.settingsOpen).toBe(true)
    expect(config.settingsActiveTab).toBe('tools')
    expect(config.settingsToolsSubTab).toBe('browser')
  })
})
