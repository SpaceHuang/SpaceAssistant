import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App } from 'antd'
import { BrowserSetupGuide } from './BrowserSetupGuide'
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

const detectReady: BrowserDetectResult = {
  stagehand: { installed: true, version: '3.0.0' },
  playwright: { installed: true, browsers: ['chromium'] },
  chromium: { ready: true },
  node: { version: 'v22.0.0', meetsRequirement: true },
  canInitialize: true,
  primaryFailure: 'ok',
  errors: [],
  recommendedCwd: 'E:\\Develop\\SpaceAssistant',
  installContext: 'development'
}

function renderGuide(detect: BrowserDetectResult | null = detectMissing) {
  const onRefresh = vi.fn().mockResolvedValue(undefined)
  return render(
    <App>
      <BrowserSetupGuide detect={detect} onRefresh={onRefresh} mode="settings" platform="win32" />
    </App>
  )
}

describe('BrowserSetupGuide', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })
    window.api = {
      ...window.api,
      browserOpenTerminal: vi.fn().mockResolvedValue({ ok: true }),
      browserDetect: vi.fn()
    } as typeof window.api
  })

  it('shows install steps when chromium missing', () => {
    renderGuide()
    expect(screen.getByText(/浏览器依赖修复/)).toBeTruthy()
    expect(screen.getByText(/Chromium 浏览器未安装/)).toBeTruthy()
    expect(screen.getByText('npx playwright install chromium')).toBeTruthy()
  })

  it('calls onRefresh when re-detect clicked', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined)
    render(
      <App>
        <BrowserSetupGuide detect={detectMissing} onRefresh={onRefresh} mode="settings" platform="win32" />
      </App>
    )
    fireEvent.click(screen.getByRole('button', { name: '重新检测' }))
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith(true))
  })

  it('collapses to one line when environment is ready', () => {
    renderGuide(detectReady)
    expect(screen.getByText('网络访问功能正常')).toBeTruthy()
    expect(screen.getByTitle('点击展开详情')).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('expands full guide when compact row clicked', () => {
    renderGuide(detectReady)
    fireEvent.click(screen.getByText('网络访问功能正常'))
    expect(screen.getByText(/Stagehand:/)).toBeTruthy()
    expect(screen.getByText('检测通过，浏览器工具可以初始化。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '收起' })).toBeTruthy()
  })
})
