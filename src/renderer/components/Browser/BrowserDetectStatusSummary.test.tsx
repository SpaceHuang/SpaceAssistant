import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { BrowserDetectStatusSummary } from './BrowserDetectStatusSummary'
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

describe('BrowserDetectStatusSummary', () => {
  it('keeps action children visible when collapsed', () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing}>
            <button type="button">帮我修复</button>
          </BrowserDetectStatusSummary>
        </App>
      </ConfigProvider>
    )
    expect(screen.getByRole('button', { name: '帮我修复' })).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('collapses by default when dependencies missing', () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing} />
        </App>
      </ConfigProvider>
    )
    expect(screen.getByText('Chromium 浏览器未安装')).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('shows four status rows when expanded', async () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByText('Chromium 浏览器未安装'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())
    expect(screen.getByText(/Playwright:/)).toBeTruthy()
    expect(screen.getByText(/Chromium:/)).toBeTruthy()
  })

  it('collapses when ready', () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectReady} />
        </App>
      </ConfigProvider>
    )
    expect(screen.getByText('网络访问功能正常')).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('expands details when compact row clicked', async () => {
    render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectReady} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByText('网络访问功能正常'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())
  })

  it('collapses details when detecting finishes even if fingerprint unchanged', async () => {
    const { rerender } = render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing} detecting={false} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByText('Chromium 浏览器未安装'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())

    rerender(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing} detecting />
        </App>
      </ConfigProvider>
    )

    rerender(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing} detecting={false} />
        </App>
      </ConfigProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('Chromium 浏览器未安装')).toBeTruthy()
      expect(screen.queryByText(/Stagehand:/)).toBeNull()
    })
  })

  it('collapses again after re-detect result changes', async () => {
    const { rerender } = render(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectMissing} />
        </App>
      </ConfigProvider>
    )
    fireEvent.click(screen.getByText('Chromium 浏览器未安装'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())

    rerender(
      <ConfigProvider>
        <App>
          <BrowserDetectStatusSummary detect={detectReady} />
        </App>
      </ConfigProvider>
    )
    await waitFor(() => {
      expect(screen.getByText('网络访问功能正常')).toBeTruthy()
      expect(screen.queryByText(/Stagehand:/)).toBeNull()
    })
  })
})
