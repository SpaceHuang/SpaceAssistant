import {
  browserErrorKindFromAction,
  toBrowserUserError,
  type BrowserUserErrorKind
} from '../browser/browserUserErrors'
import { containsInternalDetails, isIntentionalUserHint } from './toolErrorCommon'

export type ToolUserErrorOptions = {
  toolName?: string
  /** browser 专用：init / navigate / extract 等 */
  browserKind?: BrowserUserErrorKind
}

export { containsInternalDetails, isIntentionalUserHint } from './toolErrorCommon'

const TOOL_DEFAULT_MESSAGES: Record<string, string> = {
  read_file: '读取文件失败，请检查路径后重试',
  write_file: '写入文件失败，请稍后重试',
  edit_file: '编辑文件失败，请稍后重试',
  list_directory: '列出目录失败，请检查路径后重试',
  grep: '搜索失败，请检查搜索参数后重试',
  run_script: '脚本执行失败，请检查代码后重试',
  run_shell: '命令执行失败，请检查命令后重试',
  run_lark_cli: '飞书 CLI 执行失败，请稍后重试',
  read_feishu_attachment: '读取飞书附件失败，请稍后重试',
  browser: '浏览器操作失败，请稍后重试'
}

function rawMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

function defaultForTool(toolName?: string): string {
  if (toolName && TOOL_DEFAULT_MESSAGES[toolName]) return TOOL_DEFAULT_MESSAGES[toolName]!
  return '工具执行失败，请稍后重试'
}

function mapGenericToolError(msg: string, toolName?: string): string | null {
  const lower = msg.toLowerCase()

  if (/enoent|no such file|not found/i.test(lower) && toolName === 'read_file') {
    return '文件不存在或路径无效'
  }
  if (/eacces|permission denied/i.test(lower)) {
    return '没有访问权限，请检查文件或目录权限'
  }
  if (/invalid regular expression|invalid regex/i.test(lower) && toolName === 'grep') {
    return '无效的正则表达式'
  }
  if (/spawn .*enoent|command not found/i.test(lower) && toolName === 'run_script') {
    return '无法启动 Python，请在设置中检查 pythonPath'
  }
  if (/executable doesn't exist|browserType\.launch/i.test(lower) && toolName === 'browser') {
    return '未检测到 Playwright Chromium，请运行：npx playwright install chromium'
  }

  return null
}

/** 面向用户与 Agent 工具结果的错误文案（不含 node_modules、绝对路径、堆栈）。 */
export function toToolUserError(err: unknown, options?: ToolUserErrorOptions): string {
  const toolName = options?.toolName
  if (toolName === 'browser') {
    const kind = options?.browserKind ?? 'generic'
    return toBrowserUserError(err, kind)
  }

  const raw = rawMessage(err).trim()
  if (!raw) return defaultForTool(toolName)

  const mapped = mapGenericToolError(raw, toolName)
  if (mapped) return mapped

  if (!containsInternalDetails(raw) && raw.length <= 400 && isIntentionalUserHint(raw)) {
    return raw
  }

  if (!containsInternalDetails(raw) && raw.length <= 240) {
    return raw
  }

  return defaultForTool(toolName)
}

export function sanitizeToolErrorString(message: string, toolName?: string): string {
  return toToolUserError(new Error(message), { toolName })
}

export function browserKindFromBrowserAction(action: string | undefined): BrowserUserErrorKind {
  return browserErrorKindFromAction(action)
}

/** 工具返回 data 中的长文本（如 stderr）脱敏 */
export function sanitizeToolOutputText(text: string, toolName?: string): string {
  if (!text || !containsInternalDetails(text)) return text
  if (toolName === 'run_script') {
    const lines = text.split(/\r?\n/).filter((l) => !containsInternalDetails(l))
    if (lines.length > 0 && lines.join('\n').length <= 2000) {
      return lines.join('\n')
    }
    return '[脚本输出含内部路径，已省略]'
  }
  return sanitizeToolErrorString(text.slice(0, 500), toolName)
}
