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

function terminalHint(platform: string): string {
  if (platform === 'win32') return '打开 Windows Terminal 或 PowerShell'
  if (platform === 'darwin') return '打开「终端.app」'
  return '打开终端'
}

function cwdDescription(_detect: BrowserDetectResult): string {
  return '请在下方目录打开终端（应用安装位置）'
}

function buildTroubleshooting(platform: string): Array<{ title: string; body: string }> {
  const common = [
    {
      title: '网络',
      body: '安装需联网下载约 150–200MB。若使用代理，请确保终端可访问 cdn.playwright.dev。'
    },
    {
      title: '磁盘空间',
      body: '请至少预留 500MB 可用空间。'
    },
    {
      title: '仍失败',
      body: '可点击「复制诊断信息」并将内容用于排查（不含 API Key）。'
    }
  ]

  if (platform === 'win32') {
    return [
      {
        title: 'Windows 杀毒',
        body: 'Windows Defender 可能隔离 %LOCALAPPDATA%\\ms-playwright 下的 chrome.exe，请添加排除项或允许运行后重试。'
      },
      ...common
    ]
  }

  if (platform === 'darwin') {
    return [
      {
        title: 'macOS Gatekeeper',
        body: '首次运行 Chromium 可能提示无法验证开发者。请到「系统设置 → 隐私与安全性」允许，或参考 Playwright 文档移除隔离属性。'
      },
      {
        title: '缓存位置',
        body: 'Playwright 默认将浏览器下载到 ~/Library/Caches/ms-playwright/'
      },
      ...common
    ]
  }

  return [
    {
      title: '缓存位置',
      body: 'Playwright 默认将浏览器下载到 ~/.cache/ms-playwright/'
    },
    ...common
  ]
}

export function buildBrowserSetupGuideContent(
  detect: BrowserDetectResult,
  platform: string = typeof process !== 'undefined' ? process.platform : 'win32'
): BrowserSetupGuideContent {
  const failure = detect.primaryFailure
  const showNpmInstall = false
  const showPackagedDefect = failure === 'stagehand_missing' || failure === 'playwright_missing'
  const showForceInstall =
    failure === 'chromium_missing' ||
    failure === 'chromium_headless_only' ||
    failure === 'chromium_path_unresolved' ||
    failure === 'init_probe_failed'

  let summary = detect.errors[0] ?? '浏览器依赖未就绪'
  if (failure === 'ok') {
    summary = 'Chromium 已就绪，可以使用浏览器工具。'
  } else if (failure === 'node_version_low') {
    summary = detect.errors[0] ?? '应用内置 Node 版本过低，请升级 SpaceAssistant。'
  }

  return {
    title: failure === 'ok' ? '浏览器依赖已就绪' : '浏览器依赖修复',
    summary,
    terminalHint: terminalHint(platform),
    cwdLabel: cwdDescription(detect),
    showNpmInstall,
    npmInstallCmd: NPM_INSTALL_CMD,
    chromiumInstallCmd: CHROMIUM_INSTALL_CMD,
    showForceInstall,
    forceInstallCmd: FORCE_INSTALL_CMD,
    troubleshooting: buildTroubleshooting(platform),
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
