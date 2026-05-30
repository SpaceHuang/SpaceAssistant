import { classifyBrowserLlmError } from './browserLlmErrors'
import { containsInternalDetails, isIntentionalUserHint } from '../tools/toolErrorCommon'
import type { BrowserDependencyFailureCode, BrowserDependencyToolError, BrowserDetectResult } from '../../src/shared/browserTypes'
import { CHROMIUM_INSTALL_CMD, NPM_INSTALL_CMD } from '../../src/shared/browserTypes'
import { isChromiumRecoveryFailure } from './browserDependencyDetect'

export type BrowserUserErrorKind =
  | 'init'
  | 'navigate'
  | 'extract'
  | 'observe'
  | 'act'
  | 'screenshot'
  | 'generic'

function rawMessage(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name && err.name !== 'Error' ? `${err.name}: ` : ''
    return `${name}${err.message}`.trim()
  }
  return String(err)
}

/** 合并 message、responseBody 与 cause 链，便于匹配 API 返回的正文 */
function collectErrorText(err: unknown): string {
  const parts: string[] = []
  let cur: unknown = err
  for (let depth = 0; depth < 4 && cur != null; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message)
      const body = (cur as Error & { responseBody?: unknown }).responseBody
      if (typeof body === 'string' && body.trim()) parts.push(body)
      cur = cur.cause
    } else {
      parts.push(String(cur))
      break
    }
  }
  return parts.join('\n')
}

function mapKnownTechnicalError(msg: string, kind: BrowserUserErrorKind): string | null {
  const lower = msg.toLowerCase()

  if (/thinking mode does not support.*tool_choice|thinking mode does not support this tool/i.test(lower)) {
    return (
      '浏览器 LLM 在 DeepSeek 思考（Thinking）模式下无法提取或分析页面内容。' +
      '请完全退出并重新启动应用（确保已执行 npm run build:electron）；' +
      '若仍失败，请在设置 → 浏览器 将 Stagehand 模型改为 deepseek-v4-flash。'
    )
  }

  if (
    /require\s*\(\s*\)\s*of\s*es\s*module|err_require_esm|chrome-launcher|@browserbasehq/i.test(
      msg
    )
  ) {
    return '浏览器引擎初始化失败（Stagehand 模块兼容性），请完全退出并重启应用后重试'
  }

  if (/err_module_not_found/i.test(msg) && /@browserbasehq\/stagehand/i.test(msg)) {
    return '浏览器引擎初始化失败（Stagehand 加载路径错误），请完全退出并重启应用后重试'
  }

  if (/UnsupportedModelError|Unsupported model/i.test(msg)) {
    return '浏览器模型配置无效，请在设置 → 浏览器 中指定 Stagehand 模型（格式：provider/模型名，如 anthropic/claude-sonnet-4-6）'
  }

  if (
    /undefined undefined|CdpConnection|连接 Chromium CDP|CDP 超时/i.test(msg) &&
    kind === 'init'
  ) {
    return '浏览器 CDP 连接失败。请完全退出应用后，在设置 → 浏览器 查看安装引导执行 npx playwright install chromium，再重启应用'
  }

  if (
    /executable doesn't exist|browser has been closed|browserType\.launch/i.test(lower) &&
    !/浏览器引擎/.test(msg)
  ) {
    return '未检测到 Playwright Chromium，请在设置 → 浏览器 查看安装引导，或运行：npx playwright install chromium'
  }

  if (/浏览器初始化失败/i.test(msg) && containsInternalDetails(msg)) {
    return '浏览器初始化失败，请确认 Playwright Chromium 已正确安装后重试'
  }

  if (/推理次数已达上限/.test(msg)) return msg

  if (/尚未授权|白名单|不在允许|仅允许/i.test(msg) && !containsInternalDetails(msg)) return msg

  if (/net::err_name_not_resolved|getaddrinfo enotfound/i.test(lower)) {
    return '无法解析该域名，请检查 URL 是否正确'
  }

  if (/net::err_connection_refused|econnrefused/i.test(lower)) {
    return '无法连接到目标服务器，请稍后重试'
  }

  if (/net::err_|navigation.*timeout|timeout.*exceeded|打开页面.*超时|navigate.*超时/i.test(lower)) {
    if (kind === 'navigate') return '打开页面超时或网络不可达，请检查 URL 与网络后重试'
  }

  if (/\b403\b|forbidden/i.test(lower) && kind === 'navigate') {
    return '目标网站拒绝了访问（403），无法打开该页面'
  }

  if (/ssl|certificate|cert_/i.test(lower) && kind === 'navigate') {
    return '无法建立安全连接，请检查站点证书或网络环境'
  }

  return null
}

