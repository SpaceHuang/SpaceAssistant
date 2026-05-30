import { access } from 'node:fs/promises'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import type {
  BrowserDependencyFailureCode,
  BrowserDetectResult
} from '../../src/shared/browserTypes'
import {
  CHROMIUM_INSTALL_CMD,
  NPM_INSTALL_CMD
} from '../../src/shared/browserTypes'
import { importEsmModule } from '../esmDynamicImport'
import { resolveFullChromiumExecutable } from './playwrightBrowserHost'

const nodeRequire = createRequire(__filename)

export const MIN_NODE_MAJOR = 18
export { CHROMIUM_INSTALL_CMD, NPM_INSTALL_CMD } from '../../src/shared/browserTypes'

export type BrowserDetectContext = {
  isPackaged: boolean
  appPath: string
  devRoot: string
}

type ChromiumCheck = {
  ready: boolean
  failure: BrowserDependencyFailureCode | null
  executableHint?: string
  revision?: string
}

type DependencyChecks = {
  stagehandInstalled: boolean
  stagehandVersion?: string
  playwrightInstalled: boolean
  browsers: string[]
  chromium: ChromiumCheck
  nodeVersion: string
  meetsNodeRequirement: boolean
  installContext: 'development' | 'packaged'
  recommendedCwd: string
}

export function resolveRecommendedCwd(ctx: BrowserDetectContext): string {
  if (ctx.isPackaged) {
    return ctx.appPath || ctx.devRoot
  }
  return ctx.devRoot
}

export function resolveInstallContext(isPackaged: boolean): 'development' | 'packaged' {
  return isPackaged ? 'packaged' : 'development'
}

export function resolvePrimaryFailure(checks: Omit<DependencyChecks, 'recommendedCwd'>): BrowserDependencyFailureCode {
  if (!checks.meetsNodeRequirement) return 'node_version_low'
  if (!checks.stagehandInstalled) return 'stagehand_missing'
  if (!checks.playwrightInstalled) return 'playwright_missing'
  if (checks.chromium.failure) return checks.chromium.failure
  if (checks.chromium.ready) return 'ok'
  return 'chromium_missing'
}

function cwdLabel(installContext: 'development' | 'packaged'): string {
  return installContext === 'packaged' ? '应用安装目录' : '源码根目录'
}

function buildErrors(checks: DependencyChecks, primaryFailure: BrowserDependencyFailureCode): string[] {
  const errors: string[] = []
  const label = cwdLabel(checks.installContext)

  if (primaryFailure === 'node_version_low') {
    errors.push(
      `应用内置 Node ${checks.nodeVersion} 版本过低（需要 >= ${MIN_NODE_MAJOR}），请升级 SpaceAssistant 到最新版本`
    )
  }
  if (primaryFailure === 'stagehand_missing') {
    if (checks.installContext === 'packaged') {
      errors.push('浏览器引擎组件缺失，请重新安装应用或联系支持')
    } else {
      errors.push(`未安装 @browserbasehq/stagehand，请在${label}执行 npm install`)
    }
  }
  if (primaryFailure === 'playwright_missing') {
    if (checks.installContext === 'packaged') {
      errors.push('Playwright 组件缺失，请重新安装应用或联系支持')
    } else {
      errors.push(`未安装 playwright，请在${label}执行 npm install`)
    }
  }
  if (primaryFailure === 'chromium_headless_only') {
    errors.push(`未检测到完整 Chromium（仅有 headless shell），请在${label}运行：${CHROMIUM_INSTALL_CMD}`)
  }
  if (primaryFailure === 'chromium_missing') {
    errors.push(`Chromium 浏览器未安装，请在${label}运行：${CHROMIUM_INSTALL_CMD}`)
  }
  if (primaryFailure === 'chromium_path_unresolved') {
    errors.push(`无法解析 Chromium 可执行文件，请在${label}运行：${CHROMIUM_INSTALL_CMD}`)
  }
  if (primaryFailure === 'init_probe_failed') {
    errors.push('Chromium 已安装但启动失败，请完全退出应用后重试，或查看故障排除说明')
  }

  return errors
}

