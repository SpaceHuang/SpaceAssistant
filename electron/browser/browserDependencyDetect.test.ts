import { describe, expect, it } from 'vitest'
import {
  buildBrowserDetectResult,
  resolveInstallContext,
  resolvePrimaryFailure,
  resolveRecommendedCwd,
  isChromiumRecoveryFailure,
  isAllowedTerminalCwd
} from './browserDependencyDetect'
import type { BrowserDetectContext } from './browserDependencyDetect'

const devCtx: BrowserDetectContext = {
  isPackaged: false,
  appPath: '/app/path',
  devRoot: 'E:\\Develop\\SpaceAssistant'
}

const packagedCtx: BrowserDetectContext = {
  isPackaged: true,
  appPath: 'C:\\Users\\x\\AppData\\Local\\Programs\\SpaceAssistant\\resources\\app.asar',
  devRoot: 'E:\\Develop\\SpaceAssistant'
}

function baseChecks(overrides: Partial<Parameters<typeof buildBrowserDetectResult>[0]> = {}) {
  return {
    stagehandInstalled: true,
    stagehandVersion: '3.6.0',
    playwrightInstalled: true,
    browsers: ['chromium'],
    chromium: { ready: true, failure: null, executableHint: 'chrome.exe', revision: '1234' },
    nodeVersion: 'v22.0.0',
    meetsNodeRequirement: true,
    installContext: 'development' as const,
    recommendedCwd: devCtx.devRoot,
    ...overrides
  }
}

describe('browserDependencyDetect', () => {
  it('resolveRecommendedCwd uses devRoot in development', () => {
    expect(resolveRecommendedCwd(devCtx)).toBe(devCtx.devRoot)
  })

  it('resolveRecommendedCwd uses appPath when packaged', () => {
    expect(resolveRecommendedCwd(packagedCtx)).toBe(packagedCtx.appPath)
  })

  it('resolveInstallContext', () => {
    expect(resolveInstallContext(false)).toBe('development')
    expect(resolveInstallContext(true)).toBe('packaged')
  })

  it('canInitialize false when chromium not ready despite playwright installed', () => {
    const result = buildBrowserDetectResult(
      baseChecks({
        chromium: { ready: false, failure: 'chromium_missing' }
      })
    )
    expect(result.canInitialize).toBe(false)
    expect(result.primaryFailure).toBe('chromium_missing')
    expect(result.errors[0]).toMatch(/Chromium/)
    expect(result.errors[0]).not.toMatch(/项目目录/)
  })

  it('chromium_headless_only primaryFailure', () => {
    const result = buildBrowserDetectResult(
      baseChecks({
        chromium: { ready: false, failure: 'chromium_headless_only', executableHint: 'headless_shell' }
      })
    )
    expect(result.primaryFailure).toBe('chromium_headless_only')
    expect(result.chromium.ready).toBe(false)
  })

  it('node_version_low has highest priority', () => {
    const failure = resolvePrimaryFailure({
      stagehandInstalled: false,
      playwrightInstalled: false,
      browsers: [],
      chromium: { ready: false, failure: 'chromium_missing' },
      nodeVersion: 'v16.0.0',
      meetsNodeRequirement: false,
      installContext: 'development'
    })
    expect(failure).toBe('node_version_low')
  })

  it('stagehand_missing error suggests reinstall in all environments', () => {
    const result = buildBrowserDetectResult(
      baseChecks({
        stagehandInstalled: false,
        playwrightInstalled: true,
        installContext: 'development',
        recommendedCwd: devCtx.devRoot,
        chromium: { ready: false, failure: 'chromium_missing' }
      })
    )
    expect(result.primaryFailure).toBe('stagehand_missing')
    expect(result.errors[0]).toMatch(/重新安装/)
    expect(result.errors[0]).not.toMatch(/npm install/)
  })

  it('ok state has empty errors', () => {
    const result = buildBrowserDetectResult(baseChecks())
    expect(result.primaryFailure).toBe('ok')
    expect(result.canInitialize).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('isChromiumRecoveryFailure whitelist', () => {
    expect(isChromiumRecoveryFailure('chromium_missing')).toBe(true)
    expect(isChromiumRecoveryFailure('stagehand_missing')).toBe(false)
  })

  it('isAllowedTerminalCwd allows recommended cwd only', () => {
    expect(isAllowedTerminalCwd(devCtx.devRoot, devCtx)).toBe(true)
    expect(isAllowedTerminalCwd(devCtx.appPath, devCtx)).toBe(false)
    expect(isAllowedTerminalCwd(packagedCtx.appPath, packagedCtx)).toBe(true)
    expect(isAllowedTerminalCwd(packagedCtx.devRoot, packagedCtx)).toBe(false)
    expect(isAllowedTerminalCwd('C:\\evil', devCtx)).toBe(false)
  })

  it('chromium_missing error uses 源码根目录 label in development', () => {
    const result = buildBrowserDetectResult(
      baseChecks({
        chromium: { ready: false, failure: 'chromium_missing' },
        installContext: 'development',
        recommendedCwd: devCtx.devRoot
      })
    )
    expect(result.errors[0]).toMatch(/源码根目录/)
    expect(result.errors[0]).not.toMatch(/应用安装目录/)
  })

  it('chromium_missing error uses 应用安装目录 label when packaged', () => {
    const result = buildBrowserDetectResult(
      baseChecks({
        chromium: { ready: false, failure: 'chromium_missing' },
        installContext: 'packaged',
        recommendedCwd: packagedCtx.appPath
      })
    )
    expect(result.errors[0]).toMatch(/应用安装目录/)
  })
})