function defaultMessage(kind: BrowserUserErrorKind): string {
  switch (kind) {
    case 'init':
      return '浏览器初始化失败，请稍后重试或检查 Playwright Chromium 是否已安装'
    case 'navigate':
      return '打开页面失败，请检查 URL、域名授权与网络连接'
    case 'extract':
      return '提取页面内容失败，请稍后重试'
    case 'observe':
      return '分析页面元素失败，请稍后重试'
    case 'act':
      return '页面操作失败，请稍后重试'
    case 'screenshot':
      return '截图失败，请稍后重试'
    default:
      return '浏览器操作失败，请稍后重试'
  }
}

/** 面向用户/Agent 工具结果的错误文案，不含本地路径与依赖模块名。 */
export function toBrowserUserError(err: unknown, kind: BrowserUserErrorKind = 'generic'): string {
  if (err instanceof Error && (err as Error & { userFacing?: boolean }).userFacing) {
    return err.message
  }

  const llmMsg = classifyBrowserLlmError(err)
  if (llmMsg !== '浏览器操作失败') return llmMsg

  const combined = collectErrorText(err).trim()
  const raw = combined || rawMessage(err).trim()
  if (!raw) return defaultMessage(kind)

  const mapped = mapKnownTechnicalError(raw, kind)
  if (mapped) return mapped

  if (!containsInternalDetails(raw) && raw.length <= 240 && isIntentionalUserHint(raw)) {
    return raw
  }

  if (!containsInternalDetails(raw) && raw.length <= 240) {
    if (kind === 'navigate' && !/^打开页面失败/.test(raw)) {
      return `打开页面失败：${raw}`
    }
    if (kind === 'extract' && !/^提取/.test(raw)) {
      return `提取内容失败：${raw}`
    }
  }

  return defaultMessage(kind)
}

export function browserErrorKindFromAction(
  action: string | undefined
): BrowserUserErrorKind {
  switch (action) {
    case 'navigate':
      return 'navigate'
    case 'extract':
      return 'extract'
    case 'observe':
      return 'observe'
    case 'act':
      return 'act'
    case 'screenshot':
      return 'screenshot'
    default:
      return 'generic'
  }
}

export function mapErrorToFailureCode(err: unknown, kind: BrowserUserErrorKind): BrowserDependencyFailureCode | null {
  const combined = collectErrorText(err).trim().toLowerCase()
  if (
    /executable doesn't exist|browser has been closed|browsertype\.launch|headless_shell/i.test(combined)
  ) {
    if (/headless_shell/i.test(combined)) return 'chromium_headless_only'
    return 'chromium_missing'
  }
  if (/cdp|连接 chromium|target closed/i.test(combined) && kind === 'init') {
    return 'init_probe_failed'
  }
  return null
}

export function toBrowserDependencyToolError(detectResult: BrowserDetectResult): BrowserDependencyToolError {
  const errorMessage =
    detectResult.errors[0] ??
    'Chromium 浏览器未安装。需要执行 npx playwright install chromium 下载。'
  return {
    errorCode: detectResult.primaryFailure,
    errorMessage,
    recommendedCwd: detectResult.recommendedCwd,
    installCommand: CHROMIUM_INSTALL_CMD,
    detectResult
  }
}

export function shouldAttachDependencyRecovery(detectResult: BrowserDetectResult): boolean {
  return isChromiumRecoveryFailure(detectResult.primaryFailure)
}