export function buildBrowserDetectResult(checks: DependencyChecks): BrowserDetectResult {
  const primaryFailure = resolvePrimaryFailure(checks)
  const canInitialize =
    checks.stagehandInstalled &&
    checks.playwrightInstalled &&
    checks.chromium.ready &&
    checks.meetsNodeRequirement

  return {
    stagehand: { installed: checks.stagehandInstalled, version: checks.stagehandVersion },
    playwright: { installed: checks.playwrightInstalled, browsers: checks.browsers },
    chromium: {
      ready: checks.chromium.ready,
      executableHint: checks.chromium.executableHint,
      revision: checks.chromium.revision
    },
    node: { version: checks.nodeVersion, meetsRequirement: checks.meetsNodeRequirement },
    canInitialize,
    primaryFailure,
    errors: primaryFailure === 'ok' ? [] : buildErrors(checks, primaryFailure),
    recommendedCwd: checks.recommendedCwd,
    installContext: checks.installContext
  }
}

async function checkChromiumExecutable(): Promise<ChromiumCheck> {
  try {
    const { chromium } = await importEsmModule<typeof import('playwright')>('playwright')
    const exe = await resolveFullChromiumExecutable(chromium)
    const revision = exe.match(/chromium-(\d+)/i)?.[1]

    if (exe.includes('headless_shell')) {
      return {
        ready: false,
        failure: 'chromium_headless_only',
        executableHint: 'headless_shell',
        revision
      }
    }

    try {
      await access(exe)
    } catch {
      return {
        ready: false,
        failure: 'chromium_missing',
        executableHint: basename(exe),
        revision
      }
    }

    return {
      ready: true,
      failure: null,
      executableHint: basename(exe),
      revision
    }
  } catch {
    return {
      ready: false,
      failure: 'chromium_path_unresolved',
      executableHint: undefined,
      revision: undefined
    }
  }
}

export async function detectBrowserDependencies(ctx: BrowserDetectContext): Promise<BrowserDetectResult> {
  const installContext = resolveInstallContext(ctx.isPackaged)
  const recommendedCwd = resolveRecommendedCwd(ctx)

  let stagehandInstalled = false
  let stagehandVersion: string | undefined
  try {
    const pkg = nodeRequire('@browserbasehq/stagehand/package.json') as { version?: string }
    stagehandInstalled = true
    stagehandVersion = pkg.version
  } catch {
    /* missing */
  }

  let playwrightInstalled = false
  const browsers: string[] = []
  let chromium: ChromiumCheck = { ready: false, failure: 'chromium_missing' }

  try {
    nodeRequire.resolve('playwright')
    playwrightInstalled = true
    browsers.push('chromium')
    chromium = await checkChromiumExecutable()
  } catch {
    /* playwright missing */
  }

  const nodeVersion = process.version
  const major = parseInt(nodeVersion.slice(1).split('.')[0] ?? '0', 10)
  const meetsNodeRequirement = major >= MIN_NODE_MAJOR

  return buildBrowserDetectResult({
    stagehandInstalled,
    stagehandVersion,
    playwrightInstalled,
    browsers,
    chromium,
    nodeVersion,
    meetsNodeRequirement,
    installContext,
    recommendedCwd
  })
}

export function isChromiumRecoveryFailure(code: BrowserDependencyFailureCode): boolean {
  return (
    code === 'chromium_missing' ||
    code === 'chromium_headless_only' ||
    code === 'chromium_path_unresolved' ||
    code === 'init_probe_failed'
  )
}

export function isAllowedTerminalCwd(cwd: string, ctx: BrowserDetectContext): boolean {
  const allowed = resolveRecommendedCwd(ctx)
  return cwd === allowed
}
