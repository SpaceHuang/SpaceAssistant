import { describe, expect, it } from 'vitest'
import { buildBrowserSetupGuideContent } from './browserSetupGuideContent'
import type { BrowserDetectResult } from './browserTypes'

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
    const content = buildBrowserSetupGuideContent(detect({ primaryFailure: 'chromium_missing' }), 'win32')
    expect(content.showNpmInstall).toBe(false)
    expect(content.chromiumInstallCmd).toContain('playwright install chromium')
  })

  it('shows npm install for development L1 missing', () => {
    const content = buildBrowserSetupGuideContent(
      detect({ primaryFailure: 'playwright_missing', playwright: { installed: false, browsers: [] } }),
      'win32'
    )
    expect(content.showNpmInstall).toBe(true)
  })

  it('packaged L1 missing shows defect not npm install', () => {
    const content = buildBrowserSetupGuideContent(
      detect({
        primaryFailure: 'stagehand_missing',
        stagehand: { installed: false },
        installContext: 'packaged'
      }),
      'darwin'
    )
    expect(content.showNpmInstall).toBe(false)
    expect(content.showPackagedDefect).toBe(true)
    expect(content.troubleshooting.some((t) => t.title.includes('Gatekeeper'))).toBe(true)
  })

  it('windows troubleshooting mentions Defender', () => {
    const content = buildBrowserSetupGuideContent(detect({}), 'win32')
    expect(content.troubleshooting.some((t) => t.title.includes('杀毒'))).toBe(true)
  })
})
