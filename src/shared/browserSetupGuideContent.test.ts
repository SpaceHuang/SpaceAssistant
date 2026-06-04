import { describe, expect, it } from 'vitest'
import { buildBrowserSetupGuideContent } from './browserSetupGuideContent'
import type { BrowserDetectResult } from './browserTypes'

const t = (key: string): string => key

function detect(partial: Partial<BrowserDetectResult>): BrowserDetectResult {
  return {
    stagehand: { installed: true, version: '3.0.0' },
    playwright: { installed: true, browsers: ['chromium'] },
    chromium: { ready: false },
    node: { version: 'v22.0.0', meetsRequirement: true },
    canInitialize: false,
    primaryFailure: 'chromium_missing',
    errors: ['Chromium 未安装'],
    recommendedCwd: 'E:\\Develop\\SpaceAssistant',
    installContext: 'development',
    ...partial
  }
}

describe('browserSetupGuideContent', () => {
  it('does not show npm install when only chromium missing', () => {
    const content = buildBrowserSetupGuideContent(detect({ primaryFailure: 'chromium_missing' }), 'win32', t)
    expect(content.showNpmInstall).toBe(false)
    expect(content.chromiumInstallCmd).toContain('playwright install chromium')
  })

  it('L1 missing shows packaged defect not npm install', () => {
    const content = buildBrowserSetupGuideContent(
      detect({ primaryFailure: 'playwright_missing', playwright: { installed: false, browsers: [] } }),
      'win32',
      t
    )
    expect(content.showNpmInstall).toBe(false)
    expect(content.showPackagedDefect).toBe(true)
  })

  it('stagehand missing shows packaged defect', () => {
    const content = buildBrowserSetupGuideContent(
      detect({
        primaryFailure: 'stagehand_missing',
        stagehand: { installed: false },
        installContext: 'packaged'
      }),
      'darwin',
      t
    )
    expect(content.showNpmInstall).toBe(false)
    expect(content.showPackagedDefect).toBe(true)
    expect(content.troubleshooting.some((t) => t.title.includes('Gatekeeper'))).toBe(true)
  })

  it('windows troubleshooting mentions Defender', () => {
    const content = buildBrowserSetupGuideContent(detect({}), 'win32', t)
    expect(content.troubleshooting.some((t) => t.title.includes('Defender'))).toBe(true)
  })

  it('returns translated title via t function', () => {
    const content = buildBrowserSetupGuideContent(detect({}), 'win32', t)
    expect(content.title).toBe('feishu:remote.browser.setup.fixTitle')
  })

  it('ok failure returns ok title', () => {
    const content = buildBrowserSetupGuideContent(detect({ primaryFailure: 'ok', chromium: { ready: true }, canInitialize: true }), 'win32', t)
    expect(content.title).toBe('feishu:remote.browser.setup.okTitle')
  })

  it('node_version_low returns nodeTooLow summary when no errors', () => {
    const content = buildBrowserSetupGuideContent(detect({ primaryFailure: 'node_version_low', errors: [] }), 'win32', t)
    expect(content.summary).toBe('feishu:remote.browser.setup.nodeTooLow')
  })

  it('terminal hint uses platform-specific key', () => {
    const contentWin = buildBrowserSetupGuideContent(detect({}), 'win32', t)
    expect(contentWin.terminalHint).toBe('feishu:remote.browser.setup.terminalHintWin')

    const contentMac = buildBrowserSetupGuideContent(detect({}), 'darwin', t)
    expect(contentMac.terminalHint).toBe('feishu:remote.browser.setup.terminalHintMac')

    const contentLinux = buildBrowserSetupGuideContent(detect({}), 'linux', t)
    expect(contentLinux.terminalHint).toBe('feishu:remote.browser.setup.terminalHintLinux')
  })
})
