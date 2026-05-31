import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { Provider } from 'react-redux'
import { configureStore } from '@reduxjs/toolkit'
import { BrowserDependencyGuideCard } from './BrowserDependencyGuideCard'
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
      browserOpenTerminal: vi.fn().mockResolvedValue({ ok: true })
    } as typeof window.api
  })

  it('shows slim recovery bar with open terminal action', () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDependencyGuideCard dependencyRecovery={dependencyRecovery} />
        </App>
      </ConfigProvider>
    )
    expect(screen.getByText(/网络访问依赖未就绪/)).toBeTruthy()
    expect(screen.getByText(/助手将代为运行安装命令/)).toBeTruthy()
    expect(screen.getByRole('button', { name: '在终端中打开' })).toBeTruthy()
    expect(screen.queryByText(/打开设置/)).toBeNull()
  })

  it('opens terminal when button clicked', () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDependencyGuideCard dependencyRecovery={dependencyRecovery} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: '在终端中打开' }))
    expect(window.api.browserOpenTerminal).toHaveBeenCalled()
  })
})
