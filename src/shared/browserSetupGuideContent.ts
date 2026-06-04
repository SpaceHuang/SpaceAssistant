import type { BrowserDetectResult } from './browserTypes'
import { CHROMIUM_INSTALL_CMD, NPM_INSTALL_CMD } from './browserTypes'

export type BrowserSetupGuideContent = {
  title: string
  summary: string
  terminalHint: string
  cwdLabel: string
  showNpmInstall: boolean
  npmInstallCmd: string
  chromiumInstallCmd: string
  showForceInstall: boolean
  forceInstallCmd: string
  troubleshooting: Array<{ title: string; body: string }>
  showPackagedDefect: boolean
}

const FORCE_INSTALL_CMD = 'npx playwright install --force chromium'

function terminalHint(platform: string, t: (key: string) => string): string {
  if (platform === 'win32') return t('feishu:remote.browser.setup.terminalHintWin')
  if (platform === 'darwin') return t('feishu:remote.browser.setup.terminalHintMac')
  return t('feishu:remote.browser.setup.terminalHintLinux')
}

function cwdDescription(_detect: BrowserDetectResult, t: (key: string) => string): string {
  return t('feishu:remote.browser.setup.cwdDescription')
}

function buildTroubleshooting(platform: string, t: (key: string) => string): Array<{ title: string; body: string }> {
  const common = [
    {
      title: t('feishu:remote.browser.setup.troubleshootNetworkTitle'),
      body: t('feishu:remote.browser.setup.troubleshootNetworkBody')
    },
    {
      title: t('feishu:remote.browser.setup.troubleshootDiskTitle'),
      body: t('feishu:remote.browser.setup.troubleshootDiskBody')
    },
    {
      title: t('feishu:remote.browser.setup.troubleshootStillFailTitle'),
      body: t('feishu:remote.browser.setup.troubleshootStillFailBody')
    }
  ]

  if (platform === 'win32') {
    return [
      {
        title: t('feishu:remote.browser.setup.troubleshootDefenderTitle'),
        body: t('feishu:remote.browser.setup.troubleshootDefenderBody')
      },
      ...common
    ]
  }

  if (platform === 'darwin') {
    return [
      {
        title: t('feishu:remote.browser.setup.troubleshootGatekeeperTitle'),
        body: t('feishu:remote.browser.setup.troubleshootGatekeeperBody')
      },
      {
        title: t('feishu:remote.browser.setup.troubleshootCacheMacTitle'),
        body: t('feishu:remote.browser.setup.troubleshootCacheMacBody')
      },
      ...common
    ]
  }

  return [
    {
      title: t('feishu:remote.browser.setup.troubleshootCacheLinuxTitle'),
      body: t('feishu:remote.browser.setup.troubleshootCacheLinuxBody')
    },
    ...common
  ]
}

export function buildBrowserSetupGuideContent(
  detect: BrowserDetectResult,
  platform: string = typeof process !== 'undefined' ? process.platform : 'win32',
  t: (key: string, options?: Record<string, string>) => string = (key) => key
): BrowserSetupGuideContent {
  const failure = detect.primaryFailure
  const showNpmInstall = false
  const showPackagedDefect = failure === 'stagehand_missing' || failure === 'playwright_missing'
  const showForceInstall =
    failure === 'chromium_missing' ||
    failure === 'chromium_headless_only' ||
    failure === 'chromium_path_unresolved' ||
    failure === 'init_probe_failed'

  let summary = detect.errors[0] ?? t('feishu:remote.browser.setup.depNotReady')
  if (failure === 'ok') {
    summary = t('feishu:remote.browser.setup.okSummary')
  } else if (failure === 'node_version_low') {
    summary = detect.errors[0] ?? t('feishu:remote.browser.setup.nodeTooLow')
  }

  return {
    title: failure === 'ok' ? t('feishu:remote.browser.setup.okTitle') : t('feishu:remote.browser.setup.fixTitle'),
    summary,
    terminalHint: terminalHint(platform, t),
    cwdLabel: cwdDescription(detect, t),
    showNpmInstall,
    npmInstallCmd: NPM_INSTALL_CMD,
    chromiumInstallCmd: CHROMIUM_INSTALL_CMD,
    showForceInstall,
    forceInstallCmd: FORCE_INSTALL_CMD,
    troubleshooting: buildTroubleshooting(platform, t),
    showPackagedDefect
  }
}

export function buildDiagnosticText(detect: BrowserDetectResult, platform: string): string {
  return [
    `failureCode: ${detect.primaryFailure}`,
    `platform: ${platform}`,
    `installContext: ${detect.installContext}`,
    `stagehand: ${detect.stagehand.installed ? detect.stagehand.version ?? 'installed' : 'missing'}`,
    `playwright: ${detect.playwright.installed ? 'installed' : 'missing'}`,
    `chromiumReady: ${detect.chromium.ready}`,
    `node: ${detect.node.version}`
  ].join('\n')
}
