import { describe, expect, it } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { App, ConfigProvider } from 'antd'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
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

function renderWithI18n(ui: React.ReactElement) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ConfigProvider>
        <App>
          {ui}
        </App>
      </ConfigProvider>
    </I18nextProvider>
  )
}

describe('BrowserDetectStatusSummary', () => {
  it('keeps action children visible when collapsed', () => {
    renderWithI18n(
      <BrowserDetectStatusSummary detect={detectMissing}>
        <button type="button">帮我修复</button>
      </BrowserDetectStatusSummary>
    )
    expect(screen.getByRole('button', { name: '帮我修复' })).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('collapses by default when dependencies missing', () => {
    renderWithI18n(
      <BrowserDetectStatusSummary detect={detectMissing} />
    )
    expect(screen.getByText('Chromium 浏览器未安装')).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('shows four status rows when expanded', async () => {
    renderWithI18n(
      <BrowserDetectStatusSummary detect={detectMissing} />
    )
    fireEvent.click(screen.getByText('Chromium 浏览器未安装'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())
    expect(screen.getByText(/Playwright:/)).toBeTruthy()
    expect(screen.getByText(/Chromium:/)).toBeTruthy()
  })

  it('collapses when ready', () => {
    renderWithI18n(
      <BrowserDetectStatusSummary detect={detectReady} />
    )
    expect(screen.getByText('网络访问功能正常')).toBeTruthy()
    expect(screen.queryByText(/Stagehand:/)).toBeNull()
  })

  it('expands details when compact row clicked', async () => {
    renderWithI18n(
      <BrowserDetectStatusSummary detect={detectReady} />
    )
    fireEvent.click(screen.getByText('网络访问功能正常'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())
  })

  it('collapses details when detecting finishes even if fingerprint unchanged', async () => {
    const { rerender } = renderWithI18n(
      <BrowserDetectStatusSummary detect={detectMissing} detecting={false} />
    )
    fireEvent.click(screen.getByText('Chromium 浏览器未安装'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())

    rerender(
      <I18nextProvider i18n={i18n}>
        <ConfigProvider>
          <App>
            <BrowserDetectStatusSummary detect={detectMissing} detecting />
          </App>
        </ConfigProvider>
      </I18nextProvider>
    )

    rerender(
      <I18nextProvider i18n={i18n}>
        <ConfigProvider>
          <App>
            <BrowserDetectStatusSummary detect={detectMissing} detecting={false} />
          </App>
        </ConfigProvider>
      </I18nextProvider>
    )

    await waitFor(() => {
      expect(screen.getByText('Chromium 浏览器未安装')).toBeTruthy()
      expect(screen.queryByText(/Stagehand:/)).toBeNull()
    })
  })

  it('collapses again after re-detect result changes', async () => {
    const { rerender } = renderWithI18n(
      <BrowserDetectStatusSummary detect={detectMissing} />
    )
    fireEvent.click(screen.getByText('Chromium 浏览器未安装'))
    await waitFor(() => expect(screen.getByText(/Stagehand:/)).toBeTruthy())

    rerender(
      <I18nextProvider i18n={i18n}>
        <ConfigProvider>
          <App>
            <BrowserDetectStatusSummary detect={detectReady} />
          </App>
        </ConfigProvider>
      </I18nextProvider>
    )
    await waitFor(() => {
      expect(screen.getByText('网络访问功能正常')).toBeTruthy()
      expect(screen.queryByText(/Stagehand:/)).toBeNull()
    })
  })
})
